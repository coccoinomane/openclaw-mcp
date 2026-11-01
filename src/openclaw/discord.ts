import {
  ChannelCreation,
  DiscordError,
  type CreationPolicy,
  type ChannelInvoker,
  type AdmittedTarget,
} from './discord-channels.js';
import type { DiscordReader } from './discord-read.js';
import { log } from '../utils/logger.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface DiscordConfig {
  executable: string;
  stateDir: string;
  creationPolicies?: CreationPolicy[];
  cliGatewayInstance?: string;
  gatewayReadsEnabled?: boolean;
  cliTimeoutMs?: number;
  acknowledgeInboundRouting?: boolean;
  targets: Array<{
    name: string;
    guildId: string;
    channelId: string;
    accountId: string;
    agentId: string;
    normalRouting?: boolean;
  }>;
}
export type CliRunner = (executable: string, args: string[], timeout: number) => Promise<unknown>;
const snowflake = /^[1-9][0-9]{16,19}$/;
const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function check(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid ' + label);
}
export function loadDiscordConfig(env = process.env): DiscordConfig | undefined {
  if (env.MCP_DISCORD_ENABLED !== 'true') return undefined;
  const config: DiscordConfig = {
    executable: env.MCP_DISCORD_EXECUTABLE || 'openclaw',
    stateDir: env.MCP_DISCORD_STATE_DIR || '',
    targets: JSON.parse(env.MCP_DISCORD_TARGETS || '[]'),
    creationPolicies:
      env.MCP_DISCORD_CHANNEL_CREATE_ENABLED === 'true'
        ? JSON.parse(env.MCP_DISCORD_CREATION_POLICIES || '[]')
        : undefined,
    cliGatewayInstance: env.MCP_DISCORD_CLI_GATEWAY_INSTANCE,
    gatewayReadsEnabled: env.MCP_DISCORD_GATEWAY_READS_ENABLED === 'true',
    cliTimeoutMs: env.MCP_DISCORD_CLI_TIMEOUT_MS
      ? Number(env.MCP_DISCORD_CLI_TIMEOUT_MS)
      : undefined,
    acknowledgeInboundRouting: env.MCP_DISCORD_ACKNOWLEDGE_INBOUND_ROUTING === 'true',
  };
  validateConfig(config);
  return config;
}
function validateConfig(config: DiscordConfig) {
  if (
    config.cliTimeoutMs !== undefined &&
    (!Number.isInteger(config.cliTimeoutMs) ||
      config.cliTimeoutMs < 1000 ||
      config.cliTimeoutMs > 180000)
  )
    throw new Error('MCP_DISCORD_CLI_TIMEOUT_MS must be an integer from 1000 to 180000');
  if (!isAbsolute(config.stateDir)) throw new Error('MCP_DISCORD_STATE_DIR must be absolute');
  if (!config.executable || config.executable.includes('\0')) throw new Error('Invalid executable');
  if (
    !Array.isArray(config.targets) ||
    (!config.targets.length && !config.creationPolicies?.length)
  )
    throw new Error('Discord allowlist is empty');
  if (config.creationPolicies) {
    if (
      !config.creationPolicies.length ||
      !config.cliGatewayInstance ||
      config.acknowledgeInboundRouting !== true
    )
      throw new DiscordError('CREATION_ROUTING_ACKNOWLEDGEMENT_REQUIRED');
    const policies = new Set<string>();
    for (const p of config.creationPolicies) {
      check(p.name, slug, 'creation policy');
      check(p.guildId, snowflake, 'guild ID');
      check(p.categoryId, snowflake, 'category ID');
      check(p.accountId, slug, 'account');
      check(p.agentId, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'agent');
      if (p.instance !== config.cliGatewayInstance || policies.has(p.name))
        throw new DiscordError('CREATION_GATEWAY_MISMATCH');
      policies.add(p.name);
    }
  }
  const names = new Set<string>();
  for (const t of config.targets) {
    check(t.name, slug, 'target name');
    check(t.guildId, snowflake, 'guild ID');
    check(t.channelId, snowflake, 'channel ID');
    check(t.accountId, slug, 'account');
    check(t.agentId, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'agent');
    if (t.name.startsWith('created-')) throw new Error('Reserved target prefix');
    if (names.has(t.name)) throw new Error('Duplicate target name');
    names.add(t.name);
  }
}
export const runCli: CliRunner = (executable, args, timeout) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    let firstStdoutMs: number | null = null;
    let exitMs: number | null = null;
    let closeMs: number | null = null;
    // Inherit provenance unchanged, including OPENCLAW_SHELL and caller identity.
    const child = execFile(
      executable,
      args,
      { shell: false, env: process.env, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const callbackMs = elapsed();
        let parsed: any;
        let validJson = false;
        try {
          parsed = JSON.parse(stdout);
          validJson = true;
        } catch {
          /* Never log process output. */
        }
        if (error) {
          const timedOut = error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const classification = timedOut ? 'CLI_TIMEOUT' : 'CLI_EXIT_NONZERO';
          log(
            'Discord CLI diagnostic ' +
              JSON.stringify({
                classification,
                elapsed_ms: callbackMs,
                first_stdout_ms: firstStdoutMs,
                exit_ms: exitMs,
                close_ms: closeMs,
                callback_ms: callbackMs,
                signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(error.signal ?? '')
                  ? error.signal
                  : error.signal
                    ? 'OTHER'
                    : null,
                code:
                  typeof error.code === 'number'
                    ? error.code
                    : ['ENOENT', 'EACCES', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(
                          error.code ?? ''
                        )
                      ? error.code
                      : error.code
                        ? 'OTHER'
                        : null,
                stdout_bytes: new TextEncoder().encode(stdout).length,
                stderr_bytes: new TextEncoder().encode(stderr).length,
                valid_json: validJson,
              })
          );
          // Keep known identities for recovery, but never accept failed stdout as success.
          if (validJson && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            resolve({ ...parsed, _cliFailure: true, _cliCode: classification });
          } else {
            reject(new DiscordError(classification, true));
          }
          return;
        }
        if (validJson) resolve(parsed);
        else reject(new DiscordError('CLI_INVALID_JSON', true));
      }
    );
    child.stdout?.once('data', () => {
      firstStdoutMs = elapsed();
    });
    child.once?.('exit', () => {
      exitMs = elapsed();
    });
    // execFile invokes its callback from close; record close before that listener.
    child.prependOnceListener?.('close', () => {
      closeMs = elapsed();
    });
    // EOF is hygiene for noninteractive commands, not a proven timeout fix.
    // These invocations never consume prompts from stdin. Deliver EOF to CLI startup.
    if (args[0] === 'message' || (args[0] === 'agent' && args.includes('--message-file')))
      child.stdin?.end();
  });
function payload(value: any): any {
  const result = value?.payload ?? value;
  const failed =
    value?._cliFailure ||
    value?.ok === false ||
    value?.isError === true ||
    result?.ok === false ||
    result?.isError === true;
  // A known thread survives a failing exit; never hide its identity or run into it.
  if (failed && result?.thread?.id) return { ...result, partial: true };
  if (!result || failed) throw new DiscordError(value?._cliCode ?? 'CLI_ACTION_REJECTED', true);
  return result;
}
interface Operation {
  fingerprint: string;
  status:
    | 'creating'
    | 'creation_unknown'
    | 'created'
    | 'creation_partial'
    | 'running'
    | 'completed'
    | 'run_failed'
    | 'run_unknown';
  operation_id: string;
  target: string;
  channel_id?: string;
  session_key?: string;
  discord_url?: string;
  run_id?: string;
  delivery_status?: string;
  delivery_verified?: boolean;
  message_id?: string;
  generation_status?: string;
  handoff?: string;
  recovery?: string;
  error_code?: string;
}
/** Trusted adapter must inspect live inbound routing, including runtime bindings.
 * Static config, channel metadata and session enumeration are insufficient.
 * Optional extra check for fresh threads; existing-thread continuation is not supported.
 */
export type DiscordRouteResolver = (
  target: AdmittedTarget,
  channelId: string
) => Promise<{
  channelId: string;
  guildId: string;
  accountId: string;
  agentId: string;
  sessionKey: string;
  kind: 'ordinary' | 'bound' | 'subagent' | 'unknown';
}>;
export class DiscordService {
  private readonly creation?: ChannelCreation;
  constructor(
    readonly config: DiscordConfig,
    private readonly runner: CliRunner = runCli,
    invoke?: ChannelInvoker,
    private readonly resolveRoute?: DiscordRouteResolver,
    private readonly reader?: DiscordReader
  ) {
    validateConfig(config);
    if (config.creationPolicies) {
      if (!invoke) throw new DiscordError('CREATION_ADAPTER_REQUIRED');
      this.creation = new ChannelCreation(
        config.stateDir,
        config.creationPolicies,
        invoke,
        async (p, id) => (await this.readInfo({ ...p, channelId: id }, id)).channel
      );
    }
  }
  private async ordinaryRoute(t: AdmittedTarget, channelId: string) {
    if (!this.resolveRoute) return 'agent:' + t.agentId + ':discord:channel:' + channelId;
    let route;
    try {
      route = await this.resolveRoute(t, channelId);
    } catch {
      throw new DiscordError('ROUTE_UNVERIFIED');
    }
    if (
      !route ||
      route.channelId !== channelId ||
      route.guildId !== t.guildId ||
      route.accountId !== t.accountId
    )
      throw new DiscordError('ROUTE_UNVERIFIED');
    if (route.kind !== 'ordinary') throw new DiscordError('NONORDINARY_ROUTE_DENIED');
    if (
      route.agentId !== t.agentId ||
      route.sessionKey !== 'agent:' + t.agentId + ':discord:channel:' + channelId
    )
      throw new DiscordError('ROUTE_MISMATCH');
    return route.sessionKey;
  }
  async createChannel(input: any) {
    if (!this.creation) throw new DiscordError('CHANNEL_CREATION_DISABLED');
    return this.creation.create(input);
  }
  private async target(name: unknown) {
    const targets = [...this.config.targets, ...((await this.creation?.admitted()) ?? [])];
    const t = targets.find((item) => item.name === name);
    if (!t) throw new Error('Target is not allowlisted');
    return t;
  }
  private async cli(t: DiscordConfig['targets'][number], args: string[]) {
    return payload(
      await this.runner(
        this.config.executable,
        ['message', ...args, '--channel', 'discord', '--account', t.accountId, '--json'],
        this.config.cliTimeoutMs ?? 30000
      )
    );
  }
  private async readInfo(t: AdmittedTarget, id: string) {
    check(id, snowflake, 'channel ID');
    return this.reader && this.config.gatewayReadsEnabled === true && this.config.cliGatewayInstance
      ? this.reader(t, { action: 'channel-info', channelId: id })
      : this.cli(t, ['channel', 'info', '--target', 'channel:' + id]);
  }
  private verifyChannel(t: AdmittedTarget, id: string, c: any, parent = false) {
    if (!c || c.id !== id || c.guild_id !== t.guildId)
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
    return this.verifyChannel(t, id, (await this.readInfo(t, id)).channel, parent);
  }
  async channels() {
    const channels = [];
    const targets = [...this.config.targets, ...((await this.creation?.admitted()) ?? [])];
    // One live list per guild/account/agent, scoped to this request only.
    const lists = new Map<string, Map<string, any>>();
    for (const t of targets) {
      const key = JSON.stringify([t.guildId, t.accountId, t.agentId]);
      if (lists.has(key)) continue;
      const data =
        this.reader && this.config.gatewayReadsEnabled === true && this.config.cliGatewayInstance
          ? await this.reader(t, { action: 'channel-list' })
          : await this.cli(t, ['channel', 'list', '--guild-id', t.guildId]);
      if (
        !data ||
        data.ok === false ||
        data.isError ||
        data.partial ||
        !Array.isArray(data.channels)
      )
        throw new DiscordError('CHANNEL_LIST_UNVERIFIED');
      const byId = new Map<string, any>();
      for (const c of data.channels) {
        if (!c || typeof c.id !== 'string' || !snowflake.test(c.id) || byId.has(c.id))
          throw new DiscordError('CHANNEL_LIST_UNVERIFIED');
        byId.set(c.id, c);
      }
      lists.set(key, byId);
    }
    for (const t of targets) {
      const list = lists.get(JSON.stringify([t.guildId, t.accountId, t.agentId]))!;
      const c = this.verifyChannel(t, t.channelId, list.get(t.channelId), true);
      const category = c.parent_id == null ? undefined : list.get(c.parent_id);
      if (
        c.parent_id != null &&
        (!category ||
          category.id !== c.parent_id ||
          category.guild_id !== t.guildId ||
          category.type !== 4)
      )
        throw new DiscordError('CATEGORY_VERIFICATION_FAILED');
      if (
        typeof c.name !== 'string' ||
        (c.topic != null && typeof c.topic !== 'string') ||
        (category && typeof category.name !== 'string')
      )
        throw new DiscordError('CHANNEL_METADATA_UNVERIFIED');
      channels.push({
        target: t.name,
        channel_id: c.id,
        guild_id: t.guildId,
        name: c.name,
        topic: c.topic ?? null,
        category_id: c.parent_id ?? null,
        category_name: category?.name ?? null,
        discord_url: 'https://discord.com/channels/' + t.guildId + '/' + c.id,
      });
    }
    return {
      channels,
      creation_policies: (this.config.creationPolicies ?? []).map((p) => ({
        policy: p.name,
        guild_id: p.guildId,
        category_id: p.categoryId,
        agent: p.agentId,
      })),
    };
  }
  async threads(input: any) {
    const t = await this.target(input.target);
    if (input.archived !== undefined && typeof input.archived !== 'boolean')
      throw new Error('Invalid archived flag');
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new Error('Invalid limit');
    if (
      input.before !== undefined &&
      (typeof input.before !== 'string' ||
        !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/.test(input.before) ||
        !Number.isFinite(Date.parse(input.before)))
    )
      throw new Error('Invalid archive timestamp');
    if (!input.archived && (input.before !== undefined || input.limit !== undefined))
      throw new Error('Pagination is only supported for archived public threads');
    await this.info(t, t.channelId, true);
    const args = ['thread', 'list', '--guild-id', t.guildId, '--channel-id', t.channelId];
    if (input.archived) args.push('--include-archived');
    if (input.before) args.push('--before', input.before);
    if (input.limit) args.push('--limit', String(input.limit));
    const data = await this.cli(t, args);
    const raw = Array.isArray(data.threads) ? data : data.threads;
    if (!raw || !Array.isArray(raw.threads)) throw new Error('Unexpected thread list');
    const threads = raw.threads
      .filter(
        (c: any) =>
          snowflake.test(c.id) &&
          c.guild_id === t.guildId &&
          c.parent_id === t.channelId &&
          [10, 11, 12].includes(c.type)
      )
      .map((c: any) => ({
        channel_id: c.id,
        name: c.name,
        archived: c.thread_metadata?.archived,
        archive_timestamp: c.thread_metadata?.archive_timestamp,
        discord_url: 'https://discord.com/channels/' + t.guildId + '/' + c.id,
      }));
    return {
      threads,
      has_more: raw.has_more === true,
      next_before:
        raw.has_more === true ? raw.threads.at(-1)?.thread_metadata?.archive_timestamp : undefined,
      pagination: input.archived ? 'archived_public_timestamp' : 'none',
    };
  }
  private path(id: unknown) {
    check(id, /^[a-zA-Z0-9_-]{16,100}$/, 'operation ID');
    return join(this.config.stateDir, id + '.json');
  }
  async status(id: unknown) {
    const result: Operation = JSON.parse(await readFile(this.path(id), 'utf8'));
    if ((result as any).kind === 'channel_create') {
      if (
        !this.creation ||
        !this.config.creationPolicies?.some((p) => p.name === (result as any).policy)
      )
        throw new DiscordError('CREATION_POLICY_DENIED');
      return this.creation.publicResult(result);
    }
    await this.target(result.target);
    return this.publicResult(result);
  }
  private publicResult(op: Operation) {
    const result: Partial<Operation> = { ...op };
    delete result.fingerprint;
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
    if (input.mode !== 'new_thread') throw new DiscordError('CONTINUE_UNSUPPORTED');
    const t = await this.target(input.target);
    const path = this.path(input.operation_id);

    if (
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      new TextEncoder().encode(input.prompt).length > 1024 * 1024 ||
      input.prompt.includes('\0')
    )
      throw new Error('Invalid prompt');
    if (input.mode === 'new_thread') {
      if (
        typeof input.title !== 'string' ||
        !input.title.trim() ||
        input.title.length > 100 ||
        [...input.title].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        input.title.startsWith('-') ||
        input.channel_id !== undefined
      )
        throw new Error('Invalid thread title or channel_id');
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([t, input.mode, input.title, input.channel_id, input.prompt]))
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
      if (previous.fingerprint !== fingerprint)
        throw new Error('Operation ID already used with different arguments');
      return this.publicResult(previous);
    }
    const op: Operation = {
      fingerprint,
      operation_id: input.operation_id,
      target: t.name,
      status: input.mode === 'new_thread' ? 'creating' : 'created',
    };
    try {
      await file.writeFile(JSON.stringify(op));
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory();
    const save = async () => {
      const temporary = path + '.tmp';
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(op));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      await syncDirectory();
    };
    let dir: string | undefined;
    let dispatched = false;
    let createDispatched = false;
    try {
      if (this.config.acknowledgeInboundRouting !== true || t.normalRouting !== true)
        throw new DiscordError('NORMAL_ROUTING_ACKNOWLEDGEMENT_REQUIRED');
      const parent = await this.info(t, t.channelId, true);
      if ([15, 16].includes(parent.type)) throw new DiscordError('FORUM_MEDIA_WRITES_UNSUPPORTED');
      let id = input.channel_id;
      if (input.mode === 'new_thread') {
        await this.ordinaryRoute(t, t.channelId);
        createDispatched = true;
        const created = await this.cli(t, [
          'thread',
          'create',
          '--target',
          'channel:' + t.channelId,
          '--thread-name',
          input.title,
        ]);
        id = created.thread?.id;
        check(id, snowflake, 'created thread ID');
        if (id === t.channelId) throw new DiscordError('CREATED_THREAD_ID_INVALID', true);
        op.channel_id = id;
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
      op.channel_id = id;
      op.discord_url = 'https://discord.com/channels/' + t.guildId + '/' + id;
      op.session_key = await this.ordinaryRoute(t, id);
      dir = await mkdtemp(join(tmpdir(), 'openclaw-mcp-'));
      const promptFile = join(dir, 'prompt.txt');
      await writeFile(promptFile, input.prompt, { mode: 0o600 });
      op.status = 'running';
      await save();
      dispatched = true;
      const result: any = await this.runner(
        this.config.executable,
        [
          'agent',
          '--agent',
          t.agentId,
          '--session-key',
          op.session_key,
          '--message-file',
          promptFile,
          '--deliver',
          '--reply-channel',
          'discord',
          '--reply-to',
          'channel:' + id,
          '--reply-account',
          t.accountId,
          '--timeout',
          '600',
          '--json',
        ],
        630000
      );
      op.run_id = typeof result?.runId === 'string' ? result.runId : undefined;
      const delivery =
        result?.deliveryStatus ??
        result?.result?.deliveryStatus ??
        result?.delivery ??
        result?.result?.delivery;
      const deliveryStatus = typeof delivery === 'string' ? delivery : delivery?.status;
      op.delivery_status = ['sent', 'delivered', 'failed', 'partial_failed', 'suppressed'].includes(
        deliveryStatus
      )
        ? deliveryStatus
        : 'unverified';
      op.delivery_verified = false;
      const messageId = delivery?.messageId;
      if (typeof messageId === 'string' && snowflake.test(messageId)) {
        op.message_id = messageId;
        // One exact-ID read, never a text match or a scan of unrelated messages.
        try {
          const readback = await this.cli(t, [
            'read',
            '--target',
            'channel:' + id,
            '--message-id',
            messageId,
            '--limit',
            '1',
          ]);
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
      op.error_code = result?._cliFailure ? result._cliCode : undefined;
      op.status = result?._cliFailure
        ? result._cliCode === 'CLI_TIMEOUT'
          ? 'run_unknown'
          : 'run_failed'
        : ['ok', 'completed'].includes(result?.status)
          ? 'completed'
          : result?.status === 'error' || result?.ok === false
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
      op.error_code = error instanceof DiscordError ? error.code : 'UNVERIFIED_RESULT';
      op.status = dispatched
        ? 'run_unknown'
        : op.channel_id || input.mode === 'continue'
          ? 'run_failed'
          : createDispatched
            ? 'creation_unknown'
            : 'run_failed';
      op.recovery =
        'Inspect Discord and gateway logs. This operation is never automatically replayed; preserve its ID. An interrupted creating/running record also requires inspection.';
      await save();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    return this.publicResult(op);
  }
}
