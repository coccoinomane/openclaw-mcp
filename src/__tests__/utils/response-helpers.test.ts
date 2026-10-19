import { describe, it, expect } from 'vitest';
import {
  successResponse,
  errorResponse,
  jsonResponse,
  withConversation,
} from '../../utils/response-helpers.js';

describe('successResponse', () => {
  it('wraps text in content array with type "text"', () => {
    const result = successResponse('hello');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('does not set isError', () => {
    const result = successResponse('ok');
    expect(result.isError).toBeUndefined();
  });
});

describe('errorResponse', () => {
  it('prefixes message with "Error:"', () => {
    const result = errorResponse('something failed');
    expect(result.content[0].text).toBe('Error: something failed');
  });

  it('sets isError to true', () => {
    const result = errorResponse('fail');
    expect(result.isError).toBe(true);
  });
});

describe('jsonResponse', () => {
  it('serializes data with indentation', () => {
    const data = { foo: 'bar', num: 42 };
    const result = jsonResponse(data);
    expect(result.content[0].text).toBe(JSON.stringify(data, null, 2));
  });

  it('handles arrays', () => {
    const data = [1, 2, 3];
    const result = jsonResponse(data);
    expect(JSON.parse(result.content[0].text)).toEqual(data);
  });

  it('handles null', () => {
    const result = jsonResponse(null);
    expect(result.content[0].text).toBe('null');
  });

  it('is a success response (no isError)', () => {
    const result = jsonResponse({ a: 1 });
    expect(result.isError).toBeUndefined();
  });
});

describe('withConversation', () => {
  it.each([
    ['success', successResponse('  hello\nworld\n')],
    ['error', errorResponse('something failed\n')],
    ['explicit success', { ...successResponse('ok'), isError: false }],
  ] as const)('separates metadata and preserves the %s response', (_name, response) => {
    const firstBlock = { ...response.content[0] };
    const metadata = { session_id: 'session-123', instance: 'work' };
    const metadataText = '\n\n{"session_id":"session-123","instance":"work"}';

    const result = withConversation(response, metadata.session_id, metadata.instance);

    expect(result.content).toEqual([firstBlock, { type: 'text', text: metadataText }]);
    expect(result.content[0]).toBe(response.content[0]);
    expect(result.content.map((block) => block.text).join('')).toBe(firstBlock.text + metadataText);
    expect(JSON.parse(result.content[1].text)).toEqual(metadata);
    expect(result.structuredContent).toEqual(metadata);
    expect(result.isError).toBe(response.isError);
    expect(Object.hasOwn(result, 'isError')).toBe(Object.hasOwn(response, 'isError'));
    expect(response.content).toEqual([firstBlock]);
  });
});
