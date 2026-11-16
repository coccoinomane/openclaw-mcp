import type { DiscordConfig } from './discord.js';
import type { AdmittedTarget } from './discord-channels.js';

/** Fresh bindings for each effect. Thread parent metadata is checked by the service. */
export async function assertTargetAllowed(
  config: DiscordConfig,
  target: AdmittedTarget,
  _id?: string,
  _scopeError?: string
) {
  await config.access.assert(target);
}
