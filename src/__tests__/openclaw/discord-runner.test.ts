import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { runCli } from '../../openclaw/discord.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('Discord CLI execution', () => {
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
