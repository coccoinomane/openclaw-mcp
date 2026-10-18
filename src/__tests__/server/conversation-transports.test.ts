import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
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

async function httpBridge(gatewayUrl: string) {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    entryArgs([
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
      'https://Trusted.Example:8443/mcp',
      '--trust-proxy',
      'true',
    ]),
    { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] }
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
        expect(metadata.instance).toBe('default');
        expect(JSON.parse(text(result, 1))).toEqual(metadata);
        expect(metadata.session_id).toMatch(
          new RegExp(
            `^agent:research:mcp:trusted\\.example:${index === 2 ? 'other-client' : 'desktop-client'}:default:[0-9a-f-]{36}$`
          )
        );
        return metadata.session_id as string;
      });
      expect(new Set(keys).size).toBe(3);
      expect(mock.requests.map((request) => request.key).sort()).toEqual([...keys].sort());
      const tools = (await first.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'openclaw_chat',
        'openclaw_chat_async',
        'openclaw_instances',
        'openclaw_status',
        'openclaw_task_cancel',
        'openclaw_task_list',
        'openclaw_task_status',
      ]);
      expect(tools.every((tool) => tool.outputSchema === undefined)).toBe(true);
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
        /^agent:research:mcp:trusted\.example:unknown:default:/
      );
      const hostileName = await connectHttp(base, 'agent:other:cron:injected/child', transport);
      const hostileResult = await call(hostileName, 'openclaw_chat', { message: 'hostile label' });
      expect(hostileResult.structuredContent!.session_id).toMatch(
        /^agent:research:mcp:trusted\.example:agent-other-cron-injected-child:default:/
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
        instance: 'default',
      });
      expect(queued.structuredContent).toMatchObject({ session_id: keys[0], instance: 'default' });
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
        instance: 'default',
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
      expect.stringContaining(`mcp:${hostLabel}:terminal-client:default:`)
    );
    expect(text(result)).toBe('reply:stdio hello');
    expect(JSON.parse(text(result, 1))).toEqual(result.structuredContent);
    expect(mock.requests[0].key).toBe(result.structuredContent?.session_id);
  });
});
