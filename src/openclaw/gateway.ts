import { OpenClawClient } from './client.js';
import type { GatewayConfig } from './types.js';

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** One endpoint and credential, with explicit selection among its configured agents. */
export class OpenClawGateway {
  private readonly client: OpenClawClient;
  private readonly config: GatewayConfig;
  private readonly agentClients = new Map<string, OpenClawClient>();
  private readonly agentIds: Set<string>;

  constructor(
    config: GatewayConfig,
    private readonly model?: string
  ) {
    this.config = { ...config };
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error('Invalid OpenClaw Gateway URL');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('OpenClaw Gateway URL must use http or https');
    this.client = this.createClient(config.agentId);
    this.agentIds = new Set();
    for (const agent of config.agents ?? []) {
      if (!agent || !AGENT_ID_RE.test(agent.id)) throw new Error('Invalid catalog agent ID');
      const id = agent.id.toLowerCase();
      if (this.agentIds.has(id)) throw new Error('Duplicate catalog agent ID');
      this.agentIds.add(id);
    }
    const defaultAgent = this.client.getConversationAgentId();
    if (defaultAgent) this.agentIds.add(defaultAgent);
  }

  private createClient(agentId?: string): OpenClawClient {
    return new OpenClawClient(this.config.url, {
      gatewayToken: this.config.token,
      agentId,
      timeoutMs: this.config.timeout,
      model: this.model,
    });
  }

  getDefault(): OpenClawClient {
    return this.client;
  }

  resolve(agentId?: string): { client: OpenClawClient; agentId?: string } {
    if (agentId === undefined)
      return { client: this.client, agentId: this.client.getConversationAgentId() };
    if (!AGENT_ID_RE.test(agentId)) throw new Error('Invalid agent ID');
    const id = agentId.toLowerCase();
    if (!this.agentIds.has(id)) throw new Error('Unknown agent "' + id + '"');
    let client = this.agentClients.get(id);
    if (!client) {
      client = this.createClient(id);
      this.agentClients.set(id, client);
    }
    return { client, agentId: id };
  }

  listAgents(): Array<{ agentId: string; isDefault: boolean }> {
    return [...this.agentIds].map((agentId) => ({
      agentId,
      isDefault: this.client.getConversationAgentId() === agentId,
    }));
  }
}
