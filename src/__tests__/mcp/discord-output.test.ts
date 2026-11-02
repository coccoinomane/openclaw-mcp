import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { discordTools, handleDiscord } from '../../mcp/tools/discord.js';
import { DiscordService } from '../../openclaw/discord.js';
import { DiscordError } from '../../openclaw/discord-channels.js';

const guild = '500000000000000001',
  parent = '500000000000000002',
  thread = '500000000000000003',
  category = '500000000000000004',
  created = '500000000000000005';
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
  const runner = vi.fn(async (_e: string, args: string[]) => {
    if (args[0] === 'agent') return { status: 'ok', runId: 'run-1' };
    if (args[1] === 'permissions')
      return {
        permissions: {
          channelId: thread,
          guildId: guild,
          channelType: 11,
          isDm: false,
          permissions: [
            'ViewChannel',
            'SendMessagesInThreads',
            'ReadMessageHistory',
            'AttachFiles',
          ],
        },
      };
    if (args[1] === 'channel' && args[2] === 'list') return { payload: { ok: true, channels } };
    if (args[2] === 'info') {
      const id = args[args.indexOf('--target') + 1].slice(8);
      return { payload: { ok: true, channel: [...channels, ...threads].find((c) => c.id === id) } };
    }
    if (args[1] === 'thread' && args[2] === 'list')
      return { payload: { ok: true, threads: { threads, has_more: hasMore } } };
    if (args[2] === 'create') {
      if (failCreate) throw new Error('timeout');
      return { payload: { ok: true, thread: { id: thread }, partial } };
    }
    throw new Error('Unexpected mock CLI');
  });
  const invoke = vi.fn(async () => ({ ok: true, channel: { id: created } }));
  const service = new DiscordService(
    {
      executable: 'never-run',
      stateDir,
      acknowledgeInboundRouting: true,
      cliGatewayInstance: 'home',
      targets: [
        {
          name: 'work',
          guildId: guild,
          channelId: parent,
          agentId: 'main',
          accountId: 'bot',
          normalRouting: true,
        },
      ],
      creationPolicies: [
        {
          name: 'projects',
          guildId: guild,
          categoryId: category,
          accountId: 'bot',
          agentId: 'main',
          instance: 'home',
        },
      ],
    },
    runner,
    invoke,
    undefined,
    undefined,
    undefined,
    undefined,
    async (_t, _id, _prompt, _op, sent) => {
      await sent('500000000000000006');
    }
  );
  cleanups.push(async () => {
    await service.drain();
    await rm(stateDir, { recursive: true, force: true });
  });
  return {
    service,
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
  target: 'work',
  mode: 'new_thread',
  title: 'Task',
  prompt: 'Exact request',
  operation_id: 'schema-operation-001',
};
const creation = {
  policy: 'projects',
  name: 'created',
  authorize_create: true,
  authorize_admission: true,
  operation_id: 'schema-creation-001',
};

describe('Discord output contracts', () => {
  it('validates channels, nullable metadata, categories and creation policies', async () => {
    const f = await fixture();
    const initial = await checked(f.service, 'channels');
    expect(initial.channels).toMatchObject([
      { topic: null, category_id: null, category_name: null },
    ]);
    await checked(f.service, 'create_channel', creation);
    const admitted = await checked(f.service, 'channels');
    expect(admitted.channels).toMatchObject([
      {},
      { topic: 'Notes', category_id: category, category_name: 'Projects' },
    ]);
    f.channels.splice(0);
    expect((await checked(f.service, 'channels')).channels).toEqual([]);
  });
  it('validates active, archived, empty and sparse thread payloads without inventing metadata types', async () => {
    const f = await fixture();
    expect((await checked(f.service, 'threads', { target: 'work' })).pagination).toBe('none');
    f.more();
    const archived = await checked(f.service, 'threads', {
      target: 'work',
      archived: true,
      limit: 1,
    });
    expect(archived.next_before).toBe('2026-11-01T00:00:00Z');
    delete f.threads[0].name;
    delete f.threads[0].thread_metadata;
    await checked(f.service, 'threads', { target: 'work', archived: true });
    f.threads[0].name = null;
    f.threads[0].thread_metadata = { archived: 'upstream-value', archive_timestamp: 42 };
    await checked(f.service, 'threads', { target: 'work', archived: true });
    f.threads.splice(0);
    expect((await checked(f.service, 'threads', { target: 'work' })).threads).toEqual([]);
  });
  it.each(['ask', 'reply'])(
    'validates %s queued, completed and interrupted operation results',
    async (name) => {
      const f = await fixture();
      const input =
        name === 'ask'
          ? ask
          : {
              target: 'work',
              channel_id: thread,
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
        JSON.stringify({ ...queued, owner: 'old-process', status: 'running' })
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
      f.service.config.targets[0].normalRouting = false;
      const input =
        name === 'ask'
          ? ask
          : {
              target: 'work',
              channel_id: thread,
              prompt: ask.prompt,
              operation_id: ask.operation_id,
            };
      const failed = await checked(f.service, name, input);
      expect(failed).toMatchObject({
        status: 'run_failed',
        error_code: 'NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED',
      });
      expect(failed.channel_id).toBeUndefined();
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
    valid('channels', { channels: [], creation_policies: [], future_metadata: 'allowed' });
    for (const status of ['creating', 'created', 'running']) {
      const turn = { operation_id: ask.operation_id, target: 'work', status, retry_safe: false };
      valid('ask', turn);
      valid('reply', turn);
      valid('operation', turn);
    }
    const creating = {
      kind: 'channel_create',
      policy: 'projects',
      operation_id: creation.operation_id,
      status: 'creating',
      retry_safe: false,
    };
    valid('create_channel', creating);
    valid('operation', creating);
    expect(
      validators.get('openclaw_discord_channels')!({ channels: [{}], creation_policies: [] }).valid
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
          target: 'work',
          status: 'completed',
          retry_safe: true,
        }).valid
      ).toBe(false);
  });
});
