import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const route = { instance: string, agent_id: string, account_id: string };
const nullableString = { type: ['string', 'null'] };
const retrySafe = { type: 'boolean', const: false };
const error = {
  type: 'object',
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
  properties: {
    channels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...route,
          target: string,
          channel_id: string,
          guild_id: string,
          name: string,
          topic: nullableString,
          category_id: nullableString,
          category_name: nullableString,
          discord_url: string,
        },
        required: [
          'target',
          'channel_id',
          'guild_id',
          'name',
          'topic',
          'category_id',
          'category_name',
          'discord_url',
        ],
      },
    },
    creation_policies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ...route,
          policy: string,
          guild_id: string,
          category_id: string,
          agent: string,
        },
        required: ['policy', 'guild_id', 'category_id', 'agent'],
      },
    },
  },
  required: ['channels', 'creation_policies'],
});

// Metadata may be absent; malformed values are rejected by output validation.
export const discordThreadsOutput = output({
  type: 'object',
  properties: {
    ...route,
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          channel_id: string,
          name: string,
          archived: boolean,
          archive_timestamp: string,
          discord_url: string,
        },
        required: ['channel_id', 'discord_url'],
      },
    },
    has_more: boolean,
    next_before: string,
    pagination: { type: 'string', enum: ['none', 'archived_public_timestamp'] },
  },
  required: ['threads', 'has_more', 'pagination'],
});

const turn: OutputSchema = {
  type: 'object',
  properties: {
    ...route,
    kind: { type: 'string', const: 'thread_reply' },
    operation_id: string,
    target: string,
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
    channel_id: string,
    session_key: string,
    discord_url: string,
    run_id: string,
    agent_transport: { type: 'string', enum: ['cli', 'sdk'] },
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
    thread_create_transport: { type: 'string', enum: ['cli', 'gateway'] },
    thread_create_fallback: string,
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
  required: ['operation_id', 'target', 'status', 'retry_safe'],
};
const creation: OutputSchema = {
  type: 'object',
  properties: {
    ...route,
    kind: { type: 'string', const: 'channel_create' },
    policy: string,
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
    target: string,
    routing: string,
    error_code: string,
    recovery: string,
  },
  required: ['kind', 'policy', 'operation_id', 'status', 'retry_safe'],
};

// Early failures and interrupted records may lack URLs, session keys or run IDs.
// Completed generation does not imply verified Discord delivery.
export const discordTurnOutput = output(turn);
export const discordCreationOutput = output(creation);
export const discordOperationOutput: OutputSchema = {
  type: 'object',
  anyOf: [turn, creation, error],
};
