import { DiscordError } from '../../openclaw/discord-channels.js';
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
    description:
      "List verified operator-allowed Discord channels. Use their names, topics and categories to choose the most suitable channel for a new thread about the user's request; ask for clarification only when the destination is ambiguous. Requires service opt-in.",
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
    annotations: { title: 'Ask OpenClaw on Discord', readOnlyHint: false, destructiveHint: false },
    description:
      'Create a NEW ordinary Discord thread, request the first answer there, and return a Continue on Discord link. Requires operator-acknowledged normal inbound routing. Existing-thread continuation is unavailable. Generation and delivery are reported separately. When the user requests a Discord thread without naming a channel, use openclaw_discord_channels to select the best match for the topic; ask if ambiguous. Respect any destination specified by the user. Preserve operation ID and inspect partial/unknown results before any new action.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        operation_id: operation,
        mode: { type: 'string', enum: ['new_thread'] },
        title: { type: 'string', minLength: 1, maxLength: 100 },
        prompt: { type: 'string', minLength: 1, maxLength: 1048576 },
      },
      required: ['target', 'operation_id', 'mode', 'title', 'prompt'],
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
      'Create a normal text channel under an operator-approved guild/category using the configured Gateway API, then persistently admit it for CLI coordination. Requires explicit user authorization for creation AND admission. No arbitrary tool proxy. Keep operation ID on uncertainty.',
    inputSchema: {
      type: 'object',
      properties: {
        policy: {
          type: 'string',
          description: 'Creation policy returned by openclaw_discord_channels.',
        },
        operation_id: operation,
        name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,99}$' },
        topic: { type: 'string', maxLength: 1024 },
        authorize_create: { type: 'boolean', const: true },
        authorize_admission: { type: 'boolean', const: true },
      },
      required: ['policy', 'operation_id', 'name', 'authorize_create', 'authorize_admission'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
      return structuredJsonResponse(await service.createChannel(input));
    const result =
      name === 'openclaw_discord_channels'
        ? await service.channels()
        : name === 'openclaw_discord_threads'
          ? await service.threads(input)
          : name === 'openclaw_discord_ask'
            ? await service.ask(input)
            : await service.status(input.operation_id);
    return structuredJsonResponse(result);
  } catch (error) {
    if (error instanceof DiscordError)
      return {
        ...errorResponse(error.code),
        structuredContent: {
          error_code: error.code,
          uncertain: error.uncertain,
          retry_safe: false,
        },
      };
    return errorResponse(
      'Discord request rejected or could not be verified. Check arguments, allowlist and operation status; do not blindly retry writes.'
    );
  }
}
