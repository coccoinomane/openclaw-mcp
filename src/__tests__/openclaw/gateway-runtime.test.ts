import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Gateway SDK runtime compatibility', () => {
  it('pins matching official packages and supports their minimum Node version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(pkg.engines.node).toBe('>=22.19.0');
    expect(lock.packages[''].engines.node).toBe(pkg.engines.node);
    for (const name of ['@openclaw/gateway-client', '@openclaw/gateway-protocol']) {
      expect(pkg.dependencies[name]).toBe('2026.10.9');
      expect(lock.packages['node_modules/' + name].version).toBe('2026.10.9');
    }
    expect(readFileSync('Dockerfile', 'utf8').match(/FROM node:24-slim/g)).toHaveLength(2);
    expect(readFileSync('tsup.config.ts', 'utf8')).toContain("target: 'node22'");
    expect(readFileSync('.github/workflows/ci.yml', 'utf8')).toContain(
      "node-version: ['22.19.0', '24']"
    );
    expect(readFileSync('README.md', 'utf8')).toContain('Node.js 22.19 or newer');
  });
});
