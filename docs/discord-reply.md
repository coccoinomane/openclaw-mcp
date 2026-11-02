# Existing-thread replies

The shared MCP tool openclaw_discord_reply accepts target, channel_id, prompt and operation_id. It reuses the coordinator, request publisher, background worker and durable operation journal. It does not create a thread or change membership. The user request remains verbatim, posted by the bot with mentions disabled, then passed once to the ordinary agent in agent:<agent>:discord:channel:<thread>.

## Deployment gate

**The stock entry point does not yet supply the required live route inspector. Replies fail closed with ROUTE_INSPECTOR_REQUIRED before publication. This feature is not production-ready.**

A trusted DiscordRouteResolver must distinguish ordinary channel sessions from live thread-bound/subagent sessions. The operator normalRouting assertion remains the configured ordinary-route prerequisite. Gateway-backed agent --session-key already owns turn admission and queueing; no idle-state proof or custom admission flag is required.

The remaining blocker is narrower: the installed public APIs do not expose the effective session key and binding kind for a Discord conversation. Canonical outbound recipient routing ignores runtime thread bindings; conversations.list checks the owning agent but does not distinguish that agent's ordinary session from its subagent binding. A same-agent bound thread can therefore look eligible while human replies go to another session. See [installed source evidence](discord-reply-routing-evidence.md).

A read-only Gateway/plugin route-inspection method returning the effective session key and ordinary/bound/unknown classification is the required extension. It should reuse the installed Discord binding resolver and report an unavailable binding owner explicitly. It does not need a custom queue, idle precondition, human sender, or admission bypass. No such endpoint is invented or invoked by this branch.

## Validation and recovery

- The actual parent and thread must match the configured guild and ancestry. Parent whitelist, parent/thread blacklist, admitted category constraints and normal-routing acknowledgement still apply.
- Public thread types 10 and 11 are accepted under text/announcement parents. Archived unlocked threads are accepted; Discord send auto-unarchives. Locked, private, forum/media and unknown types are rejected. No unlock/unarchive mutation is sent.
- Live bot permissions must include ViewChannel, SendMessagesInThreads and ReadMessageHistory; attachments also require AttachFiles. Missing or malformed permission results fail closed.
- Callers cannot provide a session, agent, account, guild, endpoint or transport override. OAuth and service provenance rules are unchanged. The tool is shared across clients and transports, not a client-specific adapter.
- A durable exclusive session claim prevents distinct MCP operations from publishing simultaneously into the same canonical session, including overlapping service instances sharing local state. Same-ID calls read the existing operation, never replay effects. Different input with the same ID is rejected.
- Ambiguous publication, interrupted ownership or uncertain agent execution retains the claim for manual reconciliation. No automatic stale-lock expiry exists. Inspect the operation and Gateway/Discord state before an operator removes a claim; preserve operation records. Keep the existing single-service deployment rule; network filesystems are unsupported.
- queued means publication was verified and service-owned generation was accepted, not that the answer was delivered. Return only the Discord link on queued handoff. Use openclaw_discord_operation after disconnect or when the eventual result is requested.

No live Discord writes, Gateway admission tests or production changes were performed for this implementation.
