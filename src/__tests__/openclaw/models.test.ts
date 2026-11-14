import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../openclaw/gateway-discovery.js', () => ({ gatewayModelRequest: vi.fn() }));
vi.mock('../../openclaw/discord-channels.js', () => ({ assertServiceProvenance: vi.fn() }));
import { gatewayModelRequest } from '../../openclaw/gateway-discovery.js';
import { listModels, selectSessionModel } from '../../openclaw/models.js';
import { OpenClawGateway } from '../../openclaw/gateway.js';
import { handleOpenclawChat } from '../../mcp/tools/chat.js';
import { handleOpenclawModels } from '../../mcp/tools/models.js';
const config = {
  url: 'http://127.0.0.1:18789',
  agentId: 'main',
  agents: [{ id: 'main' }, { id: 'writer' }],
};
beforeEach(() => vi.resetAllMocks());
describe('agent-scoped session models', () => {
  it('returns only selectable rows with canonical refs and public metadata', async () => {
    vi.mocked(gatewayModelRequest).mockResolvedValue({
      models: [
        {
          provider: 'p',
          id: 'm',
          name: 'Model',
          alias: 'fast',
          manualSelectionAllowed: true,
          available: false,
          secret: 'private',
        },
        { provider: 'p', id: 'hidden', manualSelectionAllowed: false },
      ],
    });
    expect(await listModels(config, 'writer')).toEqual({
      agent_id: 'writer',
      models: [{ model: 'p/m', name: 'Model', alias: 'fast', available: false }],
      total: 1,
    });
    expect(gatewayModelRequest).toHaveBeenCalledWith(config, {
      method: 'models.list',
      params: { agentId: 'writer', view: 'configured' },
    });
  });
  it('requires policy-aware rows rather than returning an unfiltered inventory', async () => {
    vi.mocked(gatewayModelRequest).mockResolvedValue({ models: [{ provider: 'p', id: 'm' }] });
    await expect(listModels(config, 'main')).rejects.toThrow('model-selection-policy');
  });
  it('uses only the session write, without a duplicate catalog lookup or inference probe', async () => {
    vi.mocked(gatewayModelRequest).mockResolvedValue({ ok: true });
    await selectSessionModel(config, 'agent:writer:mcp:new', 'p/m');
    expect(gatewayModelRequest).toHaveBeenCalledTimes(1);
    expect(gatewayModelRequest).toHaveBeenCalledWith(config, {
      method: 'sessions.patch',
      params: { key: 'agent:writer:mcp:new', model: 'p/m' },
    });
  });
  it('pins a new chat before inference; follow-ups leave the selection alone', async () => {
    const gateway = new OpenClawGateway(config);
    const select = vi.spyOn(gateway, 'selectModel').mockResolvedValue();
    const chat = vi
      .spyOn(gateway.resolve('writer').client, 'chat')
      .mockImplementation(async (_message, key) => {
        expect(select).toHaveBeenCalledWith(key, 'p/m');
        return { response: 'ok' };
      });
    const result = await handleOpenclawChat(gateway, {
      message: 'hello',
      agent_id: 'writer',
      model: 'p/m',
    });
    expect(result.isError).not.toBe(true);
    const key = chat.mock.calls[0][1]!;
    await handleOpenclawChat(gateway, {
      message: 'follow-up',
      agent_id: 'writer',
      session_id: key,
    });
    expect(select).toHaveBeenCalledTimes(1);
    const rejected = await handleOpenclawChat(gateway, {
      message: 'change',
      session_id: key,
      model: 'p/other',
    });
    expect(rejected.isError).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('returns Gateway rejection and never starts inference', async () => {
    const gateway = new OpenClawGateway(config);
    vi.spyOn(gateway, 'selectModel').mockRejectedValue(new Error('model not allowed'));
    const chat = vi.spyOn(gateway.getDefault(), 'chat');
    const result = await handleOpenclawChat(gateway, { message: 'hello', model: 'p/denied' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('model not allowed');
    expect(chat).not.toHaveBeenCalled();
  });
  it('resolves default and rejects unknown agents before discovery', async () => {
    const gateway = new OpenClawGateway(config);
    vi.mocked(gatewayModelRequest).mockResolvedValue({ models: [] });
    expect((await handleOpenclawModels(gateway, {})).isError).not.toBe(true);
    expect(gatewayModelRequest).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ params: { agentId: 'main', view: 'configured' } })
    );
    vi.mocked(gatewayModelRequest).mockClear();
    expect((await handleOpenclawModels(gateway, { agent_id: 'missing' })).isError).toBe(true);
    expect(gatewayModelRequest).not.toHaveBeenCalled();
  });
});
