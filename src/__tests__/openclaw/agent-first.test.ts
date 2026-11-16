import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../openclaw/gateway-discovery.js', () => ({
  discoverGatewayAgents: vi.fn(),
  discoverGatewayConfig: vi.fn(),
  gatewayModelRequest: vi.fn(),
}));
import { discoverGatewayAgents, discoverGatewayConfig } from '../../openclaw/gateway-discovery.js';
import { OpenClawGateway } from '../../openclaw/gateway.js';
import { DiscordAccess, selectedBindings } from '../../openclaw/discord-bindings.js';
import { handleOpenclawAgents } from '../../mcp/tools/agents.js';
const guild = '600000000000000001',
  channel = '600000000000000002',
  other = '600000000000000003',
  thread = '600000000000000004';
let config: any;
beforeEach(() => {
  vi.mocked(discoverGatewayAgents).mockResolvedValue({ agents: [{ id: 'a' }, { id: 'b' }] });
  config = {
    channels: { discord: { accounts: { bot: {} } } },
    bindings: [
      { agentId: 'a', match: { channel: 'discord', accountId: 'bot', guildId: guild } },
      {
        agentId: 'b',
        match: {
          channel: 'discord',
          accountId: 'bot',
          guildId: guild,
          peer: { kind: 'channel', id: channel },
        },
      },
    ],
  };
  vi.mocked(discoverGatewayConfig).mockImplementation(async () => ({
    valid: true,
    configRevisionHash: 'r',
    appliedConfigHash: 'r',
    config,
  }));
});
const gateway = () => new OpenClawGateway({ url: 'https://fixture.invalid', defaultAgentId: 'a' });
function access() {
  const reader = vi.fn(async (_s: any, r: any) => {
    const metadata = (id: string) => ({
      id,
      guild_id: guild,
      name: id,
      type: id === thread ? 11 : 0,
      ...(id === thread ? { parent_id: channel } : {}),
    });
    return r.action === 'channel-list'
      ? { channels: [metadata(channel), metadata(other)] }
      : { channel: metadata(r.channelId) };
  });
  return { reader, access: new DiscordAccess(gateway(), reader) };
}
const target = (agentId = 'a', id = channel) => ({
  name: id,
  channelId: id,
  guildId: guild,
  accountId: 'bot',
  agentId,
});
describe('live agent selection', () => {
  it('requires explicit selection in mandatory mode and never uses a default', async () => {
    const g = new OpenClawGateway({
      url: 'https://fixture.invalid',
      defaultAgentId: 'a',
      agentIsMandatory: true,
    });
    await expect(g.resolve()).rejects.toThrow('required');
    expect((await g.resolve('b')).agentId).toBe('b');
    expect((await g.listAgents()).every((a) => !a.isDefault)).toBe(true);
  });
  it('uses explicit then default and rejects absent/invalid/unknown agents', async () => {
    const g = gateway();
    expect((await g.resolve()).agentId).toBe('a');
    expect((await g.resolve('b')).agentId).toBe('b');
    await expect(new OpenClawGateway({ url: 'https://fixture.invalid' }).resolve()).rejects.toThrow(
      'Select'
    );
    await expect(g.resolve('../a')).rejects.toThrow('Invalid');
    await expect(g.resolve('missing')).rejects.toThrow('Unknown');
  });
  it('reloads every list and validation, including cached clients', async () => {
    const g = gateway();
    await g.resolve('b');
    expect((await handleOpenclawAgents(g, {})).structuredContent?.total).toBe(2);
    vi.mocked(discoverGatewayAgents).mockResolvedValue({ agents: [{ id: 'a' }, { id: 'new' }] });
    expect((await g.listAgents()).map((a) => a.agentId)).toEqual(['a', 'new']);
    await expect(g.resolve('b')).rejects.toThrow('Unknown');
    expect((await g.resolve('new')).agentId).toBe('new');
  });
  it('fails closed on unreachable roster or unapplied config', async () => {
    vi.mocked(discoverGatewayAgents).mockRejectedValueOnce(new Error('offline'));
    await expect(gateway().resolve('a')).rejects.toThrow('offline');
    vi.mocked(discoverGatewayConfig).mockResolvedValue({
      valid: true,
      configRevisionHash: 'new',
      appliedConfigHash: 'old',
      config,
    });
    await expect(gateway().bindingsConfig()).rejects.toThrow('applied');
  });
});
describe('selected agent Discord union', () => {
  it('does not revive a disabled default account through an inherited token', () => {
    config.channels.discord = {
      token: '__OPENCLAW_REDACTED__',
      accounts: { default: { enabled: false } },
    };
    config.bindings = [{ agentId: 'a', match: { channel: 'discord', guildId: guild } }];
    expect(selectedBindings(config, 'a')).toEqual([]);
  });
  it('does not combine distinct incomplete binding conditions into a grant', async () => {
    const { access: a } = access();
    config.bindings = [
      { agentId: 'b', match: { channel: 'discord', accountId: 'else', guildId: guild } },
      { agentId: 'b', match: { channel: 'discord', accountId: 'bot', guildId: other } },
    ];
    await expect(a.assert(target('b'))).rejects.toThrow('BINDING');
  });
  it('allows guild A and channel B concurrently without subtracting either binding', async () => {
    const { access: a } = access();
    await expect(a.assert(target('a'))).resolves.toBeUndefined();
    await expect(a.assert(target('b'))).resolves.toBeUndefined();
    await expect(a.assert(target('a', other))).resolves.toBeUndefined();
    await expect(a.assert(target('b', other))).rejects.toThrow('BINDING_ACCESS_DENIED');
    expect((await a.channels('a')).channels.map((c) => c.channel_id)).toEqual([channel, other]);
    expect((await a.channels('b')).channels.map((c) => c.channel_id)).toEqual([channel]);
  });
  it('verifies direct IDs and denies forged guild/account and thread-specific binding', async () => {
    const { access: a } = access();
    await expect(
      a.target({ agent_id: 'b', target: channel, guild_id: guild, account_id: 'bot' })
    ).resolves.toMatchObject(target('b'));
    await expect(
      a.target({ agent_id: 'b', target: other, guild_id: guild, account_id: 'bot' })
    ).rejects.toThrow('BINDING');
    await expect(
      a.target({ agent_id: 'b', target: channel, guild_id: other, account_id: 'bot' })
    ).rejects.toThrow('UNVERIFIED');
    await expect(a.assert({ ...target(), accountId: 'else' })).rejects.toThrow('BINDING');
    config.bindings = [
      {
        agentId: 'b',
        match: { channel: 'discord', accountId: 'bot', peer: { kind: 'channel', id: thread } },
      },
    ];
    expect((await a.channels('b')).channels).toEqual([]);
    await expect(
      a.target({ agent_id: 'b', target: thread, guild_id: guild, account_id: 'bot' })
    ).rejects.toThrow('PARENT');
  });
  it('reloads binding removals and ignores malformed other-agent bindings', async () => {
    const { access: a } = access();
    config.bindings.push({ agentId: 'unrelated', match: { channel: 'discord', roles: ['x'] } });
    await a.assert(target());
    config.bindings = [];
    await expect(a.assert(target())).rejects.toThrow('BINDING');
  });
  it('requires guild binding for creation, never channel binding or generic conditions', async () => {
    const { access: a } = access();
    await expect(a.assertCreate(target('a'))).resolves.toBeUndefined();
    await expect(a.assertCreate(target('b'))).rejects.toThrow('GUILD_BINDING');
    for (const match of [
      { channel: 'discord' },
      { channel: 'discord', guildId: guild, roles: ['role'] },
      { channel: 'discord', guildId: guild, peer: { kind: 'channel', id: '*' } },
      { channel: 'discord', guildId: guild, teamId: 'x' },
    ]) {
      config.bindings = [{ agentId: 'a', match: { accountId: 'bot', ...match } }];
      await expect(a.assert(target())).rejects.toThrow('BINDING');
    }
  });
  it('respects literal default, wildcard accounts, guild constraints and disabled accounts', () => {
    config.channels.discord = {
      defaultAccount: 'bot',
      accounts: { bot: {}, disabled: { enabled: false }, default: {} },
    };
    config.bindings = [{ agentId: 'a', match: { channel: 'discord', guildId: guild } }];
    expect(selectedBindings(config, 'a').map((b) => b.accountId)).toEqual(['default']);
    config.bindings[0].match.accountId = '*';
    expect(selectedBindings(config, 'a').map((b) => b.accountId)).toEqual(['bot', 'default']);
    config.bindings[0].type = 'acp';
    expect(selectedBindings(config, 'a')).toEqual([]);
  });
});
