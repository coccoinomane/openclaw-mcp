import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as exports from '../../mcp/tools/index.js';
import { discordTools } from '../../mcp/tools/discord.js';

const tools = [
  ...Object.values(exports).filter(
    (value): value is Tool => typeof value === 'object' && value !== null && 'inputSchema' in value
  ),
  ...discordTools,
];
const validator = new AjvJsonSchemaValidator();

describe('public tool contracts', () => {
  it('validates documentation examples against all 15 live schemas', () => {
    const examples = JSON.parse(
      readFileSync(new URL('../../../docs/tool-contract-examples.json', import.meta.url), 'utf8')
    );
    expect(tools).toHaveLength(15);
    expect(examples.map((example: any) => example.name).sort()).toEqual(
      tools.map((tool) => tool.name).sort()
    );
    for (const example of examples) {
      const tool = tools.find((tool) => tool.name === example.name)!;
      const result = validator.getValidator(tool.inputSchema)(example.arguments);
      expect(result.valid, tool.name + ': ' + result.errorMessage).toBe(true);
    }
  });

  it('has no removed names in public input or output properties', () => {
    const removed = new Set([
      'target',
      'guild_id',
      'account_id',
      'session_id',
      'fork_from_session',
      'mode',
      'before',
      'next_before',
      'creation_guilds',
    ]);
    const inspect = (schema: any) => {
      if (!schema || typeof schema !== 'object') return;
      for (const [name, value] of Object.entries(schema.properties ?? {})) {
        expect(removed.has(name), name).toBe(false);
        inspect(value);
      }
      for (const branch of schema.anyOf ?? []) inspect(branch);
      inspect(schema.items);
    };
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      inspect(tool.inputSchema);
      inspect(tool.outputSchema);
    }
  });

  it('validates conversation and task identities without accepting legacy session aliases', () => {
    const chat = validator.getValidator(exports.openclawChatTool.outputSchema!);
    expect(chat({ session_key: 'agent:main:mcp:server:client:key', agent_id: 'main' }).valid).toBe(
      true
    );
    expect(chat({ session_id: 'old' }).valid).toBe(false);
    for (const tool of [
      exports.openclawChatAsyncTool,
      exports.openclawTaskStatusTool,
      exports.openclawTaskCancelTool,
    ]) {
      const validate = validator.getValidator(tool.outputSchema!);
      expect(validate({ task_id: 'task-1', status: 'completed', session_key: 'key' }).valid).toBe(
        true
      );
      expect(validate({ task_id: 'task-1', status: 'completed', session_id: 'old' }).valid).toBe(
        false
      );
    }
  });
});
