import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordService, loadDiscordConfig } from '../../openclaw/discord.js';
import { handleDiscord } from '../../mcp/tools/discord.js';
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
  } = {}
) {
  const stateDir = await mkdtemp(join(tmpdir(), 'discord-test-'));
  dirs.push(stateDir);
  let promptPath: string;
  const runner = vi.fn(async (_exe: string, args: string[]) => {
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
    targets: [
      { name: 'work', guildId: guild, channelId: channel, accountId: 'bot', agentId: 'main' },
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
    });
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
  it('continues existing channel or thread without creating anything', async () => {
    for (const id of [channel, thread]) {
      const f = await fixture();
      const result = await f.service.ask({
        ...input,
        mode: 'continue',
        title: undefined,
        channel_id: id,
      });
      expect(result.status).toBe('completed');
      expect(f.runner.mock.calls.some((c) => c[1][2] === 'create')).toBe(false);
    }
  });
  it.each([{ wrongGuild: true }, { wrongParent: true }])(
    'rejects unverified destinations before delivery',
    async (options) => {
      const f = await fixture(options);
      await f.service.ask({ ...input, mode: 'continue', title: undefined, channel_id: thread });
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
    await writeFile(path, JSON.stringify(record));
    f.runner.mockClear();
    expect((await new DiscordService(f.config, f.runner).ask(input)).status).toBe('running');
    expect((await f.service.status(input.operation_id)).status).toBe('running');
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
