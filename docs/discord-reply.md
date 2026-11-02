# Existing-thread replies

The shared MCP tool openclaw_discord_reply accepts target, channel_id, prompt and operation_id. It reuses the coordinator, request publisher, background worker and durable operation journal. It does not create a thread or change membership. The user request remains verbatim, posted by the bot with mentions disabled, then passed once to the ordinary agent in agent:<agent>:discord:channel:<thread>.

## Deployment gate

**The stock entry point does not yet supply the required live route inspector. Replies fail closed with ROUTE_INSPECTOR_REQUIRED before publication. This feature is not production-ready.**

A trusted DiscordRouteResolver must inspect live inbound routing, including runtime bindings, verify Gateway admission for the configured account/guild/parent/thread, and return the exact ordinary canonical session with admitted:true and busy:false. Static normalRouting configuration, sessions.list, sessions.resolve and a canonical-looking key do not establish this. Do not implement the inspector by asserting these values or inventing a human sender. The available Gateway source inspected during implementation exposes no read-only API that proves all these conditions. Completing that integration requires a supported Gateway capability; no plugin/config change is included here.

Even a read-only inspector cannot atomically reserve a Gateway turn against native Discord traffic or a concurrent binding change. The coordinator rechecks before publication and dispatch; Gateway admission and serialization must remain authoritative. A stronger atomic admission/dispatch contract is a remaining integration requirement before production approval.

## Validation and recovery

- The actual parent and thread must match the configured guild and ancestry. Parent whitelist, parent/thread blacklist, admitted category constraints and normal-routing acknowledgement still apply.
- Public thread types 10 and 11 are accepted under text/announcement parents. Archived unlocked threads are accepted; Discord send auto-unarchives. Locked, private, forum/media and unknown types are rejected. No unlock/unarchive mutation is sent.
- Live bot permissions must include ViewChannel, SendMessagesInThreads and ReadMessageHistory; attachments also require AttachFiles. Missing or malformed permission results fail closed.
- Callers cannot provide a session, agent, account, guild, endpoint or transport override. OAuth and service provenance rules are unchanged. The tool is shared across clients and transports, not a client-specific adapter.
- A durable exclusive session claim prevents distinct MCP operations from publishing simultaneously into the same canonical session, including overlapping service instances sharing local state. Same-ID calls read the existing operation, never replay effects. Different input with the same ID is rejected.
- Ambiguous publication, interrupted ownership or uncertain agent execution retains the claim for manual reconciliation. No automatic stale-lock expiry exists. Inspect the operation and Gateway/Discord state before an operator removes a claim; preserve operation records. Keep the existing single-service deployment rule; network filesystems are unsupported.
- queued means publication was verified and service-owned generation was accepted, not that the answer was delivered. Return only the Discord link on queued handoff. Use openclaw_discord_operation after disconnect or when the eventual result is requested.

No live Discord writes, Gateway admission tests or production changes were performed for this implementation.
