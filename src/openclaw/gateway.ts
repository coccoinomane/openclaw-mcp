import { listModels, selectSessionModel } from './models.js';
import { OpenClawClient } from './client.js';
import { discoverGatewayAgents, discoverGatewayConfig } from './gateway-discovery.js';
import type { GatewayConfig } from './types.js';

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function validateAgentId(selector: unknown): asserts selector is string | undefined {
  if (selector !== undefined && (typeof selector !== 'string' || !AGENT_ID_RE.test(selector)))
    throw new Error(
      `Invalid agent_id ${JSON.stringify(selector)}. Use a bare agent ID, e.g. "main". Call openclaw_agents to list available agents.`
    );
}

export class OpenClawGateway {
  private readonly agentClients = new Map<string, OpenClawClient>();
  constructor(private readonly config: GatewayConfig) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error('Invalid OpenClaw Gateway URL');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('OpenClaw Gateway URL must use http or https');
    if (config.defaultAgentId !== undefined && !AGENT_ID_RE.test(config.defaultAgentId))
      throw new Error('Invalid default agent ID');
  }
  get agentIsMandatory() {
    return this.config.agentIsMandatory === true;
  }
  async resolve(selector?: unknown): Promise<{ client: OpenClawClient; agentId: string }> {
    validateAgentId(selector);
    if (selector === undefined && this.agentIsMandatory) throw new Error('agent_id is required');
    const selected = this.agentIsMandatory ? selector : (selector ?? this.config.defaultAgentId);
    if (selected === undefined)
      throw new Error('Select agent_id or configure OPENCLAW_DEFAULT_AGENT_ID');
    const agentId = selected.toLowerCase();
    if (!(await this.listAgents()).some((a) => a.agentId === agentId))
      throw new Error(
        `Unknown agent_id "${agentId}". Call openclaw_agents to list available agents.`
      );
    let client = this.agentClients.get(agentId);
    if (!client) {
      client = new OpenClawClient(this.config.url, {
        gatewayToken: this.config.token,
        agentId,
        timeoutMs: this.config.timeout,
      });
      this.agentClients.set(agentId, client);
    }
    return { client, agentId };
  }
  async listAgents(): Promise<Array<{ agentId: string; isDefault: boolean }>> {
    const roster: any = await discoverGatewayAgents(this.config);
    if (!roster || !Array.isArray(roster.agents))
      throw new Error('Gateway returned an invalid agent roster');
    const ids = new Set<string>();
    for (const a of roster.agents) {
      if (
        !a ||
        typeof a.id !== 'string' ||
        !AGENT_ID_RE.test(a.id) ||
        (a.kind !== undefined && !['agent', 'system'].includes(a.kind))
      )
        throw new Error('Gateway returned an invalid agent roster');
      if (a.kind === 'system') continue;
      const id = a.id.toLowerCase();
      if (ids.has(id)) throw new Error('Gateway returned duplicate agents');
      ids.add(id);
    }
    return [...ids].map((agentId) => ({
      agentId,
      isDefault: !this.agentIsMandatory && this.config.defaultAgentId?.toLowerCase() === agentId,
    }));
  }
  async bindingsConfig(): Promise<Record<string, any>> {
    const snapshot: any = await discoverGatewayConfig(this.config);
    if (
      snapshot?.valid !== true ||
      typeof snapshot.configRevisionHash !== 'string' ||
      !snapshot.configRevisionHash ||
      snapshot.configRevisionHash === '__OPENCLAW_REDACTED__' ||
      snapshot.configRevisionHash !== snapshot.appliedConfigHash
    )
      throw new Error('Gateway configuration is not verified as applied');
    const config = snapshot.runtimeConfig ?? snapshot.config;
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      (config.bindings !== undefined && !Array.isArray(config.bindings))
    )
      throw new Error('Gateway bindings are unavailable');
    return { bindings: config.bindings ?? [], channels: { discord: config.channels?.discord } };
  }
  async models(selector?: string) {
    const { agentId } = await this.resolve(selector);
    return listModels(this.config, agentId);
  }
  async selectModel(key: string, model: string) {
    return selectSessionModel(this.config, key, model);
  }
}
