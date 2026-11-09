# Can we replace the OpenClaw CLI with the Gateway SDK?

Assessment: 9 November 2026. Gateway **roster discovery only** is now implemented behind `MCP_AGENT_DISCOVERY=gateway`; see the [setup guide](multiagent.md). It uses the pinned 2026.10.9 SDK and requires Node >=22.19.0. The remaining migrations below are proposals. Tests use fake transports; no production authenticated connection or end-to-end Discord migration test is claimed.

## Independent review: limits found on 9 November 2026

A second review with xhigh reasoning found that matching RPC arguments do not establish equivalent behavior. It ran 23 non-network tests against installed Gateway/Discord/SDK 2026.10.9 code and protocol handling, plus 130 existing mocked MCP tests. No production model turns, Discord actions or permission changes were made.

- **New ordinary text-channel threads:** removing the CLI is plausible, retaining the existing HTTP/REST adapters, but needs a live authorization and delivery test.
- **Announcement-channel parents:** the current no-starter creation path requests a type-11 public thread. Discord announcement threads are type 10 and use a starter message. The current implementation does not establish support for this case.
- **Active existing threads:** continuation is plausible only when the intended OpenClaw session and usable transcript already exist and the caller may access them. A human Discord discussion never processed by OpenClaw is not automatically imported.
- **Archived threads:** sending another message and preserving old context are different requirements. The installed Discord archive handler deletes matching session entries and archives their transcripts. Reopening can therefore create a fresh OpenClaw session under the same thread key. This also affects the current CLI.
- **Authority:** the local CLI uses an admin-capable operator connection; the new discovery client requests read-only access. A future write grant permits ordinary agent calls but does not automatically reproduce every CLI tool capability or conversation-read policy. One fixture demonstrates different cron authority. Do not impersonate the CLI or bypass denied reads to obtain parity.

The conclusion is conditional feasibility for ordinary supported threads, not universal equivalence. Before migrating Discord execution, test a disposable text thread, active human/MCP-origin session continuation, archive behavior, delegated reads, delivery, disconnect recovery and explicit cancellation using an approved service identity. Removing CLI subprocesses does not require removing the HTTP/Discord REST adapters that preserve membership and exact prompt-publication behavior.

Evidence functions include installed `closeDiscordThreadSessions`, `createThreadDiscord`, the Gateway method-scope and session-sharing checks, and the SDK protocol request state machine. See [Discord’s thread API](https://docs.discord.com/developers/resources/channel).

## Initial feasibility assessment

Yes. The official `@openclaw/gateway-client` can retrieve the agent list and start the same Discord agent turns that we currently launch through the CLI. It can also request channel information, thread lists and permissions. Removing those subprocesses would allow the MCP service to work without a local OpenClaw CLI, including when a Gateway is remote.

It would add a WebSocket connection and its authentication lifecycle. It is not a direct replacement for an HTTP fetch call, and it would not automatically make every Discord adapter support multiple Gateways.

Thread creation itself already has an HTTP implementation. Keep it initially; see [the current Discord workflow and limits](discord-skills.md#which-parts-still-need-the-cli).

## Start with agent discovery

Create one SDK connection for each configured OpenClaw instance. Use that instance’s address and credentials, and call `agents.list`. Several agents on the same instance can share its connection. Keep credentials, cached agent lists and pending runs separate between instances.

The roster implementation returns IDs only and preserves existing configured/model defaults. It does not adopt a Gateway `defaultId` or introduce required-selection enforcement. The Gateway also reports `selectionRequired`; any future change to that behavior needs a separate design rather than treating the first agent as an intentional choice.

Bindings are separate. `agents.list` does not include them, and no dedicated bindings-list RPC was found in the audited method registry. `config.get` can supply them, but reads the full redacted configuration: it has no bindings-only selector. Both calls require `operator.read` in the inspected Gateway.

Recommend making configuration-derived binding import explicit opt-in. If enabled, validate the configuration and its applied revision where available, extract only supported binding fields, then discard the rest. Never log or return the full configuration to an MCP client. Preserve channel precedence and existing MCP permissions. Keep manual bindings as an alternative.

## What must change before using the SDK?

- **Node version:** updated for roster discovery: Node >=22.19.0, Node 24 Docker images, and CI covering the minimum release and Node 24.
- **Authentication:** a token that works for HTTP does not guarantee a remote WebSocket connection with the required permissions. Provision a persistent device identity and handle pairing where required. Store its credentials separately for each instance.
- **Permissions:** request explicit scopes. The inspected SDK defaults to `operator.admin`; discovery only needs `operator.read`. Discord tool/action RPCs require `operator.write`, even for read-only actions. Existing channel restrictions still apply.
- **Connection lifetime:** current discovery waits for authentication, reads once at startup and closes every connection. Failures stop startup; there is no live roster refresh. Future long-lived clients would need reconnect recovery, and must never repeat an agent request merely because its connection dropped.

The npm stable version observed during this assessment was 2026.11.2. A 2026.10.9 package matching the installed Gateway was also available. Use an exact, compatibility-tested version rather than upgrading the Gateway as part of this migration.

## Replace the Discord subprocess separately

The CLI already uses the Gateway’s `agent` RPC. That method accepts the agent ID, exact thread session key, prompt and Discord delivery destination used by our worker. The SDK can call it directly.

The replacement must preserve two different milestones: the Gateway accepting the work, and the work finishing. Use the SDK’s accepted callback to save the run ID, and retain a background request for the final result. The MCP client should still receive its queued thread link promptly.

After a disconnect, inspect the existing run instead of submitting the prompt again. Keep unknown outcomes when completion evidence is unavailable. Cancelling an SDK request only stops local waiting; stopping the run requires an explicit `chat.abort` request. Shutdown and user-requested cancellation must remain separate.

Successful generation is not proof that Discord received the answer. The inspected delivery response provides status and counts, but does not guarantee a Discord message ID. Moving to the SDK cannot by itself improve exact-message delivery verification.

Channel and thread reads can move to an internal, action-restricted `tools.invoke` or `message.action` adapter. Their response formats and authorization rules differ from the existing HTTP wrapper, so they need separate validation and tests. Do not expose a general Gateway method proxy through MCP.

## Suggested order and acceptance checks

1. Add the SDK connection and agent discovery. Test the intended device identity, scopes, two separate Gateways, missing defaults, reconnection and cleanup. Keep ordinary chat over HTTP.
2. Add opt-in binding import if automatic Discord mapping is needed. Test unsupported bindings and saved-but-unapplied configuration; do not silently guess a route.
3. Replace Discord reads and agent execution. Test acceptance versus completion, disconnect recovery, denied channels, explicit cancellation and failed or partial delivery. Verify no duplicate requests or messages.

A separately authorized live test should then confirm that the first answer arrives in the intended thread and a human reply continues the same conversation. Until that test passes, static API compatibility is evidence of feasibility, not a completed migration.

## References

- [Building a Gateway client](https://docs.openclaw.ai/gateway/clients)
- [Gateway authentication and device identity](https://docs.openclaw.ai/gateway/protocol/auth)
- [Operator scopes](https://docs.openclaw.ai/gateway/operator-scopes)
- [Published SDK package](https://www.npmjs.com/package/@openclaw/gateway-client)
- [Version-matched SDK source](https://github.com/openclaw/openclaw/blob/v2026.10.9/packages/gateway-client/src/client.ts)
- Current MCP code: [agent discovery](../src/openclaw/agent-catalog.ts), [thread creation](../src/openclaw/discord-thread.ts), [Discord worker](../src/openclaw/discord.ts).
