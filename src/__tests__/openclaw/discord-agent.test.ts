import {
  GatewayProtocolClient,
  type GatewayProtocolSocketHandlers,
} from '@openclaw/gateway-client/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import {
  validateAgentParams,
  validateAgentWaitParams,
  validateChatAbortParams,
} from '@openclaw/gateway-protocol';
import { discordAgentTransport, type AgentClientFactory } from '../../openclaw/discord-agent.js';
import { gatewayDiscoveryAuth } from '../../openclaw/gateway-discovery-auth.js';
import type { DiscordConfig } from '../../openclaw/discord.js';
const dirs: string[] = [];
const input = {
  message: '  exact prompt 😀\n',
  agentId: 'main',
  sessionKey: 'agent:main:discord:channel:400000000000000003',
  threadId: '400000000000000003',
  accountId: 'bot',
  idempotencyKey: 'operation-run-key',
};
const accepted = {
  runId: 'authoritative-run',
  sessionKey: input.sessionKey,
  agentId: input.agentId,
  status: 'accepted',
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  // Fixtures use in-memory clients; never remove provenance for a live connection.
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(grant: string[] | null = ['operator.read', 'operator.write']) {
  const dir = await mkdtemp(join(tmpdir(), 'discord-agent-'));
  dirs.push(dir);
  const config: DiscordConfig = {
    stateDir: dir,
    executable: 'never',
    targets: [],
    agentTransport: 'sdk',
    cliGatewayInstance: 'home',
  };
  const env = { MCP_DISCORD_SDK_STATE_DIR: dir };
  const auth = gatewayDiscoveryAuth('home', 'ws://127.0.0.1:18789/', {
    MCP_AGENT_DISCOVERY_STATE_DIR: dir,
  });
  if (grant)
    await auth.hostDeps.storeDeviceAuthToken!({
      deviceId: auth.identity.deviceId,
      role: 'operator',
      token: 'fixture-not-a-credential',
      scopes: grant,
    });
  const calls: Array<{ method: string; params: any; options: any }> = [];
  const options: any[] = [];
  const stops = vi.fn(async () => undefined);
  let helloScopes = ['operator.read', 'operator.write'];
  let handler: (method: string, params: any, options: any) => Promise<any> = async () => ({
    status: 'ok',
    runId: accepted.runId,
  });
  const factory: AgentClientFactory = vi.fn((opts) => {
    options.push(opts);
    return {
      start() {
        opts.onHelloOk!({ auth: { scopes: helloScopes } } as any);
      },
      request: vi.fn(async (method, params, opts) => {
        calls.push({ method, params, options: opts });
        return handler(method, params, opts);
      }),
      stopAndWait: stops,
    };
  });
  const make = (
    overrides = env,
    list = [
      { name: 'home', url: 'http://127.0.0.1:18789', token: 'must-not-use-shared-admin-token' },
    ]
  ) => discordAgentTransport(list, config, overrides, factory)!;
  return {
    dir,
    config,
    auth,
    make,
    transport: make(),
    calls,
    options,
    stops,
    factory,
    handler: (fn: typeof handler) => {
      handler = fn;
    },
    hello: (scopes: string[]) => {
      helloScopes = scopes;
    },
  };
}
describe('SDK service authentication', () => {
  it.each([{ grant: null }, { grant: ['operator.read'] }, { grant: ['operator.admin'] }])(
    'requires an explicitly provisioned read/write device grant %j',
    async ({ grant }) => {
      const f = await fixture(grant);
      await expect(f.transport.ready()).rejects.toThrow('SDK_APPROVED_DEVICE_REQUIRED');
      expect(f.factory).not.toHaveBeenCalled();
    }
  );
  it('does not generate keys or pair when state is missing', async () => {
    const f = await fixture();
    await expect(
      f.make({ MCP_DISCORD_SDK_STATE_DIR: join(f.dir, 'absent') }).ready()
    ).rejects.toThrow('SDK_APPROVED_DEVICE_REQUIRED');
    expect(await readdir(f.dir)).toHaveLength(2);
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('uses backend identity, only explicit service scopes, and verifies granted hello scopes', async () => {
    const f = await fixture();
    await f.transport.ready();
    expect(f.options[0]).toMatchObject({
      clientName: 'gateway-client',
      mode: 'backend',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      role: 'operator',
    });
    expect(f.options[0].token).toBeUndefined();
    expect(f.options[0].deviceIdentity.deviceId).toBe(f.auth.identity.deviceId);
    expect(f.stops).toHaveBeenCalledTimes(1);
    f.hello(['operator.read']);
    await expect(f.transport.ready()).rejects.toThrow('SDK_SCOPE_DENIED');
    expect(f.calls).toHaveLength(0);
  });
  it.each(['OPENCLAW_SHELL', 'OPENCLAW_AGENT_ID', 'OPENCLAW_SESSION_KEY', 'OPENCLAW_CALLER_ID'])(
    'preserves %s provenance denial',
    async (key) => {
      const f = await fixture();
      vi.stubEnv(key, 'agent-origin');
      await expect(f.transport.run(input, vi.fn())).rejects.toThrow('AGENT_PROVENANCE_DENIED');
      expect(f.factory).not.toHaveBeenCalled();
      expect(process.env[key]).toBe('agent-origin');
    }
  );
  it.each([
    'http://remote.invalid',
    'https://user:secret@host.invalid',
    'https://host.invalid/?token=x',
  ])('denies unsafe endpoint %s', async (url) => {
    const f = await fixture();
    expect(() => f.make(undefined, [{ name: 'home', url, token: '' }])).toThrow(
      'INSECURE_GATEWAY_URL'
    );
  });
});
describe('SDK agent lifecycle', () => {
  it('maps exact CLI routing/history parameters and waits for durable acceptance before final handling', async () => {
    const f = await fixture();
    const persist = deferred<void>();
    const capture = vi.fn(() => persist.promise);
    f.handler(async (_m, _p, opts) => {
      opts.onAccepted(accepted);
      return { status: 'ok', runId: accepted.runId, result: { deliveryStatus: 'sent' } };
    });
    let complete = false;
    const run = f.transport.run(input, capture).then((x) => {
      complete = true;
      return x;
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(complete).toBe(false);
    expect(f.calls[0].params).toEqual({
      message: input.message,
      agentId: 'main',
      sessionKey: input.sessionKey,
      deliver: true,
      replyChannel: 'discord',
      replyTo: 'channel:' + input.threadId,
      replyAccountId: 'bot',
      timeout: 600,
      idempotencyKey: input.idempotencyKey,
    });
    expect(validateAgentParams(f.calls[0].params)).toBe(true);
    expect(f.calls[0].params).not.toHaveProperty('sessionId');
    expect(f.calls[0].params).not.toHaveProperty('conversationReadOrigin');
    expect(f.calls[0].options).toMatchObject({ expectFinal: true, timeoutMs: 630000 });
    persist.resolve();
    expect((await run).status).toBe('ok');
  });
  it.each(['FORBIDDEN', 'INVALID_REQUEST'])('does not replay denied admission %s', async (code) => {
    const f = await fixture();
    f.handler(async () => {
      throw new GatewayClientRequestError({ code, message: 'private server detail' });
    });
    await expect(f.transport.run(input, vi.fn())).rejects.toMatchObject({
      code: 'SDK_REQUEST_REJECTED',
      uncertain: false,
    });
    expect(f.calls.map((c) => c.method)).toEqual(['agent']);
  });
  it('sanitizes synchronous client construction failure without leaking a readiness timer', async () => {
    const f = await fixture();
    vi.mocked(f.factory).mockImplementationOnce(() => {
      throw new Error('private detail');
    });
    await expect(f.transport.ready()).rejects.toThrow('SDK_CONNECT_FAILED');
    expect(f.calls).toHaveLength(0);
  });
  it('keeps an unavailable response uncertain before acceptance', async () => {
    const f = await fixture();
    f.handler(async () => {
      throw new GatewayClientRequestError({ code: 'UNAVAILABLE', message: 'private detail' });
    });
    await expect(f.transport.run(input, vi.fn())).rejects.toMatchObject({
      code: 'SDK_REQUEST_REJECTED',
      uncertain: true,
    });
    expect(f.calls).toHaveLength(1);
  });
  it('does not treat an admission-pending duplicate as an accepted run', async () => {
    const f = await fixture();
    const capture = vi.fn();
    f.handler(async () => ({ ...accepted, status: 'in_flight', admissionPending: true }));
    await expect(f.transport.run(input, capture)).rejects.toThrow('SDK_ACCEPTANCE_UNCONFIRMED');
    expect(capture).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(1);
  });
  it('never replays a disconnect before acceptance', async () => {
    const f = await fixture();
    f.handler(async () => {
      throw new Error('socket closed');
    });
    await expect(f.transport.run(input, vi.fn())).rejects.toMatchObject({
      code: 'SDK_OUTCOME_UNKNOWN',
      uncertain: true,
    });
    expect(f.calls.map((c) => c.method)).toEqual(['agent']);
  });
  it.each(['disconnect', 'in_flight'])(
    'observes the same owned run after %s, without redispatch',
    async (scenario) => {
      const f = await fixture();
      const capture = vi.fn(async () => undefined);
      f.handler(async (method, _p, opts) => {
        if (method === 'agent') {
          if (scenario === 'in_flight') return { ...accepted, status: 'in_flight' };
          opts.onAccepted(accepted);
          throw new Error('socket closed');
        }
        expect(capture).toHaveBeenCalledTimes(1);
        return { runId: accepted.runId, status: 'ok', terminalDelivery: { status: 'sent' } };
      });
      expect(await f.transport.run(input, capture)).toMatchObject({
        status: 'ok',
        deliveryStatus: { status: 'sent' },
      });
      expect(f.calls.map((c) => c.method)).toEqual(['agent', 'agent.wait']);
      expect(f.calls[1].params).toMatchObject({ runId: accepted.runId });
      expect(validateAgentWaitParams(f.calls[1].params)).toBe(true);
    }
  );
  it('does not equate queued observations with completion or poll them without delay', async () => {
    const f = await fixture();
    let observed = 0;
    f.handler(async (method) =>
      method === 'agent'
        ? { ...accepted, status: 'in_flight' }
        : { runId: accepted.runId, status: ++observed === 1 ? 'pending' : 'ok' }
    );
    const run = f.transport.run(
      input,
      vi.fn(async () => undefined)
    );
    await vi.waitFor(() => expect(observed).toBe(1));
    expect(f.calls).toHaveLength(2);
    expect((await run).status).toBe('ok');
    expect(observed).toBe(2);
  });
  it.each([{ sessionKey: 'wrong' }, { agentId: 'other' }, { runId: '' }])(
    'fails closed on acceptance mismatch %j',
    async (override) => {
      const f = await fixture();
      const capture = vi.fn();
      f.handler(async (_m, _p, opts) => {
        opts.onAccepted({ ...accepted, ...override });
        return { status: 'ok' };
      });
      await expect(f.transport.run(input, capture)).rejects.toThrow('SDK_ACCEPTANCE_UNCONFIRMED');
      expect(capture).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(1);
    }
  );
  it('does not observe or replay when receipt persistence fails', async () => {
    const f = await fixture();
    f.handler(async (_m, _p, opts) => {
      opts.onAccepted(accepted);
      throw new Error('close');
    });
    await expect(
      f.transport.run(input, async () => {
        throw new Error('disk');
      })
    ).rejects.toThrow('SDK_ACCEPTANCE_UNCONFIRMED');
    expect(f.calls).toHaveLength(1);
  });
  it('keeps observation denial uncertain and sanitizes server details', async () => {
    const f = await fixture();
    f.handler(async (m) => {
      if (m === 'agent') return { ...accepted, status: 'in_flight' };
      throw new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'secret' });
    });
    await expect(
      f.transport.run(
        input,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({ code: 'SDK_REQUEST_REJECTED', uncertain: true });
    expect(f.calls.map((c) => c.method)).toEqual(['agent', 'agent.wait']);
  });
  it('rejects mismatched final or observed run identity', async () => {
    const f = await fixture();
    f.handler(async (_m, _p, opts) => {
      opts.onAccepted(accepted);
      return { status: 'ok', runId: 'other' };
    });
    await expect(
      f.transport.run(
        input,
        vi.fn(async () => undefined)
      )
    ).rejects.toThrow('SDK_RESULT_IDENTITY_MISMATCH');
  });
  it('cancels the exact accepted run explicitly; closing the client alone never aborts', async () => {
    const f = await fixture();
    f.handler(async () => ({ ok: true, aborted: true, runIds: [accepted.runId] }));
    await f.transport.cancel(accepted);
    expect(f.calls.map((c) => c.method)).toEqual(['chat.abort']);
    expect(f.calls[0].params).toEqual({
      runId: accepted.runId,
      sessionKey: accepted.sessionKey,
      agentId: accepted.agentId,
    });
    expect(validateChatAbortParams(f.calls[0].params)).toBe(true);
  });
  it.each([
    { ok: true, aborted: false, runIds: [] },
    { ok: true, aborted: true, runIds: ['other'] },
    { ok: true, aborted: true },
  ])('does not claim unconfirmed cancellation %j', async (value) => {
    const f = await fixture();
    f.handler(async () => value);
    await expect(f.transport.cancel(accepted)).rejects.toThrow('SDK_CANCEL_UNCONFIRMED');
    expect(f.calls).toHaveLength(1);
  });
});

describe('official SDK protocol with an in-memory socket', () => {
  it.each(['final', 'disconnect', 'in_flight'])(
    'handles %s frames without treating acceptance as completion',
    async (scenario) => {
      const f = await fixture();
      const frames: any[] = [];
      const persist = vi.fn(async () => undefined);
      const factory: AgentClientFactory = (options) => {
        let handlers!: GatewayProtocolSocketHandlers;
        let opened = false;
        let seq = 0;
        const respond = (id: string, payload: unknown) =>
          handlers.message(JSON.stringify({ type: 'res', id, ok: true, payload }));
        const protocol = new GatewayProtocolClient({
          createSocket: (h) => {
            handlers = h;
            return {
              isOpen: () => opened,
              send(data) {
                const frame = JSON.parse(data);
                frames.push(frame);
                queueMicrotask(() => {
                  if (frame.method === 'connect')
                    respond(frame.id, {
                      type: 'hello-ok',
                      protocol: 4,
                      server: { version: 'fixture', connId: 'fixture' },
                      features: { methods: ['agent', 'agent.wait'], events: [] },
                      snapshot: {},
                      auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
                      policy: {
                        maxPayload: 1000000,
                        maxBufferedBytes: 1000000,
                        tickIntervalMs: 30000,
                      },
                    });
                  else if (frame.method === 'agent.wait')
                    respond(frame.id, { runId: accepted.runId, status: 'ok' });
                  else if (frame.method === 'agent') {
                    respond(frame.id, {
                      ...accepted,
                      status: scenario === 'in_flight' ? 'in_flight' : 'accepted',
                    });
                    if (scenario === 'final')
                      queueMicrotask(() =>
                        respond(frame.id, { status: 'ok', runId: accepted.runId })
                      );
                    if (scenario === 'disconnect') {
                      opened = false;
                      handlers.close(1006, 'fixture disconnect');
                    }
                  }
                });
              },
              close(code = 1000, reason = '') {
                opened = false;
                handlers.close(code, reason);
              },
            };
          },
          createRequestId: () => String(++seq),
          createRequestError: (error) => new GatewayClientRequestError(error),
          buildConnectPlan: () => ({}),
          buildConnectParams: () => ({
            minProtocol: 4,
            maxProtocol: 4,
            client: {
              id: 'gateway-client',
              mode: 'backend',
              version: 'fixture',
              platform: 'fixture',
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write'],
          }),
          onHello: (hello) => options.onHelloOk!(hello),
          resolveClose: () => ({ retry: false, notify: true }),
          handshake: { mode: 'require-challenge', timeoutMs: 1000 },
          reconnect: { initialMs: 10, multiplier: 2, maxMs: 50 },
          requestTimeoutMs: 1000,
        });
        return {
          start() {
            protocol.start();
            opened = true;
            handlers.open();
            handlers.message(
              JSON.stringify({
                type: 'event',
                event: 'connect.challenge',
                payload: { nonce: 'fixture', ts: Date.now() },
              })
            );
          },
          request: (method, params, opts) => protocol.request(method, params, opts),
          async stopAndWait() {
            protocol.stop();
          },
        };
      };
      const transport = discordAgentTransport(
        [{ name: 'home', url: 'http://127.0.0.1:18789' }],
        f.config,
        { MCP_DISCORD_SDK_STATE_DIR: f.dir },
        factory
      )!;
      expect(await transport.run(input, persist)).toMatchObject({
        status: 'ok',
        runId: accepted.runId,
      });
      expect(persist).toHaveBeenCalledTimes(1);
      expect(frames.filter((frame) => frame.method === 'agent')).toHaveLength(1);
      expect(frames.filter((frame) => frame.method === 'agent.wait')).toHaveLength(
        scenario === 'final' ? 0 : 1
      );
      expect(frames.filter((frame) => frame.method === 'chat.abort')).toHaveLength(0);
    }
  );
});
