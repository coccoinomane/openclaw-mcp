import { fixtureAccess, fixturePermissions } from '../discord-fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { discordTools, handleDiscord } from '../../mcp/tools/discord.js';
import { DiscordService } from '../../openclaw/discord.js';
import { DiscordError } from '../../openclaw/discord-channels.js';
import type { DiscordAgentTransport } from '../../openclaw/discord-agent.js';
import type { DiscordReader } from '../../openclaw/discord-read.js';
import type { ThreadInvoker } from '../../openclaw/discord-thread.js';

const guild = '500000000000000001',
  parent = '500000000000000002',
  thread = '500000000000000003',
  category = '500000000000000004',
  created = '500000000000000005';
const target = {
  name: 'work',
  channelId: parent,
  guildId: guild,
  accountId: 'bot',
  agentId: 'main',
};
const validators = new Map(
  discordTools.map((tool) => [
    tool.name,
    new AjvJsonSchemaValidator().getValidator(tool.outputSchema!),
  ])
);
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^OPENCLAW_(SHELL|.*AGENT.*|.*SESSION.*|.*CALLER.*)$/.test(key)) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
function valid(name: string, value: unknown) {
  const result = validators.get('openclaw_discord_' + name)!(value);
  expect(result.valid, result.errorMessage).toBe(true);
}
async function checked(service: DiscordService, name: string, input: any = {}) {
  const response = await handleDiscord(service, 'openclaw_discord_' + name, input);
  expect(response.isError).not.toBe(true);
  valid(name, response.structuredContent);
  // JSON transport drops undefined optional properties; preserve the original text.
  expect(response.content[0].text).toBe(JSON.stringify(response.structuredContent, null, 2));
  valid(name, JSON.parse(response.content[0].text));
  return response.structuredContent!;
}
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'discord-output-'));
  const channels: any[] = [
    { id: parent, guild_id: guild, type: 0, name: 'Work', topic: null },
    { id: category, guild_id: guild, type: 4, name: 'Projects' },
    { id: created, guild_id: guild, type: 0, parent_id: category, name: 'Created', topic: 'Notes' },
  ];
  const threads: any[] = [
    {
      id: thread,
      guild_id: guild,
      parent_id: parent,
      type: 11,
      name: 'Task',
      thread_metadata: {
        archived: false,
        locked: false,
        archive_timestamp: '2026-11-01T00:00:00Z',
      },
    },
  ];
  let hasMore = false;
  let partial = false;
  let failCreate = false;
  const reader = vi.fn<DiscordReader>(async (_scope, request) => {
    if (request.action === 'permissions')
      return {
        ok: true,
        permissions: fixturePermissions(guild, request.channelId, parent),
      };
    if (request.action === 'channel-list') return { ok: true, channels };
    if (request.action === 'channel-info')
      return {
        ok: true,
        channel: [...channels, ...threads].find((c) => c.id === request.channelId),
      };
    if (request.action === 'thread-list')
      return { ok: true, threads: { threads, has_more: hasMore } };
    throw new Error('Unexpected metadata read');
  });
  const invokeThread = vi.fn<ThreadInvoker>(async () => {
    if (failCreate) throw new DiscordError('GATEWAY_OUTCOME_UNKNOWN', true);
    return { thread: { id: thread }, partial };
  });
  const agent = {
    ready: vi.fn<DiscordAgentTransport['ready']>(async () => {}),
    run: vi.fn<DiscordAgentTransport['run']>(async (request, accepted) => {
      const receipt = {
        runId: 'run-1',
        sessionKey: request.sessionKey,
        agentId: request.agentId,
      };
      await accepted(receipt);
      return { ...receipt, status: 'ok' };
    }),
    cancel: vi.fn<DiscordAgentTransport['cancel']>(async () => {}),
  };
  const invoke = vi.fn(async () => ({ ok: true, channel: { id: created } }));
  const service = new DiscordService(
    {
      stateDir,
      access: fixtureAccess([target]),
      channelCreateEnabled: true,
    },
    invoke,
    reader,
    invokeThread,
    undefined,
    async (_t, _id, _prompt, _op, sent) => {
      await sent('500000000000000006');
    },
    agent
  );
  cleanups.push(async () => {
    await service.drain();
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    service,
    reader,
    invokeThread,
    agent,
    channels,
    threads,
    invoke,
    stateDir,
    more: () => {
      hasMore = true;
    },
    partial: () => {
      partial = true;
    },
    fail: () => {
      failCreate = true;
    },
  };
}
const ask = {
  channel_id: target.channelId,
  server_id: guild,
  discord_account_id: 'bot',
  thread_name: 'Task',
  prompt: 'Exact request',
  operation_id: 'schema-operation-001',
};
const creation = {
  server_id: guild,
  discord_account_id: 'bot',
  category_id: category,
  channel_name: 'created',
  authorize_create: true,
  operation_id: 'schema-creation-001',
};

describe('Discord output contracts', () => {
  it('chains discovered routes into ask, reply, send and channel creation', async () => {
    const f = await fixture();
    const discovered = (await checked(f.service, 'channels')).channels as any[];
    const { agent_id, server_id, discord_account_id, channel_id } = discovered[0];
    const route = { agent_id, server_id, discord_account_id, channel_id };
    expect(discovered[0]).not.toHaveProperty('target');
    const listing = await checked(f.service, 'threads', route);
    expect(listing).toMatchObject(route);
    const { thread_id } = (listing.threads as any[])[0];
    const createdThread = await checked(f.service, 'ask', {
      ...route,
      thread_name: 'Task',
      prompt: 'Help',
      operation_id: 'chain-ask-operation-01',
    });
    expect(createdThread).toMatchObject({ ...route, thread_id });
    await f.service.drain();
    const reply = await checked(f.service, 'reply', {
      ...route,
      thread_id,
      prompt: 'Continue',
      operation_id: 'chain-reply-operation-01',
    });
    expect(reply).toMatchObject({ ...route, thread_id });
    await f.service.drain();
    const sent = await checked(f.service, 'send', {
      ...route,
      prompt: 'Channel request',
      operation_id: 'chain-send-operation-01',
    });
    expect(sent).toMatchObject(route);
    expect(sent).not.toHaveProperty('thread_id');
    expect(sent).not.toHaveProperty('target');
    const createdChannel = await checked(f.service, 'create_channel', creation);
    expect(createdChannel.channel_id).toBe(created);
    expect(createdChannel).not.toHaveProperty('thread_id');
    expect(createdChannel).not.toHaveProperty('target');
  });

  it.each(['ask', 'create_channel'])(
    'rejects old %s journals without replay or rewriting',
    async (name) => {
      const f = await fixture();
      const input = name === 'ask' ? ask : creation;
      await checked(f.service, name, input);
      await f.service.drain();
      const path = join(f.stateDir, input.operation_id + '.json');
      const record = JSON.parse(await readFile(path, 'utf8'));
      expect(record.schema_version).toBe(2);
      for (const version of [undefined, 1, 99]) {
        const old = { ...record, schema_version: version };
        const raw = JSON.stringify(old);
        await writeFile(path, raw);
        f.invoke.mockClear();
        f.invokeThread.mockClear();
        f.agent.run.mockClear();
        const status = await handleDiscord(f.service, 'openclaw_discord_operation', {
          operation_id: input.operation_id,
        });
        const replay = await handleDiscord(f.service, 'openclaw_discord_' + name, input);
        for (const result of [status, replay]) {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error_code: 'OPERATION_SCHEMA_UNSUPPORTED',
            retry_safe: false,
          });
        }
        expect(f.invoke).not.toHaveBeenCalled();
        expect(await readFile(path, 'utf8')).toBe(raw);
      }
    }
  );

  it('validates live channels output', async () => {
    const f = await fixture();
    expect((await checked(f.service, 'channels')).channels).toHaveLength(1);
  });
  it.each([undefined, 0, 1, 30, 100])(
    'caps active results after channel filtering: %s',
    async (limit) => {
      const f = await fixture();
      const template = f.threads[0];
      const matching = Array.from({ length: 125 }, (_, i) => ({
        ...template,
        id: String(500000000000001000n + BigInt(i)),
      }));
      f.threads.splice(
        0,
        1,
        ...matching.map((c) => ({ ...c, parent_id: category })),
        ...matching.map((c) => ({ ...c, guild_id: category })),
        { ...template, id: 'invalid' },
        { ...template, type: 0 },
        null,
        ...matching
      );
      const result = await checked(f.service, 'threads', {
        channel_id: parent,
        server_id: guild,
        discord_account_id: 'bot',
        limit,
      });
      const count = limit === 0 ? 125 : (limit ?? 30);
      expect(result.threads).toHaveLength(count);
      expect((result.threads as any[]).map((t: any) => t.thread_id)).toEqual(
        matching.slice(0, count).map((t) => t.id)
      );
      expect(result.has_more).toBe(count < 125);
      expect(result.pagination).toBe('none');
      expect(result).not.toHaveProperty('next_before_archive_timestamp');
      if (count < 125) expect(result.guidance).toContain('limit=0');
      else expect(result).not.toHaveProperty('guidance');
      expect(f.reader.mock.calls.at(-1)![1]).toEqual({ action: 'thread-list', channelId: parent });
    }
  );
  it.each([0, 1, 30])('does not claim more active threads for %i matches', async (count) => {
    const f = await fixture();
    const template = f.threads[0];
    f.threads.splice(
      0,
      1,
      ...Array.from({ length: count }, (_, i) => ({
        ...template,
        id: String(500000000000001000n + BigInt(i)),
      })),
      ...Array.from({ length: 40 }, () => ({ ...template, parent_id: category }))
    );
    f.more();
    const result = await checked(f.service, 'threads', {
      channel_id: parent,
      server_id: guild,
      discord_account_id: 'bot',
      archived: false,
    });
    expect(result.threads).toHaveLength(count);
    expect(result.has_more).toBe(false);
    expect(result).not.toHaveProperty('guidance');
    expect(result).not.toHaveProperty('next_before_archive_timestamp');
  });
  it('defaults archived reads to 30 and preserves upstream pagination', async () => {
    const f = await fixture();
    f.more();
    const result = await checked(f.service, 'threads', {
      channel_id: parent,
      server_id: guild,
      discord_account_id: 'bot',
      archived: true,
    });
    expect(f.reader.mock.calls.at(-1)![1]).toMatchObject({ includeArchived: true, limit: 30 });
    expect(result).toMatchObject({
      has_more: true,
      pagination: 'archived_public_timestamp',
      next_before_archive_timestamp: '2026-11-01T00:00:00Z',
    });
    expect(result).not.toHaveProperty('guidance');
  });
  it.each([
    [{ archived: true, limit: 0 }, ['1..100', 'active-only']],
    [{ limit: -1 }, ['limit', '1 to 100']],
    [{ limit: 101 }, ['limit', '1 to 100']],
    [{ limit: 1.5 }, ['limit', 'integer']],
    [{ limit: '30' }, ['limit', 'integer']],
    [{ limit: null }, ['limit', 'integer']],
    [{ archived: 'true' }, ['archived', 'boolean']],
    [
      { before_archive_timestamp: '2026-11-01T00:00:00Z' },
      ['before_archive_timestamp', 'archived=true'],
    ],
    [
      { archived: true, before_archive_timestamp: 'private-value' },
      ['before_archive_timestamp', 'ISO 8601'],
    ],
  ])('returns safe actionable validation for %j', async (args, details) => {
    const f = await fixture();
    const result = await handleDiscord(f.service, 'openclaw_discord_threads', {
      channel_id: parent,
      server_id: guild,
      discord_account_id: 'bot',
      ...args,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    for (const detail of details) expect(result.content[0].text).toContain(detail);
    expect(result.content[0].text).not.toContain('private-value');
    expect(f.reader).not.toHaveBeenCalled();
  });

  it('validates active, archived, empty and sparse thread payloads', async () => {
    const f = await fixture();
    expect(
      (
        await checked(f.service, 'threads', {
          channel_id: parent,
          server_id: guild,
          discord_account_id: 'bot',
        })
      ).pagination
    ).toBe('none');
    f.more();
    const archived = await checked(f.service, 'threads', {
      channel_id: target.channelId,
      server_id: guild,
      discord_account_id: 'bot',
      archived: true,
      limit: 1,
    });
    expect(archived.next_before_archive_timestamp).toBe('2026-11-01T00:00:00Z');
    delete f.threads[0].name;
    delete f.threads[0].thread_metadata;
    await checked(f.service, 'threads', {
      channel_id: target.channelId,
      server_id: guild,
      discord_account_id: 'bot',
      archived: true,
    });
    f.threads[0].name = null;
    f.threads[0].thread_metadata = { archived: 'upstream-value', archive_timestamp: 42 };
    const malformed = await handleDiscord(f.service, 'openclaw_discord_threads', {
      channel_id: target.channelId,
      server_id: guild,
      discord_account_id: 'bot',
      archived: true,
    });
    expect(validators.get('openclaw_discord_threads')!(malformed.structuredContent).valid).toBe(
      false
    );
    f.threads.splice(0);
    expect(
      (
        await checked(f.service, 'threads', {
          channel_id: parent,
          server_id: guild,
          discord_account_id: 'bot',
        })
      ).threads
    ).toEqual([]);
  });
  it.each(['ask', 'reply'])(
    'validates %s queued, completed and interrupted operation results',
    async (name) => {
      const f = await fixture();
      const input =
        name === 'ask'
          ? ask
          : {
              channel_id: target.channelId,
              server_id: guild,
              discord_account_id: 'bot',
              thread_id: thread,
              prompt: ask.prompt,
              operation_id: ask.operation_id,
            };
      const queued = await checked(f.service, name, input);
      expect(queued.status).toBe('queued');
      await f.service.drain();
      const completed = await checked(f.service, 'operation', { operation_id: input.operation_id });
      expect(completed).toMatchObject({ status: 'completed', delivery_verified: false });
      valid(name, completed);
      await writeFile(
        join(f.stateDir, input.operation_id + '.json'),
        JSON.stringify({ ...queued, schema_version: 2, owner: 'old-process', status: 'running' })
      );
      const interrupted = await checked(f.service, 'operation', {
        operation_id: input.operation_id,
      });
      expect(interrupted.status).toBe('run_unknown');
      valid(name, interrupted);
    }
  );
  it.each(['ask', 'reply'])(
    'validates %s failure before dispatch without fabricated identifiers',
    async (name) => {
      const f = await fixture();
      f.service.config.access.assert = async () => {
        throw new DiscordError('BINDING_ACCESS_DENIED');
      };
      const input =
        name === 'ask'
          ? ask
          : {
              channel_id: target.channelId,
              server_id: guild,
              discord_account_id: 'bot',
              thread_id: thread,
              prompt: ask.prompt,
              operation_id: ask.operation_id,
            };
      const failed = await checked(f.service, name, input);
      expect(failed).toMatchObject({
        status: 'run_failed',
        error_code: 'BINDING_ACCESS_DENIED',
      });
      expect(failed.thread_id).toBeUndefined();
      expect(failed.session_key).toBeUndefined();
      valid('operation', failed);
    }
  );
  it.each(['partial', 'fail'] as const)(
    'validates ask %s outcomes without requiring a session or URL',
    async (mode) => {
      const f = await fixture();
      f[mode]();
      const result = await checked(f.service, 'ask', ask);
      expect(result.status).toBe(mode === 'partial' ? 'creation_partial' : 'creation_unknown');
      valid('operation', result);
    }
  );
  it.each(['completed', 'created_unadmitted', 'creation_unknown', 'creation_rejected'])(
    'validates channel creation %s results and status reads',
    async (status) => {
      const f = await fixture();
      if (status === 'created_unadmitted') f.channels[2].parent_id = parent;
      if (status === 'creation_unknown')
        f.invoke.mockRejectedValue(new DiscordError('UNKNOWN', true));
      if (status === 'creation_rejected') f.channels[1].type = 0;
      const result = await checked(f.service, 'create_channel', creation);
      expect(result.status).toBe(status);
      expect(
        await checked(f.service, 'operation', { operation_id: creation.operation_id })
      ).toEqual(result);
    }
  );
  it.each(discordTools)(
    '$name accepts its structured error and retains text-only errors',
    async (tool) => {
      const service = {
        channels: reject,
        threads: reject,
        ask: reject,
        reply: reject,
        send: reject,
        status: reject,
        createChannel: reject,
      } as unknown as DiscordService;
      async function reject() {
        throw new DiscordError('DENIED', true);
      }
      const args = Object.fromEntries(
        (tool.inputSchema.required ?? []).map((key) => [key, 'value'])
      );
      const error = await handleDiscord(service, tool.name, args);
      expect(error.isError).toBe(true);
      expect(error.content[0].text).toBe('Error: DENIED');
      expect(validators.get(tool.name)!(error.structuredContent).valid).toBe(true);
      const invalid = await handleDiscord(service, tool.name, { unexpected: true });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toBeUndefined();
    }
  );
  it('rejects malformed guaranteed fields rather than accepting any object', () => {
    for (const validate of validators.values()) {
      expect(validate({}).valid).toBe(false);
      expect(validate({ error_code: 'DENIED', uncertain: true, retry_safe: true }).valid).toBe(
        false
      );
    }
    expect(
      validators.get('openclaw_discord_channels')!({
        channels: [],
        creation_servers: [],
        target: 'old',
      }).valid
    ).toBe(false);
    for (const status of ['creating', 'created', 'running']) {
      const turn = {
        operation_id: ask.operation_id,
        channel_id: target.channelId,
        server_id: guild,
        discord_account_id: 'bot',
        status,
        retry_safe: false,
      };
      valid('ask', turn);
      valid('reply', turn);
      valid('operation', turn);
    }
    const creating = {
      kind: 'channel_create',
      server_id: guild,
      discord_account_id: 'bot',
      category_id: category,
      operation_id: creation.operation_id,
      status: 'creating',
      retry_safe: false,
    };
    valid('create_channel', creating);
    valid('operation', creating);
    expect(
      validators.get('openclaw_discord_channels')!({ channels: [{}], creation_servers: [] }).valid
    ).toBe(false);
    expect(
      validators.get('openclaw_discord_threads')!({
        threads: [],
        has_more: 'yes',
        pagination: 'none',
      }).valid
    ).toBe(false);
    for (const name of ['ask', 'reply', 'operation'])
      expect(
        validators.get('openclaw_discord_' + name)!({
          operation_id: ask.operation_id,
          channel_id: target.channelId,
          server_id: guild,
          discord_account_id: 'bot',
          status: 'completed',
          retry_safe: true,
        }).valid
      ).toBe(false);
  });
});
