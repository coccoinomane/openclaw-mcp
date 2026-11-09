import { execFile } from 'node:child_process';
import type { DiscordConfig } from './discord.js';
import type { AgentBinding, InstanceConfig } from './types.js';

export type CatalogRunner = (executable: string, args: string[]) => Promise<unknown>;

const runCatalogCommand: CatalogRunner = (executable, args) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        // Do not expose subprocess stderr or source data, which can contain local paths.
        if (error) return reject(new Error('OpenClaw agent discovery command failed'));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('OpenClaw agent discovery returned invalid JSON'));
        }
      }
    );
  });

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
    // description is emitted by the official CLI; routing overrides are unsupported.
    if (Object.keys(entry).some((key) => !['agentId', 'match', 'description'].includes(key)))
      throw new Error('Unsupported catalog binding field');
    const agentId = id(entry.agentId);
    if (!roster.some((agent) => agent.id === agentId))
      throw new Error('Catalog binding references unknown agent');
    return { agentId, match: { ...entry.match } };
  });
}

/** Load only operator-selected catalogs; never read the full OpenClaw configuration. */
export async function loadAgentCatalog(
  configs: InstanceConfig[],
  env: NodeJS.ProcessEnv = process.env,
  runner: CatalogRunner = runCatalogCommand
): Promise<InstanceConfig[]> {
  const result = configs.map((config) => ({ ...config }));
  const assigned = new Set<string>();
  const apply = (instance: unknown, rawAgents: unknown, rawBindings: unknown) => {
    if (typeof instance !== 'string') throw new Error('Agent catalog requires an instance');
    const config = result.find((entry) => entry.name === instance);
    if (!config) throw new Error(`Agent catalog references unknown instance "${instance}"`);
    if (assigned.has(instance) || config.agents !== undefined || config.bindings !== undefined)
      throw new Error(`Multiple agent catalog sources for instance "${instance}"`);
    assigned.add(instance);
    config.agents = agents(rawAgents);
    if (rawBindings !== undefined) config.bindings = bindings(rawBindings, config.agents);
  };
  if (env.MCP_AGENT_CATALOG) {
    let catalog: unknown;
    try {
      catalog = JSON.parse(env.MCP_AGENT_CATALOG);
    } catch {
      throw new Error('MCP_AGENT_CATALOG contains invalid JSON');
    }
    if (!Array.isArray(catalog)) throw new Error('MCP_AGENT_CATALOG must be an array');
    for (const entry of catalog) {
      if (
        !object(entry) ||
        Object.keys(entry).some((key) => !['instance', 'agents', 'bindings'].includes(key))
      )
        throw new Error('Invalid agent catalog instance entry');
      apply(entry.instance, entry.agents, entry.bindings);
    }
  }
  if (env.MCP_AGENT_DISCOVERY && env.MCP_AGENT_DISCOVERY !== 'cli')
    throw new Error('MCP_AGENT_DISCOVERY must be cli when enabled');
  if (env.MCP_AGENT_DISCOVERY === 'cli') {
    const instance = env.MCP_AGENT_DISCOVERY_INSTANCE;
    if (!instance || !result.some((config) => config.name === instance))
      throw new Error('MCP_AGENT_DISCOVERY_INSTANCE must name a configured instance');
    if (
      assigned.has(instance) ||
      result.find((config) => config.name === instance)?.agents !== undefined
    )
      throw new Error(`Multiple agent catalog sources for instance "${instance}"`);
    const executable = env.MCP_AGENT_DISCOVERY_EXECUTABLE || 'openclaw';
    // Separate commands are required: list --bindings emits descriptions, not raw matches.
    const roster = await runner(executable, ['agents', 'list', '--json']);
    const routes = await runner(executable, ['agents', 'bindings', '--json']);
    apply(instance, roster, routes);
  } else if (env.MCP_AGENT_DISCOVERY_INSTANCE || env.MCP_AGENT_DISCOVERY_EXECUTABLE) {
    throw new Error('Agent discovery instance/executable requires MCP_AGENT_DISCOVERY=cli');
  }
  // Validate inline per-instance catalogs too.
  for (const config of result) {
    if (config.agents !== undefined) config.agents = agents(config.agents);
    if (config.bindings !== undefined)
      config.bindings = bindings(config.bindings, config.agents ?? []);
  }
  return result;
}

/** Make existing Discord agents selectable without expanding Discord permission scopes. */
export function includeConfiguredDiscordAgents(
  configs: InstanceConfig[],
  discord?: DiscordConfig
): InstanceConfig[] {
  if (!discord) return configs;
  const result = configs.map((config) => ({ ...config, agents: [...(config.agents ?? [])] }));
  const add = (instance: string | undefined, agentId: string) => {
    if (instance === undefined) return;
    const config = result.find((entry) => entry.name === instance);
    if (!config) throw new Error(`Discord references unknown instance "${instance}"`);
    const normalized = id(agentId);
    if (!config.agents.some((agent) => agent.id.toLowerCase() === normalized))
      config.agents.push({ id: normalized });
  };
  const local = discord.cliGatewayInstance ?? (configs.length === 1 ? configs[0].name : undefined);
  for (const mapping of [...discord.targets, ...(discord.discoveryScopes ?? [])])
    add(local, mapping.agentId);
  for (const policy of discord.creationPolicies ?? []) add(policy.instance, policy.agentId);
  return result;
}
