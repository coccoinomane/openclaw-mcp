# Discord without a local OpenClaw CLI

The opt-in SDK path covers ordinary new-thread and existing-thread workflows. It uses @openclaw/gateway-client 2026.10.9 for agent execution, observation and explicit cancellation. Channel discovery, thread lists, permissions and exact-ID readback use the existing authenticated Gateway HTTP /tools/invoke adapter. Thread creation stays on that HTTP adapter; membership and exact request publication stay on Discord REST.

This is not a pure-SDK implementation. CLI remains the default and the explicit rollback transport. Generic chat, MCP OAuth, roster discovery and configured routing are unchanged. Local tests use fake transports; live authority, history and delivery canaries are still release gates.

## Opt in

Keep the existing Discord account, allowed scopes, channel policy, request-publisher credential, membership settings and verified ordinary inbound routing. Add these settings to the trusted service environment (also pass them through any launcher allowlist):

~~~dotenv
MCP_DISCORD_AGENT_TRANSPORT=sdk
MCP_DISCORD_THREAD_CREATE_MODE=gateway
MCP_DISCORD_GATEWAY_READS_ENABLED=true
MCP_DISCORD_CLI_GATEWAY_INSTANCE=default
MCP_DISCORD_SDK_STATE_DIR=/absolute/private/approved-discord-device
~~~

The instance name must match an existing OPENCLAW_INSTANCES entry (or default for a single instance). The historical CLI_GATEWAY_INSTANCE name still selects that one Gateway; it does not cause a CLI launch in SDK mode. HTTPS or loopback HTTP is required. A local CLI executable need not exist in this mode. Do not enable CLI roster discovery if the entire service must be CLI-free; use the separately configured Gateway roster or explicit catalog.

SDK mode requires both Gateway creation and Gateway reads. Missing adapters or inconsistent settings fail closed. It disables **all** Discord CLI fallback, including the legacy connection-refused thread-creation fallback. HTTP read denials never trigger another transport. No client-selected transport, endpoint, account, scope or session key is accepted.

## Service authentication

Two existing authentication surfaces remain separate:

- HTTP reads/creation use the selected instance's configured Gateway bearer credential and its tool policy. The read adapter sends no conversationReadOrigin, runtime identity or direct-operator override. HTTP server policy supplies the read context. It is selected up front, not used as a fallback for a denied WebSocket read.
- SDK calls require a pre-provisioned, operator-approved **integration-owned device identity and operator device token**. The requested scopes are exactly operator.read and operator.write. Both must be recorded in the stored grant and granted by hello. The client identifies itself as gateway-client/backend with no capabilities; it never impersonates cli or requests operator.admin.

MCP_DISCORD_SDK_STATE_DIR must be private (0700); its identity/token files must be private (0600), regular, owner-controlled files. The default is gateway-sdk inside MCP_DISCORD_STATE_DIR. Storage uses the existing gatewayDiscoveryAuth format: the filename prefix is SHA-256(JSON.stringify([instanceName, normalizedWebSocketURL])). The identity file is <prefix>.identity.json and the device token is <prefix>.operator.json. The helper owns key validation, signing and conditional token updates. No CLI identity files are opened.

Provisioning is a separate operator action, **not a service startup side effect**. Use an integration-owned identity from this helper and the supported Gateway SDK/device approval flow, request the two scopes above, and persist the Gateway-issued device token through the helper's storeDeviceAuthToken callback. An existing discovery identity is usable only if its operator-approved device token already has both scopes for the exact instance and endpoint. Do not edit a token's scope array to manufacture permission, copy the CLI's identity, auto-approve pairing, or silently add admin. If no such approved credential exists, stop and obtain the operator's authorization for provisioning.

The SDK adapter uses existingOnly state loading: it does not create an identity/directory, bootstrap with the HTTP/shared Gateway token, pair or request a scope upgrade. Missing or insufficient state returns SDK_APPROVED_DEVICE_REQUIRED before any Discord mutation. A readiness handshake also verifies the granted scopes before thread creation or prompt publication. The host can call discordAgentTransport(...).ready() to check this gate without a model turn. Run it only from the authorized service/operator host; never strip agent provenance to run it from an agent shell.

A write scope does not grant local-admin tool parity. Gateway role ceilings, ownership/sharing, session lifecycle and send policy remain authoritative. A revoked or denied grant is a failure, not a reason to switch transports. /new and /reset can require admin and are not elevated by this adapter.

## Execution and recovery

The agent payload preserves the exact message, configured agent, canonical ordinary thread sessionKey, deliver=true, replyChannel=discord, replyTo=channel:<thread>, replyAccountId and timeout=600. It does not supply a session ID, history reset, synthetic inbound event or caller identity.

The operation journal records an operation-derived agent_idempotency_key before dispatch, separate from creation/publication stage keys. The SDK uses expectFinal=true. Acceptance persists the authoritative run ID only after its session and agent match the admitted route. Callback persistence is awaited before final handling or recovery; acceptance is not completion. The MCP handoff still returns queued after verified publication, while the host owns generation independently of the caller's connection.

After a disconnect with a durably accepted receipt, the worker reconnects with the same approved identity and calls agent.wait for that exact run. It never submits agent again. Pending/timeout observations are not success; observation has a bounded budget and a delay between immediately returning queued observations. Unknown outcomes, lost receipt persistence, route mismatches and denied observation remain uncertain. A timeout does not imply cancellation. Process restart retains the existing fail-closed behavior: old operations are reported interrupted and are not resumed, rewritten or replayed.

Explicit cancellation is a host API, DiscordService.cancel(operationId, selectors), for a currently owned, durably accepted SDK run. It sends chat.abort with exact run/session/agent and requires an acknowledgment naming that run. Duplicate calls share the same cancellation promise; uncertain aborts are not retried. cancellation_status reports requested, acknowledged or unknown, separately from generation. Closing a request/socket or calling shutdown never claims cancellation; shutdown drains owned work. The MCP tool surface is unchanged and does not expose a new cancellation tool.

Generation completion does not prove a Discord reply. delivery_verified remains false unless an exact message ID is returned and read back. Do not regenerate or republish on a delivery timeout. Preserve operation files and uncertain session locks.

## Live release gates and existing limits

Before production opt-in, use the authorized service harness to check readiness and bounded HTTP reads, including one denied target. Then test an approved text-parent new thread, an active MCP-origin thread and an active human-origin thread with existing OpenClaw history. Verify agent/account/session equality, topic context, one prompt, one answer, membership and delivery receipts. Test accepted-run disconnect/observation, duplicate operation IDs and explicit cancellation. Do not use agent-origin tooling to bypass provenance checks for these tests.

Announcement parents still lack the required starter-message design; this migration does not fix them. Archiving on Discord 2026.10.9 can delete the OpenClaw session entry, so reopening can lose prior context. Human discussion never processed by OpenClaw is not imported automatically. Bound, subagent, private, locked or incompatible groupScope routes remain outside the supported ordinary workflow. See the [independent audit](gateway-sdk-feasibility.md).

## Roll back

Set MCP_DISCORD_AGENT_TRANSPORT=cli and reload only the MCP service through its normal operator procedure. Keep Gateway reads/creation flags at their previous values; the legacy mode retains its existing metadata-HTTP/remaining-CLI behavior and the narrowly permitted ECONNREFUSED creation fallback. For an entirely CLI legacy configuration, also restore the prior MCP_DISCORD_THREAD_CREATE_MODE and MCP_DISCORD_GATEWAY_READS_ENABLED values.

Drain active work before swapping releases. Preserve the same operation state directory and all session locks. A rollback does not make an uncertain SDK operation safe to replay: repeated IDs still return the original journal entry. Inspect the existing thread/run before separately authorizing a new operation. No Gateway configuration edit, pairing change or Gateway restart is part of rollback.
