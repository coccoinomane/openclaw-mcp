# Discord CLI tools and MCP Skills

## Scope

Direct Ask OpenClaw continues to use the HTTP chat-completions endpoint. Its tools, session_id/instance response contract, and multi-instance routing are unchanged. Discord tools are a separate, opt-in service capability using a locally installed OpenClaw CLI. They do not use a Gateway SDK or create subagents.

The /mcp endpoint routes 2026-07-28 requests through the official createMcpHandler factory and Node adapter. The SDK's isLegacyRequest classifier sends existing stateful 2025 clients to the unchanged legacy transport. Legacy SSE and stdio remain supported. The official Skills extension is available on modern HTTP; stdio, SSE and legacy HTTP expose the same packaged files through resources/list and resources/read. This is a staged migration: stdio and SSE do not advertise the new protocol or extension methods.

Pinned packages: @modelcontextprotocol/server, core and client 2.4.0; @modelcontextprotocol/node 2.1.2; legacy @modelcontextprotocol/sdk 1.32.1. The client package is test-only.

## Operator configuration

Discord tools are absent unless MCP_DISCORD_ENABLED=true. Set these in the service's trusted environment, not tool input:

- MCP_DISCORD_EXECUTABLE: executable name or absolute path; default openclaw. No shell or raw argument option.
- MCP_DISCORD_STATE_DIR: required absolute path to a private, durable local directory. Preserve it across restarts and share it between workers of this deployment. Do not share it across security principals or expose it as a static directory.
- MCP_DISCORD_TARGETS: nonempty JSON array of objects with name, guildId, channelId, accountId and agentId. Each entry authorizes discovery for one parent and its actual threads, for one account and agent. Set normalRouting:true only for parents verified by the operator to route ordinary new threads and human replies to that agent/account; omit it or set false for special bound targets. Ask also requires MCP_DISCORD_ACKNOWLEDGE_INBOUND_ROUTING=true. Use concrete Discord IDs; wildcards are rejected.

Example shape, with placeholders to replace before use:

```json
[{ "name": "project", "guildId": "GUILD_SNOWFLAKE", "channelId": "CHANNEL_SNOWFLAKE", "accountId": "bot", "agentId": "main", "normalRouting": true }]
```

The CLI uses its own configured gateway, accounts and credentials. Channel creation uses the named OPENCLAW_INSTANCES entry (or the single default instance), with its existing server-side token; credentials are never accepted in tool input. A deployment launcher that filters environment variables must explicitly pass the new settings.

Only expose this capability to callers trusted to act within every configured target. This is a shared service allowlist, not per-user Discord ACLs. HTTP deployments should enable OAuth and restrict network access. Existing gateway policy and bot permissions remain authoritative. Guild identity is read back before writes; existing thread ancestry is checked before delivery.

Invocation environment is inherited unchanged, including OPENCLAW_SHELL and caller identity. An agent-originated CLI restriction is a rejection to respect, not a marker to remove. Do not deploy a wrapper that erases provenance.

## Tools

- openclaw_discord_channels reads and verifies each allowlisted parent, including persistently admitted channels, topic/category metadata and available creation policies.
- openclaw_discord_threads lists active threads or archived public threads. Active listing has no pagination. Archived listing uses before as an ISO archive timestamp and limit up to 100. Private archive enumeration is not supported.
- openclaw_discord_ask accepts only new_thread, with target, title, prompt and an unpredictable operation_id of 16–100 URL-safe characters. Existing-thread/channel continuation is rejected before effects and is absent from the public schema.
- openclaw_discord_operation reads a durable record without writes or CLI calls.
- openclaw_discord_create_channel creates only normal text channels through the documented Gateway message/channel-create action. It requires a separately enabled creation policy and explicit authorization for both creation and persistent admission. CLI thread/session actions do not use this HTTP route. Forum/media parent writes are rejected before effects rather than inventing starter-message behavior.

The supported workflow is a new thread created by this service, its first OpenClaw response, then a “Continue on Discord” link. The fresh thread ID is associated durably with agent:<agentId>:discord:channel:<threadId> using the operator-verified normal parent routing. There is no arbitrary existing-thread continuation or runtime rebinding support. Special bound parents must not be marked normalRouting:true. An optional route inspector can reject mismatches, but the shipped new-thread path does not require an unavailable exact-route API. Parent guild/type and thread ancestry are still read back. No Gateway bindings are changed.

Normal human replies must route to the same ordinary session. Before enabling a target, the operator verifies account/agent routing, bot permissions, channel access and mention requirements. A separately authorized external-client canary must create a new thread, receive the first reply, then confirm that a human Discord reply retains context. This integration test has not been run here. Later binding/configuration changes are outside the guarantee. The agent CLI uses --session-key, --message-file, --deliver, --reply-channel discord, --reply-to channel:<id>, --reply-account, --agent and --json. The prompt is not separately mirrored into Discord.

Prompt files live in private temporary directories with mode 0600 and are removed after success or failure. The prompt does not appear in process arguments or operation records. A hard process kill can leave a temporary directory; operators may clean stale openclaw-mcp-* directories only after confirming no CLI reads them.

## Idempotency and outcomes

An exclusive file claim and synced record precede external writes. Reusing the same operation ID and identical arguments reads the existing record. Reusing it with different arguments fails. Creating the thread and running the agent are separate stages; known thread identity is recorded before running. A timeout never automatically creates another thread or repeats the agent turn.

There is no exactly-once guarantee across Discord and the local filesystem. A crash can leave creating/running, and an ambiguous CLI failure can leave creation_unknown/run_unknown. Inspect the existing target and gateway logs before authorizing a new operation. State records must not be deleted to force retries. The synchronous CLI turn can outlast the client request timeout. Query openclaw_discord_operation using the original ID: once the thread is recorded, its link and handoff are available while generation is running. Reusing the exact original request reads the same record without another CLI invocation. Local filesystem atomic-create semantics are required; network filesystems and multi-host replication are not supported.

completed and generation_status describe agent generation, not independently verified Discord delivery. delivery_status separately reports sent/delivered, failed, partial_failed, suppressed or unverified. The installed CLI returns deliveryStatus as an object (also promoted from result.deliveryStatus); nested delivery.status is accepted as well. Suppressed is never treated as visible delivery. When that delivery object includes a valid messageId, one bounded message read checks that exact ID and thread, setting delivery_verified; otherwise it remains false. No guessed text matching or extra message send is used. Links, session keys and run IDs are returned when known. Partial creation retains the thread and does not start the agent. CLI stderr and raw failure output are not returned or logged by this adapter. Nonzero CLI exits cannot become completed even when stdout claims success; known thread IDs are preserved as partial creation. Sanitized error_code fields identify CLI_TIMEOUT, CLI_EXIT_NONZERO and verified policy/preflight failures.

Modern HTTP async task ownership uses a hash of the validated access token, never clientInfo. Reconnects with that token retain access; token rotation changes ownership. Anonymous modern calls cannot start or access async tasks because there is no stable authenticated owner. Stateful legacy connections retain the prior connection-local ownership rules. All existing tool names remain listed.

## Explicit channel creation

Enable MCP_DISCORD_CHANNEL_CREATE_ENABLED=true only after defining MCP_DISCORD_CREATION_POLICIES as a JSON array. Each policy has name, guildId, categoryId, accountId, agentId and instance; normalRouting:true additionally authorizes fresh-thread asks under newly admitted channels. The instance names an existing server-side gateway configuration with a credential. MCP_DISCORD_CLI_GATEWAY_INSTANCE must name that same instance: this is the operator assertion that the CLI targets that gateway, not a client-selected URL. All policies currently use that one CLI gateway.

Set MCP_DISCORD_ACKNOWLEDGE_INBOUND_ROUTING=true only after verifying that new channels in each configured guild/category are allowed by OpenClaw and Discord and route inbound messages to the configured agent. The adapter does not change bindings, channel permissions, mention requirements or gateway policy. Explicit --agent does not prove inbound continuity. The acknowledgement and per-target normalRouting:true are explicit deployment prerequisites for the narrowed fresh-thread workflow; neither claims arbitrary existing-thread continuity. If those prerequisites are not satisfied, leave creation disabled.

The caller selects a policy, name and optional topic, and must pass authorize_create=true and authorize_admission=true after user approval. The service reads the configured category through CLI, verifies its guild/type, invokes only message/channel-create with channelType=0, and reads the resulting channel back through the same CLI account. HTTPS or loopback HTTP is required; redirects are rejected. The server-side token never appears in results. No arbitrary tool, action, URL, headers, account, guild or category can be supplied by the caller.

The HTTP adapter refuses agent-originated environments (OPENCLAW_SHELL and agent/session/caller identity markers) before dispatch. It never clears or replaces them. The service must be independently operator-launched; this is not a way for an agent to bypass its messaging tools.

A completed creation record is also the persistent admission record. The returned created-<channelId> target becomes available for discovery across restarts. Fresh-thread asks require normalRouting:true in the creation policy as well as the global acknowledgement. Admission does not establish a session binding. Its policy digest must still match current operator configuration. Removing/changing the policy revokes admission; moving the channel outside the category fails readback. Clients cannot forge admissions by supplying a target string. No gateway config is rewritten.

created_unadmitted retains a known channel ID when post-create verification fails; creation_unknown means a write may have happened without a confirmed ID. Neither is admitted or automatically retried. A known 401/403/404/429 is returned as creation_rejected with a sanitized error_code. HTTP idempotencyKey supplies a stable tool-call ID, not a claimed provider exactly-once guarantee; the local durable claim prevents replay. If the process stops after creation but before admission, inspect and recover under operator control rather than creating another channel.

## Verification before deployment

Run npm run lint, npm run typecheck, npm run test:run and npm run build. Tests use mock CLI and mock HTTP gateway servers; they do not create Discord channels, threads or messages. npm pack --dry-run must include skills/openclaw-coordinator/SKILL.md and references/recovery.md.

Then review the actual service account permissions, allowlist, private state directory, provenance, launcher environment, installed CLI response shapes and ingress Origin/Host behavior. A separately authorized external-client canary should verify thread creation, first-response delivery and a human reply in Discord retaining context. No production changes or canary writes were performed during implementation.
