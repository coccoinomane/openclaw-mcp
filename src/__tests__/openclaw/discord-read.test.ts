import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelReader, type DiscordReader } from '../../openclaw/discord-read.js';
import type { DiscordAgentTransport } from '../../openclaw/discord-agent.js';
import type { ThreadInvoker } from '../../openclaw/discord-thread.js';
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
  stateDir: '/unused-test-state',
  targets: [target],
  gatewayInstance: 'home',
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
function adapters() {
  return {
    invokeThread: vi.fn<ThreadInvoker>(async () => ({ thread: { id: other } })),
    agent: {
      ready: vi.fn<DiscordAgentTransport['ready']>(async () => {}),
      run: vi.fn<DiscordAgentTransport['run']>(async (request, accepted) => {
        const receipt = {
          runId: 'mock-run',
          sessionKey: request.sessionKey,
          agentId: request.agentId,
        };
        await accepted(receipt);
        return { ...receipt, status: 'ok' };
      }),
      cancel: vi.fn<DiscordAgentTransport['cancel']>(async () => {}),
    },
  };
}
function fixture(
  c = config,
  channels: any[] = [
    parent,
    categoryData,
    { ...parent, id: other, name: 'Do not expose', topic: 'private' },
  ]
) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope({ ok: true, channels }))));
  const { invokeThread, agent } = adapters();
  const reader = channelReader(instances, c, fetcher);
  return {
    fetcher,
    invokeThread,
    agent,
    reader,
    service: new DiscordService(
      c,
      undefined,
      undefined,
      reader,
      invokeThread,
      undefined,
      undefined,
      agent
    ),
  };
}
beforeEach(() => {
  // Clear inherited agent provenance; keep the production guard enabled.
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe('closed metadata reader', () => {
  it('enables HTTP reads with the required gateway instance and no opt-in', () => {
    const loaded = loadDiscordConfig({
      MCP_DISCORD_ENABLED: 'true',
      MCP_DISCORD_STATE_DIR: '/unused-test-state',
      MCP_DISCORD_TARGETS: JSON.stringify([target]),
      MCP_DISCORD_GATEWAY_INSTANCE: 'home',
    });
    expect(loaded?.gatewayInstance).toBe('home');
    expect(typeof channelReader(instances, loaded!)).toBe('function');
  });

  it.each([undefined, ''])('requires the gateway instance when enabled: %j', (instance) => {
    expect(() =>
      loadDiscordConfig({
        MCP_DISCORD_ENABLED: 'true',
        MCP_DISCORD_STATE_DIR: '/unused-test-state',
        MCP_DISCORD_TARGETS: JSON.stringify([target]),
        MCP_DISCORD_GATEWAY_INSTANCE: instance,
      })
    ).toThrow('DISCORD_GATEWAY_INSTANCE_REQUIRED');
  });

  it('uses fixed server instance, account and agent with no redirects', async () => {
    const f = fixture();
    const result = await f.service.channels();
    expect(result.channels).toEqual([
      {
        instance: 'home',
        agent_id: 'main',
        account_id: 'bot',
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
    expect(f.invokeThread).not.toHaveBeenCalled();
    expect(f.agent.ready).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it.each(['OPENCLAW_SHELL', 'OPENCLAW_AGENT_ID', 'OPENCLAW_SESSION_KEY', 'OPENCLAW_CALLER_ID'])(
    'denies %s provenance without fallback',
    async (key) => {
      const f = fixture();
      vi.stubEnv(key, 'agent-origin');
      await expect(f.service.channels()).rejects.toThrow('AGENT_PROVENANCE_DENIED');
      expect(process.env[key]).toBe('agent-origin');
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.invokeThread).not.toHaveBeenCalled();
      expect(f.agent.ready).not.toHaveBeenCalled();
      expect(f.agent.run).not.toHaveBeenCalled();
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
  it.each(['reader', 'invokeThread', 'agent'] as const)(
    'rejects startup when the %s adapter is missing',
    (missing) => {
      const { invokeThread, agent } = adapters();
      const reader = vi.fn<DiscordReader>();
      expect(
        () =>
          new DiscordService(
            config,
            undefined,
            undefined,
            missing === 'reader' ? undefined : reader,
            missing === 'invokeThread' ? undefined : invokeThread,
            undefined,
            undefined,
            missing === 'agent' ? undefined : agent
          )
      ).toThrow(missing === 'invokeThread' ? 'THREAD_ADAPTER_REQUIRED' : 'SDK_ADAPTER_REQUIRED');
      expect(reader).not.toHaveBeenCalled();
      expect(invokeThread).not.toHaveBeenCalled();
      expect(agent.ready).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
      expect(agent.cancel).not.toHaveBeenCalled();
    }
  );

  it('rejects an absent gateway mapping instead of disabling HTTP reads', () => {
    expect(() =>
      channelReader(instances, {
        ...config,
        gatewayInstance: undefined,
      } as unknown as DiscordConfig)
    ).toThrow('READ_GATEWAY_CONFIGURATION_INVALID');
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
    expect(f.invokeThread).not.toHaveBeenCalled();
    expect(f.agent.ready).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
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
    expect(f.invokeThread).not.toHaveBeenCalled();
    expect(f.agent.ready).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it('sanitizes transport failure without fallback', async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(new Error('secret'));
    await expect(f.service.channels()).rejects.toThrow('GATEWAY_READ_FAILED');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.invokeThread).not.toHaveBeenCalled();
    expect(f.agent.ready).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
  });
});
describe('batched allowlist discovery', () => {
  it('uses HTTP metadata reads for preflight with direct thread creation and SDK dispatch', async () => {
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
      const { invokeThread, agent } = adapters();
      const service = new DiscordService(
        c,
        undefined,
        undefined,
        channelReader(instances, c, fetcher),
        invokeThread,
        undefined,
        async (_t, _id, _p, _op, sent) => {
          await sent('300000000000000005');
        },
        agent
      );
      expect(
        await service.ask({
          target: 'work',
          mode: 'new_thread',
          operation_id: 'reader-ask-test-001',
          title: 'Task',
          prompt: 'mock prompt',
        })
      ).toMatchObject({ status: 'queued', channel_id: other });
      await service.drain();
      expect(invokeThread).toHaveBeenCalledTimes(1);
      expect(invokeThread).toHaveBeenCalledWith(target, 'Task', 'reader-ask-test-001');
      expect(agent.ready).toHaveBeenCalledTimes(1);
      expect(agent.ready.mock.invocationCallOrder[0]).toBeLessThan(
        invokeThread.mock.invocationCallOrder[0]
      );
      expect(invokeThread.mock.invocationCallOrder[0]).toBeLessThan(
        agent.run.mock.invocationCallOrder[0]
      );
      expect(agent.run).toHaveBeenCalledTimes(1);
      expect(agent.run).toHaveBeenCalledWith(
        {
          message: 'mock prompt',
          agentId: 'main',
          sessionKey: 'agent:main:discord:channel:' + other,
          threadId: other,
          accountId: 'bot',
          idempotencyKey: expect.any(String),
        },
        expect.any(Function)
      );
      expect(agent.cancel).not.toHaveBeenCalled();
      expect(await service.status('reader-ask-test-001')).toMatchObject({
        status: 'completed',
        run_id: 'mock-run',
        agent_transport: 'sdk',
        thread_create_transport: 'gateway',
      });
      expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).args)).toEqual([
        { action: 'channel-info', channel: 'discord', accountId: 'bot', channelId: channel },
        { action: 'channel-info', channel: 'discord', accountId: 'bot', channelId: other },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('groups all mapping dimensions and refreshes every request', async () => {
    const targets = Array.from({ length: 35 }, (_, i) => ({ ...target, name: 'work-' + i }));
    targets.push(
      { ...target, name: 'agent', agentId: 'second' },
      { ...target, name: 'account', accountId: 'second' },
      { ...target, name: 'guild', guildId: other }
    );
    const c = { ...config, targets };
    const reader = vi.fn<DiscordReader>(async (t) => ({
      ok: true,
      channels: [
        { ...parent, guild_id: t.guildId },
        { ...categoryData, guild_id: t.guildId },
      ],
    }));
    const { invokeThread, agent } = adapters();
    const service = new DiscordService(
      c,
      undefined,
      undefined,
      reader,
      invokeThread,
      undefined,
      undefined,
      agent
    );
    expect((await service.channels()).channels).toHaveLength(38);
    expect(reader).toHaveBeenCalledTimes(4);
    expect(
      reader.mock.calls.map(([scope, request]) => [
        scope.guildId,
        scope.accountId,
        scope.agentId,
        request,
      ])
    ).toEqual([
      [guild, 'bot', 'main', { action: 'channel-list' }],
      [guild, 'bot', 'second', { action: 'channel-list' }],
      [guild, 'second', 'main', { action: 'channel-list' }],
      [other, 'bot', 'main', { action: 'channel-list' }],
    ]);
    await service.channels();
    expect(reader).toHaveBeenCalledTimes(8);
    expect(invokeThread).not.toHaveBeenCalled();
    expect(agent.ready).not.toHaveBeenCalled();
    expect(agent.run).not.toHaveBeenCalled();
  });
  it.each(
    [
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
    expect(f.invokeThread).not.toHaveBeenCalled();
    expect(f.agent.ready).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
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
      const { invokeThread, agent } = adapters();
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
        invoke,
        undefined,
        channelReader(instances, c, fetcher),
        invokeThread,
        undefined,
        undefined,
        agent
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
      expect(invokeThread).not.toHaveBeenCalled();
      expect(agent.ready).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
