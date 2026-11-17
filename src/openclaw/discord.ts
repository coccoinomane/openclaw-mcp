import { assertOperationVersion, operationSchemaVersion } from './discord-channels.js';
import { checkModel } from './models.js';
import { checkForkSource } from './session-fork.js';
import { assertTargetAllowed } from './discord-policy.js';
import type { DiscordAccess } from './discord-bindings.js';
import type { RequestPublisher } from './discord-request.js';
import { displaySource } from './discord-source.js';
import {
  ChannelCreation,
  DiscordError,
  assertServiceProvenance,
  type ChannelDestination,
  type ChannelInvoker,
  type AdmittedTarget,
} from './discord-channels.js';
import type { DiscordAgentTransport } from './discord-agent.js';
import type { DiscordReader } from './discord-read.js';
import type { ThreadInvoker, ThreadMemberAdder } from './discord-thread.js';
import { log } from '../utils/logger.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface DiscordSelectors {
  agent_id?: string;
}
export interface DiscordConfig {
  access: DiscordAccess;
  stateDir: string;
  channelCreateEnabled?: boolean;
  maxOperations?: number;
  threadMember?: { userId: string; accountId: string };
  forwardingRequesterName?: string;
  threadCreationMode?: 'silent-starter' | 'classic';
}
const snowflake = /^[1-9][0-9]{16,19}$/;
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function check(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid ' + label);
}
export function loadDiscordConfig(env = process.env): Omit<DiscordConfig, 'access'> | undefined {
  if (env.MCP_DISCORD_ENABLED !== 'true') return undefined;
  const config: Omit<DiscordConfig, 'access'> = {
    stateDir: env.MCP_DISCORD_STATE_DIR || '',
    channelCreateEnabled: env.MCP_DISCORD_CHANNEL_CREATE_ENABLED === 'true',
    threadMember:
      env.MCP_DISCORD_THREAD_MEMBER_ENABLED === 'true'
        ? {
            userId: env.MCP_DISCORD_THREAD_MEMBER_USER_ID || '',
            accountId: env.MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID || '',
          }
        : undefined,
    forwardingRequesterName: env.MCP_DISCORD_FORWARDING_REQUESTER_NAME || undefined,
    threadCreationMode: (env.MCP_DISCORD_THREAD_CREATION_MODE ??
      'silent-starter') as DiscordConfig['threadCreationMode'],
    maxOperations: Number(env.MCP_DISCORD_MAX_OPERATIONS ?? 4),
  };
  validateConfig(config);
  return config;
}
function validateConfig(config: Omit<DiscordConfig, 'access'>) {
  if (!['silent-starter', 'classic'].includes(config.threadCreationMode ?? 'silent-starter'))
    throw new DiscordError('THREAD_CREATION_MODE_INVALID');
  if (
    !Number.isInteger(config.maxOperations ?? 4) ||
    (config.maxOperations ?? 4) < 1 ||
    (config.maxOperations ?? 4) > 16
  )
    throw new DiscordError('OPERATION_LIMIT_INVALID');
  if (
    config.forwardingRequesterName !== undefined &&
    (typeof config.forwardingRequesterName !== 'string' ||
      !config.forwardingRequesterName.trim() ||
      config.forwardingRequesterName.length > 100 ||
      [...config.forwardingRequesterName].some((c) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(c)) ||
      new TextDecoder().decode(new TextEncoder().encode(config.forwardingRequesterName)) !==
        config.forwardingRequesterName)
  )
    throw new DiscordError('FORWARDING_REQUESTER_NAME_INVALID');
  if (config.threadMember) {
    check(config.threadMember.userId, snowflake, 'thread member user ID');
    check(config.threadMember.accountId, slug, 'thread member account');
  }
  if (!isAbsolute(config.stateDir)) throw new Error('MCP_DISCORD_STATE_DIR must be absolute');
}

interface Operation {
  schema_version: number;
  agent_id?: string;
  server_id?: string;
  discord_account_id?: string;
  fingerprint: string;
  kind?: 'thread_reply' | 'channel_message';
  owner?: string;
  request_status?:
    | 'pending'
    | 'publishing'
    | 'sent'
    | 'verified'
    | 'failed'
    | 'partial'
    | 'unknown';
  request_verified?: boolean;
  request_message_ids?: string[];
  status:
    | 'creating'
    | 'creation_unknown'
    | 'created'
    | 'creation_partial'
    | 'queued'
    | 'running'
    | 'completed'
    | 'run_failed'
    | 'run_unknown';
  operation_id: string;
  channel_id: string;
  thread_id?: string;
  session_key?: string;
  discord_url?: string;
  run_id?: string;
  agent_transport?: 'sdk';
  agent_idempotency_key?: string;
  cancellation_status?: 'requested' | 'acknowledged' | 'unknown';
  delivery_status?: string;
  delivery_verified?: boolean;
  message_id?: string;
  generation_status?: string;
  thread_create_transport?: 'gateway';
  starter_message_id?: string;
  model?: string;
  model_error?: string;
  fork_from_session_key?: string;
  fork_status?: 'pending' | 'forking' | 'completed' | 'failed' | 'unknown';
  fork_error_code?: string;
  member_status?: 'disabled' | 'pending' | 'adding' | 'verified' | 'failed' | 'unknown';
  member_verified?: boolean;
  member_error_code?: string;
  handoff?: string;
  recovery?: string;
  error_code?: string;
}
export class DiscordService {
  private readonly creation?: ChannelCreation;
  private readonly owner = randomUUID();
  private readonly workers = new Set<Promise<unknown>>();
  private readonly active = new Set<string>();
  private readonly preparations = new Map<string, number>();
  private readonly cancellations = new Map<string, () => Promise<void>>();
  private closing = false;
  async shutdown() {
    this.closing = true;
    await this.drain();
  }
  async drain() {
    while (this.workers.size) await Promise.allSettled([...this.workers]);
  }

  constructor(
    readonly config: DiscordConfig,
    invoke?: ChannelInvoker,
    private readonly reader?: DiscordReader,
    private readonly invokeThread?: ThreadInvoker,
    private readonly addThreadMember?: ThreadMemberAdder,
    private readonly publishRequest?: RequestPublisher,
    private readonly agent?: DiscordAgentTransport
  ) {
    validateConfig(config);
    if (!agent || !reader) throw new DiscordError('SDK_ADAPTER_REQUIRED');
    if (!invokeThread) throw new DiscordError('THREAD_ADAPTER_REQUIRED');
    if (config.threadMember && !addThreadMember)
      throw new DiscordError('THREAD_MEMBER_ADAPTER_REQUIRED');
    if (config.channelCreateEnabled) {
      if (!invoke) throw new DiscordError('CREATION_ADAPTER_REQUIRED');
      this.creation = new ChannelCreation(
        config.stateDir,
        invoke,
        async (p, id) => (await this.readInfo({ ...p, name: id, channelId: id }, id)).channel,
        async (p) => {
          await this.config.access.assertCreate({ ...p, name: '', channelId: '' });
          // A category's overwrites cannot prove guild-level ManageChannels. The
          // invoker performs a guild-level bot role check before channel-create.
        }
      );
    }
  }
  private async ordinaryRoute(t: AdmittedTarget, channelId: string) {
    await this.config.access.assert(t);
    return 'agent:' + t.agentId + ':discord:channel:' + channelId;
  }
  async createChannel(input: any) {
    if (!this.creation) throw new DiscordError('CHANNEL_CREATION_DISABLED');
    const agentId = await this.config.access.select(input.agent_id);
    check(input.server_id, snowflake, 'server ID');
    check(input.discord_account_id, slug, 'account ID');
    if (input.category_id !== undefined) check(input.category_id, snowflake, 'category ID');
    const destination: ChannelDestination = {
      agentId,
      guildId: input.server_id,
      accountId: input.discord_account_id,
      categoryId: input.category_id,
    };
    await this.config.access.assertCreate({ ...destination, name: '', channelId: '' });
    return this.creation.create(input, destination);
  }
  private async target(input: any) {
    return this.config.access.target(input);
  }
  private async readInfo(t: AdmittedTarget, id: string) {
    check(id, snowflake, 'channel ID');
    return this.reader!(t, { action: 'channel-info', channelId: id });
  }
  private verifyChannel(t: AdmittedTarget, id: string, c: any, parent = false) {
    if (!c || c.id !== id || c.guild_id !== t.guildId || !Number.isInteger(c.type))
      throw new Error('Channel guild could not be verified');
    if (id === t.channelId && t.categoryId && c.parent_id !== t.categoryId)
      throw new DiscordError('ADMITTED_CHANNEL_MOVED');
    const thread = [10, 11, 12].includes(c.type);
    if (
      parent
        ? id !== t.channelId || ![0, 5, 15, 16].includes(c.type)
        : id !== t.channelId && (!thread || c.parent_id !== t.channelId)
    ) {
      throw new Error('Channel is outside allowed target');
    }
    return c;
  }
  private async info(t: AdmittedTarget, id: string, parent = false) {
    await assertTargetAllowed(this.config, t, id);
    return this.verifyChannel(t, id, (await this.readInfo(t, id)).channel, parent);
  }
  async channels(input: DiscordSelectors = {}) {
    const result = await this.config.access.channels(input.agent_id);
    return {
      ...result,
      creation_servers: this.config.channelCreateEnabled ? result.creation_servers : [],
    };
  }
  async threads(input: any) {
    const t = await this.target(input);
    if (input.archived !== undefined && typeof input.archived !== 'boolean')
      throw new Error('Invalid archived flag');
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new Error('Invalid limit');
    if (
      input.before_archive_timestamp !== undefined &&
      (typeof input.before_archive_timestamp !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(
          input.before_archive_timestamp
        ) ||
        !Number.isFinite(Date.parse(input.before_archive_timestamp)))
    )
      throw new Error('Invalid archive timestamp');
    if (
      !input.archived &&
      (input.before_archive_timestamp !== undefined || input.limit !== undefined)
    )
      throw new Error('Pagination is only supported for archived public threads');
    await this.info(t, t.channelId, true);
    const data = await this.reader!(t, {
      action: 'thread-list',
      channelId: t.channelId,
      includeArchived: input.archived,
      before: input.before_archive_timestamp,
      limit: input.limit,
    });
    const raw = Array.isArray(data.threads) ? data : data.threads;
    if (!raw || !Array.isArray(raw.threads)) throw new Error('Unexpected thread list');
    const threads = raw.threads
      .filter(
        (c: any) =>
          c &&
          typeof c.id === 'string' &&
          snowflake.test(c.id) &&
          c.guild_id === t.guildId &&
          c.parent_id === t.channelId &&
          [10, 11, 12].includes(c.type)
      )
      .map((c: any) => ({
        thread_id: c.id,
        thread_name: c.name,
        archived: c.thread_metadata?.archived,
        archive_timestamp: c.thread_metadata?.archive_timestamp,
        discord_url: 'https://discord.com/channels/' + t.guildId + '/' + c.id,
      }));
    return {
      agent_id: t.agentId,
      discord_account_id: t.accountId,
      server_id: t.guildId,
      channel_id: t.channelId,
      threads,
      has_more: raw.has_more === true,
      next_before_archive_timestamp:
        raw.has_more === true ? raw.threads.at(-1)?.thread_metadata?.archive_timestamp : undefined,
      pagination: input.archived ? 'archived_public_timestamp' : 'none',
    };
  }
  private path(id: unknown) {
    check(id, /^[a-zA-Z0-9_-]{16,100}$/, 'operation ID');
    return join(this.config.stateDir, id + '.json');
  }
  async status(id: unknown, input: DiscordSelectors = {}) {
    const result: Operation = JSON.parse(await readFile(this.path(id), 'utf8'));
    assertOperationVersion(result);
    const agentId = await this.config.access.select(input.agent_id);
    if (result.agent_id !== agentId) throw new DiscordError('ROUTE_SELECTOR_CONFLICT');
    if ((result as any).kind === 'channel_create') {
      const creation: Partial<Operation> = { ...result };
      delete creation.fingerprint;
      delete creation.schema_version;
      return this.creation
        ? this.creation.publicResult(result)
        : { ...creation, retry_safe: false };
    }
    return this.publicResult(result);
  }
  /** Host-only explicit cancellation; MCP request disconnects never call this. */
  async cancel(id: string, input: DiscordSelectors = {}) {
    assertServiceProvenance();
    const current = await this.status(id, input);
    const cancel = this.cancellations.get(id);
    if (!cancel || !this.active.has(id) || current.status !== 'running' || !current.run_id)
      throw new DiscordError('OWNED_ACCEPTED_RUN_REQUIRED');
    const cancellation = cancel();
    this.workers.add(cancellation);
    try {
      await cancellation;
      return await this.status(id, input);
    } finally {
      this.workers.delete(cancellation);
    }
  }
  private publicResult(op: Operation) {
    assertOperationVersion(op);
    const result: Partial<Operation> = { ...op };
    delete result.schema_version;
    delete result.fingerprint;
    delete result.owner;
    // Old process work is never resumed. Reads never rewrite records or repeat effects.
    if (
      ['creating', 'created', 'queued', 'running'].includes(op.status) &&
      (op.owner !== this.owner || !this.active.has(op.operation_id))
    ) {
      result.status =
        op.thread_id || op.kind === 'thread_reply' || op.kind === 'channel_message'
          ? 'run_unknown'
          : 'creation_unknown';
      result.error_code = 'OPERATION_INTERRUPTED';
      result.recovery =
        'Service ownership ended. Inspect the existing thread; never replay this operation.';
      if (op.request_status === 'publishing' || op.request_status === 'sent')
        result.request_status = 'unknown';
      if (op.member_status === 'adding') result.member_status = 'unknown';
      if (op.fork_status === 'forking') result.fork_status = 'unknown';
    }
    if (result.discord_url && !result.handoff)
      result.handoff =
        'Continue on Discord: ' +
        result.discord_url +
        ' (operation ' +
        result.status +
        '; first response not confirmed)';
    return { ...result, retry_safe: false };
  }
  async ask(input: any) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'channel_id',
            'server_id',
            'discord_account_id',
            'operation_id',
            'thread_name',
            'prompt',
            'agent_id',
            'model',
            'fork_from_session_key',
            'source',
          ].includes(key)
      )
    )
      throw new DiscordError('ASK_ARGUMENTS_INVALID');
    displaySource(input.source);
    return this.enqueue({ ...input, mode: 'new_thread' });
  }
  async reply(input: any) {
    if (
      !input ||
      Object.keys(input).some(
        (key) =>
          ![
            'channel_id',
            'server_id',
            'discord_account_id',
            'thread_id',
            'operation_id',
            'prompt',
            'agent_id',
          ].includes(key)
      )
    )
      throw new DiscordError('REPLY_ARGUMENTS_INVALID');
    check(input.thread_id, snowflake, 'thread ID');
    if (input.thread_id === input.channel_id) throw new DiscordError('PUBLIC_THREAD_REQUIRED');
    return this.enqueue({ ...input, mode: 'reply' });
  }
  async send(input: any) {
    if (
      !input ||
      Object.keys(input).some(
        (key) =>
          ![
            'channel_id',
            'server_id',
            'discord_account_id',
            'operation_id',
            'prompt',
            'agent_id',
          ].includes(key)
      )
    )
      throw new DiscordError('SEND_ARGUMENTS_INVALID');
    return this.enqueue({ ...input, mode: 'send' });
  }
  private async enqueue(input: any) {
    this.path(input.operation_id);
    const existing = await readFile(this.path(input.operation_id), 'utf8').then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      }
    );
    if (
      !existing &&
      !this.active.has(input.operation_id) &&
      (this.closing || this.active.size >= (this.config.maxOperations ?? 4))
    )
      throw new DiscordError(this.closing ? 'SERVICE_STOPPING' : 'OPERATION_CAPACITY');
    const reserved = !existing && !this.active.has(input.operation_id);
    if (reserved) this.active.add(input.operation_id);
    this.preparations.set(input.operation_id, (this.preparations.get(input.operation_id) ?? 0) + 1);
    const task = this.prepare(input);
    this.workers.add(task);
    try {
      return await task;
    } finally {
      this.workers.delete(task);
      const remaining = this.preparations.get(input.operation_id)! - 1;
      if (remaining) this.preparations.set(input.operation_id, remaining);
      else {
        this.preparations.delete(input.operation_id);
        if (!this.background.has(input.operation_id)) this.active.delete(input.operation_id);
      }
    }
  }
  private async verifyThreadCreate(t: AdmittedTarget, prompt: string) {
    const { permissions: p } = await this.reader!(t, {
      action: 'permissions',
      channelId: t.channelId,
    });
    if (
      !p ||
      p.channelId !== t.channelId ||
      p.guildId !== t.guildId ||
      p.isDm !== false ||
      ![0, 5].includes(p.channelType) ||
      !Array.isArray(p.permissions) ||
      ![
        'ViewChannel',
        'SendMessages',
        'ReadMessageHistory',
        'CreatePublicThreads',
        'SendMessagesInThreads',
        ...(prompt.length > 2000 ? ['AttachFiles'] : []),
      ].every((v) => p.permissions.includes(v))
    )
      throw new DiscordError('THREAD_PERMISSIONS_DENIED');
    await this.config.access.assert(t);
  }
  private async verifyDestination(t: AdmittedTarget, id: string, prompt: string) {
    if (id !== t.channelId) return this.verifyReply(t, id, prompt);
    const c = await this.info(t, id, true);
    const { permissions: p } = await this.reader!(t, { action: 'permissions', channelId: id });
    if (
      ![0, 5].includes(c.type) ||
      !p ||
      p.channelId !== id ||
      p.guildId !== t.guildId ||
      p.channelType !== c.type ||
      p.isDm !== false ||
      !Array.isArray(p.permissions) ||
      ![
        'ViewChannel',
        'SendMessages',
        'ReadMessageHistory',
        ...(prompt.length > 2000 ? ['AttachFiles'] : []),
      ].every((v) => p.permissions.includes(v))
    )
      throw new DiscordError('CHANNEL_PERMISSIONS_DENIED');
    return this.ordinaryRoute(t, id);
  }
  private async verifyReply(t: AdmittedTarget, id: string, prompt: string) {
    await this.info(t, t.channelId, true);
    const thread = await this.info(t, id);
    if (id === t.channelId || ![10, 11].includes(thread.type))
      throw new DiscordError('PUBLIC_THREAD_REQUIRED');
    if (
      thread.thread_metadata?.locked !== false ||
      typeof thread.thread_metadata?.archived !== 'boolean'
    )
      throw new DiscordError('THREAD_LOCKED_OR_UNVERIFIED');
    const permissions = await this.reader!(t, { action: 'permissions', channelId: id });
    const p = permissions.permissions;
    if (
      !p ||
      p.channelId !== id ||
      p.guildId !== t.guildId ||
      p.isDm !== false ||
      p.channelType !== thread.type ||
      !Array.isArray(p.permissions) ||
      ![
        'ViewChannel',
        'SendMessagesInThreads',
        'ReadMessageHistory',
        ...(prompt.length > 2000 ? ['AttachFiles'] : []),
      ].every((name) => p.permissions.includes(name))
    )
      throw new DiscordError('THREAD_PERMISSIONS_DENIED');
    return this.ordinaryRoute(t, id);
  }
  private readonly background = new Set<string>();
  private async claimSession(key: string, operation: string) {
    const path = join(
      this.config.stateDir,
      'session-' + createHash('sha256').update(key).digest('hex') + '.lock'
    );
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new DiscordError('SESSION_BUSY_OR_UNCERTAIN');
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ operation_id: operation, owner: this.owner }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(this.config.stateDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    let released = false;
    return async () => {
      if (released) return;
      await rm(path);
      released = true;
      const directory = await open(this.config.stateDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
  }
  private async prepare(input: any) {
    const replying = input.mode === 'reply';
    const sending = input.mode === 'send';
    assertServiceProvenance();
    const t = await this.target(input);
    const path = this.path(input.operation_id);

    if (
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      new TextEncoder().encode(input.prompt).length > 1024 * 1024 ||
      input.prompt.includes('\0') ||
      new TextDecoder().decode(new TextEncoder().encode(input.prompt)) !== input.prompt
    )
      throw new Error('Invalid prompt');
    if (input.mode === 'new_thread') {
      if (
        typeof input.thread_name !== 'string' ||
        !input.thread_name.trim() ||
        input.thread_name.length > 100 ||
        [...input.thread_name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        input.thread_name.startsWith('-') ||
        input.thread_id !== undefined
      )
        throw new Error('Invalid thread_name or thread_id');
    }
    checkModel(input.model);
    checkForkSource(input.fork_from_session_key, t.agentId);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          t,
          input.mode,
          input.thread_name,
          input.thread_id,
          input.prompt,
          ...(input.model !== undefined ? [input.model] : []),
          ...(input.fork_from_session_key !== undefined
            ? [{ fork_from_session_key: input.fork_from_session_key }]
            : []),
          ...(input.source !== undefined ? [{ source: input.source }] : []),
        ])
      )
      .digest('hex');
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const state = await lstat(this.config.stateDir);
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077) !== 0)
      throw new Error('State directory must be private (0700) and not a symlink');
    const syncDirectory = async () => {
      const directory = await open(this.config.stateDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    // Exclusive durable claim: never replay a write, even after process failure.
    let file;
    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: Operation;
      try {
        previous = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        throw new Error(
          'Operation is being reserved or needs operator recovery; do not retry with a new ID'
        );
      }
      assertOperationVersion(previous);
      if (previous.fingerprint !== fingerprint)
        throw new Error('Operation ID already used with different arguments');
      await assertTargetAllowed(this.config, t, previous.thread_id);
      return this.publicResult(previous);
    }
    const op: Operation = {
      schema_version: operationSchemaVersion,
      fingerprint,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.fork_from_session_key !== undefined
        ? { fork_from_session_key: input.fork_from_session_key, fork_status: 'pending' as const }
        : {}),
      agent_id: t.agentId,
      server_id: t.guildId,
      discord_account_id: t.accountId,
      agent_transport: 'sdk',
      agent_idempotency_key:
        'discord-run-' +
        createHash('sha256')
          .update(JSON.stringify([input.operation_id]))
          .digest('hex'),
      ...(replying
        ? { kind: 'thread_reply' as const }
        : sending
          ? { kind: 'channel_message' as const }
          : {}),
      owner: this.owner,
      request_status: 'pending',
      request_verified: false,
      request_message_ids: [],
      operation_id: input.operation_id,
      channel_id: t.channelId,
      status: input.mode === 'new_thread' ? 'creating' : 'created',
      member_status:
        input.mode === 'new_thread' && this.config.threadMember ? 'pending' : 'disabled',
      member_verified: false,
    };
    try {
      await file.writeFile(JSON.stringify(op));
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory();
    let saves = Promise.resolve();
    const save = () => {
      const snapshot = JSON.stringify(op);
      const saved = saves.then(async () => {
        const temporary = path + '.tmp';
        const handle = await open(temporary, 'w', 0o600);
        try {
          await handle.writeFile(snapshot);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        await syncDirectory();
      });
      saves = saved.catch(() => undefined);
      return saved;
    };
    let releaseSession: (() => Promise<void>) | undefined;
    let dispatched = false;
    let createDispatched = false;
    try {
      if (!this.publishRequest) throw new DiscordError('REQUEST_PUBLISHER_REQUIRED');
      if (input.fork_from_session_key !== undefined && !this.agent?.forkSession)
        throw new DiscordError('FORK_UNSUPPORTED');
      await this.agent!.ready();
      const parent = await this.info(t, t.channelId, true);
      if ([15, 16].includes(parent.type)) throw new DiscordError('FORUM_MEDIA_WRITES_UNSUPPORTED');
      let id = sending ? input.channel_id : input.thread_id;
      if (replying || sending) {
        op.session_key = replying
          ? await this.verifyReply(t, id, input.prompt)
          : await this.verifyDestination(t, id, input.prompt);
        if (!sending) op.thread_id = id;
        op.discord_url = 'https://discord.com/channels/' + t.guildId + '/' + id;
        releaseSession = await this.claimSession(op.session_key, input.operation_id);
        await save();
      }
      if (input.mode === 'new_thread') {
        await this.verifyThreadCreate(t, input.prompt);
        await this.ordinaryRoute(t, t.channelId);
        createDispatched = true;
        op.thread_create_transport = 'gateway';
        await save();
        const created = await this.invokeThread!(
          t,
          input.thread_name,
          input.operation_id,
          async (messageId) => {
            op.starter_message_id = messageId;
            await save();
          }
        );
        id = created.thread?.id;
        check(id, snowflake, 'created thread ID');
        if (id === t.channelId) throw new DiscordError('CREATED_THREAD_ID_INVALID', true);
        if (!sending) op.thread_id = id;
        op.discord_url = 'https://discord.com/channels/' + t.guildId + '/' + id;
        op.status = created.partial ? 'creation_partial' : 'created';
        await save();
        if (created.partial) {
          op.recovery =
            'Thread created with partial result. Inspect it; no agent turn was started.';
          await save();
          return this.publicResult(op);
        }
      }
      await this.info(t, id);
      if (!sending) op.thread_id = id;
      op.discord_url = 'https://discord.com/channels/' + t.guildId + '/' + id;
      op.session_key = await this.ordinaryRoute(t, id);
      if (!replying && input.fork_from_session_key !== undefined) {
        releaseSession = await this.claimSession(op.session_key, input.operation_id);
        op.fork_status = 'forking';
        await save();
        try {
          await this.config.access.assert(t);
          await this.agent!.forkSession!(
            op.session_key,
            input.fork_from_session_key,
            t.agentId,
            input.model
          );
          op.fork_status = 'completed';
        } catch (error) {
          const known = error instanceof DiscordError && !error.uncertain;
          op.fork_status = known ? 'failed' : 'unknown';
          op.fork_error_code = error instanceof DiscordError ? error.code : 'FORK_OUTCOME_UNKNOWN';
          throw new DiscordError(op.fork_error_code, !known);
        }
        await save();
      }
      if (!replying && input.model !== undefined && input.fork_from_session_key === undefined) {
        if (!this.agent?.selectModel) throw new DiscordError('MODEL_SELECTION_UNSUPPORTED');
        try {
          await this.config.access.assert(t);
          await this.agent.selectModel(op.session_key, input.model);
        } catch (error) {
          op.model_error = error instanceof Error ? error.message : 'Model selection failed';
          throw new DiscordError('MODEL_SELECTION_FAILED');
        }
        await save();
      }
      if (input.mode === 'new_thread' && this.config.threadMember) {
        op.member_status = 'adding';
        await save();
        try {
          await this.verifyDestination(t, id, input.prompt);
          await this.addThreadMember!(t, id);
          op.member_status = 'verified';
          op.member_verified = true;
        } catch (error) {
          op.member_status =
            error instanceof DiscordError && !error.uncertain ? 'failed' : 'unknown';
          op.member_error_code =
            error instanceof DiscordError ? error.code : 'THREAD_MEMBER_UNVERIFIED';
          await save();
          throw new DiscordError('THREAD_MEMBER_NOT_VERIFIED');
        }
        await save();
      }
      await this.verifyDestination(t, id, input.prompt);
      op.request_status = 'publishing';
      await save();
      try {
        await this.publishRequest!(
          t,
          id,
          input.prompt,
          input.operation_id,
          async (messageId) => {
            op.request_message_ids = [messageId];
            op.request_status = 'sent';
            await save();
          },
          input.mode === 'new_thread',
          input.source
        );
        if (!op.request_message_ids?.length)
          throw new DiscordError('REQUEST_RESULT_UNVERIFIED', true);
        op.request_status = 'verified';
        op.request_verified = true;
      } catch (error) {
        op.request_status = op.request_message_ids?.length
          ? 'partial'
          : error instanceof DiscordError && !error.uncertain
            ? 'failed'
            : 'unknown';
        throw error;
      }
      op.status = 'queued';
      op.generation_status = 'queued';
      await save();
      const accepted = this.publicResult(op);
      this.background.add(input.operation_id);
      const worker = (async () => {
        // Handoff is independent of generation and of any transport abort signal.
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          op.status = 'running';
          op.generation_status = 'running';
          await save();
          await this.verifyDestination(t, id, input.prompt);
          dispatched = true;
          const result: any = await this.agent!.run(
            {
              message: input.prompt,
              agentId: t.agentId,
              sessionKey: op.session_key!,
              threadId: id,
              accountId: t.accountId,
              idempotencyKey: op.agent_idempotency_key!,
            },
            async (receipt) => {
              if (
                receipt.sessionKey !== op.session_key ||
                receipt.agentId !== t.agentId ||
                !receipt.runId ||
                (op.run_id && receipt.runId !== op.run_id)
              )
                throw new DiscordError('SDK_ACCEPTANCE_IDENTITY_MISMATCH', true);
              op.run_id = receipt.runId;
              op.generation_status = 'accepted';
              await save();
              let cancellation: Promise<void> | undefined;
              this.cancellations.set(input.operation_id, () => {
                cancellation ??= (async () => {
                  op.cancellation_status = 'requested';
                  await save();
                  try {
                    await this.agent!.cancel(receipt);
                    op.cancellation_status = 'acknowledged';
                  } catch (error) {
                    op.cancellation_status = 'unknown';
                    await save();
                    throw error;
                  }
                  await save();
                })();
                return cancellation;
              });
            }
          );
          op.run_id = typeof result?.runId === 'string' ? result.runId : op.run_id;
          const delivery =
            result?.deliveryStatus ??
            result?.result?.deliveryStatus ??
            result?.delivery ??
            result?.result?.delivery;
          const deliveryStatus = typeof delivery === 'string' ? delivery : delivery?.status;
          op.delivery_status = [
            'sent',
            'delivered',
            'failed',
            'partial_failed',
            'suppressed',
          ].includes(deliveryStatus)
            ? deliveryStatus
            : 'unverified';
          op.delivery_verified = false;
          const messageId = delivery?.messageId;
          if (typeof messageId === 'string' && snowflake.test(messageId)) {
            op.message_id = messageId;
            // One exact-ID read, never a text match or a scan of unrelated messages.
            try {
              const readback = await this.reader!(t, {
                action: 'read',
                channelId: id,
                messageId,
                limit: 1,
              });
              op.delivery_verified =
                readback.channelId === id &&
                Array.isArray(readback.messages) &&
                readback.messages.some(
                  (m: any) => m.id === messageId && (!m.channel_id || m.channel_id === id)
                );
            } catch {
              /* Delivery may have succeeded; a failed read does not authorize retry. */
            }
          }
          op.status = ['ok', 'completed'].includes(result?.status)
            ? 'completed'
            : ['error', 'aborted'].includes(result?.status) || result?.ok === false
              ? 'run_failed'
              : 'run_unknown';
          op.generation_status = op.status;
          op.handoff = 'Continue on Discord: ' + op.discord_url;
          if (
            (op.delivery_status !== 'sent' && op.delivery_status !== 'delivered') ||
            !op.delivery_verified
          )
            op.handoff +=
              ' (first-response delivery ' +
              op.delivery_status +
              '; ' +
              (op.delivery_verified ? 'message verified' : 'not independently verified') +
              ')';
          if (op.status !== 'completed')
            op.recovery =
              'Inspect the existing conversation before authorizing a new turn. Never repeat this operation with a new ID blindly.';
          await save();
        } catch (error) {
          op.status =
            dispatched && !(error instanceof DiscordError && !error.uncertain)
              ? 'run_unknown'
              : 'run_failed';
          op.generation_status = op.status;
          op.error_code = error instanceof DiscordError ? error.code : 'UNVERIFIED_RESULT';
          await save();
        } finally {
          // Ambiguous dispatch retains the durable claim for operator recovery.
          if (!dispatched || op.status === 'completed') await releaseSession?.();
        }
      })();
      // Handle failures saving state or cleaning files as well as agent rejection.
      const owned = worker
        .catch(() => {
          log('Discord worker failed; operation requires inspection');
        })
        .finally(() => {
          this.cancellations.delete(input.operation_id);
          this.background.delete(input.operation_id);
          this.active.delete(input.operation_id);
          this.workers.delete(owned);
        });
      this.workers.add(owned);
      return accepted;
    } catch (error) {
      op.error_code = error instanceof DiscordError ? error.code : 'UNVERIFIED_RESULT';
      op.status = dispatched
        ? 'run_unknown'
        : op.thread_id || sending
          ? 'run_failed'
          : createDispatched
            ? 'creation_unknown'
            : 'run_failed';
      op.recovery =
        'Inspect Discord and gateway logs. This operation is never automatically replayed; preserve its ID. An interrupted creating/running record also requires inspection.';
      await save();
    } finally {
      if (
        !this.background.has(input.operation_id) &&
        !['unknown', 'partial', 'publishing', 'sent'].includes(op.request_status ?? '') &&
        !['forking', 'unknown'].includes(op.fork_status ?? '')
      )
        await releaseSession?.();
    }
    return this.publicResult(op);
  }
}
