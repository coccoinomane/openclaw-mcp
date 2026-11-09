/**
 * Instance Registry for multi-instance OpenClaw support.
 *
 * Manages named OpenClawClient instances, each pointing to a different
 * OpenClaw gateway. Supports a default instance for backward compatibility.
 */

import { OpenClawClient } from './client.js';
import type { AgentBinding, InstanceConfig } from './types.js';

const INSTANCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class InstanceRegistry {
  private instances: Map<string, { config: InstanceConfig; client: OpenClawClient }> = new Map();
  private defaultName: string;
  private agentClients = new Map<string, OpenClawClient>();
  private model: string | undefined;

  constructor(configs: InstanceConfig[], model?: string) {
    if (configs.length === 0) {
      throw new Error('At least one OpenClaw instance must be configured');
    }

    this.model = model;
    const names = new Set<string>();
    let explicitDefault: string | undefined;

    for (let config of configs) {
      if (!INSTANCE_NAME_RE.test(config.name)) {
        throw new Error(
          `Invalid instance name "${config.name}": must be 1-64 chars, alphanumeric/dashes/underscores, start with alphanumeric`
        );
      }

      // Validate URL scheme (prevent SSRF)
      try {
        const parsed = new URL(config.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(
            `Instance "${config.name}": URL must use http or https (got ${parsed.protocol})`
          );
        }
      } catch (error) {
        if (error instanceof TypeError) {
          throw new Error(`Instance "${config.name}": invalid URL "${config.url}"`);
        }
        throw error;
      }

      if (names.has(config.name)) {
        throw new Error(`Duplicate instance name: "${config.name}"`);
      }
      names.add(config.name);

      if (config.default) {
        if (explicitDefault) {
          throw new Error(
            `Multiple default instances: "${explicitDefault}" and "${config.name}". Only one default is allowed.`
          );
        }
        explicitDefault = config.name;
      }

      const client = new OpenClawClient(config.url, {
        gatewayToken: config.token,
        agentId: config.agentId,
        timeoutMs: config.timeout,
        model,
      });
      const ids = new Set<string>();
      for (const agent of config.agents ?? []) {
        if (!agent || !INSTANCE_NAME_RE.test(agent.id)) throw new Error('Invalid catalog agent ID');
        const id = agent.id.toLowerCase();
        if (ids.has(id)) throw new Error(`Duplicate agent "${id}" in instance "${config.name}"`);
        ids.add(id);
      }
      const defaultAgent = client.getConversationAgentId();
      if (defaultAgent) ids.add(defaultAgent);
      config = { ...config, agents: [...ids].map((id) => ({ id })) };
      this.instances.set(config.name, { config, client });
    }

    this.defaultName = explicitDefault ?? configs[0].name;
  }

  /**
   * Get client by instance name. Returns undefined if not found.
   */
  get(name: string): OpenClawClient | undefined {
    return this.instances.get(name)?.client;
  }

  /**
   * Get the default client.
   */
  getDefault(): OpenClawClient {
    const entry = this.instances.get(this.defaultName);
    if (!entry) {
      throw new Error(`Default instance "${this.defaultName}" not found`);
    }
    return entry.client;
  }

  /**
   * Get the default instance name.
   */
  getDefaultName(): string {
    return this.defaultName;
  }

  /**
   * Resolve an optional instance name to a concrete client.
   * Falls back to default when name is undefined.
   */
  resolve(
    name?: string,
    agentId?: string
  ): { name: string; client: OpenClawClient; agentId?: string } {
    const resolvedName = name ?? this.defaultName;
    const entry = this.instances.get(resolvedName);
    if (!entry)
      throw new Error(
        `Unknown instance "${resolvedName}". Available: ${this.listNames().join(', ')}`
      );
    if (agentId === undefined)
      return {
        name: resolvedName,
        client: entry.client,
        agentId: entry.client.getConversationAgentId(),
      };
    if (!INSTANCE_NAME_RE.test(agentId)) throw new Error('Invalid agent ID');
    const id = agentId.toLowerCase();
    if (!entry.config.agents?.some((agent) => agent.id === id))
      throw new Error(`Unknown agent "${id}" for instance "${resolvedName}"`);
    const key = `${resolvedName}:${id}`;
    let client = this.agentClients.get(key);
    if (!client) {
      client = new OpenClawClient(entry.config.url, {
        gatewayToken: entry.config.token,
        agentId: id,
        timeoutMs: entry.config.timeout,
        model: this.model,
      });
      this.agentClients.set(key, client);
    }
    return { name: resolvedName, client, agentId: id };
  }

  listAgents(name?: string): Array<{ instance: string; agentId: string; isDefault: boolean }> {
    if (name !== undefined) this.resolve(name);
    return [...this.instances.entries()]
      .filter(([instance]) => name === undefined || name === instance)
      .flatMap(([instance, entry]) =>
        (entry.config.agents ?? []).map(({ id }) => ({
          instance,
          agentId: id,
          isDefault: entry.client.getConversationAgentId() === id,
        }))
      );
  }

  getBindings(name: string): AgentBinding[] | undefined {
    this.resolve(name);
    return this.instances.get(name)?.config.bindings;
  }

  /**
   * List instance names.
   */
  listNames(): string[] {
    return Array.from(this.instances.keys());
  }

  /**
   * List instances with safe metadata (never exposes tokens).
   */
  list(): Array<{ name: string; url: string; isDefault: boolean }> {
    return Array.from(this.instances.entries()).map(([name, { config }]) => ({
      name,
      url: config.url,
      isDefault: name === this.defaultName,
    }));
  }

  /**
   * Number of registered instances.
   */
  get size(): number {
    return this.instances.size;
  }

  /**
   * Check if this is a single-instance (backward-compat) setup.
   */
  get isSingleInstance(): boolean {
    return this.instances.size === 1;
  }
}
