import { DiscordError } from './discord-channels.js';

export const forkSessionParameter = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  description:
    'Canonical same-agent source key (agent:<agent>:...). Copies completed history; prompt is the new assignment. Omit if unknown.',
};

export function checkForkSource(
  value: unknown,
  agentId: string
): asserts value is string | undefined {
  if (value === undefined) return;
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !/^agent:([a-z0-9][a-z0-9_-]{0,63}):[^\s:][^\s]*$/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new DiscordError('FORK_SOURCE_INVALID');
  if (value.split(':')[1] !== agentId) throw new DiscordError('FORK_AGENT_MISMATCH');
}
