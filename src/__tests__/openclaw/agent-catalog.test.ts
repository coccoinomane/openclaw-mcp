import { describe, expect, it, vi } from 'vitest';
import { includeConfiguredDiscordAgents, loadAgentCatalog } from '../../openclaw/agent-catalog.js';
import type { DiscordConfig } from '../../openclaw/discord.js';
import { assertServiceProvenance } from '../../openclaw/discord-channels.js';
import { OpenClawGateway } from '../../openclaw/gateway.js';

const config = { url: 'http://localhost:18789', agentId: 'main' };
const roster = {
  agents: [{ id: 'main' }, { id: 'writer' }],
  defaultId: 'writer',
  selectionRequired: true,
};
const discovery = { MCP_AGENT_DISCOVERY: 'gateway' };

describe('single Gateway agent catalog', () => {
  it('accepts operator catalogs without weakening agent provenance denial', () => {
    const env = { MCP_AGENT_CATALOG: JSON.stringify({ agents: [{ id: 'main' }] }), ...discovery };
    expect(() => assertServiceProvenance(env)).not.toThrow();
    expect(() => assertServiceProvenance({ ...env, OPENCLAW_AGENT_ID: 'caller' })).toThrow(
      'AGENT_PROVENANCE_DENIED'
    );
  });
  it('preserves defaults and immutable clients for generic agents without Discord', async () => {
    const result = await loadAgentCatalog(config, {
      MCP_AGENT_CATALOG: JSON.stringify({ agents: roster.agents }),
    });
    const gateway = new OpenClawGateway(result);
    const writer = gateway.resolve('writer');
    expect(writer.client.getConversationAgentId()).toBe('writer');
    expect(gateway.resolve().client.getConversationAgentId()).toBe('main');
    expect(gateway.resolve('writer').client).toBe(writer.client);
    expect(gateway.listAgents()).toEqual([
      { agentId: 'main', isDefault: true },
      { agentId: 'writer', isDefault: false },
    ]);
    expect(result.bindings).toBeUndefined();
    expect(() => gateway.resolve('missing')).toThrow('Unknown agent');
  });
  it('strips private roster fields and preserves manual bindings', async () => {
    const loader = vi.fn().mockResolvedValue({
      agents: [
        { id: 'main', workspace: '/private', token: 'secret' },
        { id: 'writer' },
        { id: 'system', kind: 'system' },
      ],
    });
    const result = await loadAgentCatalog(
      config,
      {
        ...discovery,
        MCP_AGENT_CATALOG: JSON.stringify({
          bindings: [
            {
              agentId: 'writer',
              match: { channel: 'discord', guildId: '123' },
              description: 'route',
            },
          ],
        }),
      },
      loader
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(
      expect.objectContaining(config),
      expect.objectContaining(discovery)
    );
    expect(JSON.stringify(result)).not.toMatch(/private|secret|system/);
    expect(result.bindings).toEqual([
      { agentId: 'writer', match: { channel: 'discord', guildId: '123' } },
    ]);
  });
  it('does not execute discovery by default', async () => {
    const loader = vi.fn();
    expect(await loadAgentCatalog(config, {}, loader)).toEqual(config);
    expect(loader).not.toHaveBeenCalled();
  });
  it('rejects invalid discovery settings before connecting', async () => {
    const loader = vi.fn();
    await expect(loadAgentCatalog(config, { MCP_AGENT_DISCOVERY: 'cli' }, loader)).rejects.toThrow(
      'must be gateway'
    );
    await expect(
      loadAgentCatalog(config, { MCP_AGENT_DISCOVERY_STATE_DIR: '/tmp/catalog' }, loader)
    ).rejects.toThrow('requires');
    expect(loader).not.toHaveBeenCalled();
  });
  it.each([
    [],
    null,
    { unexpected: [] },
    { agents: [{ id: 'main' }, { id: 'MAIN' }] },
    { agents: [{ id: '../bad' }] },
    { agents: [null] },
    { agents: [], bindings: [{ agentId: 'writer', match: {} }] },
    { agents: [{ id: 'main' }], bindings: [{ agentId: 'main', match: {}, session: 'override' }] },
  ])('rejects invalid catalog %j', async (catalog) => {
    await expect(
      loadAgentCatalog(config, { MCP_AGENT_CATALOG: JSON.stringify(catalog) })
    ).rejects.toThrow();
  });
  it('rejects malformed JSON and duplicate roster sources', async () => {
    await expect(loadAgentCatalog(config, { MCP_AGENT_CATALOG: '{' })).rejects.toThrow(
      'invalid JSON'
    );
    await expect(
      loadAgentCatalog(
        { ...config, agents: [] },
        { MCP_AGENT_CATALOG: JSON.stringify({ agents: [] }) }
      )
    ).rejects.toThrow('Multiple');
  });
  it('retains model-derived defaults and unknown Gateway default behavior', () => {
    const gateway = new OpenClawGateway({ url: config.url }, 'agent:writer');
    expect(gateway.resolve().agentId).toBe('writer');
    expect(gateway.resolve('writer').agentId).toBe('writer');
    expect(new OpenClawGateway({ url: config.url }).listAgents()).toEqual([]);
  });
  it('combines a discovered roster with bindings without inferring routing defaults', async () => {
    const loader = vi.fn().mockResolvedValue(roster);
    const bindings = [{ agentId: 'writer', match: { channel: 'discord', guildId: '123' } }];
    const result = await loadAgentCatalog(
      config,
      { ...discovery, MCP_AGENT_CATALOG: JSON.stringify({ bindings }) },
      loader
    );
    expect(result.agents).toEqual(roster.agents);
    expect(result.bindings).toEqual(bindings);
    expect(new OpenClawGateway(result).resolve().agentId).toBe('main');
    expect(loader).toHaveBeenCalledTimes(1);
    const unknown = new OpenClawGateway(
      await loadAgentCatalog({ url: config.url }, discovery, async () => roster)
    );
    expect(unknown.resolve().agentId).toBeUndefined();
    expect(unknown.listAgents().every((agent) => !agent.isDefault)).toBe(true);
    expect(unknown.resolve('writer').agentId).toBe('writer');
  });
  it('rejects conflicting roster sources before connecting', async () => {
    const loader = vi.fn();
    await expect(
      loadAgentCatalog(
        config,
        { ...discovery, MCP_AGENT_CATALOG: JSON.stringify({ agents: [{ id: 'main' }] }) },
        loader
      )
    ).rejects.toThrow('static agent roster');
    await expect(loadAgentCatalog({ ...config, agents: [] }, discovery, loader)).rejects.toThrow(
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
  ])('rejects malformed Gateway response %j', async (value) => {
    await expect(loadAgentCatalog(config, discovery, async () => value)).rejects.toThrow();
    expect(config).not.toHaveProperty('agents');
  });
  it('validates manual bindings against the roster and preserves explicit empty routes', async () => {
    await expect(
      loadAgentCatalog(
        { ...config, bindings: [{ agentId: 'missing', match: {} }] },
        discovery,
        async () => roster
      )
    ).rejects.toThrow('unknown agent');
    expect(
      (await loadAgentCatalog({ ...config, bindings: [] }, discovery, async () => roster)).bindings
    ).toEqual([]);
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
  it('includes mapped agents without changing scopes or defaults', () => {
    const result = includeConfiguredDiscordAgents(config, discord);
    expect(result.agents).toEqual([{ id: 'writer' }, { id: 'reviewer' }]);
    expect(config).not.toHaveProperty('agents');
    expect(discord.targets).toHaveLength(1);
    expect(new OpenClawGateway(result).resolve().agentId).toBe('main');
    expect(new OpenClawGateway(result).resolve('writer').agentId).toBe('writer');
  });
  it('deduplicates mapped agents and retains the catalog when Discord is disabled', () => {
    const configured = { ...config, agents: [{ id: 'writer' }] };
    expect(includeConfiguredDiscordAgents(configured, discord).agents).toEqual([
      { id: 'writer' },
      { id: 'reviewer' },
    ]);
    expect(includeConfiguredDiscordAgents(configured)).toBe(configured);
  });
});
