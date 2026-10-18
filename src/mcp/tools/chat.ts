import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import {
  successResponse,
  errorResponse,
  withConversation,
  type ToolResponse,
} from '../../utils/response-helpers.js';
import { validateInputIsObject, validateMessage, validateId } from '../../utils/validation.js';
import { createConversationKey, type ConversationContext } from '../conversation.js';

export const openclawChatTool: Tool = {
  name: 'openclaw_chat',
  description:
    'Send a message to OpenClaw and get a response. Save the returned session_id and instance and reuse both for follow-up turns. Omitting session_id starts a new conversation. The key is returned in structuredContent and an additional text block, including on Gateway errors; errors may follow accepted work, so do not automatically resend.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The message to send to OpenClaw',
      },
      session_id: {
        type: 'string',
        description:
          'Gateway conversation key returned by a previous chat. Reuse it unchanged for follow-up turns; omit for a new conversation. Distinct from MCP transport session and task IDs.',
      },
      instance: {
        type: 'string',
        description:
          'Target OpenClaw instance name. Use openclaw_instances to list available instances. Defaults to the default instance.',
      },
    },
    required: ['message'],
  },
};

export async function handleOpenclawChat(
  registry: InstanceRegistry,
  input: unknown,
  context: ConversationContext = {}
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }

  const msgResult = validateMessage(input.message);
  if (msgResult.valid === false) {
    return errorResponse(msgResult.error);
  }

  let sessionId: string | undefined;
  if (input.session_id !== undefined) {
    const sidResult = validateId(input.session_id, 'session_id');
    if (sidResult.valid === false) {
      return errorResponse(sidResult.error);
    }
    sessionId = sidResult.value;
  }

  let instanceName: string | undefined;
  if (input.instance !== undefined) {
    const instResult = validateId(input.instance, 'instance');
    if (instResult.valid === false) {
      return errorResponse(instResult.error);
    }
    instanceName = instResult.value;
  }

  let effectiveInstance: string;
  try {
    const { client, name } = registry.resolve(instanceName);
    effectiveInstance = name;
    sessionId ??= createConversationKey(name, context, client.getConversationAgentId());
    const response = await client.chat(msgResult.value, sessionId);
    return withConversation(successResponse(response.response), sessionId, name);
  } catch (error) {
    const response = errorResponse(
      error instanceof Error ? error.message : 'Failed to chat with OpenClaw'
    );
    return sessionId && effectiveInstance
      ? withConversation(response, sessionId, effectiveInstance)
      : response;
  }
}
