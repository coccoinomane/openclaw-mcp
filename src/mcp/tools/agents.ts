import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceRegistry } from '../../openclaw/registry.js';
import {
  errorResponse,
  structuredJsonResponse,
  type ToolResponse,
} from '../../utils/response-helpers.js';
import { validateId, validateInputIsObject } from '../../utils/validation.js';

export const openclawAgentsTool: Tool = {
  name: 'openclaw_agents',
  description:
    'List configured agents available to every authenticated client, including agents without Discord mappings. This is an operator catalog snapshot, not a live availability probe.',
  inputSchema: {
    type: 'object',
    properties: {
      instance: {
        type: 'string',
        description: 'Filter by configured instance name; omit to list all instances.',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instance: { type: 'string' },
            agent_id: { type: 'string' },
            is_default: { type: 'boolean' },
          },
          required: ['instance', 'agent_id', 'is_default'],
          additionalProperties: false,
        },
      },
      total: { type: 'integer', minimum: 0 },
    },
    required: ['agents', 'total'],
    additionalProperties: false,
  },
};

export async function handleOpenclawAgents(
  registry: InstanceRegistry,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) return errorResponse('Invalid input: expected an object');
  if (Object.keys(input).some((key) => key !== 'instance'))
    return errorResponse('Unknown argument');
  let instance: string | undefined;
  if (input.instance !== undefined) {
    const checked = validateId(input.instance, 'instance');
    if (!checked.valid) return errorResponse(checked.error);
    instance = checked.value;
  }
  try {
    const agents = registry.listAgents(instance).map((entry) => ({
      instance: entry.instance,
      agent_id: entry.agentId,
      is_default: entry.isDefault,
    }));
    return structuredJsonResponse({ agents, total: agents.length });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to list agents');
  }
}
