# Discord setup and MCP Skills

## How Discord requests reach OpenClaw

The bridge does not launch or require the OpenClaw CLI. Discord agent execution, observation and explicit cancellation always use the official Gateway SDK. The remaining calls use fixed authenticated HTTP/REST adapters:

- **Discover and verify destinations:** Gateway HTTP `/tools/invoke` with the closed `message` read actions for channels, threads, permissions and exact-ID messages.
- **Create a thread:** the same Gateway HTTP endpoint with `message/thread-create` and an explicit parent `channelId`. Announcement parents need separate treatment: the call omits a starter message and does not establish correct type-10 announcement-thread creation.
- **Add the configured member and publish the original request:** Discord REST with the configured bot credential.
- **Run the agent and deliver its answer:** the SDK calls `agent` with the configured agent, canonical thread session key and Discord reply destination. Gateway owns answer delivery.

There is no transport selector or CLI fallback. See [SDK authentication and deployment](discord-sdk.md), the [remaining HTTP/REST inventory](discord-sdk.md#remaining-httprest-calls-and-sdk-feasibility), and the [historical audit](gateway-sdk-feasibility.md) for limits that a transport change does not solve.

## One Gateway connection per MCP service

One MCP deployment connects to one OpenClaw installation. Direct chat, discovery and Discord share the configured Gateway URL and credential. The Discord integration uses one bot account and can serve several agents and permitted Discord servers.

Use a separate MCP deployment for each additional OpenClaw installation or Discord bot account, with its own configuration and private state. Tool callers cannot select a different Gateway.

## Scope

Direct Ask OpenClaw continues to use the HTTP chat-completions endpoint. Responses include session_id and optional agent_id for conversation continuity. Discord tools are an optional service capability combining the Gateway SDK, Gateway HTTP calls and Discord REST calls. They do not create subagents.

The /mcp endpoint routes 2026-07-28 requests through the official createMcpHandler factory and Node adapter. The SDK's isLegacyRequest classifier sends existing stateful 2025 clients to the unchanged legacy transport. Legacy SSE and stdio remain supported. The official Skills extension is available on modern HTTP; stdio, SSE and legacy HTTP expose the same packaged files through resources/list and resources/read. This is a staged migration: stdio and SSE do not advertise the new protocol or extension methods.

Pinned packages: @modelcontextprotocol/server, core and client 2.4.0; @modelcontextprotocol/node 2.1.2; legacy @modelcontextprotocol/sdk 1.32.1. The client package is test-only.

## Operator configuration

The settings below apply to every Discord deployment. Complete [SDK service authentication](discord-sdk.md#service-authentication) before enabling writes.

Discord tools are absent unless MCP_DISCORD_ENABLED=true. Set these in the service's trusted environment, not tool input:

- MCP_DISCORD_SDK_AUTH: device (default) or explicitly authorized local-shared-token on literal loopback.
- MCP_DISCORD_SDK_STATE_DIR: private directory holding the pre-provisioned integration identity and, in device mode, its approved device token. Defaults to gateway-sdk inside MCP_DISCORD_STATE_DIR.
- MCP_DISCORD_STATE_DIR: required absolute path to a private, durable local directory. Preserve it across restarts. Run one service process per state directory; all its transports share that process. Do not share it across security principals or expose it as a static directory.
- MCP_DISCORD_TARGETS: legacy JSON array of objects with name, guildId, channelId, accountId and agentId. Each entry authorizes discovery for one parent and its actual threads, for one account and agent. Set normalRouting:true only for parents verified by the operator to route ordinary new threads and human replies to that agent/account; omit it or set false for special bound targets. Ask also requires MCP_DISCORD_ACKNOWLEDGE_INBOUND_ROUTING=true. Use concrete Discord IDs; wildcards are rejected.
- MCP_DISCORD_DISCOVERY_SCOPES: JSON array of explicit {guildId, accountId, agentId, normalRouting?} mappings, default []. Only these mappings enable dynamic guild discovery. Missing/empty scopes never expand legacy targets or creation policies to whole guilds. Duplicate mappings, unknown fields, malformed IDs and nonboolean normalRouting fail startup.
- MCP_DISCORD_CHANNEL_WHITELIST: JSON array of parent channel IDs, default []. Empty means all supported parents within explicit discovery scopes, plus configured legacy/admitted targets. A nonempty array narrows all of those sources.
- MCP_DISCORD_CHANNEL_BLACKLIST: JSON array of denied channel/thread IDs, default []. Blacklist takes precedence over the whitelist, legacy aliases and persisted admissions. A denied parent cannot be used to list or create threads. A denied thread cannot receive membership, request publication or generation through this service. These are exact IDs, not category-subtree rules.

For dynamic-only discovery, omit MCP_DISCORD_TARGETS or set it to []. Example (synthetic IDs):

```
MCP_DISCORD_DISCOVERY_SCOPES=[{"guildId":"700000000000000001","accountId":"bot","agentId":"main","normalRouting":true}]
MCP_DISCORD_CHANNEL_WHITELIST=[]
MCP_DISCORD_CHANNEL_BLACKLIST=["700000000000000003"]
```

Discovery fetches a fresh list on every call, once per guild/account/agent mapping. New channels appear without config edits; renames retain the target ID; deleted or inaccessible legacy targets are skipped. Dynamic IDs use the mapping hash and channel ID, never the display name. Existing aliases remain in discovery when their mapping overlaps a scope. Legacy TARGETS stays an additional explicitly authorized source, not a scope restriction: remove obsolete entries when migrating. Blacklist and whitelist checks apply to all sources and crafted target IDs before writes.

Text and announcement parents pass discovery/type validation, but fresh announcement-thread creation is not established without a starter message; use ordinary text parents for the supported new-thread workflow. Forum/media parents remain discoverable but reject asks. Categories, voice/stage channels and threads are not parent targets. Metadata with unverified guild/type/identity fails closed. An accessible category is required when parent metadata references it. Actual writes still read back the parent and new thread ancestry, require normalRouting:true and the global routing acknowledgement, and retain route checks. Enabling normalRouting on a scope asserts ordinary routing for every eligible current and future channel in that scope; use a whitelist when that assertion is too broad.

Existing creation policies remain separate. Created channels must also pass the channel policy before admission and later operations. With a nonempty whitelist, a new, not-yet-listed ID remains created_unadmitted; no automatic retry or policy edit occurs. A blacklisted category denies creation under that policy; category blacklisting does not recursively hide its existing children. Scope changes do not resume old operations.

Legacy target shape, with placeholders to replace before use:

```json
[{ "name": "project", "guildId": "GUILD_SNOWFLAKE", "channelId": "CHANNEL_SNOWFLAKE", "accountId": "bot", "agentId": "main", "normalRouting": true }]
```

All Discord reads use the configured Gateway bearer credential. The closed reader permits only message/channel-list, channel-info, thread-list, permissions and exact-ID read. It uses configured guild/account/agent mappings and never accepts client URLs, actions, credentials or raw arguments. Gateway policy remains authoritative. Missing Gateway credentials or invalid configuration fail startup; read errors never switch transports. Thread creation and optional channel creation use the same Gateway connection. A deployment launcher that filters environment variables must explicitly pass the required settings.

Only expose this capability to callers trusted to act within every configured target. This is a shared service allowlist, not per-user Discord ACLs. HTTP deployments should enable OAuth and restrict network access. Existing gateway policy and bot permissions remain authoritative. Guild identity is read back before writes; existing thread ancestry is checked before delivery.

Service provenance guards preserve OPENCLAW_SHELL and agent/session/caller identity markers. Agent-originated service environments are rejected, not converted into operator authority. Do not deploy a wrapper that erases provenance.

## Gateway thread creation and owner membership

New threads are always created through the authenticated, closed message/thread-create HTTP adapter using OPENCLAW_URL and its server-side OPENCLAW_GATEWAY_TOKEN. Parent and thread checks use the HTTP read adapter; agent execution uses the SDK.

Creation never falls back to another transport, including on connection refusal. No HTTP response, timeout, connection reset, malformed result or partial creation authorizes a second create. Parent metadata failures stop before creation. The bridge never starts or restarts the Gateway.

To add the owner to every newly created thread, configure the service environment:

```dotenv
MCP_DISCORD_THREAD_MEMBER_ENABLED=true
MCP_DISCORD_THREAD_MEMBER_USER_ID=400000000000000006
MCP_DISCORD_THREAD_MEMBER_ACCOUNT_ID=bot
# Supply DISCORD_BOT_TOKEN through the service's private environment/secret store.
```

Replace bot with the configured account name. Membership is disabled unless explicitly enabled. The configured account must match every allowed target and creation policy; mixed-account deployments need separate services. Missing credentials fail startup. Clients cannot choose a user, credential, endpoint, or membership action. This adds no targets to the allowlist.

The native message tool has no thread-member-add action. After saving the new thread ID/link and verifying its guild, parent and thread type through the existing metadata reader, the service sends one PUT to https://discord.com/api/v10/channels/{newThreadId}/thread-members/{configuredUserId}, then one GET to the same URL. Both use the service's bot credential, reject redirects and preserve the service-provenance guard. Discord requires send permission and an unarchived thread. Its 204 response covers both added and already-present members; the GET must confirm the exact thread and user before member_verified becomes true. See [Discord's membership API](https://docs.discord.com/developers/resources/channel#add-thread-member).

The operation saves member_status before generation: disabled, pending, adding, verified, failed or unknown, alongside member_verified and a sanitized member_error_code when applicable. A membership failure stops generation, retains the thread link and reports run_failed rather than completed. Unknown means membership may have changed but was not verified; do not create another thread or replay the operation. A crash during adding also requires operator inspection. Partial creation stops before membership and generation. Neither reusing an operation ID nor polling its status repeats creation, membership, or the agent turn. Tokens and raw HTTP error bodies are never included in these records or results.

## Visible request and asynchronous ownership

New-thread asks require the configured request publisher; the shipped publisher uses the existing thread-member account and DISCORD_BOT_TOKEN. Without membership configuration, discovery and channel creation still work, but ask fails with REQUEST_PUBLISHER_REQUIRED before creating anything.

The first service-authored message is bot-posted and preserves the exact prompt. With `MCP_DISCORD_FORWARDING_REQUESTER_NAME` set, the server prepends `**Forwarding <name>’s request**` and a blank line to the initial new-thread publication only. Clients must pass the original prompt unchanged, without adding a header. Existing-thread replies, generated answers and agent input are unchanged. The optional name is an operator assertion for single-owner deployments, not an identity inferred from OAuth client names or model input. Leave it unset (or empty) for the legacy no-header behavior; do not configure a shared name for a multi-user service. Names must be nonblank, at most 100 UTF-16 code units, and free of control or format characters, line separators and malformed Unicode. Markdown is escaped and mention syntax is neutralized.

The request publication precedes agent invocation, topic markers triggered by that invocation, and the answer. The service does not impersonate a user or synthesize an inbound Discord event. OpenClaw's Discord self-message filter ignores its own bot, including when allowBots is enabled. The token must belong to the same configured account; this remains an operator assertion, as for membership.

The native Gateway message/send schema does not expose allowedMentions and ordinary delivery trims trailing whitespace. Alongside the membership adapter, request publication uses a closed Discord REST adapter: one POST to /api/v10/channels/{verifiedThreadId}/messages and one GET of its returned ID, using the same configured bot credential as membership. Clients cannot supply URLs, credentials, author identity, HTTP methods or raw arguments. Provenance, account/guild/agent scope and verified thread ancestry still apply. No fallback or retry follows an ambiguous send, including 429. The payload sets allowed_mentions to no users, roles or everyone, disables reply mentions and suppresses embeds. The fixed nonce is additional short-term protection, not an exactly-once guarantee.

When the prompt plus configured header and blank line exceeds 2,000 UTF-16 code units, one message carries the full unchanged UTF-8 richiesta.txt attachment, with the header alone as its caption (empty when unconfigured). Inline readback must match the expected header plus original content and bot identity. Attachment readback verifies the expected caption, filename and byte size, not a downloaded content hash; the uploaded bytes are the original prompt. Malformed Unicode is rejected before effects. Discord text normalization causes verification failure rather than silently changing the prompt. The adapter does not fetch arbitrary attachment URLs.

request_status distinguishes pending, publishing, sent, verified, failed, partial and unknown. request_message_ids is persisted as soon as POST yields a valid ID; request_verified requires the readback. A failed or unverified publication stops generation and preserves the thread link. Request verification is separate from eventual answer delivery_status/delivery_verified.

After publication verification and durable queued state, ask returns immediately. It does not wait for generation or answer delivery. One service-owned worker advances the operation to running and its eventual completed/run_failed/run_unknown state. Client disconnects and MCP-session closure do not own or cancel it. Poll openclaw_discord_operation for the eventual result; replay never repeats creation, publication, membership or generation.

MCP_DISCORD_MAX_OPERATIONS caps all preparing and background asks (default 4, integer 1–16). There is no waiting backlog: admission rejects excess new work before mutation with OPERATION_CAPACITY. Existing records remain readable at capacity and during shutdown. This is a per-process limit; multiple service processes sharing a directory are not supported. Exclusive file claims still prevent a duplicate operation from executing across processes, but a foreign live owner is conservatively reported as interrupted.

On HTTP/SSE shutdown the service stops admitting new asks and drains accepted workers before closing transports, with a 660-second hard process deadline. Stdio signal/EOF shutdown also stops admission and drains workers. A supervisor may impose a shorter stop grace; after forced termination, interrupted work is fail-closed and is never restarted. The SDK receives the prompt directly; the bridge creates no CLI prompt files or subprocess arguments. Operation records retain a digest, not the prompt.

## Tools

- openclaw_discord_channels fetches one live channel list per guild/account/agent for each request. It returns only exact allowlisted parents, including persistently admitted channels, with verified guild/type and category metadata. Missing or invalid parents/categories fail the request; moved admitted channels are rejected. Lists are never cached across requests.
- openclaw_discord_threads lists active threads or archived public threads. Active listing has no pagination. Archived listing uses before as an ISO archive timestamp and limit up to 100. Private archive enumeration is not supported.
- openclaw_discord_ask accepts only new_thread, with target, title, prompt and an unpredictable operation_id of 16–100 URL-safe characters. It returns link/status rather than answer content; absence of answer text is expected. The tool description and coordinator skill instruct callers to pass the original user request unchanged, letting the server add any configured forwarding header, without added requirements or unrequested optimization, and respond with only the Discord link on successful handoff. Errors and partial/unknown outcomes must still be reported. These are caller guidance, not a technical guarantee of another model’s response style. Continue on Discord to read and reply. Existing-thread replies use the separate openclaw_discord_reply tool; see [its deployment requirements](discord-reply.md). Bare-channel continuation remains unsupported.
- openclaw_discord_operation reads a durable record without external writes or agent dispatch.
- openclaw_discord_create_channel creates only normal text channels through the documented Gateway message/channel-create action. It requires a separately enabled creation policy and explicit authorization for both creation and persistent admission. The agent turn uses the SDK; thread creation uses the separate message/thread-create HTTP action. Forum/media parent writes are rejected before effects rather than inventing starter-message behavior.

The supported workflow creates a new thread, verifies membership, publishes the request, and returns a queued “Continue on Discord” link without waiting for the first OpenClaw response. The fresh thread ID is associated durably with agent:<agentId>:discord:channel:<threadId> using the operator-verified normal parent routing. Existing-thread replies use the configured ordinary routing described in [discord-reply.md](discord-reply.md). There is no client-selected session or runtime rebinding support. Special bound parents must not be marked normalRouting:true. An optional route inspector can reject mismatches, but the shipped new-thread path does not require an unavailable exact-route API. Parent guild/type and thread ancestry are still read back. No Gateway bindings are changed.

Normal human replies must route to the same ordinary session. Before enabling a target, the operator verifies account/agent routing, bot permissions, channel access and mention requirements. A separately authorized external-client canary must create a new thread, receive the first reply, then confirm that a human Discord reply retains context. Later binding/configuration changes are outside the guarantee. The SDK agent request uses message, agentId, sessionKey, deliver=true, replyChannel=discord, replyTo=channel:<id> and replyAccountId. The original prompt is published before this request and passed unchanged once to the normal agent turn. See [live evidence and remaining release gates](discord-sdk.md#live-release-gates-and-existing-limits).

Accepted runs are observed with agent.wait after a disconnect; the prompt is never resubmitted as recovery. Explicit host-side cancellation uses chat.abort for the exact accepted run. Closing an MCP request does not cancel generation. See [execution and recovery](discord-sdk.md#execution-and-recovery).

## Idempotency and outcomes

An exclusive file claim and synced record precede external writes. Reusing the same operation ID and identical arguments reads the existing record. Reusing it with different arguments fails. Creating the thread and running the agent are separate stages; known thread identity is recorded before running. A timeout never automatically creates another thread or repeats the agent turn.

There is no exactly-once guarantee across Discord and the local filesystem. A crash can leave a stored creating/created/queued/running record. On read, a record without a live owner in this service is reported as creation_unknown/run_unknown with OPERATION_INTERRUPTED; it is not rewritten or resumed. An ambiguous SDK or HTTP failure also leaves creation_unknown/run_unknown. Inspect the existing target and gateway logs before authorizing a new operation. State records must not be deleted to force retries. The service-owned background SDK turn can outlast the client request timeout. Query openclaw_discord_operation using the original ID: once the thread is recorded, its link and handoff are available while generation is running. Reusing the exact original request reads the same record without another agent invocation. Local filesystem atomic-create semantics are required; network filesystems and multi-host replication are not supported.

completed and generation_status describe agent generation, not independently verified Discord delivery. delivery_status separately reports sent/delivered, failed, partial_failed, suppressed or unverified. The SDK result may include deliveryStatus or nested delivery.status. Suppressed is never treated as visible delivery. When the delivery object includes a valid messageId, one bounded HTTP message read checks that exact ID and thread, setting delivery_verified; otherwise it remains false. No guessed text matching or extra message send is used. Links, session keys and run IDs are returned when known. Partial creation retains the thread and does not start the agent. Sanitized error codes distinguish rejected requests, uncertain outcomes and failed preflight checks without exposing raw credential-bearing responses.

Modern HTTP async task ownership uses a hash of the validated access token, never clientInfo. Reconnects with that token retain access; token rotation changes ownership. Anonymous modern calls cannot start or access async tasks because there is no stable authenticated owner. Stateful legacy connections retain the prior connection-local ownership rules. All supported tools use the same agent-selection contract across transports.

## Explicit channel creation

Enable MCP_DISCORD_CHANNEL_CREATE_ENABLED=true only after defining MCP_DISCORD_CREATION_POLICIES as a JSON array. Each policy has name, guildId, categoryId, accountId and agentId; normalRouting:true additionally authorizes fresh-thread asks under newly admitted channels. All policies use the configured Gateway URL and credential; clients cannot select another URL.

Set MCP_DISCORD_ACKNOWLEDGE_INBOUND_ROUTING=true only after verifying that new channels in each configured guild/category are allowed by OpenClaw and Discord and route inbound messages to the configured agent. The adapter does not change bindings, channel permissions, mention requirements or gateway policy. Explicit agentId does not prove inbound continuity. The acknowledgement and per-target normalRouting:true are explicit deployment prerequisites for the narrowed fresh-thread workflow; neither claims arbitrary existing-thread continuity. If those prerequisites are not satisfied, leave creation disabled.

The caller selects a policy, name and optional topic, and must pass authorize_create=true and authorize_admission=true after user approval. The service reads the configured category through the HTTP metadata reader, verifies its guild/type, invokes only message/channel-create with channelType=0, and reads the resulting channel back with the same account/agent mapping. HTTPS or loopback HTTP is required; redirects are rejected. The server-side token never appears in results. No arbitrary tool, action, URL, headers, account, guild or category can be supplied by the caller.

The HTTP adapter refuses agent-originated environments (OPENCLAW_SHELL and agent/session/caller identity markers) before dispatch. It never clears or replaces them. The service must be independently operator-launched; this is not a way for an agent to bypass its messaging tools.

A completed creation record is also the persistent admission record. The returned created-<channelId> target becomes available for discovery across restarts. Fresh-thread asks require normalRouting:true in the creation policy as well as the global acknowledgement. Admission does not establish a session binding. Its policy digest must still match current operator configuration. Removing/changing the policy revokes admission; moving the channel outside the category fails readback. Clients cannot forge admissions by supplying a target string. No gateway config is rewritten.

created_unadmitted retains a known channel ID when post-create verification fails; creation_unknown means a write may have happened without a confirmed ID. Neither is admitted or automatically retried. A known 401/403/404/429 is returned as creation_rejected with a sanitized error_code. HTTP idempotencyKey supplies a stable tool-call ID, not a claimed provider exactly-once guarantee; the local durable claim prevents replay. If the process stops after creation but before admission, inspect and recover under operator control rather than creating another channel.

## Verification before deployment

Run npm run lint, npm run typecheck, npm run test:run and npm run build. Tests use fake SDK clients and mock Gateway HTTP/Discord REST responses; they do not create Discord channels, threads or messages. npm pack --dry-run must include skills/openclaw-coordinator/SKILL.md and references/recovery.md.

Then review the actual service account permissions, allowlist, private state directories, provenance, launcher environment, SDK scope grants and ingress Origin/Host behavior. A separately authorized external-client canary should verify thread creation, first-response delivery and a human reply in Discord retaining context. Automated tests do not establish production authorization or continuity.

## Agent selection

See [multiagent configuration](multiagent.md) for explicit catalogs, optional Gateway SDK roster discovery, `agent_id` selectors, Discord mapping precedence and the shared trust model. Every authenticated client can select every configured agent; generic chat requires no Discord mapping.
