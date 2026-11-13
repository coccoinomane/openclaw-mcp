import { threadMemberAdder } from '../../openclaw/discord-thread.js';
import { requestPublisher } from '../../openclaw/discord-request.js';
import { channelReader } from '../../openclaw/discord-read.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DiscordService,
  type DiscordConfig,
  type DiscordRouteResolver,
} from '../../openclaw/discord.js';
import type { DiscordAgentRequest, DiscordAgentTransport } from '../../openclaw/discord-agent.js';
import { DiscordError } from '../../openclaw/discord-channels.js';
import { discordTools, handleDiscord } from '../../mcp/tools/discord.js';

const guild = '400000000000000001',
  parent = '400000000000000002',
  thread = '400000000000000003';
const input = {
  target: 'work',
  channel_id: thread,
  operation_id: 'reply-operation-0001',
  prompt: '  exact @everyone 😀\ntrailing  ',
};
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'discord-reply-'));
  const config: DiscordConfig = {
    stateDir: dir,
    targets: [
      {
        name: 'work',
        guildId: guild,
        channelId: parent,
        accountId: 'bot',
        agentId: 'main',
        normalRouting: true,
      },
    ],
    acknowledgeInboundRouting: true,
  };
  const metadata: any = {
    id: thread,
    guild_id: guild,
    parent_id: parent,
    type: 11,
    thread_metadata: { archived: false, locked: false },
  };
  const route: any = {
    channelId: thread,
    guildId: guild,
    accountId: 'bot',
    agentId: 'main',
    sessionKey: 'agent:main:discord:channel:' + thread,
    kind: 'ordinary',
  };
  const permissions: any = {
    channelId: thread,
    guildId: guild,
    channelType: 11,
    isDm: false,
    permissions: ['ViewChannel', 'SendMessagesInThreads', 'ReadMessageHistory', 'AttachFiles'],
  };
  let finish!: (value: unknown) => void;
  const generation = new Promise((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let prompt = '';
  const agent = {
    ready: vi.fn(async () => {}),
    run: vi.fn(async (request: DiscordAgentRequest) => {
      prompt = request.message;
      started();
      return generation;
    }),
    cancel: vi.fn(async () => {}),
  } satisfies DiscordAgentTransport;
  const createThread = vi.fn(async () => ({ thread: { id: thread } }));
  const reader = vi.fn(async (_t: any, req: any) =>
    req.action === 'permissions'
      ? { permissions }
      : { channel: req.channelId === parent ? { id: parent, guild_id: guild, type: 0 } : metadata }
  );
  const resolver = vi.fn<DiscordRouteResolver>(async () => route);
  const publish = vi.fn(
    async (
      _t: any,
      _id: string,
      _prompt: string,
      _op: string,
      sent: (id: string) => Promise<void>
    ) => {
      await sent('400000000000000004');
    }
  );
  const make = (resolve: DiscordRouteResolver | undefined = resolver) =>
    new DiscordService(config, undefined, resolve, reader, createThread, undefined, publish, agent);
  const service = make();
  const others: DiscordService[] = [];
  cleanups.push(async () => {
    finish({ status: 'ok' });
    await Promise.all([service, ...others].map((s) => s.drain()));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    config,
    metadata,
    route,
    permissions,
    agent,
    createThread,
    reader,
    resolver,
    publish,
    service,
    running,
    finish,
    prompt: () => prompt,
    make: () => {
      const s = make();
      others.push(s);
      return s;
    },
    withoutResolver: () =>
      new DiscordService(
        config,
        undefined,
        undefined,
        reader,
        createThread,
        undefined,
        publish,
        agent
      ),
  };
}
describe('existing public thread replies', () => {
  it.each([false, true])(
    'queues exact request in same ordinary session; archived=%s',
    async (archived) => {
      const f = await fixture();
      f.metadata.thread_metadata.archived = archived;
      const result = await f.service.reply(input);
      expect(result).toMatchObject({
        kind: 'thread_reply',
        status: 'queued',
        request_verified: true,
        channel_id: thread,
        session_key: f.route.sessionKey,
        member_status: 'disabled',
        discord_url: 'https://discord.com/channels/' + guild + '/' + thread,
      });
      expect(f.publish.mock.calls[0].slice(1, 4)).toEqual([
        thread,
        input.prompt,
        input.operation_id,
      ]);
      await f.running;
      expect(f.prompt()).toBe(input.prompt);
      expect(f.agent.run.mock.calls[0][0]).toEqual({
        message: input.prompt,
        agentId: 'main',
        sessionKey: f.route.sessionKey,
        threadId: thread,
        accountId: 'bot',
        idempotencyKey: expect.any(String),
      });
      expect(f.createThread).not.toHaveBeenCalled();
      f.finish({ status: 'ok', runId: 'one' });
      await f.service.drain();
      expect(await f.service.reply(input)).toMatchObject({ status: 'completed', run_id: 'one' });
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect((await readdir(f.dir)).filter((p) => p.endsWith('.lock'))).toEqual([]);
    }
  );
  it.each([
    [
      'locked',
      (f: any) => {
        f.metadata.thread_metadata.locked = true;
      },
    ],
    [
      'private',
      (f: any) => {
        f.metadata.type = 12;
      },
    ],
    [
      'unsupported',
      (f: any) => {
        f.metadata.type = 2;
      },
    ],
    [
      'wrong guild',
      (f: any) => {
        f.metadata.guild_id = parent;
      },
    ],
    [
      'wrong parent',
      (f: any) => {
        f.metadata.parent_id = guild;
      },
    ],
    [
      'unknown archive',
      (f: any) => {
        delete f.metadata.thread_metadata.archived;
      },
    ],
    [
      'missing permission',
      (f: any) => {
        f.permissions.permissions = ['ViewChannel'];
      },
    ],
    [
      'wrong permission destination',
      (f: any) => {
        f.permissions.channelId = parent;
      },
    ],
    [
      'bound',
      (f: any) => {
        f.route.kind = 'bound';
      },
    ],
    [
      'subagent',
      (f: any) => {
        f.route.kind = 'subagent';
      },
    ],
    [
      'unknown route',
      (f: any) => {
        f.route.kind = 'unknown';
      },
    ],
    [
      'wrong session',
      (f: any) => {
        f.route.sessionKey += ':thread:' + thread;
      },
    ],
    [
      'wrong agent',
      (f: any) => {
        f.route.agentId = 'other';
      },
    ],
    [
      'wrong account',
      (f: any) => {
        f.route.accountId = 'other';
      },
    ],
    [
      'routing exception',
      (f: any) => {
        f.resolver.mockRejectedValue(new Error('secret'));
      },
    ],
    [
      'routing acknowledgement',
      (f: any) => {
        f.config.acknowledgeInboundRouting = false;
      },
    ],
  ])('rejects %s before publication', async (_label, mutate) => {
    const f = await fixture();
    mutate(f);
    expect(await f.service.reply(input)).toMatchObject({
      status: 'run_failed',
      request_verified: false,
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.agent.run).not.toHaveBeenCalled();
    expect(f.createThread).not.toHaveBeenCalled();
  });
  it.each(['parent blacklist', 'thread blacklist', 'whitelist', 'guild scope'])(
    'rejects forbidden %s',
    async (kind) => {
      const f = await fixture();
      if (kind === 'parent blacklist') f.config.channelBlacklist = [parent];
      if (kind === 'thread blacklist') f.config.channelBlacklist = [thread];
      if (kind === 'whitelist') f.config.channelWhitelist = [guild];
      if (kind === 'guild scope') f.config.targets = [];
      const result = await handleDiscord(f.service, 'openclaw_discord_reply', input);
      expect(
        result.isError || (result.structuredContent as any)?.status === 'run_failed'
      ).toBeTruthy();
      expect(f.publish).not.toHaveBeenCalled();
    }
  );
  it('uses configured canonical routing without an optional resolver', async () => {
    const f = await fixture();
    const service = f.withoutResolver();
    expect(await service.reply(input)).toMatchObject({
      status: 'queued',
      session_key: f.route.sessionKey,
    });
    await f.running;
    expect(f.agent.run.mock.calls[0][0].sessionKey).toBe('agent:main:discord:channel:' + thread);
    expect(f.publish).toHaveBeenCalledTimes(1);
    f.finish({ status: 'ok' });
    await service.drain();
    expect(await service.reply(input)).toMatchObject({ status: 'completed' });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('rejects a parent ID and client-selected session, agent or transport fields', async () => {
    const f = await fixture();
    expect(await f.service.reply({ ...input, channel_id: parent })).toMatchObject({
      status: 'run_failed',
    });
    for (const key of ['session_key', 'agent', 'mode', 'title', 'account', 'url']) {
      expect(
        (await handleDiscord(f.service, 'openclaw_discord_reply', { ...input, [key]: 'spoof' }))
          .isError
      ).toBe(true);
    }
    expect(f.publish).not.toHaveBeenCalled();
    expect(
      discordTools.find((t) => t.name === 'openclaw_discord_reply')!.inputSchema
        .additionalProperties
    ).toBe(false);
  });
  it('rejects agent provenance without changing its environment', async () => {
    const f = await fixture();
    vi.stubEnv('OPENCLAW_CALLER_ID', 'agent');
    await expect(f.service.reply(input)).rejects.toThrow('AGENT_PROVENANCE_DENIED');
    expect(process.env.OPENCLAW_CALLER_ID).toBe('agent');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('claims concurrent repeated IDs once and rejects changed input', async () => {
    const f = await fixture();
    await Promise.allSettled([
      f.service.reply(input),
      f.service.reply(input),
      f.make().reply(input),
    ]);
    await f.running;
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.agent.run).toHaveBeenCalledTimes(1);
    await expect(f.service.reply({ ...input, prompt: 'changed' })).rejects.toThrow(
      'different arguments'
    );
  });
  it('serializes distinct IDs for the same session across service objects', async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.service.reply(input),
      f.make().reply({ ...input, operation_id: 'reply-operation-0002' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['queued', 'run_failed']);
    expect(results.find((r) => r.status === 'run_failed')?.error_code).toBe(
      'SESSION_BUSY_OR_UNCERTAIN'
    );
    await f.running;
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'unknown', 'partial'])('never replays publication %s', async (kind) => {
    const f = await fixture();
    f.publish.mockImplementationOnce(async (_t, _id, _p, _op, sent) => {
      if (kind === 'partial') await sent('400000000000000004');
      throw new DiscordError('REQUEST_TEST_FAILED', kind !== 'failed');
    });
    const result = await f.service.reply(input);
    expect(result).toMatchObject({ status: 'run_failed', request_status: kind });
    expect(await f.make().reply(input)).toEqual(result);
    expect(f.publish).toHaveBeenCalledTimes(1);
    if (kind !== 'failed')
      expect((await readdir(f.dir)).some((p) => p.endsWith('.lock'))).toBe(true);
  });
  it('retains session claim after uncertain execution and restart; no fresh-ID recovery', async () => {
    const f = await fixture();
    await f.service.reply(input);
    await f.running;
    expect(await f.make().reply(input)).toMatchObject({
      status: 'run_unknown',
      error_code: 'OPERATION_INTERRUPTED',
    });
    f.finish({ status: 'unknown' });
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({ status: 'run_unknown' });
    expect(await f.make().reply({ ...input, operation_id: 'reply-operation-0002' })).toMatchObject({
      error_code: 'SESSION_BUSY_OR_UNCERTAIN',
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('rejects a corrupt operation record without effects', async () => {
    const f = await fixture();
    await writeFile(join(f.dir, input.operation_id + '.json'), '{');
    await expect(f.service.reply(input)).rejects.toThrow('operator recovery');
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('rechecks routing before generation after publication', async () => {
    const f = await fixture();
    f.publish.mockImplementationOnce(async (_t, _id, _p, _op, sent) => {
      await sent('400000000000000004');
      f.route.kind = 'bound';
    });
    expect(await f.service.reply(input)).toMatchObject({ status: 'queued' });
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'run_failed',
      error_code: 'NONORDINARY_ROUTE_DENIED',
      request_verified: true,
    });
    expect(f.agent.run).not.toHaveBeenCalled();
    expect(f.createThread).not.toHaveBeenCalled();
  });
  it.each(['locked', 'permissions', 'policy'])(
    'rechecks %s after publication before dispatch',
    async (kind) => {
      const f = await fixture();
      f.publish.mockImplementationOnce(async (_t, _id, _p, _op, sent) => {
        await sent('400000000000000004');
        if (kind === 'locked') f.metadata.thread_metadata.locked = true;
        if (kind === 'permissions') f.permissions.permissions = [];
        if (kind === 'policy') f.config.channelBlacklist = [thread];
      });
      expect(await f.service.reply(input)).toMatchObject({ status: 'queued' });
      await f.service.drain();
      const record = JSON.parse(await readFile(join(f.dir, input.operation_id + '.json'), 'utf8'));
      expect(record).toMatchObject({ status: 'run_failed', request_verified: true });
      expect(f.agent.run).not.toHaveBeenCalled();
      expect(f.createThread).not.toHaveBeenCalled();
    }
  );
  it('requires AttachFiles for long exact requests', async () => {
    const f = await fixture();
    f.permissions.permissions.pop();
    expect(await f.service.reply({ ...input, prompt: 'x'.repeat(2001) })).toMatchObject({
      error_code: 'THREAD_PERMISSIONS_DENIED',
    });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('accepts public announcement threads under announcement parents', async () => {
    const f = await fixture();
    f.metadata.type = 10;
    f.permissions.channelType = 10;
    f.reader.mockImplementation(async (_t, req) =>
      req.action === 'permissions'
        ? { permissions: f.permissions }
        : {
            channel:
              req.channelId === parent ? { id: parent, guild_id: guild, type: 5 } : f.metadata,
          }
    );
    expect(await f.service.reply(input)).toMatchObject({ status: 'queued' });
    await f.running;
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('retains the claim when a dispatched SDK run fails without proving the run ended', async () => {
    const f = await fixture();
    await f.service.reply(input);
    await f.running;
    f.finish({ status: 'error' });
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({ status: 'run_failed' });
    expect(await f.make().reply({ ...input, operation_id: 'reply-operation-0002' })).toMatchObject({
      error_code: 'SESSION_BUSY_OR_UNCERTAIN',
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'runs stock adapter composition without a route resolver; archived=%s',
    async (archived) => {
      const f = await fixture();
      f.metadata.thread_metadata.archived = archived;
      f.config.threadMember = { accountId: 'bot', userId: '400000000000000009' };
      f.config.forwardingRequesterName = 'owner';
      let posted: any;
      const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const address = String(url);
        if (address === 'http://127.0.0.1:18789/tools/invoke') {
          const body = JSON.parse(String(init?.body));
          expect(['channel-info', 'permissions']).toContain(body.args.action);
          return Response.json({
            ok: true,
            result: {
              details:
                body.args.action === 'permissions'
                  ? { ok: true, permissions: f.permissions }
                  : {
                      ok: true,
                      channel:
                        body.args.channelId === parent
                          ? { id: parent, guild_id: guild, type: 0 }
                          : f.metadata,
                    },
            },
          });
        }
        const base = 'https://discord.com/api/v10/channels/' + thread + '/messages';
        if (address === base && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          expect(posted.content).toBe(input.prompt);
          expect(posted.allowed_mentions).toEqual({
            parse: [],
            users: [],
            roles: [],
            replied_user: false,
          });
          expect(posted.flags).toBe(4 | 4096);
          expect(posted.enforce_nonce).toBe(true);
        } else if (address !== base + '/400000000000000004' || init?.method !== 'GET') {
          throw new Error('Unexpected network effect: ' + address);
        }
        return Response.json({
          id: '400000000000000004',
          channel_id: thread,
          content: posted.content,
          author: { id: '400000000000000008', bot: true },
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
        });
      });
      const service = new DiscordService(
        f.config,
        undefined,
        undefined,
        channelReader({ url: 'http://127.0.0.1:18789', token: 'test-only' }, f.config, network),
        f.createThread,
        threadMemberAdder(f.config, { DISCORD_BOT_TOKEN: 'test-only' }, network),
        requestPublisher(f.config, { DISCORD_BOT_TOKEN: 'test-only' }, network),
        f.agent
      );
      try {
        const result = await handleDiscord(service, 'openclaw_discord_reply', input);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: 'queued',
          session_key: f.route.sessionKey,
          request_verified: true,
        });
        await f.running;
        expect(f.prompt()).toBe(input.prompt);
        f.finish({ status: 'ok' });
        await service.drain();
        expect(await service.reply(input)).toMatchObject({ status: 'completed' });
        expect(
          network.mock.calls.filter(
            ([, init]) => init?.method === 'POST' && String(init.body).includes('allowed_mentions')
          )
        ).toHaveLength(1);
        expect(f.agent.run).toHaveBeenCalledTimes(1);
      } finally {
        f.finish({ status: 'ok' });
        await service.drain();
      }
    }
  );
});
