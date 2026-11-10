import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscordAgentRequest, DiscordAgentTransport } from '../../openclaw/discord-agent.js';
import type { DiscordReader } from '../../openclaw/discord-read.js';
import type { ThreadInvoker } from '../../openclaw/discord-thread.js';
import { DiscordError } from '../../openclaw/discord-channels.js';
import {
  DiscordService,
  loadDiscordConfig,
  type DiscordConfig,
  type DiscordRouteResolver,
} from '../../openclaw/discord.js';
import { handleDiscord, discordTools } from '../../mcp/tools/discord.js';
const guild = '100000000000000001',
  channel = '100000000000000002',
  thread = '100000000000000003';
const dirs: string[] = [];
const services: DiscordService[] = [];
const publish = async (
  _t: any,
  _id: string,
  _prompt: string,
  _op: string,
  sent: (id: string) => Promise<void>
) => {
  await sent('100000000000000004');
};
class TestService extends DiscordService {
  constructor(...args: ConstructorParameters<typeof DiscordService>) {
    args[6] = publish;
    super(...args);
    services.push(this);
  }
}
async function finished(service: DiscordService, input: any) {
  const result = await service.ask(input);
  await service.drain();
  return result.status === 'queued' ? service.status(input.operation_id) : result;
}
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.drain()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
async function fixture(
  options: {
    partial?: boolean;
    createError?: boolean;
    runError?: boolean;
    wrongGuild?: boolean;
    wrongParent?: boolean;
    runResult?: any;
    parentType?: number;
    readbackId?: string;
    readbackError?: boolean;
  } = {}
) {
  const stateDir = await mkdtemp(join(tmpdir(), 'discord-test-'));
  dirs.push(stateDir);
  const reader = vi.fn<DiscordReader>(async (_scope, request) => {
    if (request.action === 'read') {
      if (options.readbackError) throw new Error('read unavailable');
      expect(request).toEqual({
        action: 'read',
        channelId: thread,
        messageId: '100000000000000004',
        limit: 1,
      });
      return { channelId: thread, messages: [{ id: options.readbackId, channel_id: thread }] };
    }
    if (request.action === 'channel-info') {
      const id = request.channelId;
      return {
        ok: true,
        channel: {
          id,
          guild_id: options.wrongGuild ? '100000000000000009' : guild,
          type: id === channel ? (options.parentType ?? 0) : 11,
          parent_id:
            id === channel ? undefined : options.wrongParent ? '100000000000000009' : channel,
          name: 'Allowed',
        },
      };
    }
    if (request.action === 'channel-list')
      return { ok: true, channels: [{ id: channel, guild_id: guild, type: 0, name: 'Allowed' }] };
    if (request.action === 'thread-list')
      return {
        ok: true,
        threads: {
          threads: [
            {
              id: thread,
              guild_id: guild,
              parent_id: channel,
              type: 11,
              name: 'Thread',
              thread_metadata: { archive_timestamp: '2026-11-01T00:00:00.000Z' },
            },
            {
              id: '100000000000000099',
              guild_id: guild,
              parent_id: '100000000000000098',
              type: 11,
              thread_metadata: { archive_timestamp: '2026-10-31T00:00:00.000Z' },
            },
          ],
          has_more: true,
        },
      };
    throw new Error('Unexpected read action');
  });
  const createThread = vi.fn<ThreadInvoker>(async () => {
    if (options.createError) throw new Error('timeout');
    return { ok: true, thread: { id: thread }, partial: options.partial };
  });
  const agent = {
    ready: vi.fn(async () => {}),
    run: vi.fn(async (request: DiscordAgentRequest) => {
      expect(request.message).toBe('Please help $(not-a-shell)');
      if (options.runError) throw new Error('secret must not leak');
      return options.runResult ?? { status: 'ok', runId: 'run-1' };
    }),
    cancel: vi.fn(async () => {}),
  } satisfies DiscordAgentTransport;
  const config: DiscordConfig = {
    stateDir,
    acknowledgeInboundRouting: true,
    targets: [
      {
        name: 'work',
        guildId: guild,
        channelId: channel,
        accountId: 'bot',
        agentId: 'main',
        normalRouting: true,
      },
    ],
  };
  const make = (settings: DiscordConfig = config, resolveRoute?: DiscordRouteResolver) =>
    new TestService(
      settings,
      undefined,
      resolveRoute,
      reader,
      createThread,
      undefined,
      publish,
      agent
    );
  const calls = () =>
    reader.mock.calls.length +
    createThread.mock.calls.length +
    agent.ready.mock.calls.length +
    agent.run.mock.calls.length +
    agent.cancel.mock.calls.length;
  const clear = () => {
    reader.mockClear();
    createThread.mockClear();
    agent.ready.mockClear();
    agent.run.mockClear();
    agent.cancel.mockClear();
  };
  return { service: make(), reader, createThread, agent, config, make, calls, clear };
}
const input = {
  target: 'work',
  mode: 'new_thread',
  operation_id: 'test-operation-0001',
  title: 'A new task',
  prompt: 'Please help $(not-a-shell)',
};
describe('Discord service', () => {
  it('loads without a Gateway selector and probes SDK readiness before any reads or writes', async () => {
    const f = await fixture();
    const loaded = loadDiscordConfig({
      MCP_DISCORD_ENABLED: 'true',
      MCP_DISCORD_STATE_DIR: f.config.stateDir,
      MCP_DISCORD_TARGETS: JSON.stringify(f.config.targets),
    });
    expect(loaded).not.toHaveProperty('gatewayInstance');
    f.agent.ready.mockRejectedValueOnce(new DiscordError('SDK_AUTH_FAILED'));
    expect(await f.service.ask(input)).toMatchObject({
      status: 'run_failed',
      error_code: 'SDK_AUTH_FAILED',
    });
    expect(f.agent.ready).toHaveBeenCalledOnce();
    expect(f.reader).not.toHaveBeenCalled();
    expect(f.createThread).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it('requires operator acknowledgement of normal inbound human reply routing', async () => {
    const f = await fixture();
    const service = f.make({ ...f.config, acknowledgeInboundRouting: false });
    expect(await service.ask(input)).toMatchObject({
      status: 'run_failed',
      error_code: 'NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(f.calls()).toBe(0);
  });
  it('excludes special bound targets unless explicitly configured for normal routing', async () => {
    const f = await fixture();
    const service = f.make({
      ...f.config,
      targets: f.config.targets.map((t) => ({ ...t, normalRouting: false })),
    });
    expect(await service.ask(input)).toMatchObject({
      error_code: 'NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(f.calls()).toBe(0);
  });
  it('rejects parent routed to another agent before creating a new thread', async () => {
    const f = await fixture();
    const service = f.make(f.config, async (t, id) => ({
      ...t,
      channelId: id,
      agentId: 'other',
      sessionKey: 'agent:other:discord:channel:' + id,
      kind: 'ordinary',
    }));
    expect(await service.ask(input)).toMatchObject({
      error_code: 'ROUTE_MISMATCH',
      status: 'run_failed',
    });
    expect(f.reader.mock.calls.every((c) => c[1].action === 'channel-info')).toBe(true);
    expect(f.createThread).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it('checks the actual new thread route and retains its ID when bound', async () => {
    const f = await fixture();
    const seen: string[] = [];
    const service = f.make(f.config, async (t, id) => {
      seen.push(id);
      return {
        ...t,
        channelId: id,
        sessionKey: 'agent:main:discord:channel:' + id,
        kind: id === channel ? 'ordinary' : 'bound',
      };
    });
    const result = await service.ask(input);
    expect(seen).toEqual([channel, thread]);
    expect(result).toMatchObject({
      error_code: 'NONORDINARY_ROUTE_DENIED',
      channel_id: thread,
      status: 'run_failed',
    });
    expect(result.session_key).toBeUndefined();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it('rejects an ordinary-looking key when live inspection fails', async () => {
    const f = await fixture();
    const service = f.make(f.config, async () => {
      throw new Error('private routing detail');
    });
    expect(await service.ask(input)).toMatchObject({ error_code: 'ROUTE_UNVERIFIED' });
    expect(f.reader.mock.calls.every((c) => c[1].action === 'channel-info')).toBe(true);
    expect(f.createThread).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it.each(['sent', 'failed', 'partial_failed', 'suppressed'])(
    'keeps generation separate from nested delivery %s',
    async (status) => {
      const f = await fixture({
        runResult: { status: 'ok', result: { deliveryStatus: { status } } },
      });
      expect(await finished(f.service, input)).toMatchObject({
        status: 'completed',
        generation_status: 'completed',
        delivery_status: status,
        delivery_verified: false,
      });
      expect(f.reader.mock.calls.some((c) => c[1].action === 'read')).toBe(false);
    }
  );
  it.each([false, true])(
    'reads a reported message ID once, read failure %s',
    async (readbackError) => {
      const messageId = '100000000000000004';
      const f = await fixture({
        runResult: { status: 'ok', result: { delivery: { status: 'sent', messageId } } },
        readbackId: messageId,
        readbackError,
      });
      expect(await finished(f.service, input)).toMatchObject({
        delivery_status: 'sent',
        message_id: messageId,
        delivery_verified: !readbackError,
      });
      expect(f.reader.mock.calls.filter((c) => c[1].action === 'read')).toHaveLength(1);
    }
  );
  it('does not verify a different message ID', async () => {
    const f = await fixture({
      runResult: {
        status: 'ok',
        deliveryStatus: { status: 'sent', messageId: '100000000000000004' },
      },
      readbackId: '100000000000000099',
    });
    expect(await finished(f.service, input)).toMatchObject({ delivery_verified: false });
  });
  it('is opt-in and fails closed on missing config', () => {
    expect(loadDiscordConfig({})).toBeUndefined();
    expect(() => loadDiscordConfig({ MCP_DISCORD_ENABLED: 'true' })).toThrow();
  });
  it('creates an ordinary session with explicit SDK destination and no prompt files', async () => {
    const f = await fixture();
    const result = await finished(f.service, input);
    expect(result).toMatchObject({
      status: 'completed',
      session_key: 'agent:main:discord:channel:' + thread,
      channel_id: thread,
      run_id: 'run-1',
      retry_safe: false,
      delivery_status: 'unverified',
      delivery_verified: false,
      generation_status: 'completed',
    });
    expect(result.handoff).toContain('Continue on Discord: https://discord.com/channels/');
    expect(f.agent.run.mock.calls[0][0]).toEqual({
      message: input.prompt,
      agentId: 'main',
      sessionKey: 'agent:main:discord:channel:' + thread,
      threadId: thread,
      accountId: 'bot',
      idempotencyKey: expect.any(String),
    });
    expect(await readdir(f.config.stateDir)).toEqual([input.operation_id + '.json']);
    expect(
      await readFile(join(f.config.stateDir, input.operation_id + '.json'), 'utf8')
    ).not.toContain(input.prompt);
  });
  it('does not repeat writes after restart or duplicate request', async () => {
    const f = await fixture();
    const result = await finished(f.service, input);
    const count = f.calls();
    expect(await f.make().ask(input)).toEqual(result);
    expect(f.calls()).toBe(count);
    await expect(f.service.ask({ ...input, prompt: 'different' })).rejects.toThrow(
      'different arguments'
    );
  });
  it.each([15, 16])('rejects forum/media type %i before writes', async (parentType) => {
    const f = await fixture({ parentType });
    const result = await finished(f.service, input);
    expect(result.error_code).toBe('FORUM_MEDIA_WRITES_UNSUPPORTED');
    expect(f.createThread).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it('does not report completion when the SDK rejects a dispatched request', async () => {
    const f = await fixture();
    f.agent.run.mockRejectedValueOnce(new DiscordError('SDK_REQUEST_REJECTED'));
    expect(await finished(f.service, input)).toMatchObject({
      status: 'run_failed',
      error_code: 'SDK_REQUEST_REJECTED',
    });
  });
  it('claims concurrent requests before any write', async () => {
    const f = await fixture();
    await Promise.allSettled([f.service.ask(input), f.service.ask(input)]);
    expect(f.createThread).toHaveBeenCalledTimes(1);
  });
  it.each([
    { partial: true, status: 'creation_partial' },
    { createError: true, status: 'creation_unknown' },
    { runError: true, status: 'run_unknown' },
    { runResult: { status: 'error' }, status: 'run_failed' },
  ])('records partial/uncertain outcomes: $status', async (options) => {
    const f = await fixture(options);
    const result = await finished(f.service, input);
    expect(result.status).toBe(options.status);
    expect(JSON.stringify(result)).not.toContain('secret');
    const count = f.calls();
    await finished(f.service, input);
    expect(f.calls()).toBe(count);
    if (options.partial) expect(f.agent.run).not.toHaveBeenCalled();
  });
  it('publishes only new_thread without an existing channel argument', () => {
    const schema = discordTools.find((t) => t.name === 'openclaw_discord_ask')!.inputSchema;
    expect(schema.properties?.mode).toMatchObject({ enum: ['new_thread'] });
    expect(schema.properties).not.toHaveProperty('channel_id');
  });
  it('rejects continue before state changes or adapter calls even with a resolver', async () => {
    const f = await fixture();
    await expect(
      f.service.ask({ ...input, mode: 'continue', title: undefined, channel_id: thread })
    ).rejects.toThrow('CONTINUE_UNSUPPORTED');
    expect(f.calls()).toBe(0);
    await expect(readFile(join(f.config.stateDir, input.operation_id + '.json'))).rejects.toThrow();
  });
  it.each([{ wrongGuild: true }, { wrongParent: true }])(
    'rejects unverified destinations before delivery',
    async (options) => {
      const f = await fixture(options);
      await finished(f.service, input);
      expect(f.agent.run).not.toHaveBeenCalled();
    }
  );
  it.each([
    { target: 'other' },
    { operation_id: '../escape' },
    { title: '--json' },
    { title: '' },
    { prompt: '' },
    { mode: 'fork' },
  ])('rejects invalid input without adapter calls: %j', async (invalid) => {
    const f = await fixture();
    await expect(f.service.ask({ ...input, ...invalid })).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });
  it('retains interrupted records and never replays on restart', async () => {
    const f = await fixture();
    await finished(f.service, input);
    const path = join(f.config.stateDir, input.operation_id + '.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.status = 'running';
    delete record.handoff;
    await writeFile(path, JSON.stringify(record));
    f.clear();
    expect((await f.make().ask(input)).status).toBe('run_unknown');
    const running = await f.service.status(input.operation_id);
    expect(running.status).toBe('run_unknown');
    expect(running.handoff).toContain(
      'Continue on Discord: https://discord.com/channels/' + guild + '/' + thread
    );
    expect(running.handoff).toContain('first response not confirmed');
    expect(f.calls()).toBe(0);
  });
  it('rejects a public state directory before dispatch', async () => {
    const f = await fixture();
    await chmod(f.config.stateDir, 0o755);
    await expect(f.service.ask(input)).rejects.toThrow('private');
    expect(f.calls()).toBe(0);
  });
  it('filters lists and passes archive timestamp pagination', async () => {
    const f = await fixture();
    expect((await f.service.channels()).channels).toHaveLength(1);
    const result = await f.service.threads({
      target: 'work',
      archived: true,
      before: '2026-11-02T00:00:00Z',
      limit: 10,
    });
    expect(result.threads).toHaveLength(1);
    expect(result.next_before).toBe('2026-10-31T00:00:00.000Z');
    expect(f.reader.mock.calls.at(-1)![1]).toEqual({
      action: 'thread-list',
      channelId: channel,
      includeArchived: true,
      before: '2026-11-02T00:00:00Z',
      limit: 10,
    });
    await expect(f.service.threads({ target: 'work', limit: 10 })).rejects.toThrow(
      'only supported'
    );
  });
  it('requires channel creation opt-in and rejects raw arguments', async () => {
    const f = await fixture();
    expect(
      (
        await handleDiscord(f.service, 'openclaw_discord_create_channel', {
          policy: 'work',
          name: 'test',
          operation_id: 'channel-operation-001',
          authorize_create: true,
          authorize_admission: true,
        })
      ).structuredContent?.error_code
    ).toBe('CHANNEL_CREATION_DISABLED');
    expect(
      (await handleDiscord(f.service, 'openclaw_discord_ask', { ...input, args: ['--local'] }))
        .isError
    ).toBe(true);
    expect(f.calls()).toBe(0);
  });
});
