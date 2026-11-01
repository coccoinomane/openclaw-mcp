import { assertTargetAllowed } from './discord-policy.js';
import { createHash } from 'node:crypto';
import { assertServiceProvenance, DiscordError, type AdmittedTarget } from './discord-channels.js';
import type { DiscordConfig } from './discord.js';

const snowflake = /^[1-9][0-9]{16,19}$/;
export type RequestPublisher = (
  target: AdmittedTarget,
  threadId: string,
  prompt: string,
  operation: string,
  sent: (messageId: string) => Promise<void>
) => Promise<void>;

/** Fixed bot POST + exact-ID GET. Native message/send has no public allowed-mentions field. */
export function requestPublisher(
  config: DiscordConfig,
  env = process.env,
  fetcher = fetch
): RequestPublisher | undefined {
  if (!config.threadMember) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.threadMember.accountId))
    throw new DiscordError('REQUEST_ACCOUNT_INVALID');
  const token = env.DISCORD_BOT_TOKEN;
  if (!token || /\s/.test(token)) throw new DiscordError('REQUEST_CREDENTIAL_MISSING');
  const account = config.threadMember.accountId;
  return async (target, threadId, prompt, operation, sent) => {
    assertServiceProvenance();
    assertTargetAllowed(config, target, threadId, 'REQUEST_SCOPE_DENIED');
    if (target.accountId !== account || !snowflake.test(threadId) || threadId === target.channelId)
      throw new DiscordError('REQUEST_SCOPE_DENIED');
    if (
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      prompt.includes('\0') ||
      new TextDecoder().decode(new TextEncoder().encode(prompt)) !== prompt ||
      new TextEncoder().encode(prompt).length > 1048576 ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(operation)
    )
      throw new DiscordError('REQUEST_ARGUMENTS_INVALID');
    const attachment = prompt.length > 2000;
    const content = attachment ? '' : prompt;
    const payload = {
      content,
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
      flags: 4,
      nonce: createHash('sha256').update(operation).digest('hex').slice(0, 25),
      enforce_nonce: true,
      ...(attachment ? { attachments: [{ id: 0, filename: 'richiesta.txt' }] } : {}),
    };
    let body: string | FormData = JSON.stringify(payload);
    if (attachment) {
      body = new FormData();
      body.set('payload_json', JSON.stringify(payload));
      body.set(
        'files[0]',
        new Blob([prompt], { type: 'text/plain;charset=utf-8' }),
        'richiesta.txt'
      );
    }
    const url = 'https://discord.com/api/v10/channels/' + threadId + '/messages';
    const request = async (method: 'POST' | 'GET', suffix = '') => {
      let response: Response;
      try {
        response = await fetcher(url + suffix, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: 'Bot ' + token,
            ...(method === 'POST' && !attachment ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(method === 'POST' ? { body } : {}),
        });
      } catch {
        throw new DiscordError('REQUEST_OUTCOME_UNKNOWN', true);
      }
      if (!response.ok)
        throw new DiscordError(
          'REQUEST_HTTP_' + response.status,
          method === 'GET' || ![400, 401, 403, 404, 429].includes(response.status)
        );
      try {
        // Discord responses are small; reject oversized/unbounded bodies without retaining them.
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const decoder = new TextDecoder();
        let text = '',
          bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 65536) throw new Error();
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel();
        }
        return JSON.parse(text);
      } catch {
        throw new DiscordError('REQUEST_RESULT_UNVERIFIED', true);
      }
    };
    const posted: any = await request('POST');
    if (typeof posted?.id !== 'string' || !snowflake.test(posted.id))
      throw new DiscordError('REQUEST_RESULT_UNVERIFIED', true);
    await sent(posted.id);
    const readback: any = await request('GET', '/' + posted.id);
    for (const message of [posted, readback]) {
      if (
        message.channel_id !== threadId ||
        message.id !== posted.id ||
        message.author?.bot !== true ||
        message.webhook_id ||
        message.content !== content ||
        message.mention_everyone !== false ||
        !Array.isArray(message.mentions) ||
        message.mentions.length ||
        !Array.isArray(message.mention_roles) ||
        message.mention_roles.length ||
        (attachment &&
          (!Array.isArray(message.attachments) ||
            message.attachments.length !== 1 ||
            message.attachments[0].filename !== 'richiesta.txt' ||
            message.attachments[0].size !== new TextEncoder().encode(prompt).length))
      )
        throw new DiscordError('REQUEST_READBACK_UNVERIFIED', true);
    }
    if (!snowflake.test(posted.author.id) || posted.author.id !== readback.author.id)
      throw new DiscordError('REQUEST_AUTHOR_UNVERIFIED', true);
  };
}
