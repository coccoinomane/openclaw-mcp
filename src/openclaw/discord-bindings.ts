import type { OpenClawGateway } from './gateway.js';
import { DiscordError, type AdmittedTarget } from './discord-channels.js';
import type { DiscordReader } from './discord-read.js';

const snowflake = /^[1-9][0-9]{16,19}$/;
const accountId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export interface DiscordBinding {
  agentId: string;
  accountId: string;
  guildId?: string;
  channelId?: string;
}

/** Only supported bindings of the selected agent grant access. No routing precedence. */
export function selectedBindings(config: Record<string, any>, agent: string): DiscordBinding[] {
  const discord = config.channels?.discord;
  if (!discord || discord.enabled === false) return [];
  const accounts = new Set<string>();
  if (
    discord.accounts &&
    typeof discord.accounts === 'object' &&
    !Array.isArray(discord.accounts)
  ) {
    for (const [id, value] of Object.entries(discord.accounts)) {
      if (
        accountId.test(id) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value as any).enabled !== false
      )
        accounts.add(id);
    }
  }
  // The unnamed binding account is the literal default account, not defaultAccount.
  if (
    (!discord.accounts || discord.token !== undefined) &&
    discord.accounts?.default?.enabled !== false
  )
    accounts.add('default');
  const result: DiscordBinding[] = [];
  for (const binding of config.bindings ?? []) {
    if (binding?.agentId !== agent || (binding.type !== undefined && binding.type !== 'route'))
      continue;
    if (Object.keys(binding).some((k) => !['agentId', 'match', 'type', 'comment'].includes(k)))
      continue;
    const m = binding.match;
    if (
      !m ||
      m.channel !== 'discord' ||
      Object.keys(m).some((k) => !['channel', 'accountId', 'guildId', 'peer'].includes(k))
    )
      continue;
    if (m.guildId !== undefined && (typeof m.guildId !== 'string' || !snowflake.test(m.guildId)))
      continue;
    if (
      m.peer !== undefined &&
      (!m.peer ||
        typeof m.peer !== 'object' ||
        Object.keys(m.peer).some((k) => !['kind', 'id'].includes(k)) ||
        !['channel', 'group'].includes(m.peer.kind) ||
        typeof m.peer.id !== 'string' ||
        !snowflake.test(m.peer.id))
    )
      continue;
    if (!m.guildId && !m.peer) continue;
    const account = m.accountId ?? 'default';
    if (typeof account !== 'string' || (account !== '*' && !accountId.test(account))) continue;
    for (const id of account === '*' ? accounts : [account]) {
      if (!accounts.has(id)) continue;
      result.push({
        agentId: agent,
        accountId: id,
        ...(m.guildId ? { guildId: m.guildId } : {}),
        ...(m.peer ? { channelId: m.peer.id } : {}),
      });
    }
  }
  return result;
}
export class DiscordAccess {
  constructor(
    private gateway: OpenClawGateway,
    private reader: DiscordReader
  ) {}
  async select(selector?: string) {
    return (await this.gateway.resolve(selector)).agentId;
  }
  async bindings(agentId: string) {
    await this.gateway.resolve(agentId);
    return selectedBindings(await this.gateway.bindingsConfig(), agentId);
  }
  async assert(target: AdmittedTarget) {
    const bindings = await this.bindings(target.agentId);
    if (
      !bindings.some(
        (b) =>
          b.accountId === target.accountId &&
          (!b.guildId || b.guildId === target.guildId) &&
          (!b.channelId || b.channelId === target.channelId)
      )
    )
      throw new DiscordError('BINDING_ACCESS_DENIED');
  }
  async target(
    input: { agent_id?: string; account_id?: string; guild_id?: string; target?: string },
    id = input.target
  ): Promise<AdmittedTarget> {
    const agentId = await this.select(input.agent_id);
    if (
      typeof id !== 'string' ||
      !snowflake.test(id) ||
      typeof input.account_id !== 'string' ||
      !accountId.test(input.account_id) ||
      typeof input.guild_id !== 'string' ||
      !snowflake.test(input.guild_id)
    )
      throw new DiscordError('DESTINATION_INVALID');
    const t: AdmittedTarget = {
      name: id,
      channelId: id,
      guildId: input.guild_id,
      accountId: input.account_id,
      agentId,
    };
    // Metadata must be verified before interpreting an ID as a channel or thread.
    const c = (await this.reader(t, { action: 'channel-info', channelId: id })).channel;
    if (!c || c.id !== id || c.guild_id !== t.guildId || ![0, 5, 15, 16].includes(c.type))
      throw new DiscordError('PARENT_CHANNEL_UNVERIFIED');
    await this.assert(t);
    return t;
  }
  async assertCreate(target: AdmittedTarget) {
    const bindings = await this.bindings(target.agentId);
    if (
      !bindings.some(
        (b) => b.accountId === target.accountId && b.guildId === target.guildId && !b.channelId
      )
    )
      throw new DiscordError('GUILD_BINDING_REQUIRED');
  }
  async channels(selector?: string) {
    const agentId = await this.select(selector);
    const bindings = await this.bindings(agentId);
    const channels = new Map<string, any>();
    const guilds = new Map<string, { agent_id: string; account_id: string; guild_id: string }>();
    for (const b of bindings) {
      const scope = { agentId, accountId: b.accountId, guildId: b.guildId ?? '' };
      let rows: any[];
      if (b.channelId)
        rows = [
          (await this.reader(scope, { action: 'channel-info', channelId: b.channelId })).channel,
        ];
      else {
        guilds.set(b.accountId + ':' + b.guildId, {
          agent_id: agentId,
          account_id: b.accountId,
          guild_id: b.guildId!,
        });
        const data = await this.reader(scope, { action: 'channel-list' });
        if (!data || data.partial || data.ok === false || !Array.isArray(data.channels))
          throw new DiscordError('CHANNEL_LIST_UNVERIFIED');
        rows = data.channels;
      }
      for (const c of rows) {
        if (
          !c ||
          typeof c.id !== 'string' ||
          !snowflake.test(c.id) ||
          typeof c.guild_id !== 'string' ||
          !snowflake.test(c.guild_id) ||
          (b.guildId && c.guild_id !== b.guildId) ||
          (b.channelId && c.id !== b.channelId)
        )
          throw new DiscordError('CHANNEL_METADATA_UNVERIFIED');
        // Thread-specific bindings grant nothing. Threads inherit their verified parent.
        if (![0, 5, 15, 16].includes(c.type)) continue;
        if (
          typeof c.name !== 'string' ||
          (c.topic != null && typeof c.topic !== 'string') ||
          (c.parent_id != null && (typeof c.parent_id !== 'string' || !snowflake.test(c.parent_id)))
        )
          throw new DiscordError('CHANNEL_METADATA_UNVERIFIED');
        channels.set(b.accountId + ':' + c.id, {
          agent_id: agentId,
          account_id: b.accountId,
          target: c.id,
          channel_id: c.id,
          guild_id: c.guild_id,
          name: c.name,
          topic: c.topic ?? null,
          category_id: c.parent_id ?? null,
          category_name: rows.find((r) => r.id === c.parent_id && r.type === 4)?.name ?? null,
          discord_url: 'https://discord.com/channels/' + c.guild_id + '/' + c.id,
        });
      }
    }
    return { channels: [...channels.values()], creation_guilds: [...guilds.values()] };
  }
}
