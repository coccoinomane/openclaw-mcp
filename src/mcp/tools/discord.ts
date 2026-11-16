import { modelParameter } from '../../openclaw/models.js';
import { forkSessionParameter } from '../../openclaw/session-fork.js';
import { sourceMessageParameter } from '../../openclaw/discord-source.js';
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
    description:
      'Agent filter for discovery; route assertion for targets, policies and operations.',
  },
};
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
    outputSchema: discordChannelsOutput,
    description:
      "List verified operator-allowed Discord channels. Use their names, topics and categories to choose the most suitable channel for a new thread about the user's request; ask for clarification only when the destination is ambiguous. Requires service opt-in.",
    inputSchema: { type: 'object', properties: { ...selectors }, additionalProperties: false },
  },
  {
    name: 'openclaw_discord_threads',
    outputSchema: discordThreadsOutput,
    description:
      'List active threads or archived public threads under an allowed channel. Only archived results support pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
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
    outputSchema: discordTurnOutput,
    annotations: { title: 'Ask OpenClaw on Discord', readOnlyHint: false, destructiveHint: false },
    description:
      'Create a NEW ordinary Discord thread and its OpenClaw session, optionally forking a same-agent source with fork_from_session. The separate prompt is the new assignment; fork history is not republished. Without model, a fork retains inherited model settings; an explicit model overrides them for the child only. Publish the original request as a bot with an optional server-configured forwarding header, and return a queued Continue on Discord link, not answer content. Does not wait for generation. Forward self-contained requests faithfully; for delegated work, include the context needed to carry out the user’s intent without adding unrelated requirements. The submitted prompt is published on Discord; the server adds any configured forwarding header, never the client. Supply source_message_url only for a known originating Discord message permalink; it appears in the header, not agent input. On successful handoff, return the destination in the originating conversation using a native thread mention on Discord or the returned link elsewhere; report errors or partial/unknown outcomes instead of implying success. Use openclaw_discord_operation only when eventual status or recovery is needed, not before handing off. Select an allowed channel using openclaw_discord_channels when unspecified; ask if ambiguous. Use openclaw_discord_reply for an existing public thread. Preserve operation ID; inspect partial/unknown outcomes before further action.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
        target,
        operation_id: operation,
        mode: { type: 'string', enum: ['new_thread'] },
        model: modelParameter,
        fork_from_session: forkSessionParameter,
        source_message_url: sourceMessageParameter,
        title: { type: 'string', minLength: 1, maxLength: 100 },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 1048576,
          description:
            'The request or self-contained delegated assignment to publish and execute. Preserve the user’s intent; include necessary context and available source session/link references for handoffs. Omit instructions addressed only to the client about choosing a destination. The server adds any configured forwarding header.',
        },
      },
      required: ['target', 'operation_id', 'mode', 'title', 'prompt'],
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
      'Publish the exact request as a bot in an EXISTING public Discord thread and queue an ordinary agent turn in the same canonical session. Active and archived unlocked threads are supported; sending auto-unarchives. Uses operator-configured normal routing; Gateway owns run admission and queueing. Forking, model overrides and runtime rebindings are unsupported on this existing-thread tool. Do not select a destination session key; routing determines it. Forward faithfully or include necessary context for delegated work. Source session references may appear in the prompt. Return a native thread mention on Discord or the returned link elsewhere on queued handoff, without polling for the answer; report denied, partial or unknown outcomes honestly. Reuse the operation ID and identical arguments after a disconnect; use openclaw_discord_operation for recovery. Never retry uncertain writes with a new ID.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
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
            'Request or contextual handoff to publish and execute in this thread, preserving the user’s intent and including source references when available.',
        },
      },
      required: ['target', 'channel_id', 'operation_id', 'prompt'],
      additionalProperties: false,
    },
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
      'Create a normal text channel under an operator-approved guild/category using the configured Gateway API, then persistently admit it for Discord coordination. Requires explicit user authorization for creation AND admission. No arbitrary tool proxy. Keep operation ID on uncertainty.',
    inputSchema: {
      type: 'object',
      properties: {
        ...selectors,
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
      'Discord request rejected or could not be verified. Check arguments, allowlist and operation status; do not blindly retry writes.'
    );
  }
}
