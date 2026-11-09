# Can we replace the OpenClaw CLI with the Gateway SDK?

Assessment: 9 November 2026. This is a migration proposal, not an implemented feature. It is based on documentation, published package inspection and the installed Gateway’s code. No authenticated connection or end-to-end migration test was performed.

## Conclusion

Yes. The official `@openclaw/gateway-client` can retrieve the agent list and start the same Discord agent turns that we currently launch through the CLI. It can also request channel information, thread lists and permissions. Removing those subprocesses would allow the MCP service to work without a local OpenClaw CLI, including when a Gateway is remote.

It would add a WebSocket connection and its authentication lifecycle. It is not a direct replacement for an HTTP fetch call, and it would not automatically make every Discord adapter support multiple Gateways.

Thread creation itself already has an HTTP implementation. Keep it initially; see [the current Discord workflow and limits](discord-skills.md#which-parts-still-need-the-cli).

## Start with agent discovery

Create one SDK connection for each configured OpenClaw instance. Use that instance’s address and credentials, and call `agents.list`. Several agents on the same instance can share its connection. Keep credentials, cached agent lists and pending runs separate between instances.

Return only the agent details the MCP client needs. The Gateway response can include more information than an agent ID. It also reports default-selection information, including `selectionRequired`; respect that flag rather than treating the first agent or a compatibility default as an intentional choice. This could support installations where every new request must choose an agent, but the MCP adapter still needs to implement that behavior.

Bindings are separate. `agents.list` does not include them, and no dedicated bindings-list RPC was found in the audited method registry. `config.get` can supply them, but reads the full redacted configuration: it has no bindings-only selector. Both calls require `operator.read` in the inspected Gateway.

Recommend making configuration-derived binding import explicit opt-in. If enabled, validate the configuration and its applied revision where available, extract only supported binding fields, then discard the rest. Never log or return the full configuration to an MCP client. Preserve channel precedence and existing MCP permissions. Keep manual bindings as an alternative.

## What must change before using the SDK?

- **Node version:** the inspected SDK packages require Node 22.19 or later. This repository currently declares Node 20 support and uses Node 20 Docker images. Update that requirement and the images, or explicitly separate SDK support from the existing compatibility target.
- **Authentication:** a token that works for HTTP does not guarantee a remote WebSocket connection with the required permissions. Provision a persistent device identity and handle pairing where required. Store its credentials separately for each instance.
- **Permissions:** request explicit scopes. The inspected SDK defaults to `operator.admin`; discovery only needs `operator.read`. Discord tool/action RPCs require `operator.write`, even for read-only actions. Existing channel restrictions still apply.
- **Reconnects:** wait for a successful authenticated handshake. Refresh validated discovery data after reconnection, and close connections cleanly on shutdown. Never repeat an agent request merely because its connection dropped.

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
