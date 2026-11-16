import { DiscordError } from './discord-channels.js';

export const forkSessionParameter = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  description:
    'Optional canonical OpenClaw source session key for a native fork into this NEW Discord thread. Use a known OpenClaw key, such as session_id returned by an earlier MCP chat, or trusted runtime context when available. This is not the calling client’s own conversation ID; never guess it from a Discord ID. Source and destination must use the same agent on this Gateway. Copies history through the last completed turn; the separate prompt is the new assignment, published on Discord. No existing-thread replacement or cross-agent fork. Omit for a fresh session with a contextual handoff.',
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
