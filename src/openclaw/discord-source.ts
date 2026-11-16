import { DiscordError } from './discord-channels.js';

// Match the exact permalink, without URL normalization or a trailing newline exception.
const sourceMessagePattern = String.raw`^https://discord\.com/channels/[1-9][0-9]{16,19}/[1-9][0-9]{16,19}/[1-9][0-9]{16,19}(?![\s\S])`;

export const sourceMessageParameter = {
  type: 'string',
  pattern: sourceMessagePattern,
  description:
    'Optional exact originating Discord message permalink: https://discord.com/channels/GUILD/CHANNEL/MESSAGE. Supply only a known actual source message link; omit when unavailable, including external clients without a Discord origin. Session or channel links are not accepted. Displayed only in the server-rendered new-thread header, including forks; never added to agent input, fetched, or used as authority. Do not add it to the prompt merely for attribution.',
};

export function checkSourceMessageUrl(value: unknown): asserts value is string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !new RegExp(sourceMessagePattern).test(value))
    throw new DiscordError('SOURCE_MESSAGE_URL_INVALID');
}
