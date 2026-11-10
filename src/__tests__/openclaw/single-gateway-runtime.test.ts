import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('single Gateway runtime contract', () => {
  it('has no named endpoint loader, registry, selector, or discovery tool', () => {
    expect(existsSync('src/openclaw/registry.ts')).toBe(false);
    expect(existsSync('src/mcp/tools/instances.ts')).toBe(false);
    for (const path of sources('src')) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(
        /OPENCLAW_INSTANCES|MCP_DISCORD_GATEWAY_INSTANCE|InstanceRegistry|InstanceConfig|openclaw_instances|gatewayInstance|instanceId|instanceName|isSingleInstance|listNames|getDefaultName/
      );
      expect(source, path).not.toMatch(/\binstance\??\s*:/);
    }
  });
});
