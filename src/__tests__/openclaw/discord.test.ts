import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordService, loadDiscordConfig } from '../../openclaw/discord.js';
import { handleDiscord, discordTools } from '../../mcp/tools/discord.js';
const guild = '100000000000000001',
  channel = '100000000000000002',
  thread = '100000000000000003';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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
  let promptPath: string;
  const runner = vi.fn(async (_exe: string, args: string[]) => {
    if (args[1] === 'read') {
      if (options.readbackError) throw new Error('read unavailable');
      expect(args).toContain('--message-id');
      expect(args).toContain('1');
      return {
        payload: { channelId: thread, messages: [{ id: options.readbackId, channel_id: thread }] },
      };
    }
    if (args[0] === 'agent') {
      promptPath = args[args.indexOf('--message-file') + 1];
      expect(await readFile(promptPath, 'utf8')).toBe('Please help $(not-a-shell)');
      expect((await stat(promptPath)).mode & 0o777).toBe(0o600);
      if (options.runError) throw new Error('secret must not leak');
      return options.runResult ?? { status: 'ok', runId: 'run-1' };
    }
    if (args[2] === 'info') {
      const id = args[args.indexOf('--target') + 1].slice(8);
      return {
        payload: {
          ok: true,
          channel: {
            id,
            guild_id: options.wrongGuild ? '100000000000000009' : guild,
            type: id === channel ? (options.parentType ?? 0) : 11,
            parent_id:
              id === channel ? undefined : options.wrongParent ? '100000000000000009' : channel,
            name: 'Allowed',
          },
        },
      };
    }
    if (args[2] === 'create') {
      if (options.createError) throw new Error('timeout');
      return { payload: { ok: true, thread: { id: thread }, partial: options.partial } };
    }
    if (args[1] === 'channel' && args[2] === 'list')
      return {
        payload: {
          ok: true,
          channels: [{ id: channel, guild_id: guild, type: 0, name: 'Allowed' }],
        },
      };
    if (args[2] === 'list')
      return {
        payload: {
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
        },
      };
    throw new Error('Unexpected CLI');
  });
  const config = {
    executable: '/operator/openclaw',
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
  return {
    service: new DiscordService(config, runner),
    runner,
    config,
    promptPath: () => promptPath,
  };
}
const input = {
  target: 'work',
  mode: 'new_thread',
  operation_id: 'test-operation-0001',
  title: 'A new task',
  prompt: 'Please help $(not-a-shell)',
};
describe('Discord service', () => {
  it('requires operator acknowledgement of normal inbound human reply routing', async () => {
    const f = await fixture();
    const service = new DiscordService({ ...f.config, acknowledgeInboundRouting: false }, f.runner);
    expect(await service.ask(input)).toMatchObject({
      status: 'run_failed',
      error_code: 'NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('excludes special bound targets unless explicitly configured for normal routing', async () => {
    const f = await fixture();
    const service = new DiscordService(
      { ...f.config, targets: f.config.targets.map((t) => ({ ...t, normalRouting: false })) },
      f.runner
    );
    expect(await service.ask(input)).toMatchObject({
      error_code: 'NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('rejects parent routed to another agent before creating a new thread', async () => {
    const f = await fixture();
    const service = new DiscordService(f.config, f.runner, undefined, async (t, id) => ({
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
    expect(f.runner.mock.calls.every((c) => c[1][2] === 'info')).toBe(true);
  });
  it('checks the actual new thread route and retains its ID when bound', async () => {
    const f = await fixture();
    const seen: string[] = [];
    const service = new DiscordService(f.config, f.runner, undefined, async (t, id) => {
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
    expect(f.runner.mock.calls.some((c) => c[1][0] === 'agent')).toBe(false);
  });
  it('rejects an ordinary-looking key when live inspection fails', async () => {
    const f = await fixture();
    const service = new DiscordService(f.config, f.runner, undefined, async () => {
      throw new Error('private routing detail');
    });
    expect(await service.ask(input)).toMatchObject({ error_code: 'ROUTE_UNVERIFIED' });
    expect(f.runner.mock.calls.every((c) => c[1][2] === 'info')).toBe(true);
  });
  it.each(['sent', 'failed', 'partial_failed', 'suppressed'])(
    'keeps generation separate from nested delivery %s',
    async (status) => {
      const f = await fixture({
        runResult: { status: 'ok', result: { deliveryStatus: { status } } },
      });
      expect(await f.service.ask(input)).toMatchObject({
        status: 'completed',
        generation_status: 'completed',
        delivery_status: status,
        delivery_verified: false,
      });
      expect(f.runner.mock.calls.some((c) => c[1][1] === 'read')).toBe(false);
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
      expect(await f.service.ask(input)).toMatchObject({
        delivery_status: 'sent',
        message_id: messageId,
        delivery_verified: !readbackError,
      });
      expect(f.runner.mock.calls.filter((c) => c[1][1] === 'read')).toHaveLength(1);
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
    expect(await f.service.ask(input)).toMatchObject({ delivery_verified: false });
  });
  it('is opt-in and fails closed on missing config', () => {
    expect(loadDiscordConfig({})).toBeUndefined();
    expect(() => loadDiscordConfig({ MCP_DISCORD_ENABLED: 'true' })).toThrow();
  });
  it('creates an ordinary session with explicit delivery and safe prompt cleanup', async () => {
    const f = await fixture();
    const result = await f.service.ask(input);
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
    const args = f.runner.mock.calls.find((c) => c[1][0] === 'agent')![1];
    expect(args).toContain('--deliver');
    expect(args).toContain('--reply-account');
    expect(args).toContain('channel:' + thread);
    expect(args).not.toContain(input.prompt);
    await expect(stat(f.promptPath())).rejects.toThrow();
    expect(
      await readFile(join(f.config.stateDir, input.operation_id + '.json'), 'utf8')
    ).not.toContain(input.prompt);
  });
  it('does not repeat writes after restart or duplicate request', async () => {
    const f = await fixture();
    const result = await f.service.ask(input);
    const count = f.runner.mock.calls.length;
    expect(await new DiscordService(f.config, f.runner).ask(input)).toEqual(result);
    expect(f.runner).toHaveBeenCalledTimes(count);
    await expect(f.service.ask({ ...input, prompt: 'different' })).rejects.toThrow(
      'different arguments'
    );
  });
  it.each([15, 16])('rejects forum/media type %i before writes', async (parentType) => {
    const f = await fixture({ parentType });
    const result = await f.service.ask(input);
    expect(result.error_code).toBe('FORUM_MEDIA_WRITES_UNSUPPORTED');
    expect(f.runner.mock.calls.some((c) => c[1][2] === 'create' || c[1][0] === 'agent')).toBe(
      false
    );
  });
  it('does not report completion on conflicting nonzero CLI exit', async () => {
    const f = await fixture({
      runResult: { status: 'ok', _cliFailure: true, _cliCode: 'CLI_EXIT_NONZERO' },
    });
    expect(await f.service.ask(input)).toMatchObject({
      status: 'run_failed',
      error_code: 'CLI_EXIT_NONZERO',
    });
  });
  it('claims concurrent requests before any write', async () => {
    const f = await fixture();
    await Promise.allSettled([f.service.ask(input), f.service.ask(input)]);
    expect(f.runner.mock.calls.filter((c) => c[1][2] === 'create')).toHaveLength(1);
  });
  it.each([
    { partial: true, status: 'creation_partial' },
    { createError: true, status: 'creation_unknown' },
    { runError: true, status: 'run_unknown' },
    { runResult: { status: 'error' }, status: 'run_failed' },
  ])('records partial/uncertain outcomes: $status', async (options) => {
    const f = await fixture(options);
    const result = await f.service.ask(input);
    expect(result.status).toBe(options.status);
    expect(JSON.stringify(result)).not.toContain('secret');
    const count = f.runner.mock.calls.length;
    await f.service.ask(input);
    expect(f.runner).toHaveBeenCalledTimes(count);
    if (options.partial) expect(f.runner.mock.calls.some((c) => c[1][0] === 'agent')).toBe(false);
  });
  it('publishes only new_thread without an existing channel argument', () => {
    const schema = discordTools.find((t) => t.name === 'openclaw_discord_ask')!.inputSchema;
    expect(schema.properties?.mode).toMatchObject({ enum: ['new_thread'] });
    expect(schema.properties).not.toHaveProperty('channel_id');
  });
  it('rejects continue before state changes or CLI calls even with a resolver', async () => {
    const f = await fixture();
    await expect(
      f.service.ask({ ...input, mode: 'continue', title: undefined, channel_id: thread })
    ).rejects.toThrow('CONTINUE_UNSUPPORTED');
    expect(f.runner).not.toHaveBeenCalled();
    await expect(readFile(join(f.config.stateDir, input.operation_id + '.json'))).rejects.toThrow();
  });
  it.each([{ wrongGuild: true }, { wrongParent: true }])(
    'rejects unverified destinations before delivery',
    async (options) => {
      const f = await fixture(options);
      await f.service.ask(input);
      expect(f.runner.mock.calls.some((c) => c[1][0] === 'agent')).toBe(false);
    }
  );
  it.each([
    { target: 'other' },
    { operation_id: '../escape' },
    { title: '--json' },
    { title: '' },
    { prompt: '' },
    { mode: 'fork' },
  ])('rejects invalid input without CLI calls: %j', async (invalid) => {
    const f = await fixture();
    await expect(f.service.ask({ ...input, ...invalid })).rejects.toThrow();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('retains interrupted records and never replays on restart', async () => {
    const f = await fixture();
    await f.service.ask(input);
    const path = join(f.config.stateDir, input.operation_id + '.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.status = 'running';
    delete record.handoff;
    await writeFile(path, JSON.stringify(record));
    f.runner.mockClear();
    expect((await new DiscordService(f.config, f.runner).ask(input)).status).toBe('running');
    const running = await f.service.status(input.operation_id);
    expect(running.status).toBe('running');
    expect(running.handoff).toContain(
      'Continue on Discord: https://discord.com/channels/' + guild + '/' + thread
    );
    expect(running.handoff).toContain('first response not confirmed');
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('rejects a public state directory before dispatch', async () => {
    const f = await fixture();
    await chmod(f.config.stateDir, 0o755);
    await expect(f.service.ask(input)).rejects.toThrow('private');
    expect(f.runner).not.toHaveBeenCalled();
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
    expect(f.runner.mock.calls.at(-1)![1]).toContain('--include-archived');
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
    expect(f.runner).not.toHaveBeenCalled();
  });
});
