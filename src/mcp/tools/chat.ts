import { modelParameter, checkModel } from '../../openclaw/models.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OpenClawGateway } from '../../openclaw/gateway.js';
import {
  successResponse,
  errorResponse,
  withConversation,
  type ToolResponse,
} from '../../utils/response-helpers.js';
import { validateInputIsObject, validateMessage, validateId } from '../../utils/validation.js';
import {
  createConversationKey,
  resolveConversation,
  type ConversationContext,
} from '../conversation.js';

export const openclawChatTool: Tool = {
  name: 'openclaw_chat',
  description:
    'Send a message to OpenClaw and get a response. Save the returned session_id and agent_id (when present) and reuse them for follow-up turns. Omitting session_id starts a new conversation. The key is returned in structuredContent and an additional text block, including on Gateway errors; errors may follow accepted work, so do not automatically resend.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      model: modelParameter,
      message: {
        type: 'string',
        description: 'The message to send to OpenClaw',
      },
      session_id: {
        type: 'string',
        description:
          'Gateway conversation key returned by a previous chat. Reuse it unchanged for follow-up turns; omit for a new conversation. Distinct from MCP transport session and task IDs.',
      },
      agent_id: { type: 'string', description: 'Configured agent ID from openclaw_agents.' },
    },
    required: ['message'],
  },
};

export async function handleOpenclawChat(
  gateway: OpenClawGateway,
  input: unknown,
  context: ConversationContext = {}
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }
  if (
    Object.keys(input).some(
      (key) => !Object.prototype.hasOwnProperty.call(openclawChatTool.inputSchema.properties, key)
    )
  ) {
    return errorResponse('Unknown argument');
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

  let resolvedConversation = false;
  let agentId: string | undefined;
  try {
    checkModel(input.model);
    if (input.model !== undefined && sessionId !== undefined)
      throw new Error('model can only be selected when starting a new session; omit session_id');
    const resolved = resolveConversation(gateway, input.agent_id, sessionId);
    const { client } = resolved;
    agentId = resolved.agentId;
    if (input.model !== undefined && !agentId)
      throw new Error('Select an agent_id from openclaw_agents before choosing a model');
    resolvedConversation = true;
    sessionId ??= createConversationKey(context, agentId);
    if (input.model !== undefined) await gateway.selectModel(sessionId, input.model);
    const response = await client.chat(msgResult.value, sessionId);
    return withConversation(successResponse(response.response), sessionId, agentId);
  } catch (error) {
    const response = errorResponse(
      error instanceof Error ? error.message : 'Failed to chat with OpenClaw'
    );
    return sessionId && resolvedConversation
      ? withConversation(response, sessionId, agentId)
      : response;
  }
}
