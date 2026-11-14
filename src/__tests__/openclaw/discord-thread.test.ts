import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscordService, loadDiscordConfig, type DiscordConfig } from '../../openclaw/discord.js';
import { threadInvoker, threadMemberAdder } from '../../openclaw/discord-thread.js';
import type { DiscordAgentRequest, DiscordAgentTransport } from '../../openclaw/discord-agent.js';
import { channelReader } from '../../openclaw/discord-read.js';
import { discordTools, handleDiscord } from '../../mcp/tools/discord.js';

const guild = '300000000000000001',
  channel = '300000000000000002',
  thread = '300000000000000003';
const owner = '400000000000000006';
const target = {
  name: 'work',
  guildId: guild,
  channelId: channel,
  accountId: 'bot',
  agentId: 'main',
  normalRouting: true,
};
const base: DiscordConfig = {
  threadCreationMode: 'classic',
  stateDir: '/unused-test-state',
  targets: [target],
  threadMember: { userId: owner, accountId: 'bot' },
  acknowledgeInboundRouting: true,
};
const gatewayConfig = { url: 'http://127.0.0.1:18789', token: 'mock-gateway-secret' };
const env = { DISCORD_BOT_TOKEN: 'mock-bot-secret' };
const input = {
  target: 'work',
  mode: 'new_thread',
  operation_id: 'thread-test-operation-1',
  title: 'Task',
  prompt: 'Help',
};
const envelope = (result: any) =>
  new Response(JSON.stringify({ ok: true, result: { details: result } }));
const dirs: string[] = [];
const services: DiscordService[] = [];
async function finished(service: DiscordService, input: any) {
  const result = await service.ask(input);
  await service.drain();
  return result.status === 'queued' ? service.status(input.operation_id) : result;
}
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.drain()));
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture(overrides: Partial<DiscordConfig> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'discord-thread-test-'));
  dirs.push(stateDir);
  const config = { ...base, ...overrides, stateDir };
  const events: string[] = [];
  const record = async () =>
    JSON.parse(await readFile(join(stateDir, input.operation_id + '.json'), 'utf8'));
  const gateway = vi.fn(async (_url: any, opts: any) => {
    if (String(_url).startsWith('https://discord.com/')) {
      events.push('starter-' + opts.method);
      if (opts.method === 'GET')
        expect(await record()).toMatchObject({ starter_message_id: thread, status: 'creating' });
      return new Response(
        JSON.stringify({
          id: thread,
          channel_id: channel,
          author: { id: owner, bot: true },
          content: input.title,
          flags: 4100,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
        })
      );
    }
    const args = JSON.parse(opts.body).args;
    if (args.action === 'permissions') {
      events.push(args.action);
      return envelope({
        ok: true,
        permissions: {
          channelId: channel,
          guildId: guild,
          channelType: 0,
          isDm: false,
          permissions: [
            'ViewChannel',
            'SendMessages',
            'ReadMessageHistory',
            'CreatePublicThreads',
            'SendMessagesInThreads',
          ],
        },
      });
    }
    if (args.action === 'thread-create' && args.messageId)
      expect(await record()).toMatchObject({
        starter_message_id: args.messageId,
        status: 'creating',
      });
    events.push(args.action);
    if (args.action === 'thread-create') return envelope({ ok: true, thread: { id: thread } });
    return envelope({
      ok: true,
      channel: {
        id: args.channelId,
        guild_id: guild,
        type: args.channelId === channel ? 0 : 11,
        parent_id: args.channelId === channel ? undefined : channel,
      },
    });
  });
  const member = vi.fn(async (_url: any, opts: any) => {
    events.push(opts.method);
    expect(await record()).toMatchObject({
      channel_id: thread,
      member_status: 'adding',
      member_verified: false,
    });
    return opts.method === 'PUT'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ id: thread, user_id: owner }));
  });
  const agent = {
    selectModel: vi.fn(async (_key: string, _model: string) => {}),
    ready: vi.fn(async () => {}),
    run: vi.fn(async (_request: DiscordAgentRequest) => {
      events.push('agent');
      expect(await record()).toMatchObject({
        member_status: config.threadMember ? 'verified' : 'disabled',
        status: 'running',
      });
      return { status: 'ok', runId: 'mock-run' };
    }),
    cancel: vi.fn(async () => {}),
  } satisfies DiscordAgentTransport;
  const service = () => {
    const instance = new DiscordService(
      config,
      undefined,
      undefined,
      channelReader(gatewayConfig, config, gateway),
      threadInvoker(gatewayConfig, config, gateway, env),
      threadMemberAdder(config, env, member),
      async (_t, _id, _prompt, _op, sent) => {
        events.push('publish');
        await sent('300000000000000004');
      },
      agent
    );
    services.push(instance);
    return instance;
  };
  return { config, events, gateway, member, agent, record, service: service(), restart: service };
}

describe('Classic new threads', () => {
  it('persists thread then verified owner membership before ordinary SDK turn; replay is read-only', async () => {
    const f = await fixture();
    const result = await finished(f.service, input);
    expect(result).toMatchObject({
      status: 'completed',
      channel_id: thread,
      member_status: 'verified',
      member_verified: true,
      thread_create_transport: 'gateway',
      session_key: 'agent:main:discord:channel:' + thread,
    });
    expect(f.events).toEqual([
      'channel-info',
      'thread-create',
      'channel-info',
      'PUT',
      'GET',
      'publish',
      'agent',
    ]);
    const [url, options] = f.gateway.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:18789/tools/invoke');
    expect(options.redirect).toBe('error');
    expect(options.headers.Authorization).toBe('Bearer mock-gateway-secret');
    expect(JSON.parse(options.body)).toEqual({
      tool: 'message',
      sessionKey: 'agent:main:main',
      idempotencyKey: input.operation_id,
      args: {
        action: 'thread-create',
        channel: 'discord',
        accountId: 'bot',
        channelId: channel,
        threadName: 'Task',
      },
    });
    expect(f.member.mock.calls.map((c) => c[0])).toEqual(
      Array(2).fill('https://discord.com/api/v10/channels/' + thread + '/thread-members/' + owner)
    );
    expect(f.member.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      redirect: 'error',
      headers: { Authorization: 'Bot mock-bot-secret' },
    });
    expect(f.agent.run.mock.calls[0][0]).toEqual({
      message: input.prompt,
      agentId: 'main',
      sessionKey: 'agent:main:discord:channel:' + thread,
      threadId: thread,
      accountId: 'bot',
      idempotencyKey: expect.any(String),
    });
    expect(f.agent.ready).toHaveBeenCalledOnce();
    expect(await f.restart().ask(input)).toEqual(result);
    expect(await f.service.status(input.operation_id)).toEqual(result);
    expect(f.gateway).toHaveBeenCalledTimes(3);
    expect(f.member).toHaveBeenCalledTimes(2);
    expect(f.agent.run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await f.record())).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('fails closed on proven pre-dispatch connection refusal without a second create', async () => {
    const f = await fixture();
    f.gateway.mockResolvedValueOnce(
      envelope({ ok: true, channel: { id: channel, guild_id: guild, type: 0 } })
    );
    f.gateway.mockRejectedValueOnce(
      Object.assign(new Error('private'), { cause: { code: 'ECONNREFUSED' } })
    );
    expect(await finished(f.service, input)).toMatchObject({
      status: 'creation_unknown',
      thread_create_transport: 'gateway',
      error_code: 'THREAD_GATEWAY_UNREACHABLE',
    });
    expect(f.gateway).toHaveBeenCalledTimes(2);
    expect(f.agent.run).not.toHaveBeenCalled();
    expect(f.member).not.toHaveBeenCalled();
    expect(await f.restart().ask(input)).toMatchObject({
      error_code: 'THREAD_GATEWAY_UNREACHABLE',
    });
    expect(f.gateway).toHaveBeenCalledTimes(2);
  });
  it('uses the Gateway create adapter without membership when not configured', async () => {
    const f = await fixture({ threadMember: undefined });
    expect(await finished(f.service, input)).toMatchObject({
      status: 'completed',
      thread_create_transport: 'gateway',
      member_status: 'disabled',
    });
    expect(f.events).toContain('thread-create');
    expect(f.member).not.toHaveBeenCalled();
    expect(f.agent.run).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 404, 429, 500, 'timeout', 'reset', 'malformed', 'denied'])(
    'never falls back after %s',
    async (failure) => {
      const f = await fixture();
      f.gateway.mockResolvedValueOnce(
        envelope({ ok: true, channel: { id: channel, guild_id: guild, type: 0 } })
      );
      if (typeof failure === 'number')
        f.gateway.mockResolvedValueOnce(new Response('private-secret', { status: failure }));
      else if (failure === 'malformed')
        f.gateway.mockResolvedValueOnce(new Response('private-secret'));
      else if (failure === 'denied')
        f.gateway.mockResolvedValueOnce(envelope({ ok: false, error: 'private-secret' }));
      else
        f.gateway.mockRejectedValueOnce(
          Object.assign(new Error('private-secret'), {
            code: failure === 'timeout' ? 'ETIMEDOUT' : 'ECONNRESET',
          })
        );
      const result = await finished(f.service, input);
      expect(result.status).toBe('creation_unknown');
      expect(JSON.stringify(result)).not.toContain('private-secret');
      expect(await f.restart().ask(input)).toEqual(result);
      expect(f.gateway).toHaveBeenCalledTimes(2);
      expect(f.agent.run).not.toHaveBeenCalled();
      expect(f.member).not.toHaveBeenCalled();
    }
  );
  it('does not downgrade when parent metadata is unavailable', async () => {
    const f = await fixture();
    f.gateway.mockRejectedValueOnce(new Error('refused'));
    expect(await finished(f.service, input)).toMatchObject({
      status: 'run_failed',
      error_code: 'GATEWAY_READ_FAILED',
    });
    expect(f.gateway).toHaveBeenCalledTimes(1);
    expect(f.agent.run).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'retains partial known thread, even failed envelope=%s',
    async (failed) => {
      const f = await fixture();
      f.gateway.mockResolvedValueOnce(
        envelope({ ok: true, channel: { id: channel, guild_id: guild, type: 0 } })
      );
      f.gateway.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: !failed,
            result: {
              isError: failed,
              details: { ok: !failed, thread: { id: thread }, partial: true },
            },
          })
        )
      );
      const result = await finished(f.service, input);
      expect(result).toMatchObject({
        status: 'creation_partial',
        channel_id: thread,
        discord_url: expect.stringContaining(thread),
        member_verified: false,
      });
      expect(await f.restart().ask(input)).toEqual(result);
      expect(f.agent.run).not.toHaveBeenCalled();
      expect(f.member).not.toHaveBeenCalled();
    }
  );
  it.each([{ parent_id: guild }, { guild_id: channel }, { type: 0 }])(
    'verifies ancestry before membership %j',
    async (override) => {
      const f = await fixture();
      f.gateway.mockResolvedValueOnce(
        envelope({ ok: true, channel: { id: channel, guild_id: guild, type: 0 } })
      );
      f.gateway.mockResolvedValueOnce(envelope({ ok: true, thread: { id: thread } }));
      f.gateway.mockResolvedValueOnce(
        envelope({
          ok: true,
          channel: { id: thread, guild_id: guild, type: 11, parent_id: channel, ...override },
        })
      );
      expect(await finished(f.service, input)).toMatchObject({
        status: 'run_failed',
        channel_id: thread,
        member_verified: false,
      });
      expect(f.member).not.toHaveBeenCalled();
      expect(f.agent.run).not.toHaveBeenCalled();
    }
  );
  it.each(['put-denied', 'put-timeout', 'get-absent', 'get-wrong-user', 'get-malformed'])(
    'retains link and separate unverified membership on %s',
    async (failure) => {
      const f = await fixture();
      if (failure === 'put-timeout') f.member.mockRejectedValueOnce(new Error('mock-bot-secret'));
      else if (failure === 'put-denied')
        f.member.mockResolvedValueOnce(new Response('mock-bot-secret', { status: 403 }));
      else {
        f.member.mockResolvedValueOnce(new Response(null, { status: 204 }));
        f.member.mockResolvedValueOnce(
          failure === 'get-absent'
            ? new Response('private', { status: 404 })
            : failure === 'get-malformed'
              ? new Response('private')
              : new Response(JSON.stringify({ id: thread, user_id: channel }))
        );
      }
      const result = await finished(f.service, input);
      expect(result).toMatchObject({
        status: 'run_failed',
        channel_id: thread,
        discord_url: expect.stringContaining(thread),
        member_status: 'unknown',
        member_verified: false,
        member_error_code: expect.stringContaining('THREAD_MEMBER_'),
        error_code: 'THREAD_MEMBER_NOT_VERIFIED',
      });
      expect(await f.restart().ask(input)).toEqual(result);
      expect(f.agent.run).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(f.member).toHaveBeenCalledTimes(failure.startsWith('put') ? 1 : 2);
    }
  );
});

describe('Silent starter threads', () => {
  it('defaults to a verified silent title starter without duplicating the prompt', async () => {
    const f = await fixture({ threadCreationMode: undefined });
    const result = await finished(f.service, input);
    expect(result).toMatchObject({
      status: 'completed',
      starter_message_id: thread,
      channel_id: thread,
    });
    expect(f.events).toEqual([
      'channel-info',
      'permissions',
      'starter-POST',
      'starter-GET',
      'thread-create',
      'channel-info',
      'PUT',
      'GET',
      'publish',
      'agent',
    ]);
    const post = f.gateway.mock.calls.find(
      ([url, opts]) => String(url).startsWith('https://discord.com/') && opts.method === 'POST'
    )!;
    expect(JSON.parse(post[1].body)).toEqual({
      content: input.title,
      flags: 4100,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
      nonce: expect.any(String),
      enforce_nonce: true,
    });
    expect(JSON.parse(post[1].body).nonce.length).toBeLessThanOrEqual(25);
    const create = f.gateway.mock.calls
      .map(([, opts]) => opts.body && JSON.parse(opts.body))
      .find((body) => body?.args?.action === 'thread-create');
    expect(create.args.messageId).toBe(thread);
    const calls = f.gateway.mock.calls.length;
    expect(await f.restart().ask(input)).toEqual(result);
    expect(f.gateway).toHaveBeenCalledTimes(calls);
  });
  it.each(['permissions', 'readback', 'create-timeout'])(
    'stops safely on %s and never repeats effects on replay',
    async (failure) => {
      const f = await fixture({ threadCreationMode: 'silent-starter' });
      const original = f.gateway.getMockImplementation()!;
      f.gateway.mockImplementation(async (url, opts) => {
        const args = opts.body && JSON.parse(opts.body).args;
        if (failure === 'permissions' && args?.action === 'permissions')
          return envelope({
            ok: true,
            permissions: {
              channelId: channel,
              guildId: guild,
              channelType: 0,
              isDm: false,
              permissions: [],
            },
          });
        if (
          failure === 'readback' &&
          String(url).startsWith('https://discord.com/') &&
          opts.method === 'GET'
        )
          return new Response(JSON.stringify({ flags: 4 }));
        if (failure === 'create-timeout' && args?.action === 'thread-create')
          throw new Error('timeout');
        return original(url, opts);
      });
      const result = await finished(f.service, input);
      expect(result.status).not.toBe('completed');
      expect(f.agent.run).not.toHaveBeenCalled();
      if (failure === 'permissions') expect(f.events).not.toContain('starter-POST');
      else expect(await f.record()).toMatchObject({ starter_message_id: thread });
      if (failure === 'readback') expect(f.events).not.toContain('thread-create');
      const calls = f.gateway.mock.calls.length;
      expect(await f.restart().ask(input)).toEqual(result);
      expect(f.gateway).toHaveBeenCalledTimes(calls);
    }
  );
});

describe('operator configuration and closed inputs', () => {
  it('requires explicit opt-in with bounded configuration and credentials', () => {
    const vars = {
      MCP_DISCORD_ENABLED: 'true',
      MCP_DISCORD_STATE_DIR: '/unused-test-state',
      MCP_DISCORD_TARGETS: JSON.stringify([target]),
    };
    expect(loadDiscordConfig(vars)).toMatchObject({
      threadMember: undefined,
      threadCreationMode: 'silent-starter',
    });
    expect(
      loadDiscordConfig({ ...vars, MCP_DISCORD_THREAD_CREATION_MODE: 'classic' })
        ?.threadCreationMode
    ).toBe('classic');
    expect(() =>
      loadDiscordConfig({ ...vars, MCP_DISCORD_THREAD_CREATION_MODE: 'invalid' })
    ).toThrow('THREAD_CREATION_MODE_INVALID');
    expect(threadInvoker(gatewayConfig, base)).toEqual(expect.any(Function));
    expect(threadMemberAdder({ ...base, threadMember: undefined }, env)).toBeUndefined();
    expect(() =>
      loadDiscordConfig({ ...vars, MCP_DISCORD_THREAD_MEMBER_ENABLED: 'true' })
    ).toThrow();
    expect(() => threadMemberAdder(base, {})).toThrow('THREAD_MEMBER_CREDENTIAL_MISSING');
    expect(() =>
      threadMemberAdder({ ...base, threadMember: { userId: '../escape', accountId: 'bot' } }, env)
    ).toThrow('THREAD_MEMBER_CONFIGURATION_INVALID');
    expect(() =>
      loadDiscordConfig({
        ...vars,
        MCP_DISCORD_THREAD_MEMBER_ENABLED: 'true',
        MCP_DISCORD_THREAD_MEMBER_USER_ID: owner,
        MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID: 'other',
      })
    ).toThrow('THREAD_MEMBER_ACCOUNT_MISMATCH');
    expect(
      loadDiscordConfig({
        ...vars,
        MCP_DISCORD_THREAD_MEMBER_ENABLED: 'true',
        MCP_DISCORD_THREAD_MEMBER_USER_ID: owner,
        MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID: 'bot',
      })?.threadMember
    ).toEqual({ userId: owner, accountId: 'bot' });
    for (const gateway of [
      { ...gatewayConfig, token: undefined },
      { ...gatewayConfig, token: '' },
      { ...gatewayConfig, url: 'http://remote.invalid' },
    ])
      expect(() => threadInvoker(gateway, base)).toThrow();
  });
  it.each(['userId', 'token', 'url', 'args', 'accountId', 'threadCreateMode'])(
    'rejects client override %s before effects',
    async (key) => {
      const f = await fixture();
      expect(
        (await handleDiscord(f.service, 'openclaw_discord_ask', { ...input, [key]: 'untrusted' }))
          .isError
      ).toBe(true);
      expect(f.gateway).not.toHaveBeenCalled();
      expect(f.member).not.toHaveBeenCalled();
    }
  );
  it('enforces service provenance on both adapters and ask without stripping identity', async () => {
    const f = await fixture();
    vi.stubEnv('OPENCLAW_CALLER_ID', 'agent');
    await expect(f.service.ask(input)).rejects.toThrow('AGENT_PROVENANCE_DENIED');
    await expect(
      threadInvoker(gatewayConfig, base, f.gateway)!(target, 'Task', input.operation_id)
    ).rejects.toThrow('AGENT_PROVENANCE_DENIED');
    await expect(threadMemberAdder(base, env, f.member)!(target, thread)).rejects.toThrow(
      'AGENT_PROVENANCE_DENIED'
    );
    expect(process.env.OPENCLAW_CALLER_ID).toBe('agent');
    expect(f.gateway).not.toHaveBeenCalled();
    expect(f.member).not.toHaveBeenCalled();
  });
  it('rejects unconfigured gateway/member account mappings', async () => {
    const f = await fixture();
    await expect(
      threadInvoker(gatewayConfig, base, f.gateway)!(
        { ...target, channelId: thread },
        'Task',
        input.operation_id
      )
    ).rejects.toThrow('THREAD_SCOPE_DENIED');
    await expect(
      threadMemberAdder(base, env, f.member)!({ ...target, accountId: 'other' }, thread)
    ).rejects.toThrow('THREAD_MEMBER_SCOPE_DENIED');
    await expect(
      threadMemberAdder(base, env, f.member)!({ ...target, guildId: channel }, thread)
    ).rejects.toThrow('THREAD_MEMBER_SCOPE_DENIED');
    expect(f.gateway).not.toHaveBeenCalled();
    expect(f.member).not.toHaveBeenCalled();
  });
  it('describes handoff and expected absence of answer text without changing input schema', () => {
    const tool = discordTools.find((t) => t.name === 'openclaw_discord_ask')!;
    expect(tool.description).toContain('not answer content');
    expect(tool.description).toContain('Does not wait for generation');
    expect(tool.description).toContain('only the Discord link');
    expect(tool.description).toContain('unless explicitly requested');
    expect(tool.description).toContain('report errors or partial/unknown outcomes');
    expect((tool.inputSchema.properties?.prompt as { description: string }).description).toContain(
      'original request to forward unchanged'
    );
    expect(Object.keys(tool.inputSchema.properties!)).toEqual([
      'agent_id',
      'target',
      'operation_id',
      'mode',
      'model',
      'title',
      'prompt',
    ]);
  });
});

describe('new-thread model selection', () => {
  it('pins before publishing or running and includes model in replay identity', async () => {
    const f = await fixture();
    const select = vi.fn(async () => {
      expect(f.events).not.toContain('publish');
      expect(f.agent.run).not.toHaveBeenCalled();
    });
    f.agent.selectModel = select;
    const args = { ...input, model: 'p/m' };
    const result = await finished(f.service, args);
    expect(result).toMatchObject({ status: 'completed', model: 'p/m' });
    expect(select).toHaveBeenCalledWith('agent:main:discord:channel:' + thread, 'p/m');
    await f.service.ask(args);
    expect(select).toHaveBeenCalledTimes(1);
    await expect(f.service.ask({ ...args, model: 'p/other' })).rejects.toThrow(
      'different arguments'
    );
  });
  it('reports model rejection without a request or run, and reply cannot set model', async () => {
    const f = await fixture();
    f.agent.selectModel = vi.fn().mockRejectedValue(new Error('model not allowed'));
    const result = await finished(f.service, { ...input, model: 'p/denied' });
    expect(result).toMatchObject({
      status: 'run_failed',
      error_code: 'MODEL_SELECTION_FAILED',
      model_error: 'model not allowed',
    });
    expect(f.events).not.toContain('publish');
    expect(f.agent.run).not.toHaveBeenCalled();
    await expect(
      f.service.reply({
        target: 'work',
        channel_id: thread,
        operation_id: 'reply-model-denied',
        prompt: 'hi',
        model: 'p/m',
      })
    ).rejects.toThrow('REPLY_ARGUMENTS_INVALID');
  });
});
