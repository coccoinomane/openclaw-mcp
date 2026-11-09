import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceRegistry } from '../../openclaw/registry.js';
import { handleOpenclawChat } from '../../mcp/tools/chat.js';
import { discordBindingResolver } from '../../openclaw/discord-bindings.js';

afterEach(() => vi.unstubAllGlobals());

describe('integrated agent routing', () => {
  it('keeps actual headers and model defaults isolated across concurrent agents', async () => {
    const requests: Array<{ agent: string | undefined; session: string; model: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        requests.push({
          agent: options.headers['x-openclaw-agent-id'],
          session: options.headers['x-openclaw-session-key'],
          model: JSON.parse(options.body).model,
        });
        await Promise.resolve();
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      })
    );
    const registry = new InstanceRegistry(
      [{ name: 'local', url: 'http://localhost', agents: [{ id: 'alpha' }, { id: 'beta' }] }],
      'openclaw/alpha'
    );
    await Promise.all([
      handleOpenclawChat(registry, { message: 'one', agent_id: 'alpha' }),
      handleOpenclawChat(registry, { message: 'two', agent_id: 'beta' }),
      handleOpenclawChat(registry, { message: 'default' }),
    ]);
    expect(requests.map((request) => request.agent)).toEqual(['alpha', 'beta', undefined]);
    expect(requests.map((request) => request.model)).toEqual([
      'openclaw/alpha',
      'openclaw/alpha',
      'openclaw/alpha',
    ]);
    expect(requests[0].session).toMatch(/^agent:alpha:/);
    expect(requests[1].session).toMatch(/^agent:beta:/);
    expect(requests[2].session).toMatch(/^agent:alpha:/);
  });

  it('maps one agent across multiple admitted guilds without matching an unrelated guild', () => {
    const guilds = ['800000000000000001', '800000000000000002'];
    const resolve = discordBindingResolver(
      guilds.map((guildId) => ({
        agentId: 'writer',
        match: { channel: 'discord', accountId: 'bot', guildId },
      }))
    );
    const target = {
      name: 'scope',
      agentId: 'original',
      accountId: 'bot',
      channelId: '800000000000000004',
    };
    for (const guildId of guilds)
      expect(resolve({ ...target, guildId }, target.channelId)).toBe('writer');
    expect(resolve({ ...target, guildId: '800000000000000003' }, target.channelId)).toBeUndefined();
    expect(
      resolve({ ...target, guildId: guilds[0], accountId: 'another' }, target.channelId)
    ).toBeUndefined();
  });
});
