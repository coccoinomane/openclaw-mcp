import { describe, expect, it } from 'vitest';
import { createInputValidator } from '../../server/input-validation.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

function validator(properties: Record<string, unknown>, extra = {}) {
  return createInputValidator('test_tool', {
    type: 'object',
    properties,
    additionalProperties: false,
    ...extra,
  } as Tool['inputSchema']);
}

describe('input diagnostics', () => {
  it('reports missing and unknown fields without changing input', () => {
    const validate = validator({ channel_id: { type: 'string' } }, { required: ['channel_id'] });
    const input = Object.freeze({ thread_id: 'private-value' });
    expect(validate(input)).toBe(
      'Invalid input for test_tool: missing required field: channel_id; unknown field: thread_id. Check the input schema in tools/list.'
    );
    expect(input).toEqual({ thread_id: 'private-value' });
    expect(validate({ channel_id: 'private-value' })).toBeUndefined();
  });

  it.each([
    [{ type: 'boolean' }, 'private-value', 'value must be boolean'],
    [{ type: 'integer', minimum: 1 }, 0, 'value must be >= 1'],
    [{ type: 'integer', maximum: 100 }, 101, 'value must be <= 100'],
    [{ type: 'number', exclusiveMinimum: 1 }, 1, 'value must be > 1'],
    [{ type: 'number', exclusiveMaximum: 1 }, 1, 'value must be < 1'],
    [{ type: 'string', minLength: 2 }, '', 'value must have at least 2 characters'],
    [{ type: 'string', maxLength: 2 }, 'private-value', 'value must have at most 2 characters'],
    [{ type: 'array', minItems: 1 }, [], 'value must have at least 1 items'],
    [{ type: 'array', maxItems: 0 }, ['private-value'], 'value must have at most 0 items'],
    [{ type: 'string', pattern: '^ok$' }, 'private-value', 'value must match its schema pattern'],
    [{ type: 'string', format: 'email' }, 'private-value', 'value must match its schema format'],
    [{ const: true }, false, 'value must equal the constant in the tool schema'],
    [
      { enum: ['ok'] },
      'private-value',
      'value must be one of the allowed values in the tool schema',
    ],
    [{ not: { type: 'string' } }, 'private-value', 'value does not satisfy its schema constraint'],
  ])('formats constraint %#', (schema, input, expected) => {
    const message = validator({ value: schema })({ value: input });
    expect(message).toContain(expected);
    expect(message).not.toContain('private-value');
  });

  it('bounds error count, field names and enums', () => {
    const validate = validator({
      value: { enum: Array.from({ length: 1000 }, (_, i) => 'choice-' + i) },
    });
    const input = {
      value: 'private-value',
      ...Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => ['extra_' + i, 'private-value'])
      ),
    };
    const message = validate(input)!;
    expect(message).toContain('more errors omitted');
    expect(message).not.toContain('extra_8');
    expect(message).not.toContain('private-value');
    expect(message.length).toBeLessThanOrEqual(2048);
    const enumError = validate({ value: 'private-value' })!;
    expect(enumError).not.toContain('choice-');
    expect(enumError.length).toBeLessThan(200);
    for (const key of [
      'x'.repeat(10000),
      'private-value\n',
      'private-value/child',
      'private-value\u202e',
      'private-value~child',
    ]) {
      const error = validator({})({ [key]: 'private-value' })!;
      expect(error).toContain('[redacted field]');
      expect(error).not.toContain('private-value');
    }
  });

  it('sanitizes nested paths and preserves array indexes', () => {
    const validate = validator({
      rows: { type: 'array', items: { type: 'object', additionalProperties: { type: 'integer' } } },
    });
    expect(validate({ rows: [{ count: 'private-value' }] })).toContain(
      'rows.[0].count must be integer'
    );
    expect(validate({ rows: [{ ['private-value/child']: false }] })).toContain(
      'rows.[0].[redacted field] must be integer'
    );
    expect(validate({ rows: [{ ['x'.repeat(1000)]: false }] })).toContain(
      '[redacted path] must be integer'
    );
    expect(validate({ rows: [{ ['private-value\n']: false }] })).not.toContain('private-value');
  });

  it('rejects non-objects and does not coerce, default or remove fields', () => {
    const validate = validator({ value: { type: 'integer', default: 1 } }, { required: ['value'] });
    for (const input of [null, undefined, [], 'private-value', 1])
      expect(validate(input)).toContain('input must be object');
    const input = { value: '1', extra: true };
    expect(validate(input)).toContain('value must be integer');
    expect(input).toEqual({ value: '1', extra: true });
    const missing = {};
    expect(validate(missing)).toContain('missing required field: value');
    expect(missing).toEqual({});
  });
});
