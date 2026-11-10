import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenClawGateway } from '../../openclaw/gateway.js';

afterEach(() => vi.unstubAllGlobals());

describe('one OpenClaw Gateway', () => {
  const config = {
    url: 'https://gateway.example',
    token: 'test-credential',
    agentId: 'main',
    agents: [{ id: 'main' }, { id: 'writer' }, { id: 'reviewer' }],
  };
  it('uses one endpoint and credential across concurrent agent selections', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
      );
    vi.stubGlobal('fetch', fetcher);
    const gateway = new OpenClawGateway(config);
    await Promise.all(
      ['main', 'writer', 'reviewer'].map((id) =>
        gateway.resolve(id).client.chat('hello', 'agent:' + id + ':test')
      )
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url.toString()).toBe('https://gateway.example/v1/chat/completions');
      expect(options.headers.Authorization).toBe('Bearer test-credential');
    }
    expect(fetcher.mock.calls.map(([, options]) => options.headers['x-openclaw-agent-id'])).toEqual(
      ['main', 'writer', 'reviewer']
    );
  });
  it('does not allow later config mutation to retarget another agent', async () => {
    const supplied = { ...config };
    const gateway = new OpenClawGateway(supplied);
    supplied.url = 'https://other.example';
    supplied.token = 'different-credential';
    const fetcher = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
      );
    vi.stubGlobal('fetch', fetcher);
    await gateway.resolve('writer').client.chat('hello');
    expect(fetcher.mock.calls[0][0].toString()).toBe('https://gateway.example/v1/chat/completions');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer test-credential');
  });
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
