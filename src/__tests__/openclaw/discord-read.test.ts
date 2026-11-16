import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { channelReader } from '../../openclaw/discord-read.js';
const guild = '800000000000000001',
  channel = '800000000000000002',
  message = '800000000000000003';
const scope = { guildId: guild, accountId: 'bot', agentId: 'main' };
const config = { stateDir: '/unused' };
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());
const envelope = (details: any) =>
  Response.json({ ok: true, result: { details: { ok: true, ...details } } });
function fixture(result: any) {
  const fetcher = vi.fn(async () => envelope(result));
  return {
    fetcher,
    read: channelReader({ url: 'http://127.0.0.1:18789', token: 'fixture' }, config, fetcher),
  };
}
describe('closed Discord metadata reads', () => {
  it('uses fixed HTTP message action and verified scope', async () => {
    const f = fixture({ channel: { id: channel, guild_id: guild, type: 0 } });
    await f.read(scope, { action: 'channel-info', channelId: channel });
    expect(f.fetcher.mock.calls[0]).toEqual([
      'http://127.0.0.1:18789/tools/invoke',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({
          tool: 'message',
          sessionKey: 'agent:main:main',
          args: {
            action: 'channel-info',
            channelId: channel,
            channel: 'discord',
            accountId: 'bot',
          },
        }),
      }),
    ]);
  });
  it.each([
    { action: 'send', channelId: channel },
    { action: 'channel-info', channelId: channel, url: 'https://evil.invalid' },
    { action: 'read', channelId: channel, messageId: message, limit: 2 },
    { action: 'thread-list', channelId: channel, before: 'bad', includeArchived: true },
    { action: 'channel-info', channelId: '../escape' },
  ])('rejects arbitrary action or malformed arguments %j', async (request) => {
    const f = fixture({});
    await expect(f.read(scope, request as any)).rejects.toThrow('READ_ACTION_DENIED');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { id: channel, guild_id: message, type: 0 },
    { id: message, guild_id: guild, type: 0 },
    { id: channel, guild_id: guild, type: '0' },
  ])('rejects mismatching metadata %j', async (metadata) => {
    const f = fixture({ channel: metadata });
    await expect(f.read(scope, { action: 'channel-info', channelId: channel })).rejects.toThrow(
      'UNVERIFIED'
    );
  });
  it.each([401, 403, 404, 429, 500])('does not change transport on HTTP %s', async (status) => {
    const f = fixture({});
    f.fetcher.mockResolvedValue(new Response('secret', { status }));
    await expect(f.read(scope, { action: 'channel-list' })).rejects.toThrow(
      'GATEWAY_HTTP_' + status
    );
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('requires exact message identity and rejects partial output', async () => {
    const f = fixture({ channelId: channel, messages: [{ id: message, channel_id: channel }] });
    await expect(
      f.read(scope, { action: 'read', channelId: channel, messageId: message, limit: 1 })
    ).resolves.toMatchObject({ messages: [{ id: message }] });
    f.fetcher.mockResolvedValue(envelope({ partial: true, channels: [] }));
    await expect(f.read(scope, { action: 'channel-list' })).rejects.toThrow('UNVERIFIED');
  });
});
