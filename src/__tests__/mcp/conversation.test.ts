import { describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import {
  conversationServerLabel,
  createConversationKey,
  sessionLabel,
} from '../../mcp/conversation.js';
import { OpenClawClient } from '../../openclaw/client.js';
import { validateId } from '../../utils/validation.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

describe('MCP conversation keys', () => {
  it('uses trusted issuer hostname and a deterministic machine fallback', () => {
    expect(conversationServerLabel('https://MCP.example.test:8443/oauth')).toBe('mcp.example.test');
    expect(conversationServerLabel()).toBe(sessionLabel(hostname(), 'local'));
  });

  it('creates a distinct UUID for each new conversation, even on one connection', () => {
    const keys = Array.from({ length: 200 }, () =>
      createConversationKey(
        'default',
        { serverLabel: 'mcp.example', clientName: 'Desktop' },
        'research'
      )
    );
    expect(new Set(keys).size).toBe(200);
    for (const key of keys)
      expect(key).toMatch(new RegExp(`^agent:research:mcp:mcp.example:desktop:default:${UUID}$`));
  });

  it.each([
    ['agent:main:cron:evil\n', 'agent-main-cron-evil'],
    ['../subagent:child/acp:attack', 'subagent-child-acp-attack'],
    ['\u0000\n\r', 'unknown'],
    ['日本語', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['Mixed Case App', 'mixed-case-app'],
  ])('bounds untrusted display labels without namespace injection (%s)', (name, expected) => {
    const key = createConversationKey('default', { serverLabel: 'server', clientName: name });
    expect(key.split(':').slice(0, 4)).toEqual(['mcp', 'server', expected, 'default']);
    expect(validateId(key, 'session_id').valid).toBe(true);
  });

  it('keeps maximum-size keys reusable under the existing 256-character validation', () => {
    const key = createConversationKey(
      'i'.repeat(64),
      { serverLabel: 's'.repeat(300), clientName: 'c'.repeat(1000) },
      'a'.repeat(64)
    );
    expect(key.length).toBeLessThanOrEqual(256);
    expect(validateId(key, 'session_id').value).toBe(key);
  });

  it.each([
    [undefined, 'openclaw', undefined],
    [undefined, 'openclaw/default', undefined],
    [undefined, 'openclaw/research', 'research'],
    [undefined, 'openclaw:Research', 'research'],
    [undefined, 'agent:writer', 'writer'],
    ['ops', 'openclaw/research', 'ops'],
    ['default', 'openclaw/default', 'default'],
    [undefined, 'legacy-provider/model', undefined],
  ])(
    'resolves configured agent %s and model %s without guessing main',
    (agentId, model, expected) => {
      const client = new OpenClawClient('http://127.0.0.1:1', { agentId, model });
      expect(client.getConversationAgentId()).toBe(expected);
    }
  );

  it.each(['agent:evil', 'bad/id', 'a'.repeat(65)])(
    'rejects invalid configured agent %s rather than sanitizing into another target',
    (agentId) => {
      expect(() =>
        new OpenClawClient('http://127.0.0.1:1', { agentId }).getConversationAgentId()
      ).toThrow('Configured agent ID');
    }
  );
});
