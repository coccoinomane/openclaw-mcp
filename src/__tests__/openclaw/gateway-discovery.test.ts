import { Buffer } from 'node:buffer';
import { createHash, verify } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import {
  discoverGatewayAgents,
  gatewayModelRequest,
  type DiscoveryClientFactory,
} from '../../openclaw/gateway-discovery.js';
import { gatewayDiscoveryAuth } from '../../openclaw/gateway-discovery-auth.js';
import { loadAgentCatalog } from '../../openclaw/agent-catalog.js';
import { OpenClawGateway } from '../../openclaw/gateway.js';

let directory: string;
let env: NodeJS.ProcessEnv;
const local = {
  url: 'http://127.0.0.1:18789',
  token: 'bootstrap-secret',
  agentId: 'main',
};
const roster = {
  defaultId: 'writer',
  selectionRequired: true,
  agents: [
    { id: 'main' },
    { id: 'writer', workspace: '/private', token: 'never-return' },
    { id: 'system', kind: 'system' },
  ],
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mcp-gateway-discovery-'));
  env = { MCP_AGENT_DISCOVERY: 'gateway', MCP_AGENT_DISCOVERY_STATE_DIR: directory };
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function fake(onStart?: (options: GatewayClientOptions) => void, response: unknown = roster) {
  const options: GatewayClientOptions[] = [];
  const clients: Array<{
    start: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    stopAndWait: ReturnType<typeof vi.fn>;
  }> = [];
  const create: DiscoveryClientFactory = (opts) => {
    options.push(opts);
    const client = {
      start: vi.fn(() => (onStart ? onStart(opts) : opts.onHelloOk!({} as never))),
      request: vi.fn().mockResolvedValue(response),
      stopAndWait: vi.fn().mockResolvedValue(undefined),
    };
    clients.push(client);
    return client;
  };
  return { create, options, clients };
}

describe('Gateway roster discovery', () => {
  it('uses a signed backend identity and only agents.list/operator.read, preserving defaults and manual routes', async () => {
    const transport = fake();
    const bindings = [{ agentId: 'writer', match: { channel: 'discord', guildId: '123' } }];
    const configs = await loadAgentCatalog({ ...local, bindings }, env, (config, environment) =>
      discoverGatewayAgents(config, environment, transport.create)
    );
    expect(transport.options[0]).toMatchObject({
      url: 'ws://127.0.0.1:18789/',
      clientName: 'gateway-client',
      clientDisplayName: 'openclaw-mcp agent discovery',
      mode: 'backend',
      role: 'operator',
      scopes: ['operator.read'],
      caps: [],
      minProtocol: 4,
      maxProtocol: 4,
      token: 'bootstrap-secret',
      deviceIdentity: { deviceId: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(transport.clients[0].request.mock.calls).toEqual([
      ['agents.list', {}, { timeoutMs: 30000 }],
    ]);
    expect(transport.clients[0].stopAndWait).toHaveBeenCalledWith({ timeoutMs: 1000 });
    expect(configs.agents).toEqual([{ id: 'main' }, { id: 'writer' }]);
    expect(configs.bindings).toEqual(bindings);
    const gateway = new OpenClawGateway(configs);
    expect(gateway.resolve().agentId).toBe('main');
    expect(gateway.listAgents()).toEqual([
      { agentId: 'main', isDefault: true },
      { agentId: 'writer', isDefault: false },
    ]);
    expect(JSON.stringify(gateway.listAgents())).not.toMatch(
      /private|never-return|bootstrap-secret|selectionRequired/
    );
  });

  it('waits for hello before any RPC and leaves absent bindings absent', async () => {
    const transport = fake(() => {});
    const task = discoverGatewayAgents(local, env, transport.create);
    expect(transport.clients[0].request).not.toHaveBeenCalled();
    transport.options[0].onHelloOk!({} as never);
    await task;
    const configs = await loadAgentCatalog(local, env, async () => roster);
    expect(configs).not.toHaveProperty('bindings');
  });

  it('fails startup on a connection error and awaits cleanup', async () => {
    const transport = fake((opts) => opts.onConnectError!(new Error('secret upstream failure')));
    await expect(
      loadAgentCatalog(local, env, (config, environment) =>
        discoverGatewayAgents(config, environment, transport.create)
      )
    ).rejects.toThrow('Gateway agent discovery: connection or agents.list request failed');
    expect(transport.clients[0].stopAndWait).toHaveBeenCalledTimes(1);
    expect(transport.clients[0].request).not.toHaveBeenCalled();
    expect(local).not.toHaveProperty('agents');
  });

  it('reports pairing without leaking upstream errors, and closes the connection', async () => {
    const transport = fake((opts) =>
      opts.onConnectError!(
        Object.assign(new Error('token=secret'), {
          details: { code: 'PAIRING_REQUIRED', requestId: 'untrusted-secret' },
        })
      )
    );
    await expect(discoverGatewayAgents(local, env, transport.create)).rejects.toThrow(
      /pairing required for device [a-f0-9]{64}/
    );
    expect(transport.clients[0].request).not.toHaveBeenCalled();
    expect(transport.clients[0].stopAndWait).toHaveBeenCalledTimes(1);
  });

  it.each(['AUTH_SCOPE_MISMATCH', 'AUTH_TOKEN_MISMATCH'])(
    'reports %s without credentials',
    async (code) => {
      const transport = fake((opts) =>
        opts.onConnectError!(Object.assign(new Error('secret'), { details: { code } }))
      );
      const error = await discoverGatewayAgents(local, env, transport.create).catch(
        (error) => error
      );
      expect((error as Error).message).not.toContain('secret');
      expect((error as Error).message).toMatch(/operator.read|authentication failed/);
      expect(transport.clients[0].stopAndWait).toHaveBeenCalled();
    }
  );

  it('bounds handshake time and cleans timers on timeout', async () => {
    vi.useFakeTimers();
    const transport = fake(() => {});
    const task = discoverGatewayAgents(local, env, transport.create).catch((error) => error);
    await vi.advanceTimersByTimeAsync(15000);
    expect(((await task) as Error).message).toContain('readiness timed out');
    expect(transport.clients[0].stopAndWait).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes after request failure and never retries or calls config.get', async () => {
    const transport = fake(() => {});
    const task = discoverGatewayAgents(local, env, transport.create);
    transport.clients[0].request.mockRejectedValue(new Error('private reply body'));
    transport.options[0].onHelloOk!({} as never);
    await expect(task).rejects.toThrow('connection or agents.list request failed');
    expect(transport.clients[0].request.mock.calls.map((call) => call[0])).toEqual(['agents.list']);
    expect(transport.clients[0].stopAndWait).toHaveBeenCalledTimes(1);
  });

  it('cleans up after synchronous start failure or pre-hello close', async () => {
    for (const start of [
      () => {
        throw new Error('secret');
      },
      (opts: GatewayClientOptions) => opts.onClose!(1006, 'secret'),
    ]) {
      const transport = fake(start);
      await expect(discoverGatewayAgents(local, env, transport.create)).rejects.toThrow(
        'connection or agents.list request failed'
      );
      expect(transport.clients[0].stopAndWait).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    'http://remote.example',
    'https://user:secret@gateway.example',
    'https://gateway.example/?token=secret',
    'file:///tmp/gateway',
  ])('rejects unsafe endpoint %s before constructing a client', async (url) => {
    const create = vi.fn();
    await expect(discoverGatewayAgents({ ...local, url }, env, create)).rejects.toThrow(
      'use HTTPS'
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('discovery device credentials', () => {
  it('keys persistent identity and tokens only by the full endpoint', async () => {
    const url = 'wss://gateway.example/path';
    const auth = gatewayDiscoveryAuth(url, env);
    const key = createHash('sha256')
      .update(JSON.stringify([url]))
      .digest('hex');
    expect(readdirSync(directory)).toEqual([key + '.identity.json']);
    await auth.hostDeps.storeDeviceAuthToken!({
      deviceId: auth.identity.deviceId,
      role: 'operator',
      token: 'test-device-token',
      scopes: ['operator.read'],
    });
    expect(readdirSync(directory).sort()).toEqual([key + '.identity.json', key + '.operator.json']);
    expect(gatewayDiscoveryAuth(url, env, { existingOnly: true }).identity).toEqual(auth.identity);
    expect(() => gatewayDiscoveryAuth(url + '/other', env, { existingOnly: true })).toThrow(
      'Approved device required'
    );
  });

  it('persists valid signing keys and scoped tokens without cross-endpoint reuse', async () => {
    const a = gatewayDiscoveryAuth('wss://a.example/', env);
    const b = gatewayDiscoveryAuth('wss://b.example/', env);
    expect(a.identity.deviceId).not.toBe(b.identity.deviceId);
    const signature = a.hostDeps.signDevicePayload!(a.identity.privateKeyPem, 'challenge');
    expect(
      verify(
        null,
        Buffer.from('challenge'),
        a.identity.publicKeyPem,
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
    await a.hostDeps.storeDeviceAuthToken!({
      deviceId: a.identity.deviceId,
      role: 'operator',
      token: 'device-secret',
      scopes: ['operator.read'],
      expectedToken: null,
    });
    const again = gatewayDiscoveryAuth('wss://a.example/', env);
    expect(again.identity).toEqual(a.identity);
    expect(again.hasToken).toBe(true);
    expect(
      await b.hostDeps.loadDeviceAuthToken!({ deviceId: b.identity.deviceId, role: 'operator' })
    ).toBeNull();
    expect(() =>
      a.hostDeps.loadDeviceAuthToken!({ deviceId: b.identity.deviceId, role: 'operator' })
    ).toThrow('scope mismatch');
    await a.hostDeps.clearDeviceAuthToken!({
      deviceId: a.identity.deviceId,
      role: 'operator',
      expectedToken: 'stale',
    });
    expect(gatewayDiscoveryAuth('wss://a.example/', env).hasToken).toBe(true);
    await a.hostDeps.clearDeviceAuthToken!({
      deviceId: a.identity.deviceId,
      role: 'operator',
      expectedToken: 'device-secret',
    });
    expect(gatewayDiscoveryAuth('wss://a.example/', env).hasToken).toBe(false);
    if (process.platform !== 'win32')
      for (const file of readdirSync(directory))
        expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  });

  it('reuses the stored token instead of a bootstrap token on subsequent discovery', async () => {
    const auth = gatewayDiscoveryAuth('ws://127.0.0.1:18789/', env);
    await auth.hostDeps.storeDeviceAuthToken!({
      deviceId: auth.identity.deviceId,
      role: 'operator',
      token: 'device-secret',
      scopes: ['operator.read'],
    });
    const transport = fake();
    await discoverGatewayAgents(local, env, transport.create);
    expect(transport.options[0].token).toBeUndefined();
    expect(
      await transport.options[0].hostDeps!.loadDeviceAuthToken!({
        deviceId: auth.identity.deviceId,
        role: 'operator',
      })
    ).toEqual({ token: 'device-secret', scopes: ['operator.read'] });
    expect(transport.options[0].scopes).toEqual(['operator.read']);
  });

  it('fails closed on corrupt identity instead of replacing it', () => {
    gatewayDiscoveryAuth('wss://a.example/', env);
    const path = join(directory, readdirSync(directory)[0]);
    writeFileSync(path, '{}');
    expect(() => gatewayDiscoveryAuth('wss://a.example/', env)).toThrow(
      'Invalid discovery identity'
    );
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects public permissions and symlinked identity',
    () => {
      gatewayDiscoveryAuth('wss://a.example/', env);
      const path = join(directory, readdirSync(directory)[0]);
      chmodSync(path, 0o644);
      expect(() => gatewayDiscoveryAuth('wss://a.example/', env)).toThrow('private');
      chmodSync(path, 0o600);
      const copy = path + '.copy';
      writeFileSync(copy, readFileSync(path), { mode: 0o600 });
      rmSync(path);
      symlinkSync(copy, path);
      expect(() => gatewayDiscoveryAuth('wss://a.example/', env)).toThrow();
    }
  );
});

describe('model RPC grants', () => {
  it('negotiates model selection policy and agent scope with read access', async () => {
    const transport = fake(undefined, { models: [] });
    await gatewayModelRequest(
      local,
      { method: 'models.list', params: { agentId: 'writer', view: 'configured' } },
      env,
      transport.create
    );
    expect(transport.options[0]).toMatchObject({
      caps: ['model-selection-policy'],
      scopes: ['operator.read'],
    });
    expect(transport.clients[0].request).toHaveBeenCalledWith(
      'models.list',
      { agentId: 'writer', view: 'configured' },
      { timeoutMs: 30000 }
    );
  });
  it('requests write for session selection and permits shared tokens only on literal loopback', async () => {
    const transport = fake(undefined, { ok: true });
    const request = {
      method: 'sessions.patch' as const,
      params: { key: 'agent:main:mcp:new', model: 'p/m' },
    };
    await gatewayModelRequest(
      local,
      request,
      { ...env, MCP_MODEL_AUTH: 'local-shared-token' },
      transport.create
    );
    expect(transport.options[0]).toMatchObject({
      token: local.token,
      scopes: ['operator.read', 'operator.write'],
    });
    await expect(
      gatewayModelRequest(
        { ...local, url: 'https://remote.example' },
        request,
        { ...env, MCP_MODEL_AUTH: 'local-shared-token' },
        transport.create
      )
    ).rejects.toThrow('literal loopback');
  });
});
