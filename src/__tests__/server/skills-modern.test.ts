import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpServer, createModernMcpServer } from '../../server/tools-registration.js';
import { loadPackagedSkills, readSkillResource } from '../../server/skills.js';
import { OpenClawGateway } from '../../openclaw/gateway.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function deps() {
  return {
    gateway: new OpenClawGateway({ url: 'http://127.0.0.1:1' }, 'openclaw'),
    serverName: 'test',
    serverVersion: '1',
    skills: await loadPackagedSkills(),
  };
}
describe('Skills and modern MCP', () => {
  it('serves official extension list/get/read with verified support-file digests', async () => {
    const d = await deps();
    const handler = createMcpHandler(() => createModernMcpServer(d), { legacy: 'reject' });
    const node = toNodeHandler(handler);
    const server = createServer((req, res) => {
      void node(req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const client = new Client(
      { name: 'modern-test', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + '/mcp'))
    );
    cleanups.push(() => client.close());
    expect(client.getProtocolEra()).toBe('modern');
    const skills = new SkillsClient(client);
    expect(skills.supported).toBe(true);
    const listing = await skills.list();
    expect(listing.skills).toHaveLength(1);
    const entry = (await skills.get(listing.skills[0].uri)).skill;
    expect(new TextEncoder().encode(entry.frontmatter.description).length).toBeLessThanOrEqual(500);
    expect(entry.resources).toHaveLength(2);
    const main = await skills.read(entry);
    expect(main.verified).toBe(true);
    expect(main.text).toContain('Direct ask');
    const support = await skills.read(entry, 'references/recovery.md');
    expect(support.verified).toBe(true);
    const resources = await client.listResources();
    expect(resources.resources.some((r) => r.uri === entry.uri)).toBe(true);
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'openclaw_chat')).toBe(true);
    const result = await client.callTool({
      name: 'openclaw_chat_async',
      arguments: { message: 'must not dispatch' },
    });
    expect(result.isError).toBe(true);
  });
  it('keeps legacy resource fallback readable and refuses traversal', async () => {
    const d = await deps();
    const server = createMcpServer(d);
    const client = new LegacyClient({ name: 'legacy', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const list = await client.listResources();
    expect(list.resources).toHaveLength(1);
    const result = await client.readResource({ uri: list.resources[0].uri });
    expect(result.contents[0]).toHaveProperty('text');
    for (const entry of d.skills.entries)
      for (const resource of Array.isArray(entry.resources) ? entry.resources : []) {
        const read = await readSkillResource(d.skills, resource.uri);
        expect('sha256:' + createHash('sha256').update(read.contents[0].text).digest('hex')).toBe(
          resource.digest
        );
      }
    await expect(readSkillResource(d.skills, 'skill://../package.json')).rejects.toThrow('Unknown');
  });
});
