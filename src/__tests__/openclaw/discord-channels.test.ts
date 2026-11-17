import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelCreation,
  DiscordError,
  type ChannelDestination,
} from '../../openclaw/discord-channels.js';
const guild = '200000000000000001',
  category = '200000000000000002',
  channel = '200000000000000003';
const policy: ChannelDestination = {
  guildId: guild,
  categoryId: category,
  accountId: 'bot',
  agentId: 'main',
};
const input = {
  operation_id: 'create-operation-001',
  channel_name: 'new-project',
  channel_topic: 'Project notes',
  authorize_create: true,
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
  const inspect = vi.fn(async (_p: ChannelDestination, id: string) => ({
    id,
    guild_id: guild,
    parent_id: id === channel ? category : null,
    type: id === category ? 4 : 0,
    name: id === category ? 'Projects' : 'new-project',
    topic: 'Project notes',
  }));
  const invoke = vi.fn(async () => ({ ok: true, channel: { id: channel } }));
  return {
    dir,
    inspect,
    invoke,
    creation: new ChannelCreation(dir, invoke, inspect, async () => {}),
  };
}
describe('explicit channel creation', () => {
  it('creates once, admits persistently, and rejects changed arguments', async () => {
    const f = await fixture();
    const result = await f.creation.create(input, policy);
    expect(result).toMatchObject({
      status: 'completed',
      channel_id: channel,
    });
    expect(result.session_key).toBeUndefined();
    expect(f.inspect.mock.calls.map((c) => c[1])).toEqual([category, channel]);
    const restarted = new ChannelCreation(f.dir, f.invoke, f.inspect, async () => {});
    expect(await restarted.create(input, policy)).toEqual(result);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    await expect(restarted.create({ ...input, channel_name: 'different' }, policy)).rejects.toThrow(
      'OPERATION_CONFLICT'
    );
  });
  it('does not dispatch concurrent duplicate creation', async () => {
    const f = await fixture();
    await Promise.allSettled([f.creation.create(input, policy), f.creation.create(input, policy)]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([{ authorize_create: false }, { channel_name: '--bad' }, { operation_id: '../escape' }])(
    'rejects unapproved input %j before effects',
    async (invalid) => {
      const f = await fixture();
      await expect(f.creation.create({ ...input, ...invalid }, policy)).rejects.toThrow();
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
    }
  );
  it('fails closed on category guild mismatch', async () => {
    const f = await fixture();
    f.inspect.mockResolvedValue({ id: category, guild_id: 'other', type: 4 } as any);
    expect(await f.creation.create(input, policy)).toMatchObject({
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
    expect(await f.creation.create(input, policy)).toMatchObject({
      status: 'created_unadmitted',
      channel_id: channel,
    });
    await f.creation.create(input, policy);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    new DiscordError('GATEWAY_OUTCOME_UNKNOWN', true),
    new DiscordError('GATEWAY_HTTP_403'),
  ])('records uncertainty or known rejection without retry', async (error) => {
    const f = await fixture();
    f.invoke.mockRejectedValue(error);
    expect(await f.creation.create(input, policy)).toMatchObject({
      status: error.uncertain ? 'creation_unknown' : 'creation_rejected',
      error_code: error.code,
    });
    await f.creation.create(input, policy);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('does not replay interrupted creation after restart', async () => {
    const f = await fixture();
    await f.creation.create(input, policy);
    const path = join(f.dir, input.operation_id + '.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.status = 'creating';
    await writeFile(path, JSON.stringify(record));
    f.invoke.mockClear();
    expect((await f.creation.create(input, policy)).status).toBe('creating');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('rejects agent provenance before HTTP or Gateway reads', async () => {
    const f = await fixture();
    vi.stubEnv('OPENCLAW_SHELL', 'exec');
    await expect(f.creation.create(input, policy)).rejects.toThrow('AGENT_PROVENANCE_DENIED');
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });
});
