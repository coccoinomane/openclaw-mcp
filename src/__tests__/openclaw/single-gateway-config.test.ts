import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArguments } from '../../cli.js';
import { loadAgentCatalog } from '../../openclaw/agent-catalog.js';

const argv = [...process.argv];
afterEach(() => {
  process.argv = [...argv];
  vi.unstubAllEnvs();
});

describe('single endpoint configuration', () => {
  it('reads one URL and credential and retains agent selection', () => {
    process.argv = ['node', 'openclaw-mcp'];
    vi.stubEnv('OPENCLAW_URL', 'https://gateway.example');
    vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'test-only-token');
    vi.stubEnv('OPENCLAW_AGENT_ID', 'writer');
    vi.stubEnv(
      'OPENCLAW_INSTANCES',
      JSON.stringify([{ name: 'ignored', url: 'https://other.example' }])
    );
    const args = parseArguments('test');
    expect(args.openclawUrl).toBe('https://gateway.example');
    expect(args.gatewayToken).toBe('test-only-token');
    expect(args.agentId).toBe('writer');
    expect(args).not.toHaveProperty('instances');
  });
  it('supports explicit single endpoint CLI configuration', () => {
    process.argv = [
      'node',
      'openclaw-mcp',
      '--openclaw-url',
      'https://gateway.example',
      '--gateway-token',
      'test-only-token',
      '--agent-id',
      'reviewer',
    ];
    const args = parseArguments('test');
    expect(args.openclawUrl).toBe('https://gateway.example');
    expect(args.gatewayToken).toBe('test-only-token');
    expect(args.agentId).toBe('reviewer');
  });
  it('rejects catalog connection envelopes rather than adapting them', async () => {
    const config = { url: 'https://gateway.example' };
    for (const catalog of [
      [{ instance: 'default', agents: [{ id: 'main' }] }],
      { instance: 'default', agents: [{ id: 'main' }] },
    ])
      await expect(
        loadAgentCatalog(config, { MCP_AGENT_CATALOG: JSON.stringify(catalog) })
      ).rejects.toThrow('must be an object');
  });
});
