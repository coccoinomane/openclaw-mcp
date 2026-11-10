import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OpenClawGateway } from '../../openclaw/gateway.js';
import {
  errorResponse,
  structuredJsonResponse,
  type ToolResponse,
} from '../../utils/response-helpers.js';
import { validateInputIsObject } from '../../utils/validation.js';

export const openclawAgentsTool: Tool = {
  name: 'openclaw_agents',
  description:
    'List configured agents available to every authenticated client, including agents without Discord mappings. This is an operator catalog snapshot, not a live availability probe.',
  inputSchema: {
    type: 'object',
    properties: {},
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
            agent_id: { type: 'string' },
            is_default: { type: 'boolean' },
          },
          required: ['agent_id', 'is_default'],
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
  gateway: OpenClawGateway,
  input: unknown
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) return errorResponse('Invalid input: expected an object');
  if (Object.keys(input).length) return errorResponse('Unknown argument');
  try {
    const agents = gateway.listAgents().map((entry) => ({
      agent_id: entry.agentId,
      is_default: entry.isDefault,
    }));
    return structuredJsonResponse({ agents, total: agents.length });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to list agents');
  }
}
