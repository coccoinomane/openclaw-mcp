import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { requestPublisher } from '../../openclaw/discord-request.js';
import { handleDiscord } from '../../mcp/tools/discord.js';
import type { DiscordAgentTransport } from '../../openclaw/discord-agent.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../../openclaw/gateway-discovery.js', () => ({
  discoverGatewayAgents: vi.fn(),
  discoverGatewayConfig: vi.fn(),
}));
import { discoverGatewayAgents, discoverGatewayConfig } from '../../openclaw/gateway-discovery.js';
import { OpenClawGateway } from '../../openclaw/gateway.js';
import { DiscordAccess } from '../../openclaw/discord-bindings.js';
import { DiscordService } from '../../openclaw/discord.js';
import {
  DiscordError,
  verifyGuildManageChannels,
  channelInvoker,
} from '../../openclaw/discord-channels.js';
const guild = '700000000000000001',
  parent = '700000000000000002',
  thread = '700000000000000003',
  other = '700000000000000004',
  category = '700000000000000005';
const args = {
  channel_id: parent,
  server_id: guild,
  discord_account_id: 'bot',
  agent_id: 'b',
  operation_id: 'agent-first-write-0001',
  prompt: 'hello',
};
let bindings: any[];
const dirs: string[] = [],
  services: DiscordService[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
  vi.mocked(discoverGatewayAgents).mockResolvedValue({ agents: [{ id: 'a' }, { id: 'b' }] });
  bindings = [
    { agentId: 'a', match: { channel: 'discord', accountId: 'bot', guildId: guild } },
    {
      agentId: 'b',
      match: {
        channel: 'discord',
        accountId: 'bot',
        guildId: guild,
        peer: { kind: 'channel', id: parent },
      },
    },
  ];
  vi.mocked(discoverGatewayConfig).mockImplementation(async () => ({
    valid: true,
    configRevisionHash: 'r',
    appliedConfigHash: 'r',
    config: { bindings, channels: { discord: { accounts: { bot: {} } } } },
  }));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.drain()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
async function fixture(existingStateDir?: string, integratedPublisher = false) {
  const stateDir = existingStateDir ?? (await mkdtemp(join(tmpdir(), 'agent-first-writes-')));
  if (!existingStateDir) dirs.push(stateDir);
  const metadata = (id: string) => ({
    id,
    guild_id: guild,
    name: id,
    type: id === thread ? 11 : id === category ? 4 : 0,
    parent_id: id === thread ? parent : undefined,
    thread_metadata: { locked: false, archived: false },
  });
  const permissions = [
    'ViewChannel',
    'SendMessages',
    'ReadMessageHistory',
    'CreatePublicThreads',
    'SendMessagesInThreads',
    'AttachFiles',
  ];
  const reader = vi.fn(async (_t: any, r: any) => ({
    channel: metadata(r.channelId),
    channels: [metadata(parent), metadata(other)],
    permissions: {
      channelId: r.channelId,
      guildId: guild,
      channelType: r.channelId === thread ? 11 : 0,
      isDm: false,
      permissions,
    },
  }));
  const access = new DiscordAccess(
    new OpenClawGateway({ url: 'https://fixture.invalid', defaultAgentId: 'a' }),
    reader
  );
  const create = vi.fn(async () => ({ thread: { id: thread } }));
  const publish = vi.fn(
    async (_t: any, _id: string, _p: string, _op: string, sent: (id: string) => Promise<void>) => {
      await sent(other);
    }
  );
  const run = vi.fn<DiscordAgentTransport['run']>(async () => ({ status: 'ok' }));
  const forkSession = vi.fn(async () => {});
  const createChannel = vi.fn(async () => ({ channel: { id: other } }));
  const config = {
    stateDir,
    access,
    channelCreateEnabled: true,
    threadMember: { userId: other, accountId: 'bot' },
  };
  let posted: any;
  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const payload = JSON.parse(init.body as string);
      posted = {
        id: other,
        channel_id: String(url).split('/channels/')[1].split('/')[0],
        author: { id: category, bot: true },
        content: payload.content,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
      };
    }
    return Response.json(posted);
  });
  const service = new DiscordService(
    { stateDir, access, channelCreateEnabled: true },
    createChannel,
    reader,
    create,
    undefined,
    integratedPublisher
      ? requestPublisher(config, { DISCORD_BOT_TOKEN: 'fixture' }, fetcher)
      : publish,
    { ready: async () => {}, run, cancel: async () => {}, forkSession }
  );
  services.push(service);
  return {
    service,
    fetcher,
    reader,
    create,
    publish,
    run,
    forkSession,
    permissions,
    createChannel,
    stateDir,
  };
}
describe('binding checks on writes', () => {
  it('rejects parent-channel reply before effects but sends through the production publisher', async () => {
    const f = await fixture(undefined, true);
    const denied = await handleDiscord(f.service, 'openclaw_discord_reply', {
      ...args,
      thread_id: parent,
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('PUBLIC_THREAD_REQUIRED');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(await readdir(f.stateDir)).toEqual([]);
    const sent = await handleDiscord(f.service, 'openclaw_discord_send', args);
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent).toMatchObject({
      status: 'queued',
      channel_id: parent,
      agent_id: 'b',
      request_verified: true,
    });
    await f.service.drain();
    expect(f.fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://discord.com/api/v10/channels/' + parent + '/messages', 'POST'],
      ['https://discord.com/api/v10/channels/' + parent + '/messages/' + other, 'GET'],
    ]);
    expect(JSON.parse(f.fetcher.mock.calls[0][1]!.body as string)).toMatchObject({
      content: args.prompt,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
      enforce_nonce: true,
    });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0][0]).toMatchObject({
      agentId: 'b',
      threadId: parent,
      sessionKey: 'agent:b:discord:channel:' + parent,
      accountId: 'bot',
      message: args.prompt,
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each(['a', 'b'])(
    'permits %s on the shared channel, thread and same-agent fork',
    async (agent_id) => {
      const f = await fixture();
      const result = await f.service.ask({
        ...args,
        agent_id,
        thread_name: 'Task',
        fork_from_session_key: 'agent:' + agent_id + ':mcp:source',
        source: 'Editor',
      });
      expect(result.status).toBe('queued');
      await f.service.drain();
      expect(f.run).toHaveBeenCalledOnce();
      expect(f.forkSession).toHaveBeenCalledOnce();
      expect(f.publish.mock.calls[0][0].agentId).toBe(agent_id);
      const reply = await f.service.reply({
        ...args,
        agent_id,
        thread_id: thread,
        operation_id: 'agent-first-reply-0001',
      });
      expect(reply.status).toBe('queued');
      await f.service.drain();
      const send = await f.service.send({
        ...args,
        agent_id,
        operation_id: 'agent-first-send-00001',
      });
      expect(send.status).toBe('queued');
      await f.service.drain();
      expect(f.publish.mock.calls[2][1]).toBe(parent);
    }
  );
  it('denies direct other-channel IDs and cross-agent forks before effects', async () => {
    const f = await fixture();
    await expect(f.service.send({ ...args, channel_id: other })).rejects.toThrow('BINDING');
    await expect(
      f.service.ask({
        ...args,
        thread_name: 'Task',
        fork_from_session_key: 'agent:a:mcp:source',
      })
    ).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('checks ancestry and permissions, even for inherited thread access', async () => {
    const f = await fixture();
    f.permissions.splice(0);
    const result = await f.service.reply({ ...args, thread_id: thread });
    expect(result.status).toBe('run_failed');
    expect(f.publish).not.toHaveBeenCalled();
    const g = await fixture();
    const read = g.reader.getMockImplementation()!;
    g.reader.mockImplementation(async (t, r) => {
      const v = await read(t, r);
      if (r.channelId === thread) v.channel.parent_id = other;
      return v;
    });
    expect((await g.service.reply({ ...args, thread_id: thread })).status).toBe('run_failed');
    expect(g.publish).not.toHaveBeenCalled();
  });
  it('rechecks removal after thread creation and never publishes or runs', async () => {
    const f = await fixture();
    f.create.mockImplementation(async () => {
      bindings = [];
      return { thread: { id: thread } };
    });
    const r = await f.service.ask({ ...args, thread_name: 'Task' });
    expect(r.status).toBe('run_failed');
    expect(r.thread_id).toBe(thread);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('rechecks removal after publication before agent dispatch and retains evidence', async () => {
    const f = await fixture();
    f.publish.mockImplementation(async (_t, _id, _p, _op, sent) => {
      await sent(other);
      bindings = [];
    });
    expect((await f.service.reply({ ...args, thread_id: thread })).status).toBe('queued');
    await f.service.drain();
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.service.status(args.operation_id, { agent_id: 'b' })).toMatchObject({
      status: 'run_failed',
      request_verified: true,
    });
  });
  it('preserves idempotency and uncertain outcomes through restart', async () => {
    const f = await fixture();
    f.create.mockRejectedValue(new DiscordError('GATEWAY_OUTCOME_UNKNOWN', true));
    const input = { ...args, thread_name: 'Task' };
    const first = await f.service.ask(input);
    expect(first.status).toBe('creation_unknown');
    expect(await f.service.ask(input)).toEqual(first);
    expect(f.create).toHaveBeenCalledOnce();
    const record = JSON.parse(
      await readFile(join(f.stateDir, args.operation_id + '.json'), 'utf8')
    );
    expect(record.agent_id).toBe('b');
    await f.service.drain();
    const restarted = await fixture(f.stateDir);
    expect(restarted.service).not.toBe(f.service);
    expect(await restarted.service.ask(input)).toEqual(first);
    bindings = [];
    expect(await restarted.service.status(args.operation_id, { agent_id: 'b' })).toEqual(first);
    await expect(restarted.service.ask(input)).rejects.toThrow('BINDING');
    expect(restarted.create).not.toHaveBeenCalled();
    expect(restarted.publish).not.toHaveBeenCalled();
    expect(restarted.run).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(f.stateDir, args.operation_id + '.json'), 'utf8'))
    ).toEqual(record);
  });
  it.each(['reply', 'send'] as const)(
    'retains persisted uncertain %s and session lock across restart and binding changes',
    async (mode) => {
      const f = await fixture();
      f.run.mockRejectedValue(new DiscordError('SDK_OUTCOME_UNKNOWN', true));
      const input = mode === 'reply' ? { ...args, thread_id: thread } : args;
      expect((await f.service[mode](input)).status).toBe('queued');
      await f.service.drain();
      const before = await f.service.status(args.operation_id, { agent_id: 'b' });
      expect(before).toMatchObject({
        status: 'run_unknown',
        request_verified: true,
        agent_id: 'b',
      });
      const recordPath = join(f.stateDir, args.operation_id + '.json');
      const record = await readFile(recordPath, 'utf8');
      const locks = (await readdir(f.stateDir)).filter((p) => p.endsWith('.lock'));
      expect(locks).toHaveLength(1);
      const lockPath = join(f.stateDir, locks[0]);
      const lock = await readFile(lockPath, 'utf8');
      expect(JSON.parse(lock).operation_id).toBe(args.operation_id);
      bindings = bindings.filter((b) => b.agentId !== 'b');
      const restarted = await fixture(f.stateDir);
      expect(await restarted.service.status(args.operation_id, { agent_id: 'b' })).toEqual(before);
      await expect(restarted.service.status(args.operation_id, { agent_id: 'a' })).rejects.toThrow(
        'ROUTE_SELECTOR_CONFLICT'
      );
      await expect(restarted.service[mode](input)).rejects.toThrow('BINDING');
      await expect(
        restarted.service[mode]({ ...input, operation_id: 'denied-after-restart-01' })
      ).rejects.toThrow('BINDING');
      bindings.push({
        agentId: 'b',
        match: { channel: 'discord', accountId: 'bot', guildId: guild },
      });
      expect(await restarted.service[mode](input)).toEqual(before);
      expect(
        await restarted.service[mode]({ ...input, operation_id: 'blocked-after-restart-01' })
      ).toMatchObject({ status: 'run_failed', error_code: 'SESSION_BUSY_OR_UNCERTAIN' });
      await restarted.service.drain();
      expect(restarted.publish).not.toHaveBeenCalled();
      expect(restarted.run).not.toHaveBeenCalled();
      expect(restarted.create).not.toHaveBeenCalled();
      expect(await readFile(recordPath, 'utf8')).toBe(record);
      expect(await readFile(lockPath, 'utf8')).toBe(lock);
      expect(f.publish).toHaveBeenCalledOnce();
      expect(f.run).toHaveBeenCalledOnce();
    }
  );
  it('creates channels only with guild binding; supports no category and durable replay', async () => {
    const f = await fixture();
    const input = {
      agent_id: 'b',
      server_id: guild,
      discord_account_id: 'bot',
      operation_id: 'agent-first-create-001',
      channel_name: 'new',
      authorize_create: true,
    };
    await expect(f.service.createChannel(input)).rejects.toThrow('GUILD_BINDING');
    expect(f.createChannel).not.toHaveBeenCalled();
    const created = await f.service.createChannel({ ...input, agent_id: 'a' });
    expect(created.status).toBe('completed');
    expect(await f.service.createChannel({ ...input, agent_id: 'a' })).toEqual(created);
    expect(f.createChannel).toHaveBeenCalledOnce();
    await expect(
      f.service.createChannel({ ...input, agent_id: 'a', channel_name: 'different' })
    ).rejects.toThrow('CONFLICT');
  });
  it('denies unsupported conditions without effects', async () => {
    const f = await fixture();
    bindings = [
      {
        agentId: 'b',
        match: { channel: 'discord', accountId: 'bot', guildId: guild, roles: ['role'] },
      },
    ];
    await expect(f.service.reply({ ...args, thread_id: thread })).rejects.toThrow('BINDING');
    expect(f.publish).not.toHaveBeenCalled();
  });
});
describe('guild-level Discord permissions', () => {
  it('does not create after bindings are revoked during permission preflight', async () => {
    const fetcher = vi.fn(async (url: any) =>
      Response.json(
        String(url).endsWith('users/@me')
          ? { id: other, bot: true }
          : String(url).endsWith('/roles')
            ? [{ id: guild, permissions: '16' }]
            : { user: { id: other }, roles: [] }
      )
    );
    const invoke = channelInvoker(
      { url: 'http://127.0.0.1:18789', token: 'fixture' },
      fetcher,
      { DISCORD_BOT_TOKEN: 'fixture', MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID: 'bot' },
      async () => {
        throw new DiscordError('GUILD_BINDING_REQUIRED');
      }
    );
    await expect(
      invoke(
        { agentId: 'a', accountId: 'bot', guildId: guild },
        'new',
        undefined,
        'operation-create-0001'
      )
    ).rejects.toThrow('GUILD_BINDING_REQUIRED');
    expect(fetcher.mock.calls.every((c) => String(c[0]).startsWith('https://discord.com/'))).toBe(
      true
    );
  });
  it.each(['16', '8', '0'])('checks actual bot roles for bits %s', async (bits) => {
    const fetcher = vi.fn(async (url: any) =>
      Response.json(
        String(url).endsWith('users/@me')
          ? { id: other, bot: true }
          : String(url).endsWith('/roles')
            ? [{ id: guild, permissions: bits }]
            : { user: { id: other }, roles: [] }
      )
    );
    const result = verifyGuildManageChannels(
      { agentId: 'a', accountId: 'bot', guildId: guild },
      { DISCORD_BOT_TOKEN: 'fixture', MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID: 'bot' },
      fetcher
    );
    if (bits === '0') await expect(result).rejects.toThrow('DENIED');
    else await expect(result).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
