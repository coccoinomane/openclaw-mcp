import { createHash, randomUUID } from 'node:crypto';
import { discordTools } from '../../mcp/tools/discord.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { hostname } from 'node:os';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const cleanups: Array<() => Promise<unknown>> = [];
const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test' };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The production bundle injects this constant. Inject it before loading the real
// entry point under tsx as well, without building or writing fixture files.
function entryArgs(args: string[]): string[] {
  return [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    `globalThis.__PKG_VERSION__='transport-test'; process.argv=['node','src/index.ts',...${JSON.stringify(args)}]; await import('./src/index.ts');`,
  ];
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return address.port;
}

async function gateway() {
  const requests: Array<{ key: string; message: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const key = req.headers['x-openclaw-session-key'] as string;
    const message = body.messages[0]?.content ?? '';
    requests.push({ key, message });
    if (message === 'accepted-invalid') {
      res.end('invalid-json');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: `reply:${message}` } }] }));
  });
  const port = await listen(server);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, requests };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function httpBridge(
  gatewayUrl: string,
  auth = false,
  extraEnv: Record<string, string> = {},
  issuer = 'https://Trusted.Example:8443/mcp'
) {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    entryArgs([
      ...(auth
        ? [
            '--auth',
            '--client-id',
            'integration-client',
            '--client-secret',
            'integration-secret-12345678901234567890',
          ]
        : []),
      '--transport',
      'http',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--openclaw-url',
      gatewayUrl,
      '--agent-id',
      'research',
      '--issuer-url',
      issuer,
      '--trust-proxy',
      'true',
    ]),
    { env: { ...childEnv, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let diagnostics = '';
  child.stderr!.on('data', (chunk) => {
    diagnostics += chunk;
  });
  cleanups.push(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`Bridge exited: ${diagnostics}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return base;
    } catch {
      /* Wait for the listener, not a fixed startup delay. */
    }
    await delay(25);
  }
  throw new Error(`Bridge did not start: ${diagnostics}`);
}

function text(result: CallToolResult, index = 0): string {
  const content = result.content[index];
  expect(content.type).toBe('text');
  return content.type === 'text' ? content.text : '';
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function connectHttp(base: string, name: string, transport: 'http' | 'sse') {
  const client = new Client({ name, version: '1.0.0' });
  cleanups.push(() => client.close());
  const requestInit = {
    headers: { 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'https' },
  };
  await client.connect(
    transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit })
      : new SSEClientTransport(new URL(`${base}/sse`), { requestInit })
  );
  return client;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('conversation metadata across real MCP transports', () => {
  it.each(['http', 'sse', 'stdio', 'modern'] as const)(
    '%s wires service-owned Discord reads',
    async (transport) => {
      const guild = '400000000000000001',
        channel = '400000000000000002';
      const requests: any[] = [];
      const mock = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        requests.push({
          url: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(raw),
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              details: {
                ok: true,
                channels: [
                  { id: channel, guild_id: guild, type: 0, name: 'Allowed' },
                  { id: '400000000000000003', guild_id: guild, type: 0, name: 'Private' },
                ],
              },
            },
          })
        );
      });
      const port = await listen(mock);
      cleanups.push(async () => {
        mock.closeAllConnections();
        await new Promise<void>((resolve) => mock.close(() => resolve()));
      });
      const url = 'http://127.0.0.1:' + port;
      const env = {
        MCP_DISCORD_ENABLED: 'true',
        MCP_DISCORD_STATE_DIR: '/unused-test-state',
        OPENCLAW_GATEWAY_TOKEN: 'mock-read-token',
        MCP_DISCORD_TARGETS: JSON.stringify([
          { name: 'work', guildId: guild, channelId: channel, accountId: 'bot', agentId: 'main' },
        ]),
      };
      let client: Client | ModernClient;
      if (transport === 'stdio') {
        client = new Client({ name: 'discord-stdio', version: '1' });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: entryArgs(['--openclaw-url', url]),
            env: { ...childEnv, ...env },
            stderr: 'pipe',
          })
        );
      } else {
        const base = await httpBridge(url, false, env);
        if (transport === 'modern') {
          client = new ModernClient(
            { name: 'discord-modern', version: '1' },
            { versionNegotiation: { mode: { pin: '2026-07-28' } } }
          );
          await client.connect(new ModernTransport(new URL(base + '/mcp')));
        } else client = await connectHttp(base, 'discord-read', transport);
      }
      cleanups.push(() => client.close());
      const listing = await client.listTools();
      expect(listing.tools).toHaveLength(13);
      for (const tool of discordTools) {
        expect(listing.tools.find((t) => t.name === tool.name)?.outputSchema).toEqual(
          tool.outputSchema
        );
      }
      expect(
        listing.tools
          .filter((t) => !t.name.startsWith('openclaw_discord_') && t.name !== 'openclaw_agents')
          .every((t) => t.outputSchema === undefined)
      ).toBe(true);
      expect(
        listing.tools.find((t: any) => t.name === 'openclaw_discord_reply')?.inputSchema
      ).toMatchObject({
        required: ['target', 'channel_id', 'operation_id', 'prompt'],
        additionalProperties: false,
      });
      const result = await client.callTool({ name: 'openclaw_discord_channels', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        channels: [{ target: 'work', channel_id: channel, name: 'Allowed' }],
      });
      expect(JSON.stringify(result)).not.toContain('Private');
      const validate = new AjvJsonSchemaValidator().getValidator(
        listing.tools.find((t) => t.name === 'openclaw_discord_channels')!.outputSchema!
      );
      expect(validate(result.structuredContent).valid).toBe(true);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        result.structuredContent
      );
      const denied = await client.callTool({
        name: 'openclaw_discord_create_channel',
        arguments: {
          policy: 'denied',
          operation_id: 'denied-operation-01',
          name: 'unused',
          authorize_create: true,
          authorize_admission: true,
        },
      });
      expect(denied.isError).toBe(true);
      const validateCreation = new AjvJsonSchemaValidator().getValidator(
        listing.tools.find((t) => t.name === 'openclaw_discord_create_channel')!.outputSchema!
      );
      expect(validateCreation(denied.structuredContent).valid).toBe(true);
      const invalid = await client.callTool({ name: 'openclaw_discord_threads', arguments: {} });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toBeUndefined();
      expect(requests).toEqual([
        {
          url: '/tools/invoke',
          authorization: 'Bearer ' + env.OPENCLAW_GATEWAY_TOKEN,
          body: {
            tool: 'message',
            sessionKey: 'agent:main:main',
            args: { action: 'channel-list', channel: 'discord', accountId: 'bot', guildId: guild },
          },
        },
      ]);
    }
  );

  it.each(['http', 'sse'] as const)(
    '%s preserves initialize labels, metadata and connection ownership',
    async (transport) => {
      const mock = await gateway();
      const base = await httpBridge(mock.url);
      const [first, sameName, differentName] = await Promise.all([
        connectHttp(base, 'Desktop Client', transport),
        connectHttp(base, 'Desktop Client', transport),
        connectHttp(base, 'Other Client', transport),
      ]);
      const results = await Promise.all(
        [first, sameName, differentName].map((client, index) =>
          call(client, 'openclaw_chat', { message: `hello-${index}` })
        )
      );
      const keys = results.map((result, index) => {
        expect(result.isError).not.toBe(true);
        expect(text(result)).toBe(`reply:hello-${index}`);
        const metadata = result.structuredContent!;
        expect(metadata).not.toHaveProperty('instance');
        expect(JSON.parse(text(result, 1))).toEqual(metadata);
        expect(metadata.session_id).toMatch(
          new RegExp(
            `^agent:research:mcp:trusted\\.example:${index === 2 ? 'other-client' : 'desktop-client'}:[0-9a-f-]{36}$`
          )
        );
        return metadata.session_id as string;
      });
      expect(new Set(keys).size).toBe(3);
      expect(mock.requests.map((request) => request.key).sort()).toEqual([...keys].sort());
      const tools = (await first.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'openclaw_agents',
        'openclaw_chat',
        'openclaw_chat_async',
        'openclaw_status',
        'openclaw_task_cancel',
        'openclaw_task_list',
        'openclaw_task_status',
      ]);
      expect(
        tools
          .filter((tool) => tool.name !== 'openclaw_agents')
          .every((tool) => tool.outputSchema === undefined)
      ).toBe(true);
      const discovery = await call(first, 'openclaw_agents', {});
      expect(discovery.structuredContent).toEqual({
        agents: [{ agent_id: 'research', is_default: true }],
        total: 1,
      });
      const validateAgents = new AjvJsonSchemaValidator().getValidator(
        tools.find((tool) => tool.name === 'openclaw_agents')!.outputSchema!
      );
      expect(validateAgents(discovery.structuredContent).valid).toBe(true);
      expect(tools.find((tool) => tool.name === 'openclaw_chat')!.description).toContain('reuse');
      const invalid = await call(first, 'openclaw_chat', { message: 'hello', session_id: '' });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toBeUndefined();
      const acceptedFailure = await call(first, 'openclaw_chat', { message: 'accepted-invalid' });
      expect(acceptedFailure.isError).toBe(true);
      expect(text(acceptedFailure)).toMatch(/^Error: /);
      expect(acceptedFailure.structuredContent!.session_id).toBe(mock.requests.at(-1)!.key);
      expect(JSON.parse(text(acceptedFailure, 1))).toEqual(acceptedFailure.structuredContent);
      const unnamed = await connectHttp(base, '', transport);
      const unnamedResult = await call(unnamed, 'openclaw_chat', { message: 'unnamed' });
      expect(unnamedResult.structuredContent!.session_id).toMatch(
        /^agent:research:mcp:trusted\.example:unknown:/
      );
      const hostileName = await connectHttp(base, 'agent:other:cron:injected/child', transport);
      const hostileResult = await call(hostileName, 'openclaw_chat', { message: 'hostile label' });
      expect(hostileResult.structuredContent!.session_id).toMatch(
        /^agent:research:mcp:trusted\.example:agent-other-cron-injected-child:/
      );
      const followUp = await call(first, 'openclaw_chat', {
        message: 'follow-up',
        ...results[0].structuredContent,
      });
      expect(followUp.structuredContent).toEqual(results[0].structuredContent);
      expect(mock.requests.at(-1)).toEqual({ key: keys[0], message: 'follow-up' });

      const queued = await call(first, 'openclaw_chat_async', {
        message: 'background follow-up',
        session_id: keys[0],
      });
      expect(queued.structuredContent).toMatchObject({ session_id: keys[0] });
      expect(JSON.parse(text(queued))).toEqual(queued.structuredContent);
      const taskId = queued.structuredContent!.task_id;
      const otherStatus = await call(sameName, 'openclaw_task_status', { task_id: taskId });
      expect(otherStatus.isError).toBe(true);
      expect(text(otherStatus)).toContain('Task not found');
      const otherCancel = await call(sameName, 'openclaw_task_cancel', { task_id: taskId });
      expect(otherCancel.isError).toBe(true);
      const otherList = await call(sameName, 'openclaw_task_list', {});
      expect(JSON.parse(text(otherList)).tasks).toEqual([]);
      let status: CallToolResult | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = await call(first, 'openclaw_task_status', { task_id: taskId });
        if (status.structuredContent?.status === 'completed') break;
        await delay(20);
      }
      expect(status!.structuredContent).toMatchObject({
        status: 'completed',
        session_id: keys[0],
        result: 'reply:background follow-up',
      });
      expect(mock.requests.at(-1)).toEqual({ key: keys[0], message: 'background follow-up' });
    },
    15000
  );

  it('stdio uses the OS hostname and initialized client name through the actual entry point', async () => {
    const mock = await gateway();
    const client = new Client({ name: 'Terminal Client', version: '1.0.0' });
    cleanups.push(() => client.close());
    // env -i prevents even the SDK default inherited environment from leaking
    // operator configuration or credentials into this subprocess.
    const transport = new StdioClientTransport({
      command: '/usr/bin/env',
      args: [
        '-i',
        ...Object.entries(childEnv).map(([key, value]) => `${key}=${value}`),
        process.execPath,
        ...entryArgs(['--openclaw-url', mock.url]),
      ],
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    const result = await call(client, 'openclaw_chat', { message: 'stdio hello' });
    const hostLabel =
      hostname()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 40) || 'local';
    expect(result.structuredContent?.session_id).toEqual(
      expect.stringContaining(`mcp:${hostLabel}:terminal-client:`)
    );
    expect(text(result)).toBe('reply:stdio hello');
    expect(JSON.parse(text(result, 1))).toEqual(result.structuredContent);
    expect(mock.requests[0].key).toBe(result.structuredContent?.session_id);
  });
});

describe('mixed-era production endpoint', () => {
  it('serves 2026 Skills and chat beside legacy clients with host protection', async () => {
    const mock = await gateway();
    const base = await httpBridge(mock.url);
    const modern = new ModernClient(
      { name: 'Modern Desktop', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    cleanups.push(() => modern.close());
    await modern.connect(new ModernTransport(new URL(base + '/mcp')));
    expect(modern.getProtocolEra()).toBe('modern');
    const skills = new SkillsClient(modern);
    const list = await skills.list();
    expect((await skills.read(list.skills[0])).verified).toBe(true);
    const result = await modern.callTool({
      name: 'openclaw_chat',
      arguments: { message: 'modern hello' },
    });
    expect((result.structuredContent as Record<string, unknown>)?.session_id).toMatch(
      /^agent:research:mcp:trusted[.]example:modern-desktop:/
    );
    const legacy = await connectHttp(base, 'Legacy', 'http');
    expect((await legacy.listResources()).resources).toHaveLength(1);
    const forbidden = await new Promise<number>((resolve, reject) => {
      const req = request(
        base + '/mcp',
        {
          method: 'POST',
          headers: { Host: 'attacker.invalid', 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        }
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(forbidden).toBe(403);
    const origin = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(origin.status).toBe(403);
  });
});

describe('OAuth discovery issuer consistency', () => {
  it.each(['https://trusted.example', 'https://trusted.example/'])(
    'matches authorization server metadata for %s',
    async (issuer) => {
      const base = await httpBridge('http://127.0.0.1:1', true, {}, issuer);
      const metadata = (await (
        await fetch(base + '/.well-known/oauth-authorization-server')
      ).json()) as { issuer: string };
      const resource = (await (
        await fetch(base + '/.well-known/oauth-protected-resource/mcp')
      ).json()) as { authorization_servers: string[]; resource: string };
      expect(resource.authorization_servers).toEqual([metadata.issuer]);
      expect(resource.resource).toBe('https://trusted.example/mcp');
    }
  );
});

describe('modern OAuth gate', () => {
  it('requires authentication before protocol discovery and preserves token-owned async work', async () => {
    const mock = await gateway();
    const base = await httpBridge(mock.url, true);
    const unauthenticated = new ModernClient(
      { name: 'unauthenticated', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    cleanups.push(() => unauthenticated.close());
    await expect(
      unauthenticated.connect(new ModernTransport(new URL(base + '/mcp')))
    ).rejects.toThrow();
    const mintToken = async () => {
      const verifier = randomUUID();
      const authorize = new URL(base + '/authorize');
      for (const [key, value] of Object.entries({
        response_type: 'code',
        client_id: 'integration-client',
        redirect_uri: 'http://localhost/callback',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }))
        authorize.searchParams.set(key, value);
      const response = await fetch(authorize.toString(), { redirect: 'manual' });
      expect(response.status).toBe(302);
      const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
      const tokenResponse = await fetch(base + '/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: 'http://localhost/callback',
          client_id: 'integration-client',
          client_secret: 'integration-secret-12345678901234567890',
        }).toString(),
      });
      expect(tokenResponse.status).toBe(200);
      return ((await tokenResponse.json()) as { access_token: string }).access_token;
    };
    const token = await mintToken();
    const connect = async (name: string, accessToken: string) => {
      const client = new ModernClient(
        { name, version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      );
      cleanups.push(() => client.close());
      await client.connect(
        new ModernTransport(new URL(base + '/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + accessToken } },
        })
      );
      return client;
    };
    const first = await connect('First', token);
    const started = await first.callTool({
      name: 'openclaw_chat_async',
      arguments: { message: 'owned task' },
    });
    const meta = started.structuredContent as Record<string, unknown>;
    const firstContent = started.content as Array<{ type: string; text: string }>;
    const job = JSON.parse(firstContent[0].text);
    const reconnected = await connect('Different label', token);
    const polled = await reconnected.callTool({
      name: 'openclaw_task_status',
      arguments: { task_id: job.task_id },
    });
    expect(polled.isError).not.toBe(true);
    expect((polled.structuredContent as Record<string, unknown>).session_id).toBe(meta.session_id);
    const other = await connect('First', await mintToken());
    const rejected = await other.callTool({
      name: 'openclaw_task_status',
      arguments: { task_id: job.task_id },
    });
    expect(rejected.isError).toBe(true);
  });
});
