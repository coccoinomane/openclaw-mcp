import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discordBindingResolver } from '../../openclaw/discord-bindings.js';
import { DiscordService, type DiscordConfig } from '../../openclaw/discord.js';
import { channelReader } from '../../openclaw/discord-read.js';
import { assertTargetAllowed } from '../../openclaw/discord-policy.js';
import { handleDiscord, discordTools } from '../../mcp/tools/discord.js';

const guild = '700000000000000001';
const channel = '700000000000000002';
const other = '700000000000000003';
const thread = '700000000000000004';
const category = '700000000000000005';
const target = {
  name: 'work',
  guildId: guild,
  channelId: channel,
  accountId: 'bot',
  agentId: 'main',
  normalRouting: true,
};
const binding = (agentId: string, match: Record<string, unknown> = {}) => ({
  agentId,
  match: { channel: 'discord', accountId: 'bot', ...match },
});
const dirs: string[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(overrides: Partial<DiscordConfig> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'discord-agents-'));
  dirs.push(stateDir);
  const config: DiscordConfig = {
    executable: 'never-executed',
    stateDir,
    targets: [target],
    cliGatewayInstance: 'local',
    gatewayReadsEnabled: true,
    ...overrides,
  };
  const reader = vi.fn(async () => ({
    ok: true,
    channels: [
      { id: channel, guild_id: guild, type: 0, name: 'Work', topic: null, parent_id: null },
      { id: other, guild_id: guild, type: 0, name: 'Other', topic: null, parent_id: null },
    ],
  }));
  const invoke = vi.fn();
  return {
    service: new DiscordService(config, vi.fn(), invoke, undefined, reader),
    reader,
    invoke,
    config,
  };
}

describe('Discord imported static agent routes', () => {
  it('preserves peer, parent, wildcard, guild and account precedence', () => {
    const resolve = discordBindingResolver([
      binding('account'),
      binding('guild', { guildId: guild }),
      binding('wildcard', { peer: { kind: 'group', id: '*' } }),
      binding('parent', { peer: { kind: 'channel', id: channel } }),
      binding('thread', { peer: { kind: 'group', id: thread } }),
    ]);
    expect(resolve(target, thread)).toBe('thread');
    expect(resolve(target, other)).toBe('parent');
    expect(resolve({ ...target, channelId: other }, other)).toBe('wildcard');
    expect(
      discordBindingResolver([binding('account'), binding('guild', { guildId: guild })])(
        target,
        channel
      )
    ).toBe('guild');
  });
  it('uses first source entry within a tier and honors default-account and wildcard-account rules', () => {
    const resolve = discordBindingResolver([
      { agentId: 'default', match: { channel: 'discord' } },
      binding('first', { guildId: guild }),
      binding('second', { guildId: guild }),
      binding('fallback', { accountId: '*' }),
    ]);
    expect(resolve(target, channel)).toBe('first');
    expect(resolve({ ...target, accountId: 'default' }, channel)).toBe('default');
    expect(resolve({ ...target, accountId: 'another' }, channel)).toBe('fallback');
  });
  it('rejects advanced matches rather than silently treating them as broad routes', () => {
    expect(() => discordBindingResolver([binding('writer', { roles: ['role'] })])).toThrow(
      'IMPORTED_DISCORD_BINDING_UNSUPPORTED'
    );
  });
  it('reassigns existing target IDs, filters by agent and never widens admitted channels', async () => {
    const { service, config } = await fixture({
      importedRouteAgent: discordBindingResolver([binding('writer', { guildId: guild })]),
    });
    const listed = await service.channels({ agent_id: 'writer', instance: 'local' });
    expect(listed.channels).toHaveLength(1);
    expect(listed.channels[0]).toMatchObject({
      target: 'work',
      agent_id: 'writer',
      account_id: 'bot',
      instance: 'local',
    });
    expect((await service.channels({ agent_id: 'main' })).channels).toEqual([]);
    expect(() =>
      assertTargetAllowed(config, {
        ...target,
        permissionAgentId: 'main',
        agentId: 'writer',
        channelId: other,
      })
    ).toThrow('TARGET_SCOPE_DENIED');
    await expect(service.threads({ target: 'work', agent_id: 'main' })).rejects.toThrow(
      'ROUTE_SELECTOR_CONFLICT'
    );
    await expect(
      service.ask({
        target: 'work',
        agent_id: 'main',
        mode: 'new_thread',
        operation_id: 'unique-operation-0001',
      })
    ).rejects.toThrow('ROUTE_SELECTOR_CONFLICT');
  });
  it('keeps whitelist and blacklist restrictions after mapping and supports no mappings', async () => {
    const resolve = discordBindingResolver([binding('writer')]);
    const { config } = await fixture({ importedRouteAgent: resolve, channelBlacklist: [channel] });
    expect(() =>
      assertTargetAllowed(config, { ...target, permissionAgentId: 'main', agentId: 'writer' })
    ).toThrow('CHANNEL_POLICY_DENIED');
    const empty = await fixture({ importedRouteAgent: discordBindingResolver([]) });
    expect((await empty.service.channels()).channels).toEqual([]);
    await expect(empty.service.threads({ target: 'work' })).rejects.toThrow(
      'IMPORTED_ROUTE_UNMAPPED'
    );
  });
  it('derives different agents per channel only within explicit guild scopes', async () => {
    const { service } = await fixture({
      targets: [],
      discoveryScopes: [{ guildId: guild, accountId: 'bot', agentId: 'main', normalRouting: true }],
      importedRouteAgent: discordBindingResolver([
        binding('main', { guildId: guild }),
        binding('writer', { peer: { kind: 'channel', id: other } }),
      ]),
    });
    expect((await service.channels()).channels.map((c) => [c.channel_id, c.agent_id])).toEqual([
      [channel, 'main'],
      [other, 'writer'],
    ]);
  });
  it('rejects creation policies inconsistent with imported guild routing without dispatch', async () => {
    const { service, invoke } = await fixture({
      acknowledgeInboundRouting: true,
      creationPolicies: [
        {
          name: 'create',
          guildId: guild,
          categoryId: category,
          accountId: 'bot',
          agentId: 'main',
          instance: 'local',
        },
      ],
      importedRouteAgent: discordBindingResolver([binding('writer', { guildId: guild })]),
    });
    expect((await service.channels()).creation_policies).toEqual([]);
    await expect(service.createChannel({ policy: 'create', agent_id: 'main' })).rejects.toThrow(
      'CREATION_ROUTE_CONFLICT'
    );
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects an exact peer route on a newly created channel before admission', async () => {
    const { service, invoke, reader } = await fixture({
      acknowledgeInboundRouting: true,
      creationPolicies: [
        {
          name: 'create',
          guildId: guild,
          categoryId: category,
          accountId: 'bot',
          agentId: 'main',
          instance: 'local',
        },
      ],
      importedRouteAgent: discordBindingResolver([
        binding('main', { guildId: guild }),
        binding('writer', { peer: { kind: 'channel', id: other } }),
      ]),
    });
    reader.mockResolvedValue({
      ok: true,
      channel: { id: category, guild_id: guild, type: 4 },
    } as any);
    invoke.mockResolvedValue({ ok: true, channel: { id: other } });
    const result = await service.createChannel({
      policy: 'create',
      operation_id: 'create-peer-conflict-001',
      name: 'new-channel',
      authorize_create: true,
      authorize_admission: true,
    });
    expect(result).toMatchObject({
      status: 'created_unadmitted',
      error_code: 'CREATION_ROUTE_CONFLICT',
    });
    expect(invoke).toHaveBeenCalledOnce();
    await expect(service.threads({ target: 'created-' + other })).rejects.toThrow(
      'Target is not allowlisted'
    );
  });
  it('infers persisted operation agents and rejects selector or route changes', async () => {
    const { service, config } = await fixture({
      importedRouteAgent: discordBindingResolver([binding('writer')]),
    });
    await writeFile(
      join(config.stateDir, 'persisted-operation-001.json'),
      JSON.stringify({
        operation_id: 'persisted-operation-001',
        target: 'work',
        status: 'completed',
        agent_id: 'writer',
        instance: 'local',
        channel_id: thread,
      })
    );
    expect(await service.status('persisted-operation-001', { agent_id: 'writer' })).toMatchObject({
      agent_id: 'writer',
      instance: 'local',
    });
    await expect(service.status('persisted-operation-001', { agent_id: 'main' })).rejects.toThrow(
      'ROUTE_SELECTOR_CONFLICT'
    );
    config.importedRouteAgent = discordBindingResolver([binding('main')]);
    await expect(service.status('persisted-operation-001')).rejects.toThrow('ROUTE_MISMATCH');
  });
  it('infers legacy stored session agents without rewriting records or accepting rebindings', async () => {
    const { service, config } = await fixture({
      importedRouteAgent: discordBindingResolver([binding('writer')]),
    });
    const path = join(config.stateDir, 'legacy-operation-001.json');
    const record = JSON.stringify({
      operation_id: 'legacy-operation-001',
      target: 'work',
      status: 'completed',
      channel_id: thread,
      session_key: 'agent:writer:discord:channel:' + thread,
    });
    await writeFile(path, record);
    expect(await service.status('legacy-operation-001', { agent_id: 'writer' })).toMatchObject({
      agent_id: 'writer',
    });
    expect(await readFile(path, 'utf8')).toBe(record);
    config.importedRouteAgent = discordBindingResolver([binding('main')]);
    await expect(service.status('legacy-operation-001', { agent_id: 'main' })).rejects.toThrow(
      'ROUTE_SELECTOR_CONFLICT'
    );
    await expect(service.status('legacy-operation-001')).rejects.toThrow('ROUTE_MISMATCH');
  });
  it('uses the admitted permission scope with the actual Gateway reader after agent reassignment', async () => {
    const { config } = await fixture({
      importedRouteAgent: discordBindingResolver([binding('writer')]),
    });
    const fetcher = vi.fn(async (_url: any, options: any) => {
      const body = JSON.parse(options.body);
      expect(body.sessionKey).toBe('agent:writer:main');
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            details: { ok: true, channel: { id: body.args.channelId, guild_id: guild, type: 0 } },
          },
        })
      );
    });
    const reader = channelReader(
      [{ name: 'local', url: 'http://127.0.0.1:18789', token: 'mock' }],
      config,
      fetcher
    )!;
    const runner = vi.fn(async () => ({ ok: true, threads: [] }));
    const service = new DiscordService(config, runner, undefined, undefined, reader);
    expect(await service.threads({ target: 'work', agent_id: 'writer' })).toMatchObject({
      agent_id: 'writer',
      threads: [],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(
      reader(
        { ...target, guildId: '700000000000000099', agentId: 'writer', permissionAgentId: 'main' },
        { action: 'channel-info', channelId: channel }
      )
    ).rejects.toThrow('READ_SCOPE_DENIED');
    await expect(
      reader(
        { ...target, accountId: 'another', agentId: 'writer', permissionAgentId: 'main' },
        { action: 'channel-info', channelId: channel }
      )
    ).rejects.toThrow('READ_SCOPE_DENIED');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('adds selectors to every strict schema and rejects malformed selectors before service calls', async () => {
    expect(
      discordTools.every(
        (t) =>
          t.inputSchema.additionalProperties === false &&
          t.inputSchema.properties?.agent_id &&
          t.inputSchema.properties?.instance
      )
    ).toBe(true);
    const { service, reader } = await fixture();
    expect(
      (await handleDiscord(service, 'openclaw_discord_channels', { agent_id: 1 })).isError
    ).toBe(true);
    expect(
      (await handleDiscord(service, 'openclaw_discord_channels', { instance: ' ' })).isError
    ).toBe(true);
    expect(
      (await handleDiscord(service, 'openclaw_discord_channels', { constructor: 'bad' })).isError
    ).toBe(true);
    expect(reader).not.toHaveBeenCalled();
  });
});
