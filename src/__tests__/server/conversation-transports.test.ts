import { WebSocketServer } from 'ws';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function gatewayRpc(server: Server, bindings: any[] = []) {
  const methods: string[] = [];
  const ws = new WebSocketServer({ server });
  ws.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'fixture', ts: Date.now() },
      })
    );
    socket.on('message', (raw) => {
      const req = JSON.parse(raw.toString());
      methods.push(req.method);
      let payload: any;
      if (req.method === 'connect')
        payload = {
          type: 'hello-ok',
          protocol: 4,
          server: { version: 'fixture', connId: 'fixture' },
          features: { methods: ['agents.list', 'config.get'], events: [] },
          snapshot: {},
          policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
        };
      else if (req.method === 'agents.list')
        payload = { agents: [{ id: 'main' }, { id: 'research' }] };
      else if (req.method === 'config.get')
        payload = {
          valid: true,
          configRevisionHash: 'r',
          appliedConfigHash: 'r',
          config: { channels: { discord: { accounts: { bot: {} } } }, bindings },
        };
      else {
        socket.send(
          JSON.stringify({
            type: 'res',
            id: req.id,
            ok: false,
            error: { code: 'INVALID_REQUEST', message: 'unsupported' },
          })
        );
        return;
      }
      socket.send(JSON.stringify({ type: 'res', id: req.id, ok: true, payload }));
    });
  });
  cleanups.push(async () => {
    for (const c of ws.clients) c.terminate();
    ws.close();
  });
  return methods;
}
async function deviceEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-transport-device-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return {
    OPENCLAW_GATEWAY_TOKEN: 'fixture',
    MCP_AGENT_DISCOVERY_STATE_DIR: dir,
    OPENCLAW_DEFAULT_AGENT_ID: 'research',
  };
}

async function gateway() {
  const requests: Array<{ key: string; message: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const key = req.headers['x-openclaw-session-key'] as string;
    const message = body.messages?.[0]?.content ?? '';
    requests.push({ key, message });
    if (message === 'accepted-invalid') {
      res.end('invalid-json');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: `reply:${message}` } }] }));
  });
  const methods = gatewayRpc(server);
  const port = await listen(server);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, requests, methods };
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
      '--default-agent-id',
      'research',
      '--issuer-url',
      issuer,
      '--trust-proxy',
      'true',
    ]),
    {
      env: { ...childEnv, ...(await deviceEnv()), ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
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

async function mintToken(base: string) {
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

describe('mandatory agent selection across transports', () => {
  it.each(['http', 'sse', 'stdio', 'modern'] as const)(
    '%s requires agent_id on every scoped schema and handler',
    async (transport) => {
      const mock = await gateway();
      const stateDir = await mkdtemp(join(tmpdir(), 'mandatory-agent-state-'));
      cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
      const env = {
        ...(await deviceEnv()),
        OPENCLAW_AGENT_IS_MANDATORY: 'true',
        MCP_DISCORD_ENABLED: 'true',
        MCP_DISCORD_STATE_DIR: stateDir,
        MCP_DISCORD_CHANNEL_CREATE_ENABLED: 'true',
      };
      let client: Client | ModernClient;
      if (transport === 'stdio') {
        client = new Client({ name: 'mandatory', version: '1' });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: entryArgs(['--openclaw-url', mock.url]),
            env: { ...childEnv, ...env },
            stderr: 'pipe',
          })
        );
      } else {
        const base = await httpBridge(mock.url, transport === 'modern', env);
        if (transport === 'modern') {
          client = new ModernClient(
            { name: 'mandatory', version: '1' },
            { versionNegotiation: { mode: { pin: '2026-07-28' } } }
          );
          await client.connect(
            new ModernTransport(new URL(base + '/mcp'), {
              requestInit: { headers: { Authorization: 'Bearer ' + (await mintToken(base)) } },
            })
          );
        } else client = await connectHttp(base, 'mandatory', transport);
      }
      cleanups.push(() => client.close());
      const { tools } = await client.listTools();
      const destination = {
        guild_id: '400000000000000001',
        account_id: 'bot',
        target: '400000000000000002',
      };
      const turn = {
        ...destination,
        prompt: 'valid request',
        operation_id: 'mandatory-agent-operation-01',
      };
      const validArgs: Record<string, Record<string, unknown>> = {
        openclaw_chat: { message: 'valid request' },
        openclaw_status: {},
        openclaw_chat_async: { message: 'valid request' },
        openclaw_task_status: { task_id: 'fixture-task-0001' },
        openclaw_task_list: {},
        openclaw_task_cancel: { task_id: 'fixture-task-0001' },
        openclaw_models: {},
        openclaw_discord_channels: {},
        openclaw_discord_threads: destination,
        openclaw_discord_ask: { ...turn, mode: 'new_thread', title: 'Task' },
        openclaw_discord_reply: { ...turn, channel_id: '400000000000000003' },
        openclaw_discord_send: turn,
        openclaw_discord_operation: { operation_id: turn.operation_id },
        openclaw_discord_create_channel: {
          guild_id: destination.guild_id,
          account_id: 'bot',
          operation_id: turn.operation_id,
          name: 'new-channel',
          authorize_create: true,
        },
      };
      const validator = new AjvJsonSchemaValidator();
      const scoped = tools.filter((tool) => tool.inputSchema.properties?.agent_id);
      expect(scoped.map((tool) => tool.name).sort()).toEqual(Object.keys(validArgs).sort());
      for (const tool of scoped) {
        expect(tool.inputSchema.required).toContain('agent_id');
        const args = validArgs[tool.name];
        expect(
          validator.getValidator(
            tool.inputSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]
          )({ ...args, agent_id: 'research' }).valid
        ).toBe(true);
        for (const selector of [
          undefined,
          null,
          0,
          1,
          false,
          true,
          [],
          ['research'],
          {},
          { id: 'research' },
        ]) {
          const methodsBefore = mock.methods.length;
          const result = await client.callTool({
            name: tool.name,
            arguments: { ...args, ...(selector === undefined ? {} : { agent_id: selector }) },
          });
          expect(result.isError, tool.name + ':' + JSON.stringify(selector)).toBe(true);
          expect(JSON.stringify(result.content)).toContain('schema validation failed');
          expect(mock.methods).toHaveLength(methodsBefore);
          expect(mock.requests).toHaveLength(0);
          expect(await readdir(stateDir)).toEqual([]);
        }
        const unknown = await client.callTool({
          name: tool.name,
          arguments: { ...args, agent_id: 'absent' },
        });
        expect(unknown.isError).toBe(true);
        expect(JSON.stringify(unknown.content)).toContain('Unknown agent');
      }
      expect(mock.requests).toHaveLength(0);
      expect(
        mock.methods.filter((method) => method !== 'connect' && method !== 'agents.list')
      ).toEqual([]);
      expect(await readdir(stateDir)).toEqual([]);
      const roster = await client.callTool({ name: 'openclaw_agents', arguments: {} });
      expect(roster.isError).not.toBe(true);
      const result = await client.callTool({
        name: 'openclaw_chat',
        arguments: { agent_id: 'research', message: 'explicit' },
      });
      expect(result.isError).not.toBe(true);
      expect(mock.requests).toHaveLength(1);
    },
    20000
  );
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
                channel: { id: channel, guild_id: guild, type: 0, name: 'Allowed' },
                channels: [
                  { id: channel, guild_id: guild, type: 0, name: 'Allowed' },
                  { id: '400000000000000003', guild_id: guild, type: 0, name: 'Private' },
                ],
              },
            },
          })
        );
      });
      gatewayRpc(mock, [
        {
          agentId: 'research',
          match: {
            channel: 'discord',
            accountId: 'bot',
            guildId: guild,
            peer: { kind: 'channel', id: channel },
          },
        },
      ]);
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
      };
      let client: Client | ModernClient;
      if (transport === 'stdio') {
        client = new Client({ name: 'discord-stdio', version: '1' });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: entryArgs(['--openclaw-url', url]),
            env: { ...childEnv, ...(await deviceEnv()), ...env },
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
      expect(listing.tools).toHaveLength(15);
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
        required: ['guild_id', 'account_id', 'target', 'channel_id', 'operation_id', 'prompt'],
        additionalProperties: false,
      });
      const askSchema = listing.tools.find((t) => t.name === 'openclaw_discord_ask')!.inputSchema;
      expect(askSchema.properties?.source).toEqual(
        discordTools.find((t) => t.name === 'openclaw_discord_ask')!.inputSchema.properties?.source
      );
      expect(askSchema.required).not.toContain('source');
      expect(
        listing.tools.find((t) => t.name === 'openclaw_discord_reply')!.inputSchema.properties
      ).not.toHaveProperty('source');
      expect(askSchema).toEqual(
        discordTools.find((t) => t.name === 'openclaw_discord_ask')!.inputSchema
      );
      const validateAsk = new AjvJsonSchemaValidator().getValidator(
        discordTools.find((t) => t.name === 'openclaw_discord_ask')!.inputSchema
      );
      const sourceArgs = {
        target: channel,
        guild_id: guild,
        account_id: 'bot',
        mode: 'new_thread',
        title: 'Task',
        prompt: 'Help',
        operation_id: 'origin-schema-test-01',
        source:
          'https://discord.com/channels/400000000000000001/400000000000000002/400000000000000004',
      };
      expect(validateAsk(sourceArgs).valid).toBe(true);
      expect(validateAsk({ ...sourceArgs, source: { url: sourceArgs.source } }).valid).toBe(false);
      expect(validateAsk({ ...sourceArgs, source_message_url: sourceArgs.source }).valid).toBe(
        false
      );
      for (const source of ['https://example.com/chat/123', 'Editor session-123', 'Editor'])
        expect(validateAsk({ ...sourceArgs, source }).valid).toBe(true);
      const invalidSource = await client.callTool({
        name: 'openclaw_discord_ask',
        arguments: {
          ...sourceArgs,
          source: 'client\ninvalid',
        },
      });
      expect(invalidSource.isError).toBe(true);
      const result = await client.callTool({ name: 'openclaw_discord_channels', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        channels: [{ target: channel, channel_id: channel, name: 'Allowed' }],
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
          guild_id: guild,
          account_id: 'bot',
          operation_id: 'denied-operation-01',
          name: 'unused',
          authorize_create: true,
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
            sessionKey: 'agent:research:main',
            args: {
              action: 'channel-info',
              channel: 'discord',
              accountId: 'bot',
              channelId: channel,
            },
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
        'openclaw_models',
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
        agents: [
          { agent_id: 'main', is_default: false },
          { agent_id: 'research', is_default: true },
        ],
        total: 2,
      });
      const validateAgents = new AjvJsonSchemaValidator().getValidator(
        tools.find((tool) => tool.name === 'openclaw_agents')!.outputSchema!
      );
      expect(validateAgents(discovery.structuredContent).valid).toBe(true);
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
        ...Object.entries({ ...childEnv, ...(await deviceEnv()) }).map(
          ([key, value]) => `${key}=${value}`
        ),
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
    const token = await mintToken(base);
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
    const other = await connect('First', await mintToken(base));
    const rejected = await other.callTool({
      name: 'openclaw_task_status',
      arguments: { task_id: job.task_id },
    });
    expect(rejected.isError).toBe(true);
  });
});
