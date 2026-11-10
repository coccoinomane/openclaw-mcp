import { discoverGatewayAgents, type GatewayRosterLoader } from './gateway-discovery.js';
import type { DiscordConfig } from './discord.js';
import type { AgentBinding, GatewayConfig } from './types.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value))
    throw new Error('Invalid catalog agent ID');
  return value.toLowerCase();
}
function agents(value: unknown): Array<{ id: string }> {
  if (!Array.isArray(value)) throw new Error('Agent catalog agents must be an array');
  const result = value.map((entry: unknown) => {
    if (!object(entry)) throw new Error('Invalid agent catalog entry');
    return { id: id(entry.id) };
  });
  if (new Set(result.map((entry) => entry.id)).size !== result.length)
    throw new Error('Duplicate catalog agent ID');
  return result;
}
function bindings(value: unknown, roster: Array<{ id: string }>): AgentBinding[] {
  if (!Array.isArray(value)) throw new Error('Agent catalog bindings must be an array');
  return value.map((entry: unknown) => {
    if (!object(entry) || !object(entry.match)) throw new Error('Invalid catalog binding');
    // Descriptions are display-only; routing overrides are unsupported.
    if (Object.keys(entry).some((key) => !['agentId', 'match', 'description'].includes(key)))
      throw new Error('Unsupported catalog binding field');
    const agentId = id(entry.agentId);
    if (!roster.some((agent) => agent.id === agentId))
      throw new Error('Catalog binding references unknown agent');
    return { agentId, match: { ...entry.match } };
  });
}

/** Load only the operator-selected catalog, never the full OpenClaw configuration. */
export async function loadAgentCatalog(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
  gatewayLoader: GatewayRosterLoader = discoverGatewayAgents
): Promise<GatewayConfig> {
  const discovery = env.MCP_AGENT_DISCOVERY === 'gateway';
  if (env.MCP_AGENT_DISCOVERY && !discovery)
    throw new Error('MCP_AGENT_DISCOVERY must be gateway when enabled');
  if (!discovery && env.MCP_AGENT_DISCOVERY_STATE_DIR)
    throw new Error('Agent discovery state directory requires MCP_AGENT_DISCOVERY=gateway');
  const result = { ...config };
  let rawBindings: unknown = config.bindings;
  if (env.MCP_AGENT_CATALOG) {
    let catalog: unknown;
    try {
      catalog = JSON.parse(env.MCP_AGENT_CATALOG);
    } catch {
      throw new Error('MCP_AGENT_CATALOG contains invalid JSON');
    }
    if (
      !object(catalog) ||
      Object.keys(catalog).some((key) => !['agents', 'bindings'].includes(key))
    )
      throw new Error('MCP_AGENT_CATALOG must be an object with agents and/or bindings');
    if (config.agents !== undefined || config.bindings !== undefined)
      throw new Error('Multiple agent catalog sources');
    if (!discovery || catalog.agents !== undefined) result.agents = agents(catalog.agents);
    rawBindings = catalog.bindings;
  }
  if (discovery) {
    if (result.agents !== undefined)
      throw new Error('Gateway discovery cannot be combined with a static agent roster');
    const roster = await gatewayLoader(result, env);
    try {
      if (!object(roster) || !Array.isArray(roster.agents)) throw new Error();
      const visible = roster.agents.filter((entry: unknown) => {
        if (
          !object(entry) ||
          (entry.kind !== undefined && entry.kind !== 'agent' && entry.kind !== 'system')
        )
          throw new Error();
        return entry.kind !== 'system';
      });
      result.agents = agents(visible);
    } catch {
      throw new Error('Gateway returned an invalid agent roster');
    }
    // Retain configured/model defaults rather than inferring a routing policy from the roster.
  }
  if (result.agents !== undefined) result.agents = agents(result.agents);
  if (rawBindings !== undefined) result.bindings = bindings(rawBindings, result.agents ?? []);
  return result;
}

/** Make existing Discord agents selectable without expanding Discord permission scopes. */
export function includeConfiguredDiscordAgents(
  config: GatewayConfig,
  discord?: DiscordConfig
): GatewayConfig {
  if (!discord) return config;
  const result = { ...config, agents: [...(config.agents ?? [])] };
  for (const mapping of [
    ...discord.targets,
    ...(discord.discoveryScopes ?? []),
    ...(discord.creationPolicies ?? []),
  ]) {
    const agentId = id(mapping.agentId);
    if (!result.agents.some((agent) => agent.id.toLowerCase() === agentId))
      result.agents.push({ id: agentId });
  }
  return result;
}
