import { describe, expect, it } from 'vitest';
import { OpenClawGateway } from '../../openclaw/gateway.js';

describe('one OpenClaw Gateway', () => {
  const config = {
    url: 'https://gateway.example',
    token: 'test-credential',
    agentId: 'main',
    agents: [{ id: 'main' }, { id: 'writer' }, { id: 'reviewer' }],
  };
  it('retains default selection and caches immutable agent clients', () => {
    const gateway = new OpenClawGateway(config);
    expect(gateway.resolve().client).toBe(gateway.getDefault());
    expect(gateway.resolve().agentId).toBe('main');
    expect(gateway.resolve('WRITER').client).toBe(gateway.resolve('writer').client);
    expect(gateway.resolve('reviewer').client).not.toBe(gateway.resolve('writer').client);
    expect(gateway.resolve().client.getConversationAgentId()).toBe('main');
  });
  it('lists only safe agent metadata', () => {
    expect(new OpenClawGateway(config).listAgents()).toEqual([
      { agentId: 'main', isDefault: true },
      { agentId: 'writer', isDefault: false },
      { agentId: 'reviewer', isDefault: false },
    ]);
  });
  it('rejects unknown and malformed agent IDs', () => {
    const gateway = new OpenClawGateway(config);
    expect(() => gateway.resolve('missing')).toThrow('Unknown agent');
    expect(() => gateway.resolve('../writer')).toThrow('Invalid agent ID');
    expect(() => new OpenClawGateway({ ...config, agents: [{ id: 'bad/agent' }] })).toThrow(
      'Invalid catalog'
    );
    expect(
      () => new OpenClawGateway({ ...config, agents: [{ id: 'writer' }, { id: 'WRITER' }] })
    ).toThrow('Duplicate');
  });
  it.each(['file:///etc/passwd', 'ftp://gateway.example'])(
    'rejects unsafe URL scheme %s',
    (url) => {
      expect(() => new OpenClawGateway({ url })).toThrow('must use http or https');
    }
  );
  it('rejects malformed URLs', () => {
    expect(() => new OpenClawGateway({ url: 'not-a-url' })).toThrow('Invalid OpenClaw Gateway URL');
  });
  it.each(['http://localhost:18789', 'https://gateway.example'])('accepts endpoint %s', (url) => {
    expect(new OpenClawGateway({ url }).getDefault()).toBeDefined();
  });
});
