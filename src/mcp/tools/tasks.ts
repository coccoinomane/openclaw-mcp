/**
 * Async Task Tools for OpenClaw MCP
 *
 * Provides async/background task management for long-running operations.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OpenClawGateway } from '../../openclaw/gateway.js';
import {
  structuredJsonResponse,
  errorResponse,
  withConversation,
  type ToolResponse,
} from '../../utils/response-helpers.js';
import { taskManager, type Task, type TaskStatus } from '../tasks/manager.js';
import {
  createConversationKey,
  resolveConversation,
  type ConversationContext,
} from '../conversation.js';
import { log } from '../../utils/logger.js';
import { validateInputIsObject, validateMessage, validateId } from '../../utils/validation.js';

// ============================================================================
// Tool Definitions
// ============================================================================

export const openclawChatAsyncTool: Tool = {
  name: 'openclaw_chat_async',
  description:
    'Send a message to OpenClaw asynchronously. Returns a task_id immediately that can be polled for results. Use this for potentially long-running conversations. Save the returned session_id and agent_id (when present) and reuse them for follow-up turns; omission starts a new conversation. Poll the task after enqueue; do not resend ambiguous failures automatically.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      message: {
        type: 'string',
        description: 'The message to send to OpenClaw',
      },
      session_id: {
        type: 'string',
        description:
          'Gateway conversation key from a previous chat; reuse unchanged for follow-up turns, or omit for a new conversation. Distinct from MCP transport session and task IDs.',
      },
      priority: {
        type: 'number',
        description: 'Task priority (higher = processed first). Default: 0',
      },
      agent_id: { type: 'string', description: 'Configured agent ID from openclaw_agents.' },
    },
    required: ['message'],
  },
};

export const openclawTaskStatusTool: Tool = {
  name: 'openclaw_task_status',
  description:
    'Check the status of an async task. Returns status, session_id, and result if completed. Save session_id and agent_id for follow-up chat calls, including after failures.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      agent_id: {
        type: 'string',
        description: 'Optional assertion of the stored task agent; cannot retarget.',
      },
      task_id: {
        type: 'string',
        description: 'The task ID returned from openclaw_chat_async',
      },
    },
    required: ['task_id'],
  },
};

export const openclawTaskListTool: Tool = {
  name: 'openclaw_task_list',
  description:
    'List owned tasks with session_id and agent_id for conversation reuse. Optionally filter by status, session, or agent.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
        description: 'Filter by task status',
      },
      session_id: {
        type: 'string',
        description: 'Filter by session ID',
      },
      agent_id: { type: 'string', description: 'Configured agent ID from openclaw_agents.' },
    },
    required: [],
  },
};

export const openclawTaskCancelTool: Tool = {
  name: 'openclaw_task_cancel',
  description: "Cancel a pending task. Only works for tasks that haven't started yet.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      agent_id: {
        type: 'string',
        description: 'Optional assertion of the stored task agent; cannot retarget.',
      },
      task_id: {
        type: 'string',
        description: 'The task ID to cancel',
      },
    },
    required: ['task_id'],
  },
};

// ============================================================================
// Background Task Processor
// ============================================================================

let processorRunning = false;
let processorGateway: OpenClawGateway | null = null;

async function processTask(task: Task, gateway: OpenClawGateway): Promise<void> {
  taskManager.updateStatus(task.id, 'running');

  let client;
  try {
    client = gateway.resolve(task.routingAgentId).client;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Gateway not available';
    taskManager.updateStatus(task.id, 'failed', undefined, errorMsg);
    return;
  }

  try {
    const input = task.input as { message: string; session_id?: string };
    const response = await client.chat(input.message, input.session_id);
    taskManager.updateStatus(task.id, 'completed', response.response);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    taskManager.updateStatus(task.id, 'failed', undefined, errorMsg);
  }
}

async function taskProcessor(): Promise<void> {
  if (!processorGateway) return;

  while (processorRunning) {
    const task = taskManager.getNextPending();

    if (task) {
      await processTask(task, processorGateway);
    } else {
      // No pending tasks, wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export function startTaskProcessor(gateway: OpenClawGateway): void {
  if (processorRunning) return;

  processorGateway = gateway;
  processorRunning = true;
  taskProcessor().catch(() => {
    processorRunning = false;
  });
  log('Task processor started');
}

// ============================================================================
// Tool Handlers
// ============================================================================

export async function handleOpenclawChatAsync(
  gateway: OpenClawGateway,
  input: unknown,
  ownerId: string,
  context: ConversationContext = {}
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }
  if (
    Object.keys(input).some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(openclawChatAsyncTool.inputSchema.properties, key)
    )
  ) {
    return errorResponse('Unknown argument');
  }

  const msgResult = validateMessage(input.message);
  if (msgResult.valid === false) {
    return errorResponse(msgResult.error);
  }

  let sessionId: string | undefined;
  if (input.session_id !== undefined) {
    const sidResult = validateId(input.session_id, 'session_id');
    if (sidResult.valid === false) {
      return errorResponse(sidResult.error);
    }
    sessionId = sidResult.value;
  }

  let priority = 0;
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'number' || !Number.isInteger(input.priority)) {
      return errorResponse('priority must be an integer');
    }
    priority = input.priority;
  }

  // Validate the selected agent before queueing.
  let agentId: string | undefined;
  let routingAgentId: string | undefined;
  try {
    const resolved = resolveConversation(gateway, input.agent_id, sessionId);
    agentId = resolved.agentId;
    routingAgentId = resolved.routingAgentId;
    sessionId ??= createConversationKey(context, agentId);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Invalid agent');
  }

  // Ensure processor is running
  startTaskProcessor(gateway);

  // Create task
  const task = taskManager.create({
    type: 'chat',
    input: { message: msgResult.value, session_id: sessionId },
    ownerId,
    sessionId,
    priority,
    agentId,
    routingAgentId,
  });

  return structuredJsonResponse({
    task_id: task.id,
    status: task.status,
    ...(agentId ? { agent_id: agentId } : {}),
    session_id: sessionId,
    message: 'Task queued. Use openclaw_task_status to check progress.',
  });
}

export async function handleOpenclawTaskStatus(
  _gateway: OpenClawGateway,
  input: unknown,
  ownerId: string
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }
  if (
    Object.keys(input).some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(openclawTaskStatusTool.inputSchema.properties, key)
    )
  ) {
    return errorResponse('Unknown argument');
  }

  const tidResult = validateId(input.task_id, 'task_id');
  if (tidResult.valid === false) {
    return errorResponse(tidResult.error);
  }
  const task_id = tidResult.value;

  // Tasks owned by another connection read as "not found" — same message as a
  // genuinely unknown ID, so this cannot be used to probe for their existence.
  const task = taskManager.get(task_id, ownerId);
  if (!task) {
    return errorResponse(`Task not found: ${task_id}`);
  }

  const conflict = taskSelectorConflict(input, task);
  if (conflict) return errorResponse(conflict);

  const response: Record<string, unknown> = {
    task_id: task.id,
    type: task.type,
    status: task.status,
    ...(task.agentId ? { agent_id: task.agentId } : {}),
    session_id: task.sessionId,
    created_at: task.createdAt.toISOString(),
  };

  if (task.startedAt) {
    response.started_at = task.startedAt.toISOString();
  }
  if (task.completedAt) {
    response.completed_at = task.completedAt.toISOString();
  }
  if (task.status === 'completed' && task.result) {
    response.result = task.result;
  }
  if (task.status === 'failed' && task.error) {
    response.error = task.error;
  }

  return structuredJsonResponse(response);
}

const VALID_TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
];

export async function handleOpenclawTaskList(
  _gateway: OpenClawGateway,
  input: unknown,
  ownerId: string
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }
  if (
    Object.keys(input).some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(openclawTaskListTool.inputSchema.properties, key)
    )
  ) {
    return errorResponse('Unknown argument');
  }

  let status: TaskStatus | undefined;
  if (input.status !== undefined) {
    if (
      typeof input.status !== 'string' ||
      !VALID_TASK_STATUSES.includes(input.status as TaskStatus)
    ) {
      return errorResponse(`status must be one of: ${VALID_TASK_STATUSES.join(', ')}`);
    }
    status = input.status as TaskStatus;
  }

  let session_id: string | undefined;
  if (input.session_id !== undefined) {
    const sidResult = validateId(input.session_id, 'session_id');
    if (sidResult.valid === false) {
      return errorResponse(sidResult.error);
    }
    session_id = sidResult.value;
  }

  let agentFilter: string | undefined;
  if (input.agent_id !== undefined) {
    const checked = validateId(input.agent_id, 'agent_id');
    if (!checked.valid) return errorResponse(checked.error);
    agentFilter = checked.value.toLowerCase();
  }

  const tasks = taskManager.list(ownerId, {
    status,
    sessionId: session_id,
    agentId: agentFilter,
  });
  const stats = taskManager.stats(ownerId);

  const taskList = tasks.map((t) => ({
    task_id: t.id,
    type: t.type,
    status: t.status,
    ...(t.agentId ? { agent_id: t.agentId } : {}),
    session_id: t.sessionId,
    priority: t.priority,
    created_at: t.createdAt.toISOString(),
    has_result: t.status === 'completed' && !!t.result,
  }));

  return structuredJsonResponse({ stats, tasks: taskList });
}

export async function handleOpenclawTaskCancel(
  _gateway: OpenClawGateway,
  input: unknown,
  ownerId: string
): Promise<ToolResponse> {
  if (!validateInputIsObject(input)) {
    return errorResponse('Invalid input: expected an object');
  }
  if (
    Object.keys(input).some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(openclawTaskCancelTool.inputSchema.properties, key)
    )
  ) {
    return errorResponse('Unknown argument');
  }

  const tidResult = validateId(input.task_id, 'task_id');
  if (tidResult.valid === false) {
    return errorResponse(tidResult.error);
  }
  const task_id = tidResult.value;

  // Same as task_status: another connection's task is indistinguishable from
  // an unknown one.
  const task = taskManager.get(task_id, ownerId);
  if (!task) {
    return errorResponse(`Task not found: ${task_id}`);
  }

  const conflict = taskSelectorConflict(input, task);
  if (conflict) return errorResponse(conflict);

  if (task.status !== 'pending') {
    const response = errorResponse(
      `Cannot cancel task with status: ${task.status}. Only pending tasks can be cancelled.`
    );
    return task.sessionId ? withConversation(response, task.sessionId, task.agentId) : response;
  }

  const cancelled = taskManager.cancel(task_id, ownerId);
  if (!cancelled) {
    const response = errorResponse('Failed to cancel task');
    return task.sessionId ? withConversation(response, task.sessionId, task.agentId) : response;
  }

  return structuredJsonResponse({
    task_id,
    status: 'cancelled',
    session_id: task.sessionId,
    ...(task.agentId ? { agent_id: task.agentId } : {}),
    message: 'Task cancelled successfully',
  });
}

function taskSelectorConflict(input: Record<string, unknown>, task: Task): string | undefined {
  if (input.agent_id === undefined) return undefined;
  const checked = validateId(input.agent_id, 'agent_id');
  if (!checked.valid) return checked.error;
  if (checked.value.toLowerCase() !== task.agentId)
    return 'agent_id conflicts with the stored task route';
  return undefined;
}
