import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const route = { agent_id: string, discord_account_id: string, server_id: string };
const nullableString = { type: ['string', 'null'] };
const retrySafe = { type: 'boolean', const: false };
const error = {
  type: 'object',
  additionalProperties: false,
  properties: { error_code: string, uncertain: boolean, retry_safe: retrySafe },
  required: ['error_code', 'uncertain', 'retry_safe'],
};

// DiscordError results carry structuredContent even with isError: true.
// Other errors retain their text-only response and need no structured payload.
function output(success: OutputSchema): OutputSchema {
  return { type: 'object', anyOf: [success, error] };
}

export const discordChannelsOutput = output({
  type: 'object',
  additionalProperties: false,
  properties: {
    channels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...route,
          channel_id: string,
          channel_name: string,
          channel_topic: nullableString,
          category_id: nullableString,
          category_name: nullableString,
          discord_url: string,
        },
        required: [
          'agent_id',
          'discord_account_id',
          'channel_id',
          'server_id',
          'channel_name',
          'channel_topic',
          'category_id',
          'category_name',
          'discord_url',
        ],
      },
    },
    creation_servers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...route,
          category_id: string,
        },
        required: ['agent_id', 'discord_account_id', 'server_id'],
      },
    },
  },
  required: ['channels', 'creation_servers'],
});

// Metadata may be absent; malformed values are rejected by output validation.
export const discordThreadsOutput = output({
  type: 'object',
  additionalProperties: false,
  properties: {
    ...route,
    channel_id: string,
    threads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thread_id: string,
          thread_name: string,
          archived: boolean,
          archive_timestamp: string,
          discord_url: string,
        },
        required: ['thread_id', 'discord_url'],
      },
    },
    has_more: boolean,
    next_before_archive_timestamp: string,
    pagination: { type: 'string', enum: ['none', 'archived_public_timestamp'] },
  },
  required: ['threads', 'has_more', 'pagination'],
});

const turn: OutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...route,
    kind: { type: 'string', enum: ['thread_reply', 'channel_message'] },
    operation_id: string,
    channel_id: string,
    status: {
      type: 'string',
      enum: [
        'creating',
        'creation_unknown',
        'created',
        'creation_partial',
        'queued',
        'running',
        'completed',
        'run_failed',
        'run_unknown',
      ],
    },
    retry_safe: retrySafe,
    thread_id: string,
    session_key: string,
    discord_url: string,
    run_id: string,
    agent_transport: { type: 'string', enum: ['sdk'] },
    agent_idempotency_key: string,
    cancellation_status: { type: 'string', enum: ['requested', 'acknowledged', 'unknown'] },
    request_status: {
      type: 'string',
      enum: ['pending', 'publishing', 'sent', 'verified', 'failed', 'partial', 'unknown'],
    },
    request_verified: boolean,
    request_message_ids: { type: 'array', items: string },
    delivery_status: string,
    delivery_verified: boolean,
    message_id: string,
    generation_status: string,
    thread_create_transport: { type: 'string', enum: ['gateway'] },
    starter_message_id: string,
    model: string,
    model_error: string,
    fork_from_session_key: string,
    fork_status: { type: 'string', enum: ['pending', 'forking', 'completed', 'failed', 'unknown'] },
    fork_error_code: string,
    member_status: {
      type: 'string',
      enum: ['disabled', 'pending', 'adding', 'verified', 'failed', 'unknown'],
    },
    member_verified: boolean,
    member_error_code: string,
    handoff: string,
    recovery: string,
    error_code: string,
  },
  required: ['operation_id', 'channel_id', 'status', 'retry_safe'],
};
const creation: OutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...route,
    kind: { type: 'string', const: 'channel_create' },
    server_id: string,
    category_id: string,
    operation_id: string,
    status: {
      type: 'string',
      enum: [
        'creating',
        'created_unadmitted',
        'completed',
        'creation_unknown',
        'creation_rejected',
      ],
    },
    retry_safe: retrySafe,
    channel_id: string,
    discord_url: string,
    routing: string,
    error_code: string,
    recovery: string,
  },
  required: ['kind', 'server_id', 'operation_id', 'status', 'retry_safe'],
};

// Early failures and interrupted records may lack URLs, session keys or run IDs.
// Completed generation does not imply verified Discord delivery.
export const discordTurnOutput = output(turn);
export const discordCreationOutput = output(creation);
export const discordOperationOutput: OutputSchema = {
  type: 'object',
  anyOf: [turn, creation, error],
};
