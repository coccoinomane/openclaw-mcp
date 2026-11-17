import { modelParameter } from '../../openclaw/models.js';
import { forkSessionParameter } from '../../openclaw/session-fork.js';
import { sourceParameter } from '../../openclaw/discord-source.js';
import {
  discordChannelsOutput,
  discordThreadsOutput,
  discordTurnOutput,
  discordCreationOutput,
  discordOperationOutput,
} from './discord-output.js';
import { DiscordError } from '../../openclaw/discord-channels.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DiscordService } from '../../openclaw/discord.js';
import { errorResponse, structuredJsonResponse } from '../../utils/response-helpers.js';
const selectors = {
  agent_id: {
    type: 'string',
    pattern: '^[a-z0-9][a-z0-9_-]{0,63}$',
    description: 'Agent ID from openclaw_agents.',
  },
};
const destination = {
  server_id: { type: 'string', pattern: '^[1-9][0-9]{16,19}$' },
  discord_account_id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
};
const channel_id = {
  type: 'string',
  pattern: '^[1-9][0-9]{16,19}$',
  description: 'Parent or text channel ID from openclaw_discord_channels.',
};
const operation = {
  type: 'string',
  minLength: 16,
  maxLength: 100,
  pattern: '^[a-zA-Z0-9_-]+$',
  description: 'Unique operation ID; reuse with identical arguments after uncertainty.',
};
export const discordTools: Tool[] = [
  {
    name: 'openclaw_discord_channels',
    outputSchema: discordChannelsOutput,
    description:
      'List verified destinations for the selected agent. Reuse channel_id, server_id and discord_account_id in Discord tools; creation_servers lists servers eligible for channel creation.',
    inputSchema: { type: 'object', properties: { ...selectors }, additionalProperties: false },
  },
  {
    name: 'openclaw_discord_threads',
    outputSchema: discordThreadsOutput,
    description:
      'List threads under a channel from openclaw_discord_channels. Reuse thread_id with openclaw_discord_reply. Archived public threads support timestamp pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
        channel_id,
        ...destination,
        archived: { type: 'boolean' },
        before_archive_timestamp: {
          type: 'string',
          description: 'Archive timestamp cursor, not a snowflake.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['server_id', 'discord_account_id', 'channel_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_ask',
    outputSchema: discordTurnOutput,
    annotations: { title: 'Ask OpenClaw on Discord', readOnlyHint: false, destructiveHint: false },
    description:
      'Create a new Discord thread in a destination from openclaw_discord_channels and queue the request. Optionally fork a same-agent session; model overrides only the child. Return the thread mention or discord_url immediately on queued handoff, not answer content. Preserve operation_id on uncertainty; use openclaw_discord_operation for recovery. Use openclaw_discord_reply for existing threads. Forward faithfully with necessary context; omit client-only routing instructions and the server-owned forwarding header.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
        channel_id,
        ...destination,
        operation_id: operation,
        model: modelParameter,
        fork_from_session_key: forkSessionParameter,
        source: sourceParameter,
        thread_name: { type: 'string', minLength: 1, maxLength: 100 },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 1048576,
          description:
            'Request to publish and execute, with the context needed for delegated work.',
        },
      },
      required: [
        'server_id',
        'discord_account_id',
        'channel_id',
        'operation_id',
        'thread_name',
        'prompt',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_reply',
    outputSchema: discordTurnOutput,
    annotations: {
      title: 'Reply in an existing Discord thread',
      readOnlyHint: false,
      destructiveHint: false,
    },
    description:
      'Publish a request in an existing public thread from openclaw_discord_threads and queue its canonical agent session. Unlocked archived threads are supported. Return the thread mention or discord_url on queued handoff. Preserve operation_id on uncertainty; use openclaw_discord_operation for recovery. Forks and model overrides are unsupported. Forward faithfully with necessary context; omit client-only routing instructions and the server-owned forwarding header.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
        channel_id,
        ...destination,
        thread_id: {
          type: 'string',
          pattern: '^[1-9][0-9]{16,19}$',
          description: 'Public thread ID from openclaw_discord_threads.',
        },
        operation_id: operation,
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 1048576,
          description: 'Request to publish and execute in this thread.',
        },
      },
      required: [
        'server_id',
        'discord_account_id',
        'channel_id',
        'thread_id',
        'operation_id',
        'prompt',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_send',
    outputSchema: discordTurnOutput,
    description:
      'Publish a request in a text channel from openclaw_discord_channels and queue the selected agent. Preserve operation_id on uncertainty; use openclaw_discord_operation for recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
        ...destination,
        channel_id,
        operation_id: operation,
        prompt: { type: 'string', minLength: 1, maxLength: 1048576 },
      },
      required: ['server_id', 'discord_account_id', 'channel_id', 'operation_id', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'openclaw_discord_operation',
    outputSchema: discordOperationOutput,
    description:
      'Read durable operation status after a disconnect or uncertain outcome. Does not repeat side effects.',
    inputSchema: {
      type: 'object',
      properties: { ...selectors, operation_id: operation },
      required: ['operation_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'openclaw_discord_create_channel',
    outputSchema: discordCreationOutput,
    description:
      'Create a text channel in a creation_servers destination from openclaw_discord_channels. Requires creation opt-in, bot ManageChannels and explicit authorization. Preserve operation_id on uncertainty.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
        ...destination,
        category_id: { type: 'string', pattern: '^[1-9][0-9]{16,19}$' },
        operation_id: operation,
        channel_name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,99}$' },
        channel_topic: { type: 'string', maxLength: 1024 },
        authorize_create: { type: 'boolean', const: true },
      },
      required: [
        'server_id',
        'discord_account_id',
        'operation_id',
        'channel_name',
        'authorize_create',
      ],
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
    Object.keys(input).some(
      (key) => !Object.prototype.hasOwnProperty.call(schema.properties || {}, key)
    ) ||
    schema.required?.some((key) => input[key] === undefined)
  )
    return errorResponse('Invalid Discord tool arguments');
  try {
    if (
      input.agent_id !== undefined &&
      (typeof input.agent_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.agent_id))
    )
      return errorResponse('Invalid Discord route selectors');
    if (name === 'openclaw_discord_send') return structuredJsonResponse(await service.send(input));
    if (name === 'openclaw_discord_create_channel')
      return structuredJsonResponse(await service.createChannel(input));
    const result =
      name === 'openclaw_discord_channels'
        ? await service.channels(input)
        : name === 'openclaw_discord_threads'
          ? await service.threads(input)
          : name === 'openclaw_discord_ask'
            ? await service.ask(input)
            : name === 'openclaw_discord_reply'
              ? await service.reply(input)
              : await service.status(input.operation_id, input);
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
      'Discord request rejected or could not be verified. Check arguments, agent bindings and operation status; do not blindly retry writes.'
    );
  }
}
