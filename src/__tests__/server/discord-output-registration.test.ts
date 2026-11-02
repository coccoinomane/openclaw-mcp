import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpServer, createModernMcpServer } from '../../server/tools-registration.js';
import { InstanceRegistry } from '../../openclaw/registry.js';
import type { DiscordService } from '../../openclaw/discord.js';
import { DiscordError } from '../../openclaw/discord-channels.js';
import { discordTools } from '../../mcp/tools/discord.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function connect(modern: boolean, discord: DiscordService) {
  const deps = {
    registry: new InstanceRegistry([{ name: 'default', url: 'http://127.0.0.1:1' }], 'openclaw'),
    serverName: 'schema-test',
    serverVersion: '1',
    discord,
  };
  if (!modern) {
    const server = createMcpServer(deps);
    const client = new LegacyClient({ name: 'legacy-schema', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }
  const handler = createMcpHandler(() => createModernMcpServer(deps), { legacy: 'reject' });
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
    { name: 'modern-schema', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + address.port + '/mcp'))
  );
  cleanups.push(() => client.close());
  return client;
}
describe.each([false, true])('Discord output validation (modern=%s)', (modern) => {
  it('preserves typed or absent thread metadata and rejects malformed fields', async () => {
    const item = {
      channel_id: '500000000000000003',
      discord_url: 'https://discord.com/channels/500000000000000001/500000000000000003',
    };
    const sparse = { threads: [item], has_more: false, pagination: 'none' };
    const threads = vi.fn(async (): Promise<any> => sparse);
    const client = await connect(modern, { threads } as unknown as DiscordService);
    await client.listTools();
    const request = { name: 'openclaw_discord_threads', arguments: { target: 'work' } };
    expect((await client.callTool(request)).structuredContent).toEqual(sparse);
    const complete = {
      threads: [
        { ...item, name: 'Task', archived: true, archive_timestamp: '2026-11-01T00:00:00Z' },
      ],
      has_more: true,
      next_before: '2026-11-01T00:00:00Z',
      pagination: 'archived_public_timestamp',
    };
    threads.mockResolvedValue(complete);
    const valid = await client.callTool(request);
    expect(valid.isError).not.toBe(true);
    expect(valid.structuredContent).toEqual(complete);
    expect(valid.content[0]).toEqual({ type: 'text', text: JSON.stringify(complete, null, 2) });
    for (const patch of [
      { name: null },
      { name: 42 },
      { archived: 'false' },
      { archive_timestamp: 42 },
    ]) {
      threads.mockResolvedValue({ ...sparse, threads: [{ ...item, ...patch }] });
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
    threads.mockResolvedValue({ ...sparse, next_before: 42 });
    expect((await client.callTool(request)).isError).toBe(true);
  });
  it('advertises all schemas and rejects invalid success output server-side', async () => {
    const channels = vi.fn(async (): Promise<any> => ({ channels: [], creation_policies: [] }));
    const client = await connect(modern, { channels } as unknown as DiscordService);
    const listing = await client.listTools();
    for (const tool of discordTools)
      expect(listing.tools.find((t) => t.name === tool.name)?.outputSchema).toEqual(
        tool.outputSchema
      );
    const request = { name: 'openclaw_discord_channels', arguments: {} };
    const success = await client.callTool(request);
    expect(success.structuredContent).toEqual({ channels: [], creation_policies: [] });
    expect(success.isError).not.toBe(true);
    channels.mockResolvedValue({
      channels: 'malformed',
      creation_policies: [],
      secret: 'must-not-leak',
    });
    const invalid = await client.callTool(request);
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    expect(JSON.stringify(invalid)).toContain('do not blindly retry writes');
    expect(JSON.stringify(invalid)).not.toContain('must-not-leak');
    channels.mockResolvedValue(undefined);
    expect((await client.callTool(request)).isError).toBe(true);
    channels.mockRejectedValue(new DiscordError('DENIED', true));
    const denied = await client.callTool(request);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({
      error_code: 'DENIED',
      uncertain: true,
      retry_safe: false,
    });
    channels.mockRejectedValue(new Error('secret'));
    const generic = await client.callTool(request);
    expect(generic.isError).toBe(true);
    expect(generic.structuredContent).toBeUndefined();
    expect(JSON.stringify(generic)).not.toContain('secret');
  });
});
