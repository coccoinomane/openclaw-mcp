import { describe, expect, it, vi } from 'vitest';
import { includeConfiguredDiscordAgents, loadAgentCatalog } from '../../openclaw/agent-catalog.js';
import type { DiscordConfig } from '../../openclaw/discord.js';
import { assertServiceProvenance } from '../../openclaw/discord-channels.js';
import { InstanceRegistry } from '../../openclaw/registry.js';

const instances = [{ name: 'local', url: 'http://localhost:18789', agentId: 'main' }];
describe('agent catalog', () => {
  it('accepts operator catalog configuration without weakening agent provenance denial', () => {
    const env = {
      MCP_AGENT_CATALOG: JSON.stringify([{ instance: 'local', agents: [{ id: 'main' }] }]),
      MCP_AGENT_DISCOVERY: 'gateway',
    };
    expect(() => assertServiceProvenance(env)).not.toThrow();
    expect(() => assertServiceProvenance({ ...env, OPENCLAW_AGENT_ID: 'caller' })).toThrow(
      'AGENT_PROVENANCE_DENIED'
    );
  });
  it('preserves old defaults and immutable per-agent clients for generic agents without Discord', async () => {
    const configs = await loadAgentCatalog(instances, {
      MCP_AGENT_CATALOG: JSON.stringify([
        { instance: 'local', agents: [{ id: 'main' }, { id: 'writer' }] },
      ]),
    });
    const registry = new InstanceRegistry(configs);
    const baseline = registry.resolve();
    const writer = registry.resolve('local', 'writer');
    expect(writer.client.getConversationAgentId()).toBe('writer');
    expect(baseline.client.getConversationAgentId()).toBe('main');
    expect(registry.resolve('local', 'writer').client).toBe(writer.client);
    expect(registry.listAgents()).toEqual([
      { instance: 'local', agentId: 'main', isDefault: true },
      { instance: 'local', agentId: 'writer', isDefault: false },
    ]);
    expect(registry.getBindings('local')).toBeUndefined();
    expect(() => registry.resolve('local', 'missing')).toThrow('Unknown agent');
    expect(() => registry.resolve('missing', 'writer')).toThrow('Unknown instance');
  });
  it('strips private roster fields and preserves operator bindings', async () => {
    const loader = vi.fn().mockResolvedValue({
      agents: [{ id: 'main', workspace: '/private/path', token: 'secret' }, { id: 'writer' }],
    });
    const configs = await loadAgentCatalog(
      instances,
      {
        MCP_AGENT_DISCOVERY: 'gateway',
        MCP_AGENT_CATALOG: JSON.stringify([
          {
            instance: 'local',
            bindings: [
              {
                agentId: 'writer',
                match: { channel: 'discord', guildId: '123' },
                description: 'route',
              },
            ],
          },
        ]),
      },
      loader
    );
    expect(loader).toHaveBeenCalledOnce();
    expect(JSON.stringify(configs)).not.toContain('private');
    expect(JSON.stringify(configs)).not.toContain('secret');
    expect(configs[0].bindings).toEqual([
      { agentId: 'writer', match: { channel: 'discord', guildId: '123' } },
    ]);
  });
  it('does not execute discovery by default', async () => {
    const loader = vi.fn();
    expect(await loadAgentCatalog(instances, {}, loader)).toEqual(instances);
    expect(loader).not.toHaveBeenCalled();
  });
  it('rejects unknown scopes, duplicate catalogs, unknown binding agents and unsupported overrides', async () => {
    const loader = vi.fn();
    await expect(
      loadAgentCatalog(instances, { MCP_AGENT_DISCOVERY: 'cli' }, loader)
    ).rejects.toThrow('must be gateway');
    expect(loader).not.toHaveBeenCalled();
    for (const entry of [
      { instance: 'missing', agents: [] },
      { instance: 'local', agents: [{ id: 'main' }, { id: 'MAIN' }] },
      { instance: 'local', agents: [{ id: 'main' }], bindings: [{ agentId: 'writer', match: {} }] },
      {
        instance: 'local',
        agents: [{ id: 'main' }],
        bindings: [{ agentId: 'main', match: {}, session: 'override' }],
      },
    ])
      await expect(
        loadAgentCatalog(instances, { MCP_AGENT_CATALOG: JSON.stringify([entry]) })
      ).rejects.toThrow();
    await expect(
      loadAgentCatalog(instances, {
        MCP_AGENT_CATALOG: JSON.stringify([
          { instance: 'local', agents: [] },
          { instance: 'local', agents: [] },
        ]),
      })
    ).rejects.toThrow('Multiple');
  });
  it('keeps model-derived defaults and unknown gateway default behavior', () => {
    const registry = new InstanceRegistry([{ name: 'a', url: 'http://localhost' }], 'agent:writer');
    expect(registry.resolve().agentId).toBe('writer');
    expect(registry.resolve('a', 'writer').agentId).toBe('writer');
    expect(new InstanceRegistry([{ name: 'a', url: 'http://localhost' }]).listAgents()).toEqual([]);
  });
});

describe('configured Discord agents in generic catalog', () => {
  const discord: DiscordConfig = {
    stateDir: '/tmp/test-only',
    targets: [
      {
        name: 'channel',
        guildId: '100000000000000001',
        channelId: '100000000000000002',
        accountId: 'default',
        agentId: 'writer',
      },
    ],
    discoveryScopes: [{ guildId: '100000000000000003', accountId: 'default', agentId: 'reviewer' }],
  };
  it('includes legacy agents for one instance without changing scopes or defaults', () => {
    const result = includeConfiguredDiscordAgents(instances, discord);
    expect(result[0].agents).toEqual([{ id: 'writer' }, { id: 'reviewer' }]);
    expect(instances[0]).not.toHaveProperty('agents');
    expect(discord.targets).toHaveLength(1);
    expect(new InstanceRegistry(result).resolve().agentId).toBe('main');
    expect(new InstanceRegistry(result).resolve('local', 'writer').agentId).toBe('writer');
  });
  it('does not guess multi-instance mapping and obeys explicit association', () => {
    const configs = [...instances, { name: 'remote', url: 'https://gateway.example' }];
    expect(
      includeConfiguredDiscordAgents(configs, discord).every((entry) => entry.agents?.length === 0)
    ).toBe(true);
    const result = includeConfiguredDiscordAgents(configs, {
      ...discord,
      gatewayInstance: 'remote',
    });
    expect(result[0].agents).toEqual([]);
    expect(result[1].agents).toEqual([{ id: 'writer' }, { id: 'reviewer' }]);
    expect(() =>
      includeConfiguredDiscordAgents(configs, { ...discord, gatewayInstance: 'unknown' })
    ).toThrow('unknown instance');
  });
});

describe('Gateway catalog configuration', () => {
  const env = { MCP_AGENT_DISCOVERY: 'gateway' };
  const roster = {
    agents: [{ id: 'main' }, { id: 'writer' }],
    defaultId: 'writer',
    selectionRequired: true,
  };
  it('combines a Gateway roster with bindings-only catalog without importing configuration', async () => {
    const loader = vi.fn().mockResolvedValue(roster);
    const routes = [{ agentId: 'writer', match: { channel: 'discord', guildId: '123' } }];
    const result = await loadAgentCatalog(
      instances,
      {
        ...env,
        MCP_AGENT_CATALOG: JSON.stringify([{ instance: 'local', bindings: routes }]),
      },
      loader
    );
    expect(result[0].agents).toEqual(roster.agents);
    expect(result[0].bindings).toEqual(routes);
    expect(new InstanceRegistry(result).resolve().agentId).toBe('main');
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it('retains unknown-default behavior and does not enforce selectionRequired', async () => {
    const result = await loadAgentCatalog(
      [{ name: 'local', url: 'https://gateway.example' }],
      env,
      async () => roster
    );
    const registry = new InstanceRegistry(result);
    expect(registry.resolve().agentId).toBeUndefined();
    expect(registry.listAgents().every((agent) => !agent.isDefault)).toBe(true);
    expect(registry.resolve('local', 'writer').agentId).toBe('writer');
  });
  it('rejects conflicting roster sources before connecting', async () => {
    const loader = vi.fn();
    for (const extra of [
      { MCP_AGENT_CATALOG: JSON.stringify([{ instance: 'local', agents: [{ id: 'main' }] }]) },
    ])
      await expect(loadAgentCatalog(instances, { ...env, ...extra }, loader)).rejects.toThrow();
    await expect(loadAgentCatalog([{ ...instances[0], agents: [] }], env, loader)).rejects.toThrow(
      'static agent roster'
    );
    expect(loader).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { agents: null },
    { agents: [null] },
    { agents: [{ id: '../bad' }] },
    { agents: [{ id: 'MAIN' }, { id: 'main' }] },
    { agents: [{ id: 'main', kind: 'unknown' }] },
  ])('rejects malformed Gateway response %j without default fallback', async (value) => {
    await expect(loadAgentCatalog(instances, env, async () => value)).rejects.toThrow();
    expect(instances[0]).not.toHaveProperty('agents');
  });
  it('validates manual bindings against the returned roster and preserves explicit empty routes', async () => {
    await expect(
      loadAgentCatalog(
        [{ ...instances[0], bindings: [{ agentId: 'missing', match: {} }] }],
        env,
        async () => roster
      )
    ).rejects.toThrow('unknown agent');
    const result = await loadAgentCatalog(
      [{ ...instances[0], bindings: [] }],
      env,
      async () => roster
    );
    expect(result[0].bindings).toEqual([]);
  });
});
