import { gatewayModelRequest } from './gateway-discovery.js';
import type { GatewayConfig } from './types.js';
import { assertServiceProvenance } from './discord-channels.js';

export const modelParameter = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  description:
    'Optional model for the new session. Before setting it, call openclaw_models for the same agent and use the returned model identifier. The selection persists for that session, not the agent default. Omit to keep existing default behavior.',
};
export function checkModel(value: unknown): asserts value is string | undefined {
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      !value.trim() ||
      value.length > 256 ||
      [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
  )
    throw new Error('Invalid model');
}
export async function listModels(config: GatewayConfig, agentId: string) {
  assertServiceProvenance();
  const result = await gatewayModelRequest(config, {
    method: 'models.list',
    params: { agentId, view: 'configured' },
  });
  if (!Array.isArray(result?.models)) throw new Error('Invalid Gateway model catalog');
  const models = result.models
    .filter((m: any) => m.manualSelectionAllowed === true)
    .map((m: any) => {
      if (typeof m.provider !== 'string' || typeof m.id !== 'string')
        throw new Error('Invalid Gateway model row');
      return {
        model: m.provider + '/' + m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
        ...(typeof m.alias === 'string' ? { alias: m.alias } : {}),
        ...(typeof m.available === 'boolean' ? { available: m.available } : {}),
      };
    });
  if (result.models.some((m: any) => typeof m.manualSelectionAllowed !== 'boolean'))
    throw new Error('Gateway must support model-selection-policy');
  return { agent_id: agentId, models, total: models.length };
}
export async function selectSessionModel(config: GatewayConfig, key: string, model: string) {
  assertServiceProvenance();
  checkModel(model);
  const result = await gatewayModelRequest(config, {
    method: 'sessions.patch',
    params: { key, model },
  });
  if (result?.ok !== true)
    throw new Error('Gateway did not confirm session model selection; do not retry automatically');
}
