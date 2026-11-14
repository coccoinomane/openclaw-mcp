import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OpenClawGateway } from '../../openclaw/gateway.js';
import { errorResponse, structuredJsonResponse } from '../../utils/response-helpers.js';
import { validateInputIsObject } from '../../utils/validation.js';
export const openclawModelsTool: Tool = {
  name: 'openclaw_models',
  description:
    'List selectable models for a configured agent. Call before choosing model on openclaw_chat or openclaw_discord_ask, using the same agent. This is not a provider inference or credential test.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent ID from openclaw_agents. Omit for the configured default agent.',
      },
    },
    additionalProperties: false,
  },
};
export async function handleOpenclawModels(gateway: OpenClawGateway, input: unknown) {
  if (!validateInputIsObject(input) || Object.keys(input).some((k) => k !== 'agent_id'))
    return errorResponse('Invalid model catalog arguments');
  if (input.agent_id !== undefined && typeof input.agent_id !== 'string')
    return errorResponse('Invalid agent_id');
  try {
    return structuredJsonResponse(await gateway.models(input.agent_id as string | undefined));
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to list models');
  }
}
