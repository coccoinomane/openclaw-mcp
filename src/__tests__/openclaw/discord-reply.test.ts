import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DiscordService,
  type DiscordConfig,
  type DiscordRouteResolver,
} from '../../openclaw/discord.js';
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
    executable: 'never-run',
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
    gatewayReadsEnabled: true,
    cliGatewayInstance: 'home',
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
    admitted: true,
    busy: false,
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
  const runner = vi.fn(async (_e: string, args: string[]) => {
    if (args[0] === 'message' && args[1] === 'permissions') return { permissions };
    if (args[0] !== 'agent') throw new Error('Unexpected CLI mutation');
    prompt = await readFile(args[args.indexOf('--message-file') + 1], 'utf8');
    started();
    return generation;
  });
  const reader = vi.fn(async (_t: any, req: any) => ({
    channel: req.channelId === parent ? { id: parent, guild_id: guild, type: 0 } : metadata,
  }));
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
    new DiscordService(config, runner, undefined, resolve, reader, undefined, undefined, publish);
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
    runner,
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
        runner,
        undefined,
        undefined,
        reader,
        undefined,
        undefined,
        publish
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
      const args = f.runner.mock.calls.find((c) => c[1][0] === 'agent')![1];
      expect(args).toContain('--session-key');
      expect(args[args.indexOf('--session-key') + 1]).toBe(f.route.sessionKey);
      expect(args).toContain('channel:' + thread);
      expect(args).not.toContain('--local');
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
      'admission denied',
      (f: any) => {
        f.route.admitted = false;
      },
    ],
    [
      'admission unknown',
      (f: any) => {
        delete f.route.admitted;
      },
    ],
    [
      'busy',
      (f: any) => {
        f.route.busy = true;
      },
    ],
    [
      'activity unknown',
      (f: any) => {
        delete f.route.busy;
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
    expect(f.runner.mock.calls.some((c) => c[1][0] === 'agent')).toBe(false);
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
  it('requires a live inspector rather than guessing from static normalRouting', async () => {
    const f = await fixture();
    expect(await f.withoutResolver().reply(input)).toMatchObject({
      error_code: 'ROUTE_INSPECTOR_REQUIRED',
    });
    expect(f.publish).not.toHaveBeenCalled();
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
    expect(f.runner.mock.calls.filter((c) => c[1][0] === 'agent')).toHaveLength(1);
    await expect(f.service.reply({ ...input, prompt: 'changed' })).rejects.toThrow(
      'different arguments'
    );
  });
  it('serializes distinct IDs for the same session across service instances', async () => {
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
    f.finish({ _cliFailure: true, _cliCode: 'CLI_TIMEOUT' });
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
    expect(f.runner.mock.calls.some((c) => c[1][0] === 'agent')).toBe(false);
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
      expect(f.runner.mock.calls.some((c) => c[1][0] === 'agent')).toBe(false);
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
    f.reader.mockImplementation(async (_t, req) => ({
      channel: req.channelId === parent ? { id: parent, guild_id: guild, type: 5 } : f.metadata,
    }));
    expect(await f.service.reply(input)).toMatchObject({ status: 'queued' });
    await f.running;
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('retains the claim when a dispatched CLI fails without proving the run ended', async () => {
    const f = await fixture();
    await f.service.reply(input);
    await f.running;
    f.finish({ _cliFailure: true, _cliCode: 'CLI_EXIT_NONZERO' });
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({ status: 'run_failed' });
    expect(await f.make().reply({ ...input, operation_id: 'reply-operation-0002' })).toMatchObject({
      error_code: 'SESSION_BUSY_OR_UNCERTAIN',
    });
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
});
