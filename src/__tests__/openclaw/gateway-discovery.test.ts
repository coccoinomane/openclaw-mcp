import { Buffer } from 'node:buffer';
import { verify } from 'node:crypto';
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
  type DiscoveryClientFactory,
} from '../../openclaw/gateway-discovery.js';
import { gatewayDiscoveryAuth } from '../../openclaw/gateway-discovery-auth.js';
import { loadAgentCatalog } from '../../openclaw/agent-catalog.js';
import { InstanceRegistry } from '../../openclaw/registry.js';

let directory: string;
let env: NodeJS.ProcessEnv;
const local = {
  name: 'local',
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
    const configs = await loadAgentCatalog([{ ...local, bindings }], env, (config, environment) =>
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
    expect(configs[0].agents).toEqual([{ id: 'main' }, { id: 'writer' }]);
    expect(configs[0].bindings).toEqual(bindings);
    const registry = new InstanceRegistry(configs);
    expect(registry.resolve().agentId).toBe('main');
    expect(registry.listAgents()).toEqual([
      { instance: 'local', agentId: 'main', isDefault: true },
      { instance: 'local', agentId: 'writer', isDefault: false },
    ]);
    expect(JSON.stringify(registry.listAgents())).not.toMatch(
      /private|never-return|bootstrap-secret|selectionRequired/
    );
  });

  it('waits for hello before any RPC and leaves absent bindings absent', async () => {
    const transport = fake(() => {});
    const task = discoverGatewayAgents(local, env, transport.create);
    expect(transport.clients[0].request).not.toHaveBeenCalled();
    transport.options[0].onHelloOk!({} as never);
    await task;
    const configs = await loadAgentCatalog([local], env, async () => roster);
    expect(configs[0]).not.toHaveProperty('bindings');
  });

  it('isolates connections, device identities and credentials for two Gateways', async () => {
    const transport = fake();
    const remote = { name: 'remote', url: 'https://gateway.example', token: 'remote-secret' };
    const configs = await loadAgentCatalog([local, remote], env, (config, environment) =>
      discoverGatewayAgents(config, environment, transport.create)
    );
    expect(configs).toHaveLength(2);
    expect(transport.options.map((o) => o.url)).toEqual([
      'ws://127.0.0.1:18789/',
      'wss://gateway.example/',
    ]);
    expect(transport.options.map((o) => o.token)).toEqual(['bootstrap-secret', 'remote-secret']);
    expect(transport.options[0].deviceIdentity!.deviceId).not.toBe(
      transport.options[1].deviceIdentity!.deviceId
    );
    for (const client of transport.clients) {
      expect(client.request).toHaveBeenCalledTimes(1);
      expect(client.stopAndWait).toHaveBeenCalledTimes(1);
    }
  });

  it('fails the whole startup for one failed instance and awaits every cleanup', async () => {
    const transport = fake((opts) => {
      if (opts.url!.includes('gateway.example'))
        opts.onConnectError!(new Error('secret upstream failure'));
      else opts.onHelloOk!({} as never);
    });
    const task = loadAgentCatalog(
      [local, { name: 'remote', url: 'https://gateway.example', token: 'other' }],
      env,
      (config, environment) => discoverGatewayAgents(config, environment, transport.create)
    );
    await expect(task).rejects.toThrow(
      'instance "remote": connection or agents.list request failed'
    );
    for (const client of transport.clients) expect(client.stopAndWait).toHaveBeenCalledTimes(1);
    expect(transport.clients[1].request).not.toHaveBeenCalled();
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
  it('persists valid signing keys and scoped tokens without cross-instance reuse', async () => {
    const a = gatewayDiscoveryAuth('a', 'wss://a.example/', env);
    const b = gatewayDiscoveryAuth('b', 'wss://a.example/', env);
    const c = gatewayDiscoveryAuth('a', 'wss://b.example/', env);
    expect(new Set([a.identity.deviceId, b.identity.deviceId, c.identity.deviceId]).size).toBe(3);
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
    const again = gatewayDiscoveryAuth('a', 'wss://a.example/', env);
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
    expect(gatewayDiscoveryAuth('a', 'wss://a.example/', env).hasToken).toBe(true);
    await a.hostDeps.clearDeviceAuthToken!({
      deviceId: a.identity.deviceId,
      role: 'operator',
      expectedToken: 'device-secret',
    });
    expect(gatewayDiscoveryAuth('a', 'wss://a.example/', env).hasToken).toBe(false);
    if (process.platform !== 'win32')
      for (const file of readdirSync(directory))
        expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  });

  it('reuses the stored token instead of a bootstrap token on subsequent discovery', async () => {
    const auth = gatewayDiscoveryAuth(local.name, 'ws://127.0.0.1:18789/', env);
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
    gatewayDiscoveryAuth('a', 'wss://a.example/', env);
    const path = join(directory, readdirSync(directory)[0]);
    writeFileSync(path, '{}');
    expect(() => gatewayDiscoveryAuth('a', 'wss://a.example/', env)).toThrow(
      'Invalid discovery identity'
    );
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects public permissions and symlinked identity',
    () => {
      gatewayDiscoveryAuth('a', 'wss://a.example/', env);
      const path = join(directory, readdirSync(directory)[0]);
      chmodSync(path, 0o644);
      expect(() => gatewayDiscoveryAuth('a', 'wss://a.example/', env)).toThrow('private');
      chmodSync(path, 0o600);
      const copy = path + '.copy';
      writeFileSync(copy, readFileSync(path), { mode: 0o600 });
      rmSync(path);
      symlinkSync(copy, path);
      expect(() => gatewayDiscoveryAuth('a', 'wss://a.example/', env)).toThrow();
    }
  );
});
