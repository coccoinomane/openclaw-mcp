import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOpenclawChat } from '../../mcp/tools/chat.js';
import {
  handleOpenclawChatAsync,
  handleOpenclawTaskStatus,
  handleOpenclawTaskList,
  handleOpenclawTaskCancel,
} from '../../mcp/tools/tasks.js';
import { taskManager } from '../../mcp/tasks/manager.js';
import { OpenClawGateway } from '../../openclaw/gateway.js';
import type { ToolResponse } from '../../utils/response-helpers.js';

let gatewayServer: Server;
let gateway: OpenClawGateway;
let url: string;
const calls: Array<{
  key: string;
  message: string;
  agent?: string;
  model: string;
  bodyKey: string;
}> = [];
const history = new Map<string, string[]>();
const context = { serverLabel: 'mcp.example.test', clientName: 'Test App' };
const owners = new Set<string>();
let releaseRunning: (() => void) | undefined;
function owner() {
  const id = randomUUID();
  owners.add(id);
  return id;
}
function json(response: ToolResponse) {
  return JSON.parse(response.content[0].text);
}
function metadata(response: ToolResponse) {
  return response.structuredContent as { session_id: string; agent_id?: string };
}
async function status(taskId: string, ownerId: string, expected: string) {
  let response: ToolResponse;
  await vi.waitFor(
    async () => {
      response = await handleOpenclawTaskStatus(gateway, { task_id: taskId }, ownerId);
      expect(json(response).status).toBe(expected);
    },
    { timeout: 3000, interval: 10 }
  );
  return response!;
}

beforeAll(async () => {
  gatewayServer = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const key = req.headers['x-openclaw-session-key'] as string;
    const message = body.messages[0].content;
    calls.push({
      key,
      bodyKey: body.session_id,
      message,
      agent: req.headers['x-openclaw-agent-id'] as string | undefined,
      model: body.model,
    });
    const previous = history.get(key) ?? [];
    previous.push(message);
    history.set(key, previous);
    // Both failure fixtures accept the turn before losing a valid response.
    if (message === 'accepted-but-invalid') {
      res.end('invalid-json');
      return;
    }
    if (message === 'accepted-but-timeout') {
      req.on('close', () => res.destroy());
      return;
    }
    if (message === 'wait-for-release')
      await new Promise<void>((resolve) => {
        releaseRunning = resolve;
      });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ model: 'mock', choices: [{ message: { content: previous.join(' -> ') } }] })
    );
  });
  await new Promise<void>((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}`;
  gateway = new OpenClawGateway({
    url,
    agentId: 'research',
    timeout: 200,
    agents: [{ id: 'research' }, { id: 'ops' }],
  });
});

beforeEach(() => {
  calls.length = 0;
  history.clear();
});
afterAll(async () => {
  for (const id of owners) for (const task of taskManager.list(id)) taskManager.delete(task.id);
  gatewayServer.closeAllConnections();
  await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
});

describe('sync Gateway conversation continuity', () => {
  it('reuses the exact generated key on turn two while preserving the original text block', async () => {
    const first = await handleOpenclawChat(gateway, { message: 'remember blue' }, context);
    const { session_id, agent_id } = metadata(first);
    expect(first.content[0]).toEqual({ type: 'text', text: 'remember blue' });
    expect(JSON.parse(first.content[1].text)).toEqual(metadata(first));
    expect(session_id).toMatch(/^agent:research:mcp:mcp.example.test:test-app:/);
    const second = await handleOpenclawChat(gateway, { message: 'recall', session_id, agent_id });
    expect(second.content[0].text).toBe('remember blue -> recall');
    expect(metadata(second)).toEqual(metadata(first));
    expect(calls.map((call) => call.key)).toEqual([session_id, session_id]);
    expect(calls.every((call) => call.bodyKey === session_id && call.agent === 'research')).toBe(
      true
    );
  });

  it.each(['legacy-key', 'agent:writer:mcp:host:client:uuid', 'MixedCase:Key', ' padded '])(
    'reuses supplied %s according to existing trim validation without a prefix',
    async (supplied) => {
      const response = await handleOpenclawChat(
        gateway,
        { message: 'hello', session_id: supplied },
        context
      );
      expect(metadata(response).session_id).toBe(supplied.trim());
      expect(calls[0].key).toBe(supplied.trim());
    }
  );

  it('creates independent conversations concurrently and respects agent-specific targets', async () => {
    const responses = await Promise.all([
      handleOpenclawChat(gateway, { message: 'one' }, context),
      handleOpenclawChat(gateway, { message: 'two' }, context),
      handleOpenclawChat(gateway, { message: 'three', agent_id: 'ops' }, context),
    ]);
    expect(new Set(responses.map((r) => metadata(r).session_id)).size).toBe(3);
    expect(metadata(responses[2])).toMatchObject({ agent_id: 'ops' });
    expect(metadata(responses[2]).session_id).toMatch(/^agent:ops:mcp:/);
    expect(calls.find((call) => call.message === 'three').agent).toBe('ops');
    expect(responses.map((r) => r.content[0].text)).toEqual(['one', 'two', 'three']);
  });

  it('qualifies model targets and leaves unknown Gateway defaults unqualified', async () => {
    const modelGateway = new OpenClawGateway({ url }, 'openclaw/writer');
    const modelResult = await handleOpenclawChat(
      modelGateway,
      { message: 'model target' },
      context
    );
    expect(metadata(modelResult).session_id).toMatch(/^agent:writer:mcp:/);
    expect(calls[0]).toMatchObject({ agent: undefined, model: 'openclaw/writer' });
    const defaultGateway = new OpenClawGateway({ url });
    const defaultResult = await handleOpenclawChat(defaultGateway, { message: 'gateway default' });
    expect(metadata(defaultResult).session_id).toMatch(/^mcp:[^:]+:unknown:/);
    expect(calls[1].agent).toBeUndefined();
  });

  it.each(['', '   ', null, 4, 'x'.repeat(257), 'bad\u0000key'])(
    'rejects invalid supplied keys without submitting or allocating a replacement (%s)',
    async (session_id) => {
      const response = await handleOpenclawChat(gateway, { message: 'hello', session_id });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toBeUndefined();
      expect(calls).toHaveLength(0);
    }
  );

  it('does not submit invalid messages, selectors or agent configuration', async () => {
    for (const input of [null, { message: '' }, { message: 'hello', agent_id: 'missing' }]) {
      expect((await handleOpenclawChat(gateway, input)).isError).toBe(true);
    }
    expect(() => new OpenClawGateway({ url, agentId: 'cron:attack' })).toThrow(
      'Configured agent ID must be'
    );
    expect(calls).toHaveLength(0);
  });

  it.each(['accepted-but-invalid', 'accepted-but-timeout'])(
    'returns the accepted key on %s without retrying',
    async (message) => {
      const result = await handleOpenclawChat(gateway, { message }, context);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Error: /);
      expect(metadata(result).session_id).toBe(calls[0].key);
      expect(JSON.parse(result.content[1].text)).toEqual(metadata(result));
      expect(calls).toHaveLength(1);
      const followup = await handleOpenclawChat(gateway, {
        message: 'continue',
        ...metadata(result),
      });
      expect(followup.content[0].text).toBe(`${message} -> continue`);
    }
  );
});

describe('async conversation metadata and ownership', () => {
  it('carries the same key from enqueue through poll/list/completion and a second turn', async () => {
    const id = owner();
    const queued = await handleOpenclawChatAsync(
      gateway,
      { message: 'async first', agent_id: 'ops' },
      id,
      context
    );
    const data = json(queued);
    expect(queued.structuredContent).toEqual(data);
    expect(data.session_id).toMatch(/^agent:ops:mcp:mcp.example.test:test-app:/);
    const completed = await status(data.task_id, id, 'completed');
    expect(json(completed)).toMatchObject({
      session_id: data.session_id,
      agent_id: 'ops',
      result: 'async first',
    });
    expect(completed.structuredContent).toEqual(json(completed));
    const listed = await handleOpenclawTaskList(gateway, { session_id: data.session_id }, id);
    expect(json(listed).tasks).toHaveLength(1);
    expect(json(listed).tasks[0].session_id).toBe(data.session_id);
    expect(listed.structuredContent).toEqual(json(listed));
    const next = json(
      await handleOpenclawChatAsync(
        gateway,
        { message: 'async second', session_id: data.session_id, agent_id: data.agent_id },
        id,
        context
      )
    );
    expect(next.session_id).toBe(data.session_id);
    expect(json(await status(next.task_id, id, 'completed')).result).toBe(
      'async first -> async second'
    );
    expect(calls.every((c) => c.key === data.session_id && c.bodyKey === data.session_id)).toBe(
      true
    );
  });

  it('keeps generated keys on failed jobs and never retries accepted work', async () => {
    const id = owner();
    const queued = json(
      await handleOpenclawChatAsync(gateway, { message: 'accepted-but-invalid' }, id, context)
    );
    const failed = await status(queued.task_id, id, 'failed');
    expect(failed.isError).toBeUndefined(); // Existing status-tool contract.
    expect(json(failed)).toMatchObject({ session_id: queued.session_id, status: 'failed' });
    expect(json(failed).error).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(queued.session_id);
    expect(
      json(await handleOpenclawTaskList(gateway, { status: 'failed' }, id)).tasks[0].session_id
    ).toBe(queued.session_id);
    const cancelled = await handleOpenclawTaskCancel(gateway, { task_id: queued.task_id }, id);
    expect(cancelled.isError).toBe(true);
    expect(metadata(cancelled).session_id).toBe(queued.session_id);
  });

  it('exposes the same key while running and rejects running cancellation without losing the result', async () => {
    const id = owner();
    const queued = json(
      await handleOpenclawChatAsync(gateway, { message: 'wait-for-release' }, id, context)
    );
    try {
      await vi.waitFor(() => expect(releaseRunning).toBeTypeOf('function'));
      expect(json(await status(queued.task_id, id, 'running')).session_id).toBe(queued.session_id);
      const cancelled = await handleOpenclawTaskCancel(gateway, { task_id: queued.task_id }, id);
      expect(cancelled.isError).toBe(true);
      expect(metadata(cancelled).session_id).toBe(queued.session_id);
      expect(taskManager.get(queued.task_id, id).status).toBe('running');
    } finally {
      releaseRunning?.();
      releaseRunning = undefined;
    }
    expect(json(await status(queued.task_id, id, 'completed')).result).toBe('wait-for-release');
    expect(calls).toHaveLength(1);
  });

  it.each(['', null, 'bad\u0000key'])(
    'rejects invalid async keys without queueing or submitting (%s)',
    async (session_id) => {
      const id = owner();
      const response = await handleOpenclawChatAsync(
        gateway,
        { message: 'hello', session_id },
        id,
        context
      );
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toBeUndefined();
      expect(taskManager.list(id)).toEqual([]);
      expect(calls).toHaveLength(0);
    }
  );

  it('keeps the existing pre-submission queue-capacity exception without submitting work', async () => {
    const capacity = vi.spyOn(taskManager, 'create').mockImplementationOnce(() => {
      throw new Error('Task limit reached');
    });
    try {
      await expect(
        handleOpenclawChatAsync(gateway, { message: 'hello' }, owner(), context)
      ).rejects.toThrow('Task limit reached');
      expect(calls).toHaveLength(0);
    } finally {
      capacity.mockRestore();
    }
  });

  it('preserves pending cancellation, ownership checks, filters and expiry without leaking keys', async () => {
    const blocked = vi.spyOn(taskManager, 'getNextPending').mockReturnValue(undefined);
    try {
      const alice = owner();
      const bob = owner();
      const queued = json(
        await handleOpenclawChatAsync(gateway, { message: 'pending' }, alice, context)
      );
      expect(
        json(await handleOpenclawTaskStatus(gateway, { task_id: queued.task_id }, alice)).session_id
      ).toBe(queued.session_id);
      for (const handler of [handleOpenclawTaskStatus, handleOpenclawTaskCancel]) {
        const denied = await handler(gateway, { task_id: queued.task_id }, bob);
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent).toBeUndefined();
        expect(JSON.stringify(denied)).not.toContain(queued.session_id);
      }
      expect(
        json(await handleOpenclawTaskList(gateway, { session_id: queued.session_id }, bob)).tasks
      ).toEqual([]);
      const cancelled = await handleOpenclawTaskCancel(gateway, { task_id: queued.task_id }, alice);
      expect(json(cancelled)).toMatchObject({ session_id: queued.session_id, status: 'cancelled' });
      expect(cancelled.structuredContent).toEqual(json(cancelled));
      expect(calls).toHaveLength(0);
      taskManager.get(queued.task_id, alice).completedAt = new Date(Date.now() - 7200000);
      taskManager.cleanup();
      expect(
        (await handleOpenclawTaskStatus(gateway, { task_id: queued.task_id }, alice)).isError
      ).toBe(true);
    } finally {
      blocked.mockRestore();
    }
  });
});
