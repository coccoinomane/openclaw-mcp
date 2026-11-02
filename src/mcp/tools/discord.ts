import { DiscordError } from '../../openclaw/discord-channels.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DiscordService } from '../../openclaw/discord.js';
import { errorResponse, structuredJsonResponse } from '../../utils/response-helpers.js';
const target = {
  type: 'string',
  description:
    'Stable target identifier returned by openclaw_discord_channels; not a display name.',
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
      'Create a NEW ordinary Discord thread, publish the exact request as a bot without a prefix, and return a queued Continue on Discord link, not answer content. Does not wait for generation. Preserve the user’s wording; do not add requirements or optimize the prompt unless explicitly requested. On successful handoff, reply to the user with only the Discord link, without commentary or a summary; report errors or partial/unknown outcomes instead of implying success. Use openclaw_discord_operation only when eventual status or recovery is needed, not before handing off. Select an allowed channel using openclaw_discord_channels when unspecified; ask if ambiguous. Use openclaw_discord_reply for an existing public thread. Preserve operation ID; inspect partial/unknown outcomes before further action.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        operation_id: operation,
        mode: { type: 'string', enum: ['new_thread'] },
        title: { type: 'string', minLength: 1, maxLength: 100 },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 1048576,
          description:
            'The request to forward, verbatim where possible. Preserve the user’s wording and intent; do not add requirements, assumptions, extra context or prompt optimizations unless the user explicitly asks. Do not include channel-selection instructions addressed only to the calling client.',
        },
      },
      required: ['target', 'operation_id', 'mode', 'title', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_reply',
    annotations: {
      title: 'Reply in an existing Discord thread',
      readOnlyHint: false,
      destructiveHint: false,
    },
    description:
      'Publish the exact request as a bot in an EXISTING public Discord thread and queue an ordinary agent turn in the same canonical session. Active and archived unlocked threads are supported; sending auto-unarchives. Requires verified live routing; Gateway owns run admission and queueing; the stock entry point currently rejects replies with ROUTE_INSPECTOR_REQUIRED until a trusted inspector is integrated. Never supply a session key. Preserve wording without additions. Return only the Discord link on queued handoff, without polling for the answer; report denied, partial or unknown outcomes honestly. Reuse the operation ID and identical arguments after a disconnect; use openclaw_discord_operation for recovery. Never retry uncertain writes with a new ID.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        channel_id: {
          type: 'string',
          pattern: '^[1-9][0-9]{16,19}$',
          description: 'Existing public thread ID under the selected target parent.',
        },
        operation_id: operation,
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 1048576,
          description:
            'Exact request to forward, without extra requirements or prompt optimization.',
        },
      },
      required: ['target', 'channel_id', 'operation_id', 'prompt'],
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
            : name === 'openclaw_discord_reply'
              ? await service.reply(input)
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
