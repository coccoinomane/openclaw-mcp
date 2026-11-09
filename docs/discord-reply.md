# Existing-thread replies

The shared MCP tool openclaw_discord_reply accepts target, channel_id, prompt and operation_id. It reuses the coordinator, request publisher, background worker and durable operation journal. It does not create a thread or change membership. The user request remains verbatim, posted by the bot with mentions disabled, then passed once to the ordinary agent in agent:<agent>:discord:channel:<thread>.

Existing-thread replies share the [single-Gateway Discord setup](discord-skills.md#one-discord-gateway-connection-per-mcp-service). They do not create a thread. Agent execution defaults to CLI; the [SDK opt-in](discord-sdk.md) replaces execution and all remaining CLI reads without changing the MCP tool contract.

## Routing

Like new-thread handoffs, replies use operator-configured normalRouting and acknowledgeInboundRouting, with the canonical session agent:<configuredAgent>:discord:channel:<threadId>. Supported Gateway-backed agent --session-key dispatch owns admission and queueing. Runtime thread rebindings are unsupported.

## Context is not guaranteed by the thread ID

On the inspected Discord plugin 2026.10.9, processing a thread-archive event deletes matching OpenClaw session entries and archives the transcripts. Reopening the Discord thread can start a fresh OpenClaw session. Acceptance of an archived unlocked thread below means the service can attempt another turn; it does not guarantee retention of pre-archive context. This limitation affects the current CLI path too. Human discussion that never reached OpenClaw is not automatically loaded by an explicit agent call.

See the [independent SDK/CLI review](gateway-sdk-feasibility.md#independent-review-limits-found-on-9-november-2026) before assuming transport replacement preserves every conversation.

## Validation and recovery

- The actual parent and thread must match the configured guild and ancestry. Parent whitelist, parent/thread blacklist, admitted category constraints and normal-routing acknowledgement still apply.
- Public thread types 10 and 11 are accepted under text/announcement parents. Archived unlocked threads are accepted; Discord send auto-unarchives. Locked, private, forum/media and unknown types are rejected. No unlock/unarchive mutation is sent.
- Live bot permissions must include ViewChannel, SendMessagesInThreads and ReadMessageHistory; attachments also require AttachFiles. Missing or malformed permission results fail closed.
- Callers cannot override the destination’s session, agent, account, guild, endpoint or transport. Optional `agent_id` and `instance` selectors must agree with its configured route. OAuth and service provenance rules are unchanged. The tool is shared across clients and transports, not a client-specific adapter.
- A durable exclusive session claim prevents distinct MCP operations from publishing simultaneously into the same canonical session, including overlapping service instances sharing local state. Same-ID calls read the existing operation, never replay effects. Different input with the same ID is rejected.
- Ambiguous publication, interrupted ownership or uncertain agent execution retains the claim for manual reconciliation. No automatic stale-lock expiry exists. Inspect the operation and Gateway/Discord state before an operator removes a claim; preserve operation records. Keep the existing single-service deployment rule; network filesystems are unsupported.
- queued means publication was verified and service-owned generation was accepted, not that the answer was delivered. Return only the Discord link on queued handoff. Use openclaw_discord_operation after disconnect or when the eventual result is requested.

No live Discord writes, Gateway admission tests or production changes were performed for this implementation.

## Agent selection

See [multiagent configuration](multiagent.md) for explicit catalogs, opt-in local CLI discovery, `agent_id` selectors, Discord mapping precedence and the shared trust model. Every authenticated client can select every configured agent; generic chat requires no Discord mapping.
