import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type OutputSchema = NonNullable<Tool['outputSchema']>;
const string = { type: 'string' };
export const conversationOutput: OutputSchema = {
  type: 'object',
  properties: { session_key: string, agent_id: string },
  required: ['session_key'],
  additionalProperties: false,
};
const task: OutputSchema = {
  type: 'object',
  properties: {
    task_id: string,
    session_key: string,
    agent_id: string,
    type: string,
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
    priority: { type: 'number' },
    created_at: string,
    started_at: string,
    completed_at: string,
    has_result: { type: 'boolean' },
    result: {},
    error: string,
    message: string,
  },
  required: ['task_id', 'status'],
  additionalProperties: false,
};
export const taskOutput: OutputSchema = { type: 'object', anyOf: [task, conversationOutput] };
export const taskListOutput: OutputSchema = {
  type: 'object',
  properties: {
    stats: {
      type: 'object',
      properties: {
        total: { type: 'integer', minimum: 0 },
        byStatus: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      },
      required: ['total', 'byStatus'],
      additionalProperties: false,
    },
    tasks: { type: 'array', items: task },
  },
  required: ['stats', 'tasks'],
  additionalProperties: false,
};
