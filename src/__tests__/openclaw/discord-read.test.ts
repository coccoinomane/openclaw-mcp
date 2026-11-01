import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelReader } from '../../openclaw/discord-read.js';
import { DiscordService, loadDiscordConfig, type DiscordConfig } from '../../openclaw/discord.js';
import { handleDiscord } from '../../mcp/tools/discord.js';
const guild = '300000000000000001',
  channel = '300000000000000002',
  category = '300000000000000003',
  other = '300000000000000004';
const target = {
  name: 'work',
  guildId: guild,
  channelId: channel,
  accountId: 'bot',
  agentId: 'main',
  normalRouting: true,
};
const config: DiscordConfig = {
  executable: 'never-executed',
  stateDir: '/unused-test-state',
  targets: [target],
  cliGatewayInstance: 'home',
  gatewayReadsEnabled: true,
  acknowledgeInboundRouting: true,
};
const instances = [{ name: 'home', url: 'http://127.0.0.1:18789', token: 'mock-credential' }];
const parent = {
  id: channel,
  guild_id: guild,
  type: 0,
  name: 'Work',
  topic: 'Allowed topic',
  parent_id: category,
};
const categoryData = { id: category, guild_id: guild, type: 4, name: 'Projects' };
const envelope = (result: any) => ({ ok: true, result: { details: result } });
function fixture(
  c = config,
  channels: any[] = [
    parent,
    categoryData,
    { ...parent, id: other, name: 'Do not expose', topic: 'private' },
  ]
) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope({ ok: true, channels }))));
  const runner = vi.fn(async () => {
    throw new Error('CLI must not run');
  });
  const reader = channelReader(instances, c, fetcher)!;
  return {
    fetcher,
    runner,
    reader,
    service: new DiscordService(c, runner, undefined, undefined, reader),
  };
}
beforeEach(() => {
  // Mock HTTP and CLI only; production provenance is never changed.
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe('closed metadata reader', () => {
  it.each([undefined, 'false', '1', 'true'])('requires explicit environment opt-in %j', (flag) => {
    const loaded = loadDiscordConfig({
      MCP_DISCORD_ENABLED: 'true',
      MCP_DISCORD_STATE_DIR: '/unused-test-state',
      MCP_DISCORD_TARGETS: JSON.stringify([target]),
      MCP_DISCORD_CLI_GATEWAY_INSTANCE: 'home',
      MCP_DISCORD_GATEWAY_READS_ENABLED: flag,
    });
    expect(loaded?.gatewayReadsEnabled).toBe(flag === 'true');
    expect(typeof channelReader(instances, loaded!)).toBe(
      flag === 'true' ? 'function' : 'undefined'
    );
  });

  it('uses fixed server instance, account and agent with no redirects', async () => {
    const f = fixture();
    const result = await f.service.channels();
    expect(result.channels).toEqual([
      {
        target: 'work',
        channel_id: channel,
        guild_id: guild,
        name: 'Work',
        topic: 'Allowed topic',
        category_id: category,
        category_name: 'Projects',
        discord_url: 'https://discord.com/channels/' + guild + '/' + channel,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
    const [url, options] = f.fetcher.mock.calls[0] as any;
    expect(url).toBe('http://127.0.0.1:18789/tools/invoke');
    expect(options.redirect).toBe('error');
    expect(options.headers.Authorization).toBe('Bearer ' + instances[0].token);
    expect(JSON.parse(options.body)).toEqual({
      tool: 'message',
      sessionKey: 'agent:main:main',
      args: { action: 'channel-list', channel: 'discord', accountId: 'bot', guildId: guild },
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it.each(['OPENCLAW_SHELL', 'OPENCLAW_AGENT_ID', 'OPENCLAW_SESSION_KEY', 'OPENCLAW_CALLER_ID'])(
    'denies %s provenance without fallback',
    async (key) => {
      const f = fixture();
      vi.stubEnv(key, 'agent-origin');
      await expect(f.service.channels()).rejects.toThrow('AGENT_PROVENANCE_DENIED');
      expect(process.env[key]).toBe('agent-origin');
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.runner).not.toHaveBeenCalled();
    }
  );
  it.each([
    { action: 'send' },
    { action: 'channel-list', url: 'https://evil.invalid' },
    { action: 'channel-list', channelId: other },
    { action: 'channel-info', channelId: '../escape' },
    { action: 'channel-info', channelId: channel, args: { accountId: 'other' } },
  ])('denies arbitrary requests %j', async (request) => {
    const f = fixture();
    await expect(f.reader(target, request as any)).rejects.toThrow('READ_ACTION_DENIED');
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([{ accountId: 'other' }, { agentId: 'other' }, { guildId: other }])(
    'denies unconfigured mapping %j',
    async (override) => {
      const f = fixture();
      await expect(
        f.reader({ ...target, ...override }, { action: 'channel-list' })
      ).rejects.toThrow('READ_SCOPE_DENIED');
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  );
  it.each([
    { action: 'channel-info', channelId: other },
    { target: 'work' },
    { url: 'https://evil.invalid' },
    { accountId: 'other' },
  ])('rejects client read overrides %j', async (input) => {
    const f = fixture();
    expect((await handleDiscord(f.service, 'openclaw_discord_channels', input)).isError).toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('uses CLI compatibility only when adapter or instance assertion is absent', async () => {
    expect(channelReader(instances, { ...config, cliGatewayInstance: undefined })).toBeUndefined();
    const reader = vi.fn();
    const runner = vi.fn(async () => ({ payload: { ok: true, channels: [parent, categoryData] } }));
    for (const [c, r] of [
      [config, undefined],
      [{ ...config, cliGatewayInstance: undefined }, reader],
      [{ ...config, gatewayReadsEnabled: undefined }, reader],
      [{ ...config, gatewayReadsEnabled: false }, reader],
    ] as const) {
      await new DiscordService(c, runner, undefined, undefined, r).channels();
    }
    expect(runner).toHaveBeenCalledTimes(4);
    expect(reader).not.toHaveBeenCalled();
    expect(runner.mock.calls[0]).toEqual([
      'never-executed',
      [
        'message',
        'channel',
        'list',
        '--guild-id',
        guild,
        '--channel',
        'discord',
        '--account',
        'bot',
        '--json',
      ],
      30000,
    ]);
  });
  it('fails startup for configured but missing, duplicate, insecure or uncredentialed instances', () => {
    for (const list of [
      [],
      [instances[0], instances[0]],
      [{ ...instances[0], token: undefined }],
      [{ ...instances[0], url: 'http://remote.invalid' }],
    ])
      expect(() => channelReader(list, config)).toThrow();
    expect(() =>
      channelReader(instances, {
        ...config,
        creationPolicies: [
          {
            name: 'p',
            guildId: guild,
            categoryId: category,
            accountId: 'bot',
            agentId: 'main',
            instance: 'other',
          },
        ],
      })
    ).toThrow('READ_GATEWAY_MISMATCH');
  });
  it.each([
    null,
    {},
    { ok: false },
    { ok: true, result: { isError: true } },
    envelope({ ok: true }),
    envelope({ ok: true, channels: {} }),
    envelope({ ok: true, channels: [], partial: true }),
    { ok: true, result: { content: [{ type: 'text', text: 'not-json' }] } },
  ])('rejects malformed envelope %j', async (body) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(f.service.channels()).rejects.toThrow('GATEWAY_READ_UNVERIFIED');
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('accepts text-only native results and rejects malformed info', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, channel: parent }) }],
          },
        })
      )
    );
    expect(await f.reader(target, { action: 'channel-info', channelId: channel })).toMatchObject({
      channel: parent,
    });
    const body = JSON.parse((f.fetcher.mock.calls[0] as any)[1].body);
    expect(body.args).toEqual({
      action: 'channel-info',
      channel: 'discord',
      accountId: 'bot',
      channelId: channel,
    });
    f.fetcher.mockResolvedValue(new Response(JSON.stringify(envelope({ ok: true, channel: [] }))));
    await expect(f.reader(target, { action: 'channel-info', channelId: channel })).rejects.toThrow(
      'GATEWAY_READ_UNVERIFIED'
    );
  });
  it.each([{ ...parent, id: other }, { ...parent, guild_id: other }, { ...parent, type: '0' }, {}])(
    'rejects unverified channel info %j',
    async (channel) => {
      const f = fixture();
      f.fetcher.mockResolvedValue(new Response(JSON.stringify(envelope({ ok: true, channel }))));
      await expect(
        f.reader(target, { action: 'channel-info', channelId: target.channelId })
      ).rejects.toThrow('GATEWAY_READ_UNVERIFIED');
    }
  );
  it.each([401, 403, 404, 429, 500])('does not retry or fall back on HTTP %i', async (status) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response('secret', { status }));
    await expect(f.service.channels()).rejects.toThrow('GATEWAY_HTTP_' + status);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('sanitizes transport failure without fallback', async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(new Error('secret'));
    await expect(f.service.channels()).rejects.toThrow('GATEWAY_READ_FAILED');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.runner).not.toHaveBeenCalled();
  });
});
describe('batched allowlist discovery', () => {
  it('uses metadata reads for preflight but retains CLI thread creation and agent run', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'discord-ask-read-test-'));
    try {
      const c = { ...config, stateDir };
      const fetcher = vi.fn(async (_url: any, options: any) => {
        const id = JSON.parse(options.body).args.channelId;
        return new Response(
          JSON.stringify(
            envelope({
              ok: true,
              channel:
                id === channel
                  ? parent
                  : { id: other, guild_id: guild, type: 11, parent_id: channel },
            })
          )
        );
      });
      const runner = vi.fn(async (_exe: string, args: string[]) =>
        args[0] === 'agent'
          ? { status: 'ok', runId: 'mock-run' }
          : { payload: { ok: true, thread: { id: other } } }
      );
      const service = new DiscordService(
        c,
        runner,
        undefined,
        undefined,
        channelReader(instances, c, fetcher)
      );
      expect(
        await service.ask({
          target: 'work',
          mode: 'new_thread',
          operation_id: 'reader-ask-test-001',
          title: 'Task',
          prompt: 'mock prompt',
        })
      ).toMatchObject({ status: 'completed', channel_id: other });
      expect(runner.mock.calls.map((call) => call[1].slice(0, 3))).toEqual([
        ['message', 'thread', 'create'],
        ['agent', '--agent', 'main'],
      ]);
      expect(runner.mock.calls[1][1]).toContain('--message-file');
      expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).args)).toEqual([
        { action: 'channel-info', channel: 'discord', accountId: 'bot', channelId: channel },
        { action: 'channel-info', channel: 'discord', accountId: 'bot', channelId: other },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    'groups all mapping dimensions, gateway=%s, and refreshes every request',
    async (gateway) => {
      const targets = Array.from({ length: 35 }, (_, i) => ({ ...target, name: 'work-' + i }));
      targets.push(
        { ...target, name: 'agent', agentId: 'second' },
        { ...target, name: 'account', accountId: 'second' },
        { ...target, name: 'guild', guildId: other }
      );
      const c = { ...config, targets };
      const reader = vi.fn(async (t: any) => ({
        ok: true,
        channels: [
          { ...parent, guild_id: t.guildId },
          { ...categoryData, guild_id: t.guildId },
        ],
      }));
      const runner = vi.fn(async (_exe: string, args: string[]) => ({
        payload: await reader({ guildId: args[args.indexOf('--guild-id') + 1] }),
      }));
      const service = new DiscordService(
        c,
        runner,
        undefined,
        undefined,
        gateway ? reader : undefined
      );
      expect((await service.channels()).channels).toHaveLength(38);
      expect(reader).toHaveBeenCalledTimes(4);
      await service.channels();
      expect(reader).toHaveBeenCalledTimes(8);
      if (gateway) expect(runner).not.toHaveBeenCalled();
      else expect(runner).toHaveBeenCalledTimes(8);
    }
  );
  it.each(
    [
      [],
      [parent],
      [parent, { ...categoryData, type: 0 }],
      [parent, { ...categoryData, guild_id: other }],
      [{ ...parent, guild_id: other }, categoryData],
      [{ ...parent, type: 11 }, categoryData],
      [parent, parent, categoryData],
      [null],
      [{ ...parent, name: { private: true } }, categoryData],
    ].map((channels) => ({ channels }))
  )('fails closed for missing, duplicate or invalid metadata %j', async ({ channels }) => {
    const f = fixture(config, channels);
    await expect(f.service.channels()).rejects.toThrow();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('reads category and created channel via Gateway, then rejects moved admission', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'discord-read-test-'));
    try {
      const policy = {
        name: 'projects',
        guildId: guild,
        categoryId: category,
        accountId: 'bot',
        agentId: 'main',
        instance: 'home',
      };
      const c = { ...config, stateDir, targets: [], creationPolicies: [policy] };
      const runner = vi.fn();
      const invoke = vi.fn(async () => ({ ok: true, channel: { id: channel } }));
      const fetcher = vi.fn(async (_url: any, options: any) => {
        const args = JSON.parse(options.body).args;
        return new Response(
          JSON.stringify(
            envelope(
              args.action === 'channel-list'
                ? { ok: true, channels: [{ ...parent, parent_id: other }, categoryData] }
                : { ok: true, channel: args.channelId === category ? categoryData : parent }
            )
          )
        );
      });
      const service = new DiscordService(
        c,
        runner,
        invoke,
        undefined,
        channelReader(instances, c, fetcher)
      );
      expect(
        await service.createChannel({
          policy: 'projects',
          operation_id: 'read-create-test-001',
          name: 'new-project',
          authorize_create: true,
          authorize_admission: true,
        })
      ).toMatchObject({ status: 'completed' });
      expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).args.channelId)).toEqual([
        category,
        channel,
      ]);
      await expect(service.channels()).rejects.toThrow('ADMITTED_CHANNEL_MOVED');
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
