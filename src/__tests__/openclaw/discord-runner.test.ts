import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { runCli, DiscordService } from '../../openclaw/discord.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
describe('Discord CLI execution', () => {
  it.each([
    ['message', 'channel', 'list'],
    ['agent', '--message-file', '/private/prompt'],
  ])('closes stdin for %j', async (...args) => {
    const end = vi.fn();
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(null, '{"ok":true}', '');
      return { stdin: { end } };
    }) as any);
    await runCli('mock-only', args, 1000);
    expect(end).toHaveBeenCalledTimes(1);
  });
  it.each(['{"ok":true,"channels":[]}', 'private malformed stdout'])(
    'logs safe timeout diagnostics and never accepts stdout',
    async (stdout) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
        callback(
          Object.assign(new Error('secret-error'), { killed: true, signal: 'SIGTERM', code: null }),
          stdout,
          'secret-stderr'
        );
        return { stdin: { end: vi.fn() } };
      }) as any);
      const service = new DiscordService({
        executable: 'secret-path',
        stateDir: '/unused-test-state',
        targets: [
          {
            name: 'work',
            guildId: '300000000000000001',
            channelId: '300000000000000002',
            accountId: 'secret-account',
            agentId: 'main',
          },
        ],
      });
      await expect(service.channels()).rejects.toThrow('CLI_TIMEOUT');
      const line = log.mock.calls[0][0];
      const diagnostic = JSON.parse(line.slice(line.indexOf('{')));
      expect(diagnostic).toEqual({
        classification: 'CLI_TIMEOUT',
        elapsed_ms: expect.any(Number),
        signal: 'SIGTERM',
        code: null,
        stdout_bytes: new TextEncoder().encode(stdout).length,
        stderr_bytes: 13,
        valid_json: stdout.startsWith('{'),
      });
      expect(line).not.toContain('secret');
      expect(line).not.toContain('private');
    }
  );
  it('does not close stdin for an unrelated interactive invocation', async () => {
    const end = vi.fn();
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(null, '{}', '');
      return { stdin: { end } };
    }) as any);
    await runCli('mock-only', ['agent'], 1000);
    expect(end).not.toHaveBeenCalled();
  });

  it('keeps source text free of literal NUL bytes', async () => {
    const bytes = await readFile(new URL('../../openclaw/discord.ts', import.meta.url));
    expect([...bytes].includes(0)).toBe(false);
  });
  it('marks conflicting success stdout as failed on nonzero exit', async () => {
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(new Error('private error'), '{"status":"ok"}', '');
      return {};
    }) as any);
    await expect(runCli('openclaw', [], 1000)).resolves.toMatchObject({
      status: 'ok',
      _cliFailure: true,
      _cliCode: 'CLI_EXIT_NONZERO',
    });
  });
  it('inherits provenance unchanged and never invokes a shell', async () => {
    vi.stubEnv('OPENCLAW_SHELL', 'agent');
    vi.stubEnv('OPENCLAW_AGENT_ID', 'caller');
    vi.mocked(execFile).mockImplementation(((_file, _args, options, callback) => {
      expect(options.shell).toBe(false);
      expect(options.env).toBe(process.env);
      expect(options.env.OPENCLAW_SHELL).toBe('agent');
      expect(options.env.OPENCLAW_AGENT_ID).toBe('caller');
      callback(null, '{"ok":true}', '');
      return {};
    }) as any);
    await expect(
      runCli('/configured/openclaw', ['message', 'channel', 'info'], 1000)
    ).resolves.toEqual({ ok: true });
  });
  it('retains structured partial results on nonzero exit', async () => {
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(new Error('secret'), '{"payload":{"partial":true}}', 'secret');
      return {};
    }) as any);
    await expect(runCli('openclaw', [], 1000)).resolves.toMatchObject({
      payload: { partial: true },
      _cliFailure: true,
      _cliCode: 'CLI_EXIT_NONZERO',
    });
  });
  it('does not expose stderr or raw process failures', async () => {
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(new Error('secret'), '', 'secret');
      return {};
    }) as any);
    await expect(runCli('openclaw', [], 1000)).rejects.toThrow('CLI_EXIT_NONZERO');
  });
});
