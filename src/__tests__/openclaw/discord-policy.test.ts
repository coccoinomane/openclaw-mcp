import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordService, loadDiscordConfig, type DiscordConfig } from '../../openclaw/discord.js';
import { dynamicTarget } from '../../openclaw/discord-policy.js';
import { channelReader } from '../../openclaw/discord-read.js';
import { threadInvoker, threadMemberAdder } from '../../openclaw/discord-thread.js';
import { requestPublisher } from '../../openclaw/discord-request.js';

const guild = '700000000000000001',
  channel = '700000000000000002',
  inbox = '700000000000000003',
  category = '700000000000000004',
  thread = '700000000000000005',
  future = '700000000000000006';
const scope = { guildId: guild, accountId: 'bot', agentId: 'main', normalRouting: true };
const parent = { id: channel, guild_id: guild, type: 0, name: 'Work', parent_id: category };
const cat = { id: category, guild_id: guild, type: 4, name: 'Projects' };
const instances = [{ name: 'home', url: 'http://127.0.0.1:18789', token: 'mock' }];
const dirs: string[] = [];
const services: DiscordService[] = [];
const input = (target: string) => ({
  target,
  mode: 'new_thread',
  title: 'Task',
  prompt: 'Exact request',
  operation_id: 'policy-test-operation-001',
});
async function fixture(overrides: Partial<DiscordConfig> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'discord-policy-'));
  dirs.push(stateDir);
  const config: DiscordConfig = {
    executable: 'never-executed',
    stateDir,
    targets: [],
    discoveryScopes: [scope],
    channelWhitelist: [],
    channelBlacklist: [],
    gatewayReadsEnabled: true,
    cliGatewayInstance: 'home',
    acknowledgeInboundRouting: true,
    ...overrides,
  };
  const data: any[] = [parent, cat, { ...parent, id: inbox, name: 'Inbox' }];
  const reader = vi.fn(async (s: any, request: any) =>
    request.action === 'channel-list'
      ? { ok: true, channels: data }
      : {
          ok: true,
          channel:
            request.channelId === thread
              ? { id: thread, guild_id: s.guildId, type: 11, parent_id: channel }
              : data.find((c) => c.id === request.channelId),
        }
  );
  const runner = vi.fn(async (_exe: string, args: string[]) =>
    args[0] === 'agent' ? { status: 'ok' } : { payload: { ok: true, thread: { id: thread } } }
  );
  const publish = vi.fn(
    async (_t: any, _id: string, _p: string, _op: string, sent: (id: string) => Promise<void>) => {
      await sent(future);
    }
  );
  const invoke = vi.fn(async () => ({ ok: true, channel: { id: future } }));
  const service = new DiscordService(
    config,
    runner,
    invoke,
    undefined,
    reader,
    undefined,
    undefined,
    publish
  );
  services.push(service);
  return { config, data, reader, runner, publish, invoke, service };
}
beforeEach(() => {
  // Test doubles only; do not alter production provenance.
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.drain()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
describe('scoped channel discovery', () => {
  it('discovers all supported parents with an empty whitelist, never categories, voice or threads', async () => {
    const f = await fixture();
    f.data.push(
      ...[2, 10, 11, 12, 13, 99, 5, 15, 16].map((type, i) => ({
        ...parent,
        id: String(700000000000000020n + BigInt(i)),
        type,
      }))
    );
    const result = await f.service.channels();
    expect(result.channels).toHaveLength(5);
    expect(result.channels[0]).toMatchObject({
      target: dynamicTarget(scope, channel).name,
      category_name: 'Projects',
    });
    expect(f.reader).toHaveBeenCalledTimes(1);
  });
  it.each([[channel], [channel, inbox]])(
    'applies whitelist %j and blacklist precedence',
    async (...args) => {
      const whitelist = args as string[];
      const f = await fixture({ channelWhitelist: whitelist, channelBlacklist: [inbox] });
      expect((await f.service.channels()).channels.map((c) => c.channel_id)).toEqual([channel]);
    }
  );
  it('refreshes future, renamed and deleted channels with stable IDs', async () => {
    const f = await fixture();
    const first = (await f.service.channels()).channels[0];
    f.data[0] = { ...parent, name: 'Renamed' };
    f.data.push({ ...parent, id: future, name: 'Future' });
    const second = (await f.service.channels()).channels;
    expect(second[0]).toMatchObject({ target: first.target, name: 'Renamed' });
    expect(second.at(-1)?.channel_id).toBe(future);
    f.data.splice(0, 1);
    expect((await f.service.channels()).channels.map((c) => c.channel_id)).not.toContain(channel);
    const denied = await f.service.ask(input(first.target));
    expect(denied.status).toBe('run_failed');
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('keeps legacy aliases and skips deleted legacy entries without enabling guild discovery', async () => {
    const f = await fixture({
      discoveryScopes: [],
      targets: [
        { ...scope, name: 'old', channelId: channel },
        { ...scope, name: 'deleted', channelId: future },
      ],
    });
    expect((await f.service.channels()).channels.map((c) => c.target)).toEqual(['old']);
  });
  it('lists each configured guild/account/agent independently', async () => {
    const scopes = [
      scope,
      { ...scope, guildId: future },
      { ...scope, accountId: 'second' },
      { ...scope, agentId: 'second' },
    ];
    const f = await fixture({ discoveryScopes: scopes });
    f.reader.mockImplementation(async (s) => ({
      ok: true,
      channels: [{ ...parent, parent_id: null, guild_id: s.guildId }],
    }));
    const result = await f.service.channels();
    expect(new Set(result.channels.map((c) => c.target)).size).toBe(4);
    expect(f.reader).toHaveBeenCalledTimes(4);
    await expect(
      f.service.ask(input(dynamicTarget({ ...scope, guildId: inbox }, channel).name))
    ).rejects.toThrow();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...parent, guild_id: future },
    { ...parent, type: '0' },
    { ...parent, id: 12 },
    { ...parent, name: {} },
  ])('rejects malformed or foreign metadata %j', async (bad) => {
    const f = await fixture();
    f.data.splice(0, f.data.length, bad, cat);
    await expect(f.service.channels()).rejects.toThrow();
  });
  it('authorizes explicit scopes in the Gateway reader, but not foreign scopes', async () => {
    const f = await fixture();
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { details: { ok: true, channels: f.data } } })
        )
    );
    const reader = channelReader(instances, f.config, fetcher)!;
    await reader(scope, { action: 'channel-list' });
    await expect(reader({ ...scope, guildId: future }, { action: 'channel-list' })).rejects.toThrow(
      'READ_SCOPE_DENIED'
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe('operation policy enforcement', () => {
  it('excludes Inbox from discovery and denies crafted IDs and legacy aliases before effects', async () => {
    const f = await fixture({
      channelBlacklist: [inbox],
      targets: [{ ...scope, name: 'old-inbox', channelId: inbox }],
    });
    expect((await f.service.channels()).channels.map((c) => c.channel_id)).toEqual([channel]);
    f.reader.mockClear();
    for (const name of ['old-inbox', dynamicTarget(scope, inbox).name]) {
      await expect(f.service.ask(input(name))).rejects.toThrow('CHANNEL_POLICY_DENIED');
      await expect(f.service.threads({ target: name })).rejects.toThrow('CHANNEL_POLICY_DENIED');
    }
    expect(f.reader).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await readdir(f.config.stateDir)).toEqual([]);
  });
  it('cannot bypass whitelist with a crafted target', async () => {
    const f = await fixture({ channelWhitelist: [channel] });
    await expect(f.service.ask(input(dynamicTarget(scope, inbox).name))).rejects.toThrow(
      'CHANNEL_POLICY_DENIED'
    );
    expect(f.reader).not.toHaveBeenCalled();
  });
  it('denies admitted-created aliases and their dynamic equivalents', async () => {
    const policy = { ...scope, name: 'projects', categoryId: category, instance: 'home' };
    const f = await fixture({ creationPolicies: [policy], channelBlacklist: [inbox] });
    await writeFile(
      join(f.config.stateDir, 'created-policy-test-001.json'),
      JSON.stringify({
        kind: 'channel_create',
        status: 'completed',
        policy: policy.name,
        policy_digest: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
        channel_id: inbox,
      })
    );
    expect((await f.service.channels()).channels.map((c) => c.channel_id)).toEqual([channel]);
    for (const target of ['created-' + inbox, dynamicTarget(scope, inbox).name])
      await expect(f.service.ask(input(target))).rejects.toThrow('CHANNEL_POLICY_DENIED');
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('rejects a thread posing as a parent, including one under Inbox', async () => {
    const f = await fixture({ channelBlacklist: [inbox] });
    f.data.push({ id: future, guild_id: guild, type: 11, parent_id: inbox, name: 'Thread' });
    expect((await f.service.ask(input(dynamicTarget(scope, future).name))).status).toBe(
      'run_failed'
    );
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('denies excluded returned thread IDs before membership, publishing or generation', async () => {
    const f = await fixture({ channelBlacklist: [thread] });
    expect(await f.service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      status: 'run_failed',
      error_code: 'CHANNEL_POLICY_DENIED',
    });
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each([15, 16])('preserves forum/media rejection %s', async (type) => {
    const f = await fixture();
    f.data[0] = { ...parent, type };
    expect(await f.service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      error_code: 'FORUM_MEDIA_WRITES_UNSUPPORTED',
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('runs allowed dynamic targets without altering prompt or background handoff', async () => {
    const f = await fixture();
    expect(await f.service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      status: 'queued',
      channel_id: thread,
    });
    await f.service.drain();
    expect(f.publish.mock.calls[0][2]).toBe('Exact request');
    expect(f.runner.mock.calls[1][1][0]).toBe('agent');
  });
  it('enforces policy in every closed write adapter before HTTP', async () => {
    const f = await fixture({ channelBlacklist: [inbox], threadMember: undefined });
    const config = {
      ...f.config,
      threadCreateMode: 'gateway' as const,
      threadMember: { userId: future, accountId: 'bot' },
    };
    const fetcher = vi.fn();
    const t = dynamicTarget(scope, inbox);
    await expect(
      threadInvoker(instances, config, fetcher)!(t, 'Task', 'policy-operation-001')
    ).rejects.toThrow('CHANNEL_POLICY_DENIED');
    await expect(
      threadMemberAdder(config, { DISCORD_BOT_TOKEN: 'mock' }, fetcher)!(t, thread)
    ).rejects.toThrow('CHANNEL_POLICY_DENIED');
    await expect(
      requestPublisher(config, { DISCORD_BOT_TOKEN: 'mock' }, fetcher)!(
        t,
        thread,
        'Exact',
        'policy-operation-001',
        vi.fn()
      )
    ).rejects.toThrow('CHANNEL_POLICY_DENIED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('policy interactions', () => {
  it('filters blacklisted threads and denies forged parent ancestry before publication', async () => {
    const f = await fixture({ channelBlacklist: [inbox] });
    f.reader.mockImplementation(async (_s, req) => ({
      ok: true,
      channel:
        req.channelId === channel
          ? parent
          : { id: thread, guild_id: guild, type: 11, parent_id: inbox },
    }));
    expect(await f.service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      error_code: 'CHANNEL_POLICY_DENIED',
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.runner).toHaveBeenCalledTimes(1);
    const g = await fixture({ channelBlacklist: [thread] });
    g.runner.mockResolvedValue({
      payload: {
        threads: [{ id: thread, guild_id: guild, type: 11, parent_id: channel, name: 'Excluded' }],
      },
    } as any);
    expect(
      (await g.service.threads({ target: dynamicTarget(scope, channel).name })).threads
    ).toEqual([]);
  });
  it('does not allow discovery-only scopes to write without routing acknowledgement', async () => {
    const f = await fixture({ discoveryScopes: [{ ...scope, normalRouting: false }] });
    expect((await f.service.channels()).channels).toHaveLength(2);
    expect(await f.service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      error_code: 'NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('retains a legacy routing restriction for a crafted dynamic alias', async () => {
    const f = await fixture({
      targets: [{ ...scope, name: 'special', channelId: channel, normalRouting: false }],
    });
    expect(await f.service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      error_code: 'NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED',
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('retains admitted category checks for a crafted dynamic alias', async () => {
    const policy = { ...scope, name: 'projects', categoryId: category, instance: 'home' };
    const f = await fixture({ creationPolicies: [policy] });
    await writeFile(
      join(f.config.stateDir, 'created-policy-test-002.json'),
      JSON.stringify({
        kind: 'channel_create',
        status: 'completed',
        policy: policy.name,
        policy_digest: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
        channel_id: channel,
      })
    );
    f.data[0] = { ...parent, parent_id: future };
    expect(await f.service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      error_code: 'ADMITTED_CHANNEL_MOVED',
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('denies blacklisted categories before channel creation effects', async () => {
    const policy = { ...scope, name: 'projects', categoryId: category, instance: 'home' };
    const f = await fixture({ creationPolicies: [policy], channelBlacklist: [category] });
    await expect(
      f.service.createChannel({
        policy: 'projects',
        operation_id: 'create-policy-test-001',
        name: 'project',
        authorize_create: true,
        authorize_admission: true,
      })
    ).rejects.toThrow('CHANNEL_POLICY_DENIED');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.reader).not.toHaveBeenCalled();
  });
  it('preserves allowed category creation and admits the resulting channel', async () => {
    const policy = { ...scope, name: 'projects', categoryId: category, instance: 'home' };
    const f = await fixture({ creationPolicies: [policy] });
    f.data.push({ ...parent, id: future, name: 'New' });
    expect(
      await f.service.createChannel({
        policy: 'projects',
        operation_id: 'create-policy-test-002',
        name: 'project',
        authorize_create: true,
        authorize_admission: true,
      })
    ).toMatchObject({ status: 'completed' });
    expect(
      (await f.service.channels()).channels.some((c) => c.target === 'created-' + future)
    ).toBe(true);
  });
  it('rejects route mismatch before creating a dynamic-target thread', async () => {
    const f = await fixture();
    const route = vi.fn(async (t, id) => ({
      ...t,
      channelId: id,
      agentId: 'other',
      sessionKey: 'wrong',
      kind: 'ordinary' as const,
    }));
    const service = new DiscordService(
      f.config,
      f.runner,
      undefined,
      route,
      f.reader,
      undefined,
      undefined,
      f.publish
    );
    services.push(service);
    expect(await service.ask(input(dynamicTarget(scope, channel).name))).toMatchObject({
      error_code: 'ROUTE_MISMATCH',
    });
    expect(f.runner).not.toHaveBeenCalled();
  });
  it('admits dynamic scopes in the Gateway thread, membership and publisher adapters', async () => {
    const f = await fixture();
    const config = {
      ...f.config,
      threadCreateMode: 'gateway' as const,
      threadMember: { userId: future, accountId: 'bot' },
    };
    const fetcher = vi.fn(async () => new Response('', { status: 403 }));
    const t = dynamicTarget(scope, channel);
    await expect(
      threadInvoker(instances, config, fetcher)!(t, 'Task', 'policy-operation-002')
    ).rejects.toThrow('GATEWAY_HTTP_403');
    await expect(
      threadMemberAdder(config, { DISCORD_BOT_TOKEN: 'mock' }, fetcher)!(t, thread)
    ).rejects.toThrow('THREAD_MEMBER_HTTP_403');
    await expect(
      requestPublisher(config, { DISCORD_BOT_TOKEN: 'mock' }, fetcher)!(
        t,
        thread,
        'Exact',
        'policy-operation-002',
        vi.fn()
      )
    ).rejects.toThrow('REQUEST_HTTP_403');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('does not replay an accepted operation after its parent is excluded', async () => {
    const f = await fixture();
    const request = input(dynamicTarget(scope, channel).name);
    await f.service.ask(request);
    await f.service.drain();
    f.config.channelBlacklist = [channel];
    f.runner.mockClear();
    await expect(f.service.ask(request)).rejects.toThrow('CHANNEL_POLICY_DENIED');
    await expect(f.service.status(request.operation_id)).rejects.toThrow('CHANNEL_POLICY_DENIED');
    expect(f.runner).not.toHaveBeenCalled();
  });
});
describe('configuration validation', () => {
  const env = {
    MCP_DISCORD_ENABLED: 'true',
    MCP_DISCORD_STATE_DIR: '/unused-test-state',
    MCP_DISCORD_DISCOVERY_SCOPES: JSON.stringify([scope]),
  };
  it('is off by default and never discovers without explicit scopes', () => {
    expect(loadDiscordConfig({})).toBeUndefined();
    expect(() => loadDiscordConfig({ ...env, MCP_DISCORD_DISCOVERY_SCOPES: '[]' })).toThrow();
    expect(() => loadDiscordConfig({ ...env, MCP_DISCORD_DISCOVERY_SCOPES: undefined })).toThrow();
    expect(loadDiscordConfig(env)?.targets).toEqual([]);
  });
  it.each([
    'null',
    '{}',
    'oops',
    '[null]',
    JSON.stringify([{ ...scope, guildId: '*' }]),
    JSON.stringify([{ ...scope, accountId: '' }]),
    JSON.stringify([{ ...scope, agentId: 'Bad Agent' }]),
    JSON.stringify([{ ...scope, normalRouting: 'true' }]),
    JSON.stringify([{ ...scope, whitelist: [] }]),
    JSON.stringify([scope, scope]),
  ])('rejects malformed scopes %s', (value) => {
    expect(() => loadDiscordConfig({ ...env, MCP_DISCORD_DISCOVERY_SCOPES: value })).toThrow();
  });
  it.each(['MCP_DISCORD_CHANNEL_WHITELIST', 'MCP_DISCORD_CHANNEL_BLACKLIST'])(
    'rejects malformed IDs in %s',
    (key) => {
      for (const value of ['null', '{}', '', '[12]', '["*"]', JSON.stringify([channel, channel])])
        expect(() => loadDiscordConfig({ ...env, [key]: value })).toThrow();
    }
  );
});
