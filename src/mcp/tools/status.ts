import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import { jsonResponse, errorResponse, type ToolResponse } from '../../utils/response-helpers.js';
import { validateInputIsObject, validateId } from '../../utils/validation.js';

export const openclawStatusTool: Tool = {
  name: 'openclaw_status',
  description: 'Get OpenClaw gateway status and health information',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Select agent metadata; health checks Gateway reachability only.',
      },
      instance: {
        type: 'string',
        description: 'Target OpenClaw instance name. Defaults to the default instance.',
      },
    },
  },
};

export async function handleOpenclawStatus(
  registry: InstanceRegistry,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }

  let instanceName: string | undefined;
  if (input.instance !== undefined) {
    const instResult = validateId(input.instance, 'instance');
    if (instResult.valid === false) {
      return errorResponse(instResult.error);
    }
    instanceName = instResult.value;
  }

  let agentId: string | undefined;
  if (input.agent_id !== undefined) {
    const checked = validateId(input.agent_id, 'agent_id');
    if (!checked.valid) return errorResponse(checked.error);
    agentId = checked.value;
  }
  try {
    const resolved = registry.resolve(instanceName, agentId);
    const response = await resolved.client.health();
    return jsonResponse({
      ...response,
      instance: resolved.name,
      ...(resolved.agentId ? { agent_id: resolved.agentId } : {}),
      health_scope: 'gateway',
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to get status from OpenClaw'
    );
  }
}
