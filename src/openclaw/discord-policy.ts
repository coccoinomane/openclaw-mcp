import { createHash } from 'node:crypto';
import { DiscordError, type AdmittedTarget } from './discord-channels.js';
import type { DiscordConfig } from './discord.js';

export interface DiscoveryScope {
  guildId: string;
  accountId: string;
  agentId: string;
  normalRouting?: boolean;
}
export const scopeKey = (s: DiscoveryScope) => JSON.stringify([s.guildId, s.accountId, s.agentId]);
export const sameScope = (a: DiscoveryScope, b: DiscoveryScope) => scopeKey(a) === scopeKey(b);

/** Stable across channel renames and scope reordering; contains no display names. */
export function dynamicTarget(scope: DiscoveryScope, channelId: string): AdmittedTarget {
  const key = createHash('sha256').update(scopeKey(scope)).digest('hex');
  return { ...scope, channelId, name: 'discord-' + key + '-' + channelId };
}

export function channelAllowed(config: DiscordConfig, id: string): boolean {
  return (
    !config.channelBlacklist?.includes(id) &&
    (!config.channelWhitelist?.length || config.channelWhitelist.includes(id))
  );
}

export function assertChannelAllowed(config: DiscordConfig, id: string) {
  if (!channelAllowed(config, id)) throw new DiscordError('CHANNEL_POLICY_DENIED');
}

/** Parent allowlists cover its verified threads; thread blacklists still take precedence. */
export function assertTargetAllowed(
  config: DiscordConfig,
  target: AdmittedTarget,
  id?: string,
  scopeError = 'TARGET_SCOPE_DENIED'
) {
  assertChannelAllowed(config, target.channelId);
  if (id && config.channelBlacklist?.includes(id)) throw new DiscordError('CHANNEL_POLICY_DENIED');
  if (
    !config.targets.some((t) => t.channelId === target.channelId && sameScope(t, target)) &&
    !config.discoveryScopes?.some((s) => sameScope(s, target)) &&
    !config.creationPolicies?.some(
      (p) => p.categoryId === target.categoryId && sameScope(p, target)
    )
  )
    throw new DiscordError(scopeError);
}
