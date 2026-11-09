import type { AgentBinding } from './types.js';
import type { DiscordConfig } from './discord.js';
import { DiscordError, type AdmittedTarget } from './discord-channels.js';

/** Compile a startup snapshot. This never grants a guild, channel or creation permission. */
export function discordBindingResolver(
  bindings: AgentBinding[]
): NonNullable<DiscordConfig['importedRouteAgent']> {
  const routes = bindings.filter((binding) => binding.match.channel === 'discord');
  for (const { match } of routes) {
    if (
      Object.keys(match).some(
        (key) => !['channel', 'accountId', 'guildId', 'peer'].includes(key)
      ) ||
      (match.accountId !== undefined &&
        (typeof match.accountId !== 'string' || !match.accountId)) ||
      (match.guildId !== undefined &&
        (typeof match.guildId !== 'string' || !/^[1-9][0-9]{16,19}$/.test(match.guildId)))
    )
      throw new DiscordError('IMPORTED_DISCORD_BINDING_UNSUPPORTED');
    if (match.peer !== undefined) {
      const peer = match.peer as Record<string, unknown>;
      if (
        !peer ||
        typeof peer !== 'object' ||
        Array.isArray(peer) ||
        Object.keys(peer).some((key) => !['kind', 'id'].includes(key)) ||
        !['channel', 'group', 'direct'].includes(String(peer.kind)) ||
        typeof peer.id !== 'string' ||
        (peer.id !== '*' && !/^[1-9][0-9]{16,19}$/.test(peer.id))
      )
        throw new DiscordError('IMPORTED_DISCORD_BINDING_UNSUPPORTED');
    }
  }
  return (target: AdmittedTarget, channelId: string) => {
    let selected: string | undefined;
    let priority = Infinity;
    for (const { agentId, match } of routes) {
      const account = match.accountId ?? 'default';
      if (account !== '*' && account !== target.accountId) continue;
      if (match.guildId !== undefined && match.guildId !== target.guildId) continue;
      const peer = match.peer as { kind: string; id: string } | undefined;
      let rank: number;
      if (peer) {
        if (peer.kind === 'direct') continue;
        if (channelId && peer.id === channelId) rank = 0;
        else if (channelId && target.channelId && peer.id === target.channelId) rank = 1;
        else if (peer.id === '*') rank = 2;
        else continue;
      } else if (match.guildId !== undefined) rank = 3;
      else if (account !== '*') rank = 4;
      else rank = 5;
      // OpenClaw retains the first binding within each specificity tier.
      if (rank < priority) {
        priority = rank;
        selected = agentId;
      }
    }
    return selected;
  };
}
