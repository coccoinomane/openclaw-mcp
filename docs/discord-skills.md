# Discord CLI tools and MCP Skills

## Scope

Direct Ask OpenClaw continues to use the HTTP chat-completions endpoint. Its tools, session_id/instance response contract, and multi-instance routing are unchanged. Discord tools are a separate, opt-in service capability using a locally installed OpenClaw CLI. They do not use a Gateway SDK or create subagents.

The /mcp endpoint routes 2026-07-28 requests through the official createMcpHandler factory and Node adapter. The SDK's isLegacyRequest classifier sends existing stateful 2025 clients to the unchanged legacy transport. Legacy SSE and stdio remain supported. The official Skills extension is available on modern HTTP; stdio, SSE and legacy HTTP expose the same packaged files through resources/list and resources/read. This is a staged migration: stdio and SSE do not advertise the new protocol or extension methods.

Pinned packages: @modelcontextprotocol/server, core and client 2.4.0; @modelcontextprotocol/node 2.1.2; legacy @modelcontextprotocol/sdk 1.32.1. The client package is test-only.

## Operator configuration

Discord tools are absent unless MCP_DISCORD_ENABLED=true. Set these in the service's trusted environment, not tool input:

- MCP_DISCORD_EXECUTABLE: executable name or absolute path; default openclaw. No shell or raw argument option.
- MCP_DISCORD_STATE_DIR: required absolute path to a private, durable local directory. Preserve it across restarts and share it between workers of this deployment. Do not share it across security principals or expose it as a static directory.
- MCP_DISCORD_TARGETS: nonempty JSON array of objects with name, guildId, channelId, accountId and agentId. Each entry authorizes one parent channel and its actual threads, for one account and agent. Use concrete Discord IDs; wildcards are rejected.

Example shape, with placeholders to replace before use:

```json
[{ "name": "project", "guildId": "GUILD_SNOWFLAKE", "channelId": "CHANNEL_SNOWFLAKE", "accountId": "bot", "agentId": "main" }]
```

The CLI uses its own configured gateway, accounts and credentials; OPENCLAW_INSTANCES selects only direct HTTP chat targets. The service never loads secrets itself for Discord. A deployment launcher that filters environment variables must explicitly pass the new settings.

Only expose this capability to callers trusted to act within every configured target. This is a shared service allowlist, not per-user Discord ACLs. HTTP deployments should enable OAuth and restrict network access. Existing gateway policy and bot permissions remain authoritative. Guild identity is read back before writes; existing thread ancestry is checked before delivery.

Invocation environment is inherited unchanged, including OPENCLAW_SHELL and caller identity. An agent-originated CLI restriction is a rejection to respect, not a marker to remove. Do not deploy a wrapper that erases provenance.

## Tools

- openclaw_discord_channels reads and verifies each allowlisted parent.
- openclaw_discord_threads lists active threads or archived public threads. Active listing has no pagination. Archived listing uses before as an ISO archive timestamp and limit up to 100. Private archive enumeration is not supported.
- openclaw_discord_ask accepts new_thread or continue. New mode requires title; continue requires channel_id. Both require target, prompt and an unpredictable operation_id of 16–100 URL-safe characters.
- openclaw_discord_operation reads a durable record without writes or CLI calls.
- openclaw_discord_create_channel explicitly reports unsupported and performs no write. OpenClaw 2026.10.9 documents only message channel info/list. No nonexistent flags are exposed.

New threads start ordinary session keys agent:<agentId>:discord:channel:<threadId>. The thread ID itself is the channel peer; there is no parent:thread suffix. This was checked against Discord's installed route-resolution and session-key-normalization implementations and the Discord messaging documentation. The agent CLI uses --session-key, --message-file, --deliver, --reply-channel discord, --reply-to channel:<id>, --reply-account, --agent and --json.

Prompt files live in private temporary directories with mode 0600 and are removed after success or failure. The prompt does not appear in process arguments or operation records. A hard process kill can leave a temporary directory; operators may clean stale openclaw-mcp-* directories only after confirming no CLI reads them.

## Idempotency and outcomes

An exclusive file claim and synced record precede external writes. Reusing the same operation ID and identical arguments reads the existing record. Reusing it with different arguments fails. Creating the thread and running the agent are separate stages; known thread identity is recorded before running. A timeout never automatically creates another thread or repeats the agent turn.

There is no exactly-once guarantee across Discord and the local filesystem. A crash can leave creating/running, and an ambiguous CLI failure can leave creation_unknown/run_unknown. Inspect the existing target and gateway logs before authorizing a new operation. State records must not be deleted to force retries. Local filesystem atomic-create semantics are required; network filesystems and multi-host replication are not supported.

completed means the agent CLI reported a successful run, not independently verified Discord delivery. Links, session keys and run IDs are returned when known. Partial creation retains the thread and does not start the agent. CLI stderr and raw failure output are not returned or logged by this adapter.

Modern HTTP async task ownership uses a hash of the validated access token, never clientInfo. Reconnects with that token retain access; token rotation changes ownership. Anonymous modern calls cannot start or access async tasks because there is no stable authenticated owner. Stateful legacy connections retain the prior connection-local ownership rules. All existing tool names remain listed.

## Channel creation follow-up

The documented /tools/invoke HTTP API can invoke message/channel-create with operator credentials, and the Discord plugin implements that action. It was inspected, not called. It is deliberately not added as an implicit fallback: that endpoint carries full operator authority and needs a separately reviewed service authorization/provenance design, explicit creation-guild policy, and independent idempotency/partial-outcome tests. The CLI-only adapter does not silently switch to it. Channel creation remains a blocked feature in this staged implementation.

## Verification before deployment

Run npm run lint, npm run typecheck, npm run test:run and npm run build. Tests use mock CLI and mock HTTP gateway servers; they do not create Discord channels, threads or messages. npm pack --dry-run must include skills/openclaw-coordinator/SKILL.md and references/recovery.md.

Then review the actual service account permissions, allowlist, private state directory, provenance, launcher environment, installed CLI response shapes and ingress Origin/Host behavior. A separately authorized canary should verify thread creation, ordinary-session continuation and delivery. No production changes or canary writes were performed during implementation.
