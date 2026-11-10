import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelCreation,
  DiscordError,
  channelInvoker,
  type CreationPolicy,
} from '../../openclaw/discord-channels.js';
import type { DiscordReader } from '../../openclaw/discord-read.js';
import type { DiscordAgentTransport } from '../../openclaw/discord-agent.js';
import { DiscordService, type DiscordConfig } from '../../openclaw/discord.js';
const guild = '200000000000000001',
  category = '200000000000000002',
  channel = '200000000000000003';
const policy: CreationPolicy = {
  name: 'projects',
  guildId: guild,
  categoryId: category,
  accountId: 'bot',
  agentId: 'main',
};
const input = {
  policy: 'projects',
  operation_id: 'create-operation-001',
  name: 'new-project',
  topic: 'Project notes',
  authorize_create: true,
  authorize_admission: true,
};
const dirs: string[] = [];
beforeEach(() => {
  // Mock-only tests; no real SDK or HTTP action is executed.
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'channel-create-test-'));
  dirs.push(dir);
  const inspect = vi.fn(async (_p: CreationPolicy, id: string) => ({
    id,
    guild_id: guild,
    parent_id: id === channel ? category : null,
    type: id === category ? 4 : 0,
    name: id === category ? 'Projects' : 'new-project',
    topic: 'Project notes',
  }));
  const invoke = vi.fn(async () => ({ ok: true, channel: { id: channel } }));
  return { dir, inspect, invoke, creation: new ChannelCreation(dir, [policy], invoke, inspect) };
}
describe('explicit channel creation', () => {
  it('creates once, admits persistently, and rejects changed arguments', async () => {
    const f = await fixture();
    const result = await f.creation.create(input);
    expect(result).toMatchObject({
      status: 'completed',
      target: 'created-' + channel,
    });
    expect(result.session_key).toBeUndefined();
    expect(f.inspect.mock.calls.map((c) => c[1])).toEqual([category, channel]);
    const restarted = new ChannelCreation(f.dir, [policy], f.invoke, f.inspect);
    expect(await restarted.create(input)).toEqual(result);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(await restarted.admitted()).toEqual([
      {
        name: 'created-' + channel,
        channelId: channel,
        guildId: guild,
        categoryId: category,
        agentId: 'main',
        accountId: 'bot',
      },
    ]);
    await expect(restarted.create({ ...input, name: 'different' })).rejects.toThrow(
      'OPERATION_CONFLICT'
    );
    expect(await new ChannelCreation(f.dir, [], f.invoke, f.inspect).admitted()).toEqual([]);
    expect(
      await new ChannelCreation(
        f.dir,
        [{ ...policy, accountId: 'other' }],
        f.invoke,
        f.inspect
      ).admitted()
    ).toEqual([]);
  });
  it('rejects duplicate creation policy names before constructing adapters', async () => {
    const f = await fixture();
    expect(
      () =>
        new DiscordService({
          stateDir: f.dir,
          targets: [],
          creationPolicies: [policy, { ...policy, agentId: 'writer' }],
          acknowledgeInboundRouting: true,
        })
    ).toThrow('DUPLICATE_CREATION_POLICY');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('does not dispatch concurrent duplicate creation', async () => {
    const f = await fixture();
    await Promise.allSettled([f.creation.create(input), f.creation.create(input)]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    { authorize_create: false },
    { authorize_admission: false },
    { policy: 'other' },
    { name: '--bad' },
    { operation_id: '../escape' },
  ])('rejects unapproved input %j before effects', async (invalid) => {
    const f = await fixture();
    await expect(f.creation.create({ ...input, ...invalid })).rejects.toThrow();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it('fails closed on category guild mismatch', async () => {
    const f = await fixture();
    f.inspect.mockResolvedValue({ id: category, guild_id: 'other', type: 4 } as any);
    expect(await f.creation.create(input)).toMatchObject({
      status: 'creation_rejected',
      error_code: 'CATEGORY_VERIFICATION_FAILED',
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('retains partial creation without admitting the channel', async () => {
    const f = await fixture();
    f.inspect.mockImplementation(
      async (_p, id) =>
        ({ id, guild_id: guild, type: id === category ? 4 : 0, parent_id: 'wrong' }) as any
    );
    expect(await f.creation.create(input)).toMatchObject({
      status: 'created_unadmitted',
      channel_id: channel,
    });
    expect(await f.creation.admitted()).toEqual([]);
    await f.creation.create(input);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    new DiscordError('GATEWAY_OUTCOME_UNKNOWN', true),
    new DiscordError('GATEWAY_HTTP_403'),
  ])('records uncertainty or known rejection without retry', async (error) => {
    const f = await fixture();
    f.invoke.mockRejectedValue(error);
    expect(await f.creation.create(input)).toMatchObject({
      status: error.uncertain ? 'creation_unknown' : 'creation_rejected',
      error_code: error.code,
    });
    await f.creation.create(input);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('does not replay interrupted creation after restart', async () => {
    const f = await fixture();
    await f.creation.create(input);
    const path = join(f.dir, input.operation_id + '.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.status = 'creating';
    await writeFile(path, JSON.stringify(record));
    f.invoke.mockClear();
    expect((await f.creation.create(input)).status).toBe('creating');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(await f.creation.admitted()).toEqual([]);
  });
  it('rejects agent provenance before HTTP or Gateway reads', async () => {
    const f = await fixture();
    vi.stubEnv('OPENCLAW_SHELL', 'exec');
    await expect(f.creation.create(input)).rejects.toThrow('AGENT_PROVENANCE_DENIED');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it('uses admitted channels for discovery after restart and denies remote continuation', async () => {
    const f = await fixture();
    const config: DiscordConfig = {
      stateDir: f.dir,
      targets: [],
      creationPolicies: [policy],
      acknowledgeInboundRouting: true,
    };
    const reader = vi.fn<DiscordReader>(async (_scope, request) =>
      request.action === 'channel-list'
        ? {
            ok: true,
            channels: await Promise.all([channel, category].map((id) => f.inspect(policy, id))),
          }
        : { channel: await f.inspect(policy, request.channelId) }
    );
    const createThread = vi.fn(async () => ({ thread: { id: channel } }));
    const agent = {
      ready: vi.fn(async () => {}),
      run: vi.fn(async () => ({ status: 'ok' })),
      cancel: vi.fn(async () => {}),
    } satisfies DiscordAgentTransport;
    const service = new DiscordService(
      config,
      f.invoke,
      undefined,
      reader,
      createThread,
      undefined,
      undefined,
      agent
    );
    await service.createChannel(input);
    const restarted = new DiscordService(
      config,
      f.invoke,
      async (t, id) => ({
        ...t,
        channelId: id,
        sessionKey: 'agent:' + t.agentId + ':discord:channel:' + id,
        kind: 'ordinary',
      }),
      reader,
      createThread,
      undefined,
      undefined,
      agent
    );
    const list = await restarted.channels();
    expect(list.channels[0]).toMatchObject({
      target: 'created-' + channel,
      topic: 'Project notes',
      category_name: 'Projects',
      category_id: category,
    });
    await expect(restarted.ask({ target: 'created-' + channel, mode: 'continue' })).rejects.toThrow(
      'CONTINUE_UNSUPPORTED'
    );
    f.inspect.mockImplementation(
      async (_p, id) => ({ id, guild_id: guild, type: 0, parent_id: 'moved' }) as any
    );
    await expect(restarted.channels()).rejects.toThrow('ADMITTED_CHANNEL_MOVED');
  });
  it('requires explicit Gateway and inbound routing acknowledgement', async () => {
    const f = await fixture();
    expect(
      () =>
        new DiscordService({ stateDir: f.dir, targets: [], creationPolicies: [policy] }, f.invoke)
    ).toThrow('CREATION_ROUTING_ACKNOWLEDGEMENT_REQUIRED');
  });
});
describe('closed Gateway adapter', () => {
  const gatewayConfig = { url: 'http://127.0.0.1:18789', token: 'test-only-credential' };
  it('uses server credentials, fixed action, account and category without redirects', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { details: { ok: true, channel: { id: channel } } } }),
          { status: 200 }
        )
    );
    expect(
      await channelInvoker(gatewayConfig, fetcher)(
        policy,
        'new-project',
        'notes',
        input.operation_id
      )
    ).toMatchObject({ channel: { id: channel } });
    const [url, opts] = fetcher.mock.calls[0] as any;
    expect(url).toBe('http://127.0.0.1:18789/tools/invoke');
    expect(opts.redirect).toBe('error');
    expect(JSON.parse(opts.body)).toEqual({
      tool: 'message',
      sessionKey: 'agent:main:main',
      idempotencyKey: input.operation_id,
      args: {
        action: 'channel-create',
        channel: 'discord',
        accountId: 'bot',
        guildId: guild,
        parentId: category,
        name: 'new-project',
        topic: 'notes',
        channelType: 0,
      },
    });
    expect(opts.headers.Authorization).toBe('Bearer test-only-credential');
  });
  it.each([401, 403, 404, 429])('returns safe known rejection code for HTTP %i', async (status) => {
    const fetcher = vi.fn(async () => new Response('secret', { status }));
    await expect(
      channelInvoker(gatewayConfig, fetcher)(policy, 'test', undefined, input.operation_id)
    ).rejects.toMatchObject({ code: 'GATEWAY_HTTP_' + status, uncertain: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never bypasses agent provenance or retries a timeout', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('private transport details');
    });
    await expect(
      channelInvoker(gatewayConfig, fetcher)(policy, 'test', undefined, input.operation_id)
    ).rejects.toMatchObject({ code: 'GATEWAY_OUTCOME_UNKNOWN', uncertain: true });
    vi.stubEnv('OPENCLAW_SESSION_KEY', 'agent:main:test');
    await expect(
      channelInvoker(gatewayConfig, fetcher)(policy, 'test', undefined, input.operation_id)
    ).rejects.toThrow('AGENT_PROVENANCE_DENIED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
