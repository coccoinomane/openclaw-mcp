import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Server } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import * as registration from '../../server/tools-registration.js';
import { createHttpServer } from '../../server/http.js';
import type { OpenClawGateway } from '../../openclaw/gateway.js';

const cleanups: Array<() => Promise<unknown>> = [];
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1' },
  },
};
const status = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'openclaw_status', arguments: {} },
};

async function bridge(auth = false) {
  const health = vi.fn().mockResolvedValue({ status: 'ok' });
  const gateway = {
    resolve: () => ({ client: { health } }),
  } as unknown as OpenClawGateway;
  const factory = vi.spyOn(registration, 'createMcpServer');
  const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
  const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  let server: Server;
  const listen = express.application.listen;
  vi.spyOn(express.application, 'listen').mockImplementation(function (...args: any[]) {
    server = listen.apply(this, args);
    return server;
  });
  await createHttpServer(
    {
      port: 0,
      host: '127.0.0.1',
      ...(auth ? { authConfig: { clientId: 'test-client', clientSecret: 'test-secret' } } : {}),
    },
    {
      gateway,
      serverName: 'test',
      serverVersion: '1',
    }
  );
  if (!server!.listening) await once(server!, 'listening');
  const port = (server!.address() as { port: number }).port;
  cleanups.push(async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const result of factory.mock.results)
      if (result.type === 'return') await result.value.close();
  });
  const send = (
    body?: unknown,
    headers: Record<string, string> = {},
    method = 'POST',
    query = ''
  ) =>
    fetch('http://127.0.0.1:' + port + '/mcp' + query, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { send, health, factory, logs };
}

async function rpc(response: Response) {
  const body = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(
      body
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice(6)
    );
  }
  return JSON.parse(body);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

describe('HTTP session lifecycle', () => {
  it.each(['POST', 'GET', 'DELETE'])(
    'rejects unknown sessions with 404 on %s without allocating a server',
    async (method) => {
      const { send, factory, health } = await bridge();
      const response = await send(
        method === 'POST' ? status : undefined,
        { 'mcp-session-id': 'expired-session' },
        method
      );
      expect(response.status).toBe(404);
      expect((await rpc(response)).error.code).toBe(-32001);
      expect(factory).not.toHaveBeenCalled();
      expect(health).not.toHaveBeenCalled();
    }
  );
  it.each(['POST', 'GET', 'DELETE'])(
    'rejects absent sessions with 400 on %s without allocating a server',
    async (method) => {
      const { send, factory, health } = await bridge();
      const response = await send(method === 'POST' ? status : undefined, {}, method);
      expect(response.status).toBe(400);
      expect((await rpc(response)).error.message).toContain('Mcp-Session-Id');
      expect(factory).not.toHaveBeenCalled();
      expect(health).not.toHaveBeenCalled();
    }
  );
  it('initializes, calls status with and without protocol header, and rejects a deleted session', async () => {
    const { send, health, factory } = await bridge();
    const init = await send(initialize);
    expect(init.status).toBe(200);
    const session = init.headers.get('mcp-session-id')!;
    expect(session).toBeTruthy();
    expect((await rpc(init)).result.protocolVersion).toBe('2025-03-26');
    const headers = { 'mcp-session-id': session };
    expect(
      (await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status
    ).toBe(202);
    for (const extra of [{}, { 'mcp-protocol-version': '2025-03-26' }]) {
      const response = await send(status, { ...headers, ...extra });
      expect(response.status).toBe(200);
      expect((await rpc(response)).result.isError).not.toBe(true);
    }
    expect(health).toHaveBeenCalledTimes(2);
    expect((await send(undefined, headers, 'DELETE')).status).toBe(200);
    const stale = await send(status, headers);
    expect(stale.status).toBe(404);
    await stale.text();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledTimes(2);
  });
});

describe('HTTP protocol compatibility and diagnostics', () => {
  it('requires a new initialize without the stale session header', async () => {
    const { send, factory } = await bridge();
    const rejected = await send(initialize, { 'mcp-session-id': 'stale-initialize' });
    expect(rejected.status).toBe(404);
    await rejected.text();
    expect(factory).not.toHaveBeenCalled();
    const fresh = await send(initialize);
    expect(fresh.status).toBe(200);
    await rpc(fresh);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each([
    { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
    { ...initialize, jsonrpc: 'invalid' },
    { ...initialize, id: undefined },
    [initialize, status],
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 1,
      params: { name: 'openclaw_discord_ask', arguments: { prompt: 'never execute' } },
    },
  ])('does not allocate or execute malformed/uninitialized requests %#', async (body) => {
    const { send, factory, health } = await bridge();
    const response = await send(body);
    expect(response.status).toBe(400);
    await response.text();
    expect(factory).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
  });

  it('closes uninitialized transports rejected by SDK content negotiation', async () => {
    const { send, factory } = await bridge();
    const close = vi.spyOn(
      (await import('@modelcontextprotocol/sdk/server/index.js')).Server.prototype,
      'close'
    );
    const response = await send(initialize, { Accept: 'application/json' });
    expect(response.status).toBe(406);
    await response.text();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a valid session after unsupported protocol or duplicate initialize', async () => {
    const { send, health } = await bridge();
    const init = await send(initialize);
    const session = init.headers.get('mcp-session-id')!;
    await rpc(init);
    const headers = { 'mcp-session-id': session };
    const unsupported = await send(status, { ...headers, 'mcp-protocol-version': '1999-01-01' });
    expect(unsupported.status).toBe(400);
    await unsupported.text();
    const duplicate = await send(initialize, headers);
    expect(duplicate.status).toBe(400);
    await duplicate.text();
    expect(health).not.toHaveBeenCalled();
    const response = await send(status, headers);
    expect((await rpc(response)).result.isError).not.toBe(true);
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('returns a tool error, not JSON-RPC -32603, when gateway health throws', async () => {
    const { send, health } = await bridge();
    const init = await send(initialize);
    const headers = { 'mcp-session-id': init.headers.get('mcp-session-id')! };
    await rpc(init);
    health.mockRejectedValueOnce(new Error('mock gateway unreachable'));
    const response = await send(status, headers);
    expect(response.status).toBe(200);
    const message = await rpc(response);
    expect(message.error).toBeUndefined();
    expect(message.result.isError).toBe(true);
  });

  it('serves modern stateless calls without applying legacy session requirements', async () => {
    const { send, health, factory, logs } = await bridge();
    const response = await send(
      {
        ...status,
        params: {
          ...status.params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'openclaw_status',
      }
    );
    expect(response.status).toBe(200);
    expect((await rpc(response)).result.isError).not.toBe(true);
    expect(health).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
    expect(logs.mock.calls.flat().join(' ')).toContain('"branch":"modern"');
  });

  it('records auth rejection before routing without logging client data', async () => {
    const { send, logs, factory } = await bridge(true);
    const response = await send(
      { ...status, params: { ...status.params, arguments: { prompt: 'private-prompt' } } },
      {
        Authorization: 'Bearer private-bearer-value',
        'mcp-session-id': 'private-session-value',
        'mcp-protocol-version': 'private-version-value',
        'x-request-id': 'private-injected-request-id',
      },
      'POST',
      '?private-query=value'
    );
    expect(response.status).toBe(401);
    await response.text();
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const records = logs.mock.calls
      .flat()
      .filter((line: string) => line.startsWith('[openclaw-mcp] HTTP {'))
      .map((line: string) => JSON.parse(line.slice('[openclaw-mcp] HTTP '.length)));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      requestId,
      method: 'POST',
      path: '/mcp',
      mcpMethod: 'tools/call',
      tool: 'openclaw_status',
      protocolVersion: 'other',
      branch: 'unrouted',
      sessionPresent: true,
      sessionKnown: false,
      status: 401,
      category: 'unauthorized',
    });
    expect(records[0].timestamp).toMatch(/^\d{4}-/);
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-');
    expect(factory).not.toHaveBeenCalled();
  });

  it('logs known session state and only allowlisted methods/tools, without request bodies', async () => {
    const { send, logs } = await bridge();
    const init = await send(initialize);
    const session = init.headers.get('mcp-session-id')!;
    await rpc(init);
    const response = await send(status, { 'mcp-session-id': session });
    await rpc(response);
    const unknown = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'private-method',
      params: { name: 'private-tool', prompt: 'private-prompt' },
    });
    await unknown.text();
    const output = logs.mock.calls.flat().join(' ');
    expect(output).toContain('"sessionKnown":true');
    expect(output).toContain('"mcpMethod":"other"');
    expect(output).not.toContain(session);
    expect(output).not.toContain('private-');
  });
});

describe('additional HTTP rejection cases', () => {
  it('rejects a modern header without its envelope instead of executing a legacy tool', async () => {
    const { send, health, factory } = await bridge();
    const response = await send(status, { 'mcp-protocol-version': '2026-07-28' });
    expect(response.status).toBe(400);
    expect((await rpc(response)).error.code).toBe(-32602);
    expect(health).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['2024-11-05', '2025-06-18', '2025-11-25'])(
    'serves initialized status for %s',
    async (version) => {
      const { send, health } = await bridge();
      const init = await send({
        ...initialize,
        params: { ...initialize.params, protocolVersion: version },
      });
      const session = init.headers.get('mcp-session-id')!;
      expect((await rpc(init)).result.protocolVersion).toBe(version);
      const response = await send(status, {
        'mcp-session-id': session,
        'mcp-protocol-version': version,
      });
      expect((await rpc(response)).result.isError).not.toBe(true);
      expect(health).toHaveBeenCalledTimes(1);
    }
  );

  it('does not expose unknown tool labels in HTTP diagnostics', async () => {
    const { send, logs } = await bridge();
    const response = await send({
      ...status,
      params: { name: 'private-tool', arguments: { token: 'private-argument' } },
    });
    await response.text();
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-');
    expect(JSON.stringify(logs.mock.calls)).toContain('missing_session');
  });

  it('records origin rejections before routing', async () => {
    const { send, logs, factory } = await bridge();
    const response = await send(status, { Origin: 'https://private-origin.invalid' });
    expect(response.status).toBe(403);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    await response.text();
    expect(JSON.stringify(logs.mock.calls)).toContain('forbidden');
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-origin');
    expect(factory).not.toHaveBeenCalled();
  });
});
