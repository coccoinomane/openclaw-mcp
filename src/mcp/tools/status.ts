import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OpenClawGateway } from '../../openclaw/gateway.js';
import { jsonResponse, errorResponse, type ToolResponse } from '../../utils/response-helpers.js';
import { validateInputIsObject, validateId } from '../../utils/validation.js';

export const openclawStatusTool: Tool = {
  name: 'openclaw_status',
  description: 'Get OpenClaw gateway status and health information',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      agent_id: {
        type: 'string',
        description: 'Select agent metadata; health checks Gateway reachability only.',
      },
    },
  },
};

export async function handleOpenclawStatus(
  gateway: OpenClawGateway,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }
  if (
    Object.keys(input).some(
      (key) => !Object.prototype.hasOwnProperty.call(openclawStatusTool.inputSchema.properties, key)
    )
  ) {
    return errorResponse('Unknown argument');
  }

  let agentId: string | undefined;
  if (input.agent_id !== undefined) {
    const checked = validateId(input.agent_id, 'agent_id');
    if (!checked.valid) return errorResponse(checked.error);
    agentId = checked.value;
  }
  try {
    const resolved = gateway.resolve(agentId);
    const response = await resolved.client.health();
    return jsonResponse({
      ...response,
      ...(resolved.agentId ? { agent_id: resolved.agentId } : {}),
      health_scope: 'gateway',
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get status from OpenClaw'
    );
  }
}
