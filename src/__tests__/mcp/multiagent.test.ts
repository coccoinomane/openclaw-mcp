import { afterEach, describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { OpenClawGateway } from '../../openclaw/gateway.js';
import { handleOpenclawChat } from '../../mcp/tools/chat.js';
import { handleOpenclawAgents, openclawAgentsTool } from '../../mcp/tools/agents.js';
import { handleOpenclawStatus } from '../../mcp/tools/status.js';
import {
  handleOpenclawChatAsync,
  handleOpenclawTaskStatus,
  handleOpenclawTaskCancel,
  handleOpenclawTaskList,
} from '../../mcp/tools/tasks.js';
import { taskManager } from '../../mcp/tasks/manager.js';

const calls: Array<{ agent: string; message: string; session?: string }> = [];
const clients = Object.fromEntries(
  ['alpha', 'beta'].map((agent) => [
    agent,
    {
      getConversationAgentId: () => agent,
      health: async () => ({ status: 'ok' }),
      chat: async (message: string, session?: string) => {
        calls.push({ agent, message, session });
        await Promise.resolve();
        return { response: agent };
      },
    },
  ])
);
const gateway = {
  resolve: (agentId = 'alpha') => {
    if (!clients[agentId]) throw new Error('Unknown agent');
    return { agentId, client: clients[agentId] };
  },
  listAgents: () =>
    ['alpha', 'beta'].map((agentId) => ({
      agentId,
      isDefault: agentId === 'alpha',
    })),
} as unknown as OpenClawGateway;
const owner = 'multiagent-test';
afterEach(() => {
  calls.length = 0;
  for (const task of taskManager.list(owner)) taskManager.delete(task.id);
});

describe('generic agent routing without Discord', () => {
  it('isolates concurrent agent selection and retains default selection', async () => {
    const replies = await Promise.all(
      ['alpha', 'beta'].map((agent_id) =>
        handleOpenclawChat(gateway, { message: agent_id, agent_id })
      )
    );
    expect(replies.map((reply) => reply.content[0].text)).toEqual(['alpha', 'beta']);
    expect(replies.map((reply) => reply.structuredContent?.agent_id)).toEqual(['alpha', 'beta']);
    expect(calls.every((call) => call.session?.startsWith(`agent:${call.agent}:`))).toBe(true);
    const result = await handleOpenclawChat(gateway, { message: 'default' });
    expect(result.structuredContent?.agent_id).toBe('alpha');
  });

  it('rejects unknown agents and explicit session mismatch before dispatch', async () => {
    for (const input of [
      { message: 'bad', agent_id: 'unknown' },
      { message: 'bad', agent_id: 'beta', session_id: 'agent:alpha:mcp:old' },
    ]) {
      expect((await handleOpenclawChat(gateway, input)).isError).toBe(true);
      expect((await handleOpenclawChatAsync(gateway, input, owner)).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
    expect(taskManager.list(owner)).toHaveLength(0);
  });

  it('preserves supplied legacy sessions without explicit selection', async () => {
    const response = await handleOpenclawChat(gateway, {
      message: 'legacy',
      session_id: 'agent:legacy:mcp:old',
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).not.toHaveProperty('agent_id');
    const followup = await handleOpenclawChat(gateway, {
      ...response.structuredContent,
      message: 'followup',
    });
    expect(followup.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.session === 'agent:legacy:mcp:old')).toBe(true);
    expect(
      (
        await handleOpenclawChat(gateway, {
          message: 'explicit legacy denied',
          session_id: 'agent:legacy:mcp:old',
          agent_id: 'legacy',
        })
      ).isError
    ).toBe(true);
  });

  it('reuses legacy async continuation metadata without exporting an unknown selector', async () => {
    const queued = await handleOpenclawChatAsync(
      gateway,
      { message: 'legacy async', session_id: 'agent:legacy:mcp:old' },
      owner
    );
    expect(queued.isError).toBeUndefined();
    expect(queued.structuredContent).not.toHaveProperty('agent_id');
    const id = queued.structuredContent!.task_id as string;
    await vi.waitFor(() => expect(taskManager.get(id, owner)?.status).toBe('completed'));
    const status = await handleOpenclawTaskStatus(gateway, { task_id: id }, owner);
    expect(status.structuredContent).not.toHaveProperty('agent_id');
    const { session_id, agent_id } = status.structuredContent!;
    const second = await handleOpenclawChatAsync(
      gateway,
      { message: 'legacy async followup', session_id, agent_id },
      owner
    );
    expect(second.isError).toBeUndefined();
    expect(second.structuredContent).not.toHaveProperty('agent_id');
    await vi.waitFor(() =>
      expect(taskManager.get(second.structuredContent!.task_id as string, owner)?.status).toBe(
        'completed'
      )
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.session === session_id)).toBe(true);
    expect(
      (await handleOpenclawChatAsync(gateway, { message: 'denied', agent_id: 'legacy' }, owner))
        .isError
    ).toBe(true);
  });

  it('normalizes task agent selectors for status, listing and cancellation', async () => {
    const queued = await handleOpenclawChatAsync(
      gateway,
      { message: 'uppercase', agent_id: 'BETA' },
      owner
    );
    const id = queued.structuredContent!.task_id as string;
    expect(queued.structuredContent?.agent_id).toBe('beta');
    expect(
      (await handleOpenclawTaskStatus(gateway, { task_id: id, agent_id: 'BETA' }, owner)).isError
    ).toBeUndefined();
    expect(
      (await handleOpenclawTaskStatus(gateway, { task_id: id, unexpected: 'value' }, owner)).isError
    ).toBe(true);
    const listed = await handleOpenclawTaskList(gateway, { agent_id: 'BETA' }, owner);
    expect(listed.structuredContent?.tasks).toEqual([
      expect.objectContaining({ task_id: id, agent_id: 'beta' }),
    ]);
    expect((await handleOpenclawTaskList(gateway, { unexpected: 'value' }, owner)).isError).toBe(
      true
    );
    const pending = taskManager.create({
      type: 'chat',
      input: {},
      ownerId: owner,
      agentId: 'beta',
    });
    expect(
      (await handleOpenclawTaskCancel(gateway, { task_id: pending.id, unexpected: 'value' }, owner))
        .isError
    ).toBe(true);
    expect(
      (await handleOpenclawTaskCancel(gateway, { task_id: pending.id, agent_id: 'BETA' }, owner))
        .isError
    ).toBeUndefined();
    expect(pending.status).toBe('cancelled');
    await vi.waitFor(() => expect(taskManager.get(id, owner)?.status).toBe('completed'));
  });

  it('returns only safe catalog metadata with schema-valid output', async () => {
    const response = await handleOpenclawAgents(gateway, {});
    expect(response.structuredContent).toEqual({
      agents: [
        { agent_id: 'alpha', is_default: true },
        { agent_id: 'beta', is_default: false },
      ],
      total: 2,
    });
    expect(
      new AjvJsonSchemaValidator().getValidator(openclawAgentsTool.outputSchema!)(
        response.structuredContent
      ).valid
    ).toBe(true);
    expect((await handleOpenclawAgents(gateway, { unexpected: 'value' })).isError).toBe(true);
    expect((await handleOpenclawAgents(gateway, { credentials: true })).isError).toBe(true);
  });

  it('labels status as Gateway health and validates selected agent', async () => {
    const response = await handleOpenclawStatus(gateway, { agent_id: 'beta' });
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      agent_id: 'beta',
      health_scope: 'gateway',
    });
    expect((await handleOpenclawStatus(gateway, { agent_id: 'unknown' })).isError).toBe(true);
  });

  it('persists selected agent through worker execution and protects task ownership', async () => {
    const queued = await handleOpenclawChatAsync(
      gateway,
      { message: 'async', agent_id: 'beta' },
      owner
    );
    const id = queued.structuredContent!.task_id as string;
    expect(taskManager.get(id, owner)).toMatchObject({ agentId: 'beta', routingAgentId: 'beta' });
    await vi.waitFor(() => expect(taskManager.get(id, owner)?.status).toBe('completed'));
    expect(calls[0]).toMatchObject({ agent: 'beta', message: 'async' });
    expect(
      (await handleOpenclawTaskStatus(gateway, { task_id: id, agent_id: 'alpha' }, owner)).isError
    ).toBe(true);
    expect(
      (await handleOpenclawTaskStatus(gateway, { task_id: id, agent_id: 'beta' }, owner))
        .structuredContent?.agent_id
    ).toBe('beta');
    expect(
      (await handleOpenclawTaskStatus(gateway, { task_id: id }, 'different-owner')).content[0].text
    ).toContain('Task not found');
    const list = await handleOpenclawTaskList(gateway, { agent_id: 'alpha' }, owner);
    expect(list.structuredContent?.tasks).toEqual([]);
  });

  it('rejects retargeting pending cancellation without changing the task', async () => {
    const task = taskManager.create({
      type: 'chat',
      input: {},
      ownerId: owner,
      agentId: 'beta',
    });
    expect(
      (await handleOpenclawTaskCancel(gateway, { task_id: task.id, agent_id: 'alpha' }, owner))
        .isError
    ).toBe(true);
    expect(
      (await handleOpenclawTaskCancel(gateway, { task_id: task.id, unexpected: 'value' }, owner))
        .isError
    ).toBe(true);
    expect(task.status).toBe('pending');
    expect(
      (await handleOpenclawTaskCancel(gateway, { task_id: task.id, agent_id: 'beta' }, owner))
        .isError
    ).toBeUndefined();
  });
});
