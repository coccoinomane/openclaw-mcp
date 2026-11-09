import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscordService, loadDiscordConfig, type DiscordConfig } from '../../openclaw/discord.js';
import { channelReader } from '../../openclaw/discord-read.js';
import { threadInvoker } from '../../openclaw/discord-thread.js';
import { DiscordError } from '../../openclaw/discord-channels.js';
import type {
  DiscordAgentTransport,
  DiscordAgentRequest,
  AgentReceipt,
} from '../../openclaw/discord-agent.js';
const guild = '400000000000000001',
  parent = '400000000000000002',
  thread = '400000000000000003',
  message = '400000000000000004';
const target = {
  name: 'work',
  guildId: guild,
  channelId: parent,
  accountId: 'bot',
  agentId: 'main',
  normalRouting: true,
};
const input = {
  mode: 'new_thread',
  target: 'work',
  title: 'Task',
  operation_id: 'sdk-operation-0001',
  prompt: '  original @everyone 😀\n  ',
};
const reply = {
  target: 'work',
  channel_id: thread,
  operation_id: input.operation_id,
  prompt: input.prompt,
};
const instances = [{ name: 'home', url: 'http://127.0.0.1:18789', token: 'fixture-only' }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const fixtures: Array<{
  dir: string;
  service: DiscordService;
  generation: ReturnType<typeof deferred<any>>;
}> = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.generation.resolve({ status: 'ok' });
    await f.service.drain();
    await rm(f.dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(archived = false) {
  const dir = await mkdtemp(join(tmpdir(), 'discord-sdk-workflow-'));
  const config: DiscordConfig = {
    executable: '/does-not-exist',
    stateDir: dir,
    targets: [target],
    cliGatewayInstance: 'home',
    gatewayReadsEnabled: true,
    threadCreateMode: 'gateway',
    agentTransport: 'sdk',
    acknowledgeInboundRouting: true,
    threadMember: { userId: '400000000000000006', accountId: 'bot' },
  };
  const events: string[] = [];
  const metadata = (id: string) => ({
    id,
    guild_id: guild,
    parent_id: id === parent ? undefined : parent,
    name: id === parent ? 'Work' : 'Conversation',
    type: id === parent ? 0 : 11,
    thread_metadata: { locked: false, archived },
  });
  const fetcher = vi.fn(async (_url: any, options: any) => {
    const args = JSON.parse(options.body).args;
    events.push(args.action);
    let result: any = {};
    if (args.action === 'channel-list') result = { channels: [metadata(parent)] };
    if (args.action === 'channel-info') result = { channel: metadata(args.channelId) };
    if (args.action === 'thread-list') result = { threads: [metadata(thread)], has_more: false };
    if (args.action === 'thread-create') result = { thread: { id: thread } };
    if (args.action === 'permissions')
      result = {
        permissions: {
          channelId: thread,
          guildId: guild,
          channelType: 11,
          isDm: false,
          permissions: [
            'ViewChannel',
            'SendMessagesInThreads',
            'ReadMessageHistory',
            'AttachFiles',
          ],
        },
      };
    if (args.action === 'read')
      result = { channelId: thread, messages: [{ id: message, channel_id: thread }] };
    return new Response(JSON.stringify({ ok: true, result: { details: { ok: true, ...result } } }));
  });
  const generation = deferred<any>();
  const started = deferred<void>();
  const runner = vi.fn(async () => {
    throw new Error('CLI must never execute');
  });
  const agent = {
    ready: vi.fn(async () => {
      events.push('ready');
    }),
    run: vi.fn(
      async (request: DiscordAgentRequest, accepted: (receipt: AgentReceipt) => Promise<void>) => {
        events.push('agent');
        const record = JSON.parse(await readFile(join(dir, input.operation_id + '.json'), 'utf8'));
        expect(record.agent_idempotency_key).toBe(request.idempotencyKey);
        await accepted({
          runId: 'owned-run',
          sessionKey: request.sessionKey,
          agentId: request.agentId,
        });
        started.resolve();
        return generation.promise;
      }
    ),
    cancel: vi.fn(async (_receipt: AgentReceipt) => undefined),
  } satisfies DiscordAgentTransport;
  const member = vi.fn(async () => {
    events.push('member');
  });
  const publish = vi.fn(
    async (_t: any, _id: string, _p: string, _op: string, sent: (id: string) => Promise<void>) => {
      events.push('publish');
      await sent(message);
    }
  );
  const make = () =>
    new DiscordService(
      config,
      runner,
      undefined,
      undefined,
      channelReader(instances, config, fetcher),
      threadInvoker(instances, config, fetcher),
      member,
      publish,
      agent
    );
  const service = make();
  const f = {
    dir,
    service,
    config,
    fetcher,
    generation,
    started,
    runner,
    agent,
    member,
    publish,
    make,
    events,
  };
  fixtures.push(f);
  return f;
}
describe('SDK opt-in and rollback', () => {
  it('keeps CLI default and rejects incomplete SDK opt-in', () => {
    const env = {
      MCP_DISCORD_ENABLED: 'true',
      MCP_DISCORD_STATE_DIR: '/fixture',
      MCP_DISCORD_TARGETS: JSON.stringify([target]),
    };
    expect(loadDiscordConfig(env)?.agentTransport).toBe('cli');
    expect(() => loadDiscordConfig({ ...env, MCP_DISCORD_AGENT_TRANSPORT: 'automatic' })).toThrow(
      'AGENT_TRANSPORT_INVALID'
    );
    expect(() => loadDiscordConfig({ ...env, MCP_DISCORD_AGENT_TRANSPORT: 'sdk' })).toThrow(
      'SDK_REQUIRES_GATEWAY_READS_AND_CREATE'
    );
    expect(
      loadDiscordConfig({
        ...env,
        MCP_DISCORD_AGENT_TRANSPORT: 'sdk',
        MCP_DISCORD_THREAD_CREATE_MODE: 'gateway',
        MCP_DISCORD_GATEWAY_READS_ENABLED: 'true',
        MCP_DISCORD_CLI_GATEWAY_INSTANCE: 'home',
      })?.agentTransport
    ).toBe('sdk');
  });
  it('requires the SDK and read adapters rather than falling back to CLI', async () => {
    const f = await fixture();
    expect(() => new DiscordService(f.config, f.runner)).toThrow('SDK_ADAPTER_REQUIRED');
  });
});
describe('ordinary Discord workflows without subprocesses', () => {
  it.each(['new', 'existing', 'archived'])(
    'handles %s thread with exact route, original prompt, async handoff and no CLI',
    async (kind) => {
      const f = await fixture(kind === 'archived');
      expect((await f.service.channels()).channels[0]).toMatchObject({
        target: 'work',
        channel_id: parent,
      });
      expect((await f.service.threads({ target: 'work' })).threads[0].channel_id).toBe(thread);
      const result = kind === 'new' ? await f.service.ask(input) : await f.service.reply(reply);
      expect(result).toMatchObject({
        status: 'queued',
        request_verified: true,
        agent_transport: 'sdk',
        channel_id: thread,
      });
      expect(f.agent.run).not.toHaveBeenCalled();
      await f.started.promise;
      expect(f.agent.run.mock.calls[0][0]).toEqual({
        message: input.prompt,
        agentId: 'main',
        sessionKey: 'agent:main:discord:channel:' + thread,
        threadId: thread,
        accountId: 'bot',
        idempotencyKey: result.agent_idempotency_key,
      });
      expect(f.publish.mock.calls[0].slice(1, 4)).toEqual([
        thread,
        input.prompt,
        input.operation_id,
      ]);
      expect(f.events.indexOf('ready')).toBeLessThan(f.events.indexOf('publish'));
      expect(f.events.indexOf('publish')).toBeLessThan(f.events.indexOf('agent'));
      if (kind === 'new') {
        expect(f.events.indexOf('ready')).toBeLessThan(f.events.indexOf('thread-create'));
        expect(f.member).toHaveBeenCalledOnce();
      } else {
        expect(f.member).not.toHaveBeenCalled();
        expect(f.events).not.toContain('thread-create');
      }
      expect(await f.service.status(input.operation_id)).toMatchObject({
        status: 'running',
        generation_status: 'accepted',
        run_id: 'owned-run',
      });
      expect(
        kind === 'new' ? await f.service.ask(input) : await f.service.reply(reply)
      ).toMatchObject({ status: 'running' });
      f.generation.resolve({
        status: 'ok',
        runId: 'owned-run',
        result: { deliveryStatus: { status: 'sent', messageId: message } },
      });
      await f.service.drain();
      expect(await f.service.status(input.operation_id)).toMatchObject({
        status: 'completed',
        delivery_verified: true,
        message_id: message,
      });
      const read = f.fetcher.mock.calls
        .map((c) => JSON.parse(c[1].body))
        .find((b) => b.args.action === 'read');
      expect(read.args).toMatchObject({
        accountId: 'bot',
        channelId: thread,
        messageId: message,
        limit: 1,
      });
      expect(read).not.toHaveProperty('conversationReadOrigin');
      expect(read.args).not.toHaveProperty('conversationReadOrigin');
      expect(f.runner).not.toHaveBeenCalled();
      expect(f.agent.run).toHaveBeenCalledOnce();
      expect(f.publish).toHaveBeenCalledOnce();
      expect(await readFile(join(f.dir, input.operation_id + '.json'), 'utf8')).not.toContain(
        input.prompt
      );
    }
  );
  it.each([
    '2026-11-01T12:30:00.000Z',
    '2026-11-02T18:34:47.544000+00:00',
    '2026-11-01T13:30:00.000+01:00',
    '2026-11-01T07:30:00.000-05:00',
  ])('preserves archived thread timestamp cursor %s', async (before) => {
    const f = await fixture();
    await f.service.threads({ target: 'work', archived: true, before, limit: 10 });
    const args = JSON.parse(f.fetcher.mock.calls.at(-1)![1].body).args;
    expect(args).toEqual({
      action: 'thread-list',
      channel: 'discord',
      accountId: 'bot',
      guildId: guild,
      channelId: parent,
      includeArchived: true,
      before,
      limit: 10,
    });
    await expect(f.service.threads({ target: 'work', before })).rejects.toThrow('Pagination');
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('blocks lack of SDK authority before creation, member-add or publication', async () => {
    const f = await fixture();
    f.agent.ready.mockRejectedValue(new DiscordError('SDK_APPROVED_DEVICE_REQUIRED'));
    expect(await f.service.ask(input)).toMatchObject({
      status: 'run_failed',
      error_code: 'SDK_APPROVED_DEVICE_REQUIRED',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.member).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429])(
    'fails closed on HTTP preflight %i without CLI fallback',
    async (status) => {
      const f = await fixture();
      f.fetcher.mockResolvedValue(new Response('private detail', { status }));
      expect(await f.service.reply(reply)).toMatchObject({
        status: 'run_failed',
        error_code: 'GATEWAY_HTTP_' + status,
      });
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.agent.run).not.toHaveBeenCalled();
      expect(f.runner).not.toHaveBeenCalled();
    }
  );
  it('never falls back to CLI thread creation even on a proven connection refusal in SDK mode', async () => {
    const f = await fixture();
    const read = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (...args) => {
      if (JSON.parse(args[1].body).args.action === 'thread-create')
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      return read(...args);
    });
    expect(await f.service.ask(input)).toMatchObject({
      status: 'creation_unknown',
      error_code: 'THREAD_GATEWAY_UNREACHABLE',
      thread_create_transport: 'gateway',
    });
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('retains policy denials, route assertions and imported binding checks', async () => {
    const f = await fixture();
    f.config.channelBlacklist = [thread];
    expect(await f.service.reply(reply)).toMatchObject({
      status: 'run_failed',
      error_code: 'CHANNEL_POLICY_DENIED',
    });
    expect(f.agent.run).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    await expect(
      f.service.reply({ ...reply, agent_id: 'other', operation_id: 'sdk-operation-0002' })
    ).rejects.toThrow('ROUTE_SELECTOR_CONFLICT');
    f.config.importedRouteAgent = () => undefined;
    await expect(f.service.reply({ ...reply, operation_id: 'sdk-operation-0003' })).rejects.toThrow(
      'IMPORTED_ROUTE_UNMAPPED'
    );
  });
  it('does not dispatch when a verified thread lacks send permissions', async () => {
    const f = await fixture();
    const read = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (...args) => {
      if (JSON.parse(args[1].body).args.action === 'permissions')
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              details: {
                ok: true,
                permissions: {
                  channelId: thread,
                  guildId: guild,
                  channelType: 11,
                  isDm: false,
                  permissions: ['ViewChannel'],
                },
              },
            },
          })
        );
      return read(...args);
    });
    expect(await f.service.reply(reply)).toMatchObject({
      status: 'run_failed',
      error_code: 'THREAD_PERMISSIONS_DENIED',
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it('keeps uncertain SDK dispatch and restart read-only across explicit CLI rollback', async () => {
    const f = await fixture();
    f.agent.run.mockRejectedValue(new DiscordError('SDK_OUTCOME_UNKNOWN', true));
    await f.service.reply(reply);
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'run_unknown',
      error_code: 'SDK_OUTCOME_UNKNOWN',
    });
    const before = await readFile(join(f.dir, input.operation_id + '.json'), 'utf8');
    f.config.agentTransport = 'cli';
    const restarted = f.make();
    expect(await restarted.reply(reply)).toMatchObject({
      status: 'run_unknown',
      agent_transport: 'sdk',
    });
    expect(await readFile(join(f.dir, input.operation_id + '.json'), 'utf8')).toBe(before);
    expect((await readdir(f.dir)).some((name) => name.endsWith('.lock'))).toBe(true);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.agent.run).toHaveBeenCalledOnce();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('persists denied agent admission as failed and keeps publication evidence', async () => {
    const f = await fixture();
    f.agent.run.mockRejectedValue(new DiscordError('SDK_REQUEST_REJECTED'));
    await f.service.ask(input);
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'run_failed',
      error_code: 'SDK_REQUEST_REJECTED',
      request_verified: true,
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('does not invent exact-ID delivery verification', async () => {
    const f = await fixture();
    await f.service.ask(input);
    f.generation.resolve({ status: 'ok', result: { deliveryStatus: 'sent' } });
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'completed',
      delivery_status: 'sent',
      delivery_verified: false,
    });
    expect(f.events).not.toContain('read');
  });
  it('allows only explicit cancellation of an owned accepted run; disconnect/restart cannot cancel', async () => {
    const f = await fixture();
    await f.service.reply(reply);
    await expect(f.service.cancel(input.operation_id)).rejects.toThrow(
      'OWNED_ACCEPTED_RUN_REQUIRED'
    );
    await f.started.promise;
    await expect(f.make().cancel(input.operation_id)).rejects.toThrow(
      'OWNED_ACCEPTED_RUN_REQUIRED'
    );
    await expect(f.service.cancel(input.operation_id, { agent_id: 'other' })).rejects.toThrow(
      'ROUTE_SELECTOR_CONFLICT'
    );
    expect(await f.service.cancel(input.operation_id)).toMatchObject({
      status: 'running',
      cancellation_status: 'acknowledged',
    });
    await f.service.cancel(input.operation_id);
    expect(f.agent.cancel).toHaveBeenCalledOnce();
    expect(f.agent.cancel.mock.calls[0][0]).toEqual({
      runId: 'owned-run',
      sessionKey: 'agent:main:discord:channel:' + thread,
      agentId: 'main',
    });
    f.generation.resolve({ status: 'aborted', runId: 'owned-run' });
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'run_failed',
      cancellation_status: 'acknowledged',
    });
  });
  it('keeps failed cancellation unknown, never calls CLI, and never retries the abort', async () => {
    const f = await fixture();
    await f.service.reply(reply);
    await f.started.promise;
    f.agent.cancel.mockRejectedValue(new DiscordError('SDK_CANCEL_UNCONFIRMED', true));
    await expect(f.service.cancel(input.operation_id)).rejects.toThrow('SDK_CANCEL_UNCONFIRMED');
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'running',
      cancellation_status: 'unknown',
    });
    await expect(f.service.cancel(input.operation_id)).rejects.toThrow('SDK_CANCEL_UNCONFIRMED');
    expect(f.agent.cancel).toHaveBeenCalledOnce();
    expect(f.runner).not.toHaveBeenCalled();
  });
});
