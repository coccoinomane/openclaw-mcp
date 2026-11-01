import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DiscordService } from '../../openclaw/discord.js';
import { errorResponse, structuredJsonResponse } from '../../utils/response-helpers.js';
const target = {
  type: 'string',
  description: 'Operator-defined target name returned by openclaw_discord_channels.',
};
const operation = {
  type: 'string',
  minLength: 16,
  maxLength: 100,
  pattern: '^[a-zA-Z0-9_-]+$',
  description:
    'Unique unpredictable operation ID. Reuse with identical arguments after disconnect; never substitute a new ID blindly.',
};
export const discordTools: Tool[] = [
  {
    name: 'openclaw_discord_channels',
    description: 'List verified operator-allowed Discord channels. Requires service opt-in.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'openclaw_discord_threads',
    description:
      'List active threads or archived public threads under an allowed channel. Only archived results support pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        archived: { type: 'boolean' },
        before: { type: 'string', description: 'Archive timestamp cursor, not a snowflake.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_ask',
    description:
      'Create a NEW ordinary Discord thread and session, or continue an EXISTING thread/channel. Runs and delivers an agent turn, not a subagent or fork. User must authorize destination. Preserve operation ID and inspect partial/unknown results before any new action.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        operation_id: operation,
        mode: { type: 'string', enum: ['new_thread', 'continue'] },
        title: { type: 'string', minLength: 1, maxLength: 100 },
        channel_id: { type: 'string', pattern: '^[1-9][0-9]{16,19}$' },
        prompt: { type: 'string', minLength: 1, maxLength: 1048576 },
      },
      required: ['target', 'operation_id', 'mode', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_operation',
    description:
      'Read durable operation status after a disconnect or uncertain outcome. Does not repeat side effects.',
    inputSchema: {
      type: 'object',
      properties: { operation_id: operation },
      required: ['operation_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_create_channel',
    description:
      'Unsupported by the current CLI adapter: OpenClaw message channel exposes info/list only. No channel is created. Ask the user/operator to create and allowlist a channel; do not invent CLI flags.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];
export async function handleDiscord(service: DiscordService, name: string, input: any) {
  const schema = discordTools.find((t) => t.name === name)?.inputSchema;
  if (
    !schema ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !(key in (schema.properties || {}))) ||
    schema.required?.some((key) => input[key] === undefined)
  )
    return errorResponse('Invalid Discord tool arguments');
  try {
    if (name === 'openclaw_discord_create_channel')
      return structuredJsonResponse({
        status: 'unsupported',
        reason: 'OpenClaw CLI has no channel create command. No write attempted.',
      });
    const result =
      name === 'openclaw_discord_channels'
        ? await service.channels()
        : name === 'openclaw_discord_threads'
          ? await service.threads(input)
          : name === 'openclaw_discord_ask'
            ? await service.ask(input)
            : await service.status(input.operation_id);
    return structuredJsonResponse(result);
  } catch {
    return errorResponse(
      'Discord request rejected or could not be verified. Check arguments, allowlist and operation status; do not blindly retry writes.'
    );
  }
}
