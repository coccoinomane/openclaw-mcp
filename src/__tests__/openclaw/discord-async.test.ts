import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscordService, loadDiscordConfig, type DiscordConfig } from '../../openclaw/discord.js';
import { DiscordError } from '../../openclaw/discord-channels.js';
import { requestPublisher } from '../../openclaw/discord-request.js';

const guild = '400000000000000001',
  parent = '400000000000000002',
  thread = '400000000000000003',
  message = '400000000000000004';
const target = {
  name: 'work',
  guildId: guild,
  channelId: parent,
  accountId: 'bot',
  agentId: 'main',
  normalRouting: true,
};
const input = {
  mode: 'new_thread',
  target: 'work',
  operation_id: 'async-operation-0001',
  title: 'Task',
  prompt: '  exact @everyone <@400000000000000006> 😀\ntrailing  ',
};
const fixtures: Array<{
  generation: ReturnType<typeof deferred<any>>;
  service: DiscordService;
  dir: string;
}> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.generation.resolve({ status: 'ok' });
    await f.service.drain();
    await rm(f.dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'discord-async-'));
  const config: DiscordConfig = {
    executable: 'never-run',
    stateDir: dir,
    targets: [target],
    acknowledgeInboundRouting: true,
    gatewayReadsEnabled: true,
    cliGatewayInstance: 'home',
    threadCreateMode: 'gateway',
    threadMember: { userId: '400000000000000006', accountId: 'bot' },
    maxOperations: 1,
  };
  const events: string[] = [];
  const generation = deferred<any>();
  const started = deferred<void>();
  let promptFile = '';
  const runner = vi.fn(async (_e: string, args: string[]) => {
    events.push('agent');
    promptFile = args[args.indexOf('--message-file') + 1];
    started.resolve();
    return generation.promise;
  });
  const reader = vi.fn(async (_t: any, req: any) => ({
    channel: {
      id: req.channelId,
      guild_id: guild,
      parent_id: req.channelId === parent ? undefined : parent,
      type: req.channelId === parent ? 0 : 11,
    },
  }));
  const create = vi.fn(async () => {
    events.push('create');
    return { thread: { id: thread } };
  });
  const member = vi.fn(async () => {
    events.push('member');
  });
  const publish = vi.fn(
    async (_t: any, _id: string, _p: string, _op: string, sent: (id: string) => Promise<void>) => {
      events.push('publish');
      await sent(message);
    }
  );
  const make = () =>
    new DiscordService(config, runner, undefined, undefined, reader, create, member, publish);
  const service = make();
  const result = {
    dir,
    config,
    events,
    generation,
    started,
    runner,
    reader,
    create,
    member,
    publish,
    service,
    make,
    promptFile: () => promptFile,
  };
  fixtures.push(result);
  return result;
}
describe('service-owned asynchronous handoff', () => {
  it('returns queued link before deferred generation, publishes first, preserves exact prompt once, then completes', async () => {
    const f = await fixture();
    const accepted = await f.service.ask(input);
    expect(accepted).toMatchObject({
      status: 'queued',
      generation_status: 'queued',
      request_status: 'verified',
      request_verified: true,
      request_message_ids: [message],
      member_verified: true,
      discord_url: expect.stringContaining(thread),
    });
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.events).toEqual(['create', 'member', 'publish']);
    expect(f.publish.mock.calls[0][2]).toBe(input.prompt);
    expect(accepted.handoff).toContain('first response not confirmed');
    await f.started.promise;
    expect(await readFile(f.promptFile(), 'utf8')).toBe(input.prompt);
    expect((await stat(f.promptFile())).mode & 0o777).toBe(0o600);
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'running',
      generation_status: 'running',
    });
    expect(await f.service.ask(input)).toMatchObject({ status: 'running' });
    f.generation.resolve({ status: 'ok', runId: 'one-run' });
    await f.service.drain();
    expect(await f.service.status(input.operation_id)).toMatchObject({
      status: 'completed',
      run_id: 'one-run',
    });
    await expect(stat(f.promptFile())).rejects.toThrow();
    expect(f.runner).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    const record = await readFile(join(f.dir, input.operation_id + '.json'), 'utf8');
    expect(record).not.toContain(input.prompt);
    expect(JSON.stringify(accepted)).not.toContain('owner');
    expect(JSON.stringify(accepted)).not.toContain('fingerprint');
  });
  it('keeps accepted work after caller abandons response; rejects backlog before mutation and drains at shutdown', async () => {
    const f = await fixture();
    const abandoned = f.service.ask(input); // no request-owned abort signal or worker
    await f.started.promise;
    await abandoned;
    await expect(f.service.ask({ ...input, operation_id: 'async-operation-0002' })).rejects.toThrow(
      'OPERATION_CAPACITY'
    );
    expect(f.create).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = f.service.shutdown().then(() => {
      stopped = true;
    });
    await expect(f.service.ask({ ...input, operation_id: 'async-operation-0003' })).rejects.toThrow(
      'SERVICE_STOPPING'
    );
    expect(stopped).toBe(false);
    f.generation.resolve({ status: 'ok' });
    await shutdown;
    expect(stopped).toBe(true);
    expect(await f.service.ask(input)).toMatchObject({ status: 'completed' });
  });
  it.each(['failed', 'unknown', 'partial'])(
    'never generates after publication %s; replay is read-only',
    async (kind) => {
      const f = await fixture();
      f.publish.mockImplementationOnce(async (_t, _id, _p, _op, sent) => {
        if (kind === 'partial') await sent(message);
        throw new DiscordError('REQUEST_TEST_FAILED', kind !== 'failed');
      });
      const result = await f.service.ask(input);
      expect(result).toMatchObject({
        status: 'run_failed',
        request_status: kind,
        request_verified: false,
      });
      expect(await f.make().ask(input)).toEqual(result);
      expect(f.runner).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.publish).toHaveBeenCalledTimes(1);
    }
  );
  it('fails closed across restart without rewriting or replaying interrupted operations', async () => {
    const f = await fixture();
    await f.service.ask(input);
    await f.started.promise;
    const path = join(f.dir, input.operation_id + '.json');
    const before = await readFile(path, 'utf8');
    const restarted = f.make();
    expect(await restarted.status(input.operation_id)).toMatchObject({
      status: 'run_unknown',
      error_code: 'OPERATION_INTERRUPTED',
    });
    expect(await restarted.ask(input)).toMatchObject({ status: 'run_unknown' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(f.runner).toHaveBeenCalledTimes(1);
    f.generation.resolve({ status: 'ok' });
    await f.service.drain();
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.status = 'queued';
    record.request_status = 'publishing';
    await writeFile(path, JSON.stringify(record));
    expect(await restarted.status(input.operation_id)).toMatchObject({
      status: 'run_unknown',
      request_status: 'unknown',
    });
  });
  it('owns and records deferred runner rejection without an unhandled promise', async () => {
    const f = await fixture();
    await f.service.ask(input);
    await f.started.promise;
    f.generation.reject(new Error('private credential'));
    await f.service.drain();
    const result = await f.service.status(input.operation_id);
    expect(result).toMatchObject({ status: 'run_unknown', error_code: 'UNVERIFIED_RESULT' });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('claims simultaneous same-ID callers once and keeps the worker visible', async () => {
    const f = await fixture();
    await Promise.allSettled([f.service.ask(input), f.service.ask(input)]);
    await f.started.promise;
    expect(await f.service.status(input.operation_id)).toMatchObject({ status: 'running' });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });
  it('fails closed without a publisher before creating a thread', async () => {
    const f = await fixture();
    const service = new DiscordService(
      f.config,
      f.runner,
      undefined,
      undefined,
      f.reader,
      f.create,
      f.member
    );
    expect(await service.ask(input)).toMatchObject({
      status: 'run_failed',
      error_code: 'REQUEST_PUBLISHER_REQUIRED',
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('rejects invalid unicode before any create', async () => {
    const f = await fixture();
    await expect(f.service.ask({ ...input, prompt: '\ud800' })).rejects.toThrow('Invalid prompt');
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe('closed request publication', () => {
  async function publisherFixture(prompt = input.prompt, name?: string) {
    const f = await fixture();
    f.config.forwardingRequesterName = name;
    let posted: any;
    const http = vi.fn(async (_url: any, opts: any) => {
      if (opts.method === 'POST') {
        const multipart = opts.body instanceof FormData;
        const body = JSON.parse(multipart ? opts.body.get('payload_json') : opts.body);
        if (multipart) expect(await opts.body.get('files[0]').text()).toBe(prompt);
        expect(body.allowed_mentions).toEqual({
          parse: [],
          users: [],
          roles: [],
          replied_user: false,
        });
        posted = {
          id: message,
          channel_id: thread,
          author: { id: '400000000000000005', bot: true },
          content: body.content,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: multipart
            ? [{ filename: 'richiesta.txt', size: new TextEncoder().encode(prompt).length }]
            : [],
        };
      }
      return new Response(JSON.stringify(posted));
    });
    return {
      ...f,
      http,
      send: requestPublisher(f.config, { DISCORD_BOT_TOKEN: 'mock-token' }, http)!,
    };
  }
  it.each([
    input.prompt,
    '  Testo originale\ncon spazi  ',
    'x'.repeat(2000),
    'x'.repeat(2001),
    '😀漢字\n '.repeat(1000),
  ])('publishes exact inline or file text, suppresses mentions, reads exact ID', async (prompt) => {
    const f = await publisherFixture(prompt);
    const sent = vi.fn(async () => {});
    await f.send(target, thread, prompt, input.operation_id, sent, true);
    expect(sent).toHaveBeenCalledWith(message);
    expect(f.http).toHaveBeenCalledTimes(2);
    expect(f.http.mock.calls[0][0]).toBe(
      'https://discord.com/api/v10/channels/' + thread + '/messages'
    );
    expect(f.http.mock.calls[1][0]).toBe(
      'https://discord.com/api/v10/channels/' + thread + '/messages/' + message
    );
    expect(f.http.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bot mock-token' },
    });
    const body = f.http.mock.calls[0][1].body;
    if (prompt.length <= 2000) {
      expect(typeof body).toBe('string');
      expect(JSON.parse(body).content).toBe(prompt);
    } else {
      expect(body).toBeInstanceOf(FormData);
      expect(JSON.parse(body.get('payload_json')).content).toBe('');
      expect(await body.get('files[0]').text()).toBe(prompt);
    }
  });
  const header = '**Forwarding sample\\-owner’s request**';
  it.each([
    input.prompt,
    'x'.repeat(2000 - header.length - 2),
    'x'.repeat(2001 - header.length - 2),
    '😀'.repeat(Math.floor((2000 - header.length - 2) / 2)),
    '😀'.repeat(Math.ceil((2001 - header.length - 2) / 2)),
    '😀漢字\n '.repeat(1000),
  ])('counts the escaped header and separator toward the UTF-16 limit', async (prompt) => {
    const f = await publisherFixture(prompt, 'sample-owner');
    const expectedHeader = header;
    await f.send(target, thread, prompt, input.operation_id, async () => {}, true);
    const body = f.http.mock.calls[0][1].body;
    if ((expectedHeader + '\n\n' + prompt).length <= 2000) {
      expect(JSON.parse(body).content).toBe(expectedHeader + '\n\n' + prompt);
    } else {
      expect(body).toBeInstanceOf(FormData);
      expect(JSON.parse(body.get('payload_json')).content).toBe(expectedHeader);
      expect(await body.get('files[0]').text()).toBe(prompt);
    }
    expect(f.http).toHaveBeenCalledTimes(2);
  });
  it('escapes markdown and mention syntax only in the trusted name', async () => {
    const f = await publisherFixture(
      input.prompt,
      '**Owner**_<@123> [x](url) \u0060code\u0060 | @everyone'
    );
    await f.send(target, thread, input.prompt, input.operation_id, async () => {}, true);
    expect(JSON.parse(f.http.mock.calls[0][1].body).content).toBe(
      '**Forwarding \\*\\*Owner\\*\\*\\_\\<@\u200b123\\> \\[x\\]\\(url\\) \\\u0060code\\\u0060 \\| @\u200beveryone’s request**\n\n' +
        input.prompt
    );
  });
  it.each([2000, 2001])(
    'keeps existing-thread publication unchanged at %i units',
    async (length) => {
      const prompt = 'x'.repeat(length);
      const f = await publisherFixture(prompt, 'owner');
      await f.send(target, thread, prompt, input.operation_id, async () => {}, false);
      const body = f.http.mock.calls[0][1].body;
      if (length === 2000) expect(JSON.parse(body).content).toBe(prompt);
      else {
        expect(JSON.parse(body.get('payload_json')).content).toBe('');
        expect(await body.get('files[0]').text()).toBe(prompt);
      }
    }
  );
  it('does not republish a legacy journal record after enabling the header', async () => {
    const f = await publisherFixture();
    await f.service.ask(input);
    f.generation.resolve({ status: 'ok' });
    await f.service.drain();
    f.config.forwardingRequesterName = 'owner';
    const service = new DiscordService(
      f.config,
      f.runner,
      undefined,
      undefined,
      f.reader,
      f.create,
      f.member,
      requestPublisher(f.config, { DISCORD_BOT_TOKEN: 'mock-token' }, f.http)
    );
    expect(await service.ask(input)).toMatchObject({ status: 'completed', request_verified: true });
    expect(f.http).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.runner).toHaveBeenCalledTimes(1);
  });
  it.each(['content', 'filename', 'size'])(
    'rejects a mismatching long-request readback %s and retains the sent ID',
    async (field) => {
      const prompt = '😀'.repeat(1000);
      const f = await publisherFixture(prompt, 'owner');
      const original = f.http.getMockImplementation()!;
      f.http.mockImplementation(async (url, opts) => {
        const response = await original(url, opts);
        if (opts.method !== 'GET') return response;
        const message: any = await response.json();
        if (field === 'content') message.content = '';
        else message.attachments[0][field] = field === 'filename' ? 'other.txt' : 1;
        return Response.json(message);
      });
      const sent = vi.fn(async () => {});
      await expect(f.send(target, thread, prompt, input.operation_id, sent, true)).rejects.toThrow(
        'REQUEST_READBACK_UNVERIFIED'
      );
      expect(sent).toHaveBeenCalledWith(message);
      expect(f.http).toHaveBeenCalledTimes(2);
    }
  );
  it('adds one server header, leaves agent input unchanged and never republishes on restart', async () => {
    const f = await publisherFixture(input.prompt, 'owner');
    const make = () =>
      new DiscordService(
        f.config,
        f.runner,
        undefined,
        undefined,
        f.reader,
        f.create,
        f.member,
        f.send
      );
    const service = make();
    try {
      expect(await service.ask({ ...input, username: 'untrusted' })).toMatchObject({
        request_verified: true,
      });
      await f.started.promise;
      expect(await readFile(f.promptFile(), 'utf8')).toBe(input.prompt);
      expect(JSON.parse(f.http.mock.calls[0][1].body).content).toBe(
        '**Forwarding owner’s request**\n\n' + input.prompt
      );
      expect(await service.ask(input)).toMatchObject({ status: 'running' });
      f.generation.resolve({ status: 'ok' });
      await service.drain();
      // A later config change must not invalidate or replay the existing journal record.
      f.config.forwardingRequesterName = 'different';
      expect(await make().ask(input)).toMatchObject({
        status: 'completed',
        request_verified: true,
      });
      expect(f.http).toHaveBeenCalledTimes(2);
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.runner).toHaveBeenCalledTimes(1);
    } finally {
      f.generation.resolve({ status: 'ok' });
      await service.drain();
    }
  });
  it('loads only the operator name and accepts missing or empty configuration', () => {
    const env = {
      MCP_DISCORD_ENABLED: 'true',
      MCP_DISCORD_STATE_DIR: '/tmp/private-test-state',
      MCP_DISCORD_TARGETS: JSON.stringify([target]),
    };
    expect(loadDiscordConfig(env)?.forwardingRequesterName).toBeUndefined();
    expect(
      loadDiscordConfig({ ...env, MCP_DISCORD_FORWARDING_REQUESTER_NAME: '' })
        ?.forwardingRequesterName
    ).toBeUndefined();
    expect(
      loadDiscordConfig({ ...env, MCP_DISCORD_FORWARDING_REQUESTER_NAME: 'owner' })
        ?.forwardingRequesterName
    ).toBe('owner');
    for (const name of [' ', 'x'.repeat(101), 'owner\nother', '\ud800', 'owner\u202e']) {
      expect(() =>
        loadDiscordConfig({ ...env, MCP_DISCORD_FORWARDING_REQUESTER_NAME: name })
      ).toThrow('FORWARDING_REQUESTER_NAME_INVALID');
    }
  });
  it('rejects scope and provenance before dispatch', async () => {
    const f = await publisherFixture();
    await expect(
      f.send(
        { ...target, accountId: 'other' },
        thread,
        input.prompt,
        input.operation_id,
        async () => {}
      )
    ).rejects.toThrow('REQUEST_SCOPE_DENIED');
    vi.stubEnv('OPENCLAW_CALLER_ID', 'agent');
    await expect(
      f.send(target, thread, input.prompt, input.operation_id, async () => {})
    ).rejects.toThrow('AGENT_PROVENANCE_DENIED');
    expect(f.http).not.toHaveBeenCalled();
  });
  it.each([403, 429, 500, 'timeout', 'malformed'])(
    'does not retry publication %s or leak raw errors',
    async (failure) => {
      const f = await publisherFixture();
      if (typeof failure === 'number')
        f.http.mockResolvedValueOnce(new Response('secret', { status: failure }));
      else if (failure === 'timeout') f.http.mockRejectedValueOnce(new Error('secret'));
      else f.http.mockResolvedValueOnce(new Response('secret'));
      await expect(
        f.send(target, thread, input.prompt, input.operation_id, async () => {})
      ).rejects.toThrow(/^REQUEST_/);
      expect(f.http).toHaveBeenCalledTimes(1);
    }
  );
  it('rejects oversized publication responses without retries', async () => {
    const f = await publisherFixture();
    f.http.mockResolvedValueOnce(new Response('x'.repeat(65537)));
    await expect(
      f.send(target, thread, input.prompt, input.operation_id, async () => {})
    ).rejects.toThrow('REQUEST_RESULT_UNVERIFIED');
    expect(f.http).toHaveBeenCalledTimes(1);
  });
  it('retains known sent ID but fails verification when readback differs', async () => {
    const f = await publisherFixture();
    const original = f.http.getMockImplementation()!;
    f.http.mockImplementation(async (url, opts) =>
      opts.method === 'GET'
        ? new Response(JSON.stringify({ id: message, channel_id: parent }))
        : original(url, opts)
    );
    const sent = vi.fn(async () => {});
    await expect(f.send(target, thread, input.prompt, input.operation_id, sent)).rejects.toThrow(
      'REQUEST_READBACK_UNVERIFIED'
    );
    expect(sent).toHaveBeenCalledWith(message);
  });
});
