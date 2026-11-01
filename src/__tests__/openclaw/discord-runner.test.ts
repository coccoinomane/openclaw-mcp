import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { runCli } from '../../openclaw/discord.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('Discord CLI execution', () => {
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
    await expect(runCli('openclaw', [], 1000)).resolves.toEqual({ payload: { partial: true } });
  });
  it('does not expose stderr or raw process failures', async () => {
    vi.mocked(execFile).mockImplementation(((_file, _args, _options, callback) => {
      callback(new Error('secret'), '', 'secret');
      return {};
    }) as any);
    await expect(runCli('openclaw', [], 1000)).rejects.toThrow('CLI outcome unconfirmed');
  });
});
