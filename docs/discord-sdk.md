# Discord without a local OpenClaw CLI

The opt-in SDK path covers ordinary new-thread and existing-thread workflows. It uses @openclaw/gateway-client 2026.10.9 for agent execution, observation and explicit cancellation. Channel discovery, thread lists, permissions and exact-ID readback use the existing authenticated Gateway HTTP /tools/invoke adapter. Thread creation stays on that HTTP adapter; membership and exact request publication stay on Discord REST.

This is not a pure-SDK implementation. CLI remains the default and the explicit rollback transport. Generic chat, MCP OAuth, roster discovery and configured routing are unchanged. Automated tests use fake transports. On 9 November 2026, a live local-shared-token canary created a new thread, continued the same session and recalled a code supplied only in the first turn. Repeating the first operation reused its original run and thread. Gateway delivery reported sent for both turns; independent Discord message readback was unavailable in the test session. Channel/thread discovery and blacklist enforcement passed without CLI invocations. Production reconnect and cancellation remain untested; their protocol behavior is covered by automated tests. Revalidate these gates for each deployment.

## Opt in

Keep the existing Discord account, allowed scopes, channel policy, request-publisher credential, membership settings and verified ordinary inbound routing. Add these settings to the trusted service environment (also pass them through any launcher allowlist):

~~~dotenv
MCP_DISCORD_AGENT_TRANSPORT=sdk
MCP_DISCORD_THREAD_CREATE_MODE=gateway
MCP_DISCORD_GATEWAY_READS_ENABLED=true
MCP_DISCORD_CLI_GATEWAY_INSTANCE=default
MCP_DISCORD_SDK_STATE_DIR=/absolute/private/approved-discord-device
MCP_DISCORD_SDK_AUTH=device
~~~

The instance name must match an existing OPENCLAW_INSTANCES entry (or default for a single instance). The historical CLI_GATEWAY_INSTANCE name still selects that one Gateway; it does not cause a CLI launch in SDK mode. HTTPS or loopback HTTP is required. A local CLI executable need not exist in this mode. Do not enable CLI roster discovery if the entire service must be CLI-free; use the separately configured Gateway roster or explicit catalog.

SDK mode requires both Gateway creation and Gateway reads. Missing adapters or inconsistent settings fail closed. It disables **all** Discord CLI fallback, including the legacy connection-refused thread-creation fallback. HTTP read denials never trigger another transport. No client-selected transport, endpoint, account, scope or session key is accepted.

## Service authentication

HTTP reads/creation use the selected instance's configured Gateway bearer credential and its tool policy. The read adapter sends no conversationReadOrigin, runtime identity or direct-operator override. HTTP server policy supplies the read context. It is selected up front, not used as a fallback for a denied WebSocket read.

SDK authentication is selected explicitly with MCP_DISCORD_SDK_AUTH:

- **device (default):** requires a pre-provisioned integration-owned identity and an operator-approved device token containing operator.read and operator.write for the exact instance/endpoint. It never supplies the shared instance token if device authentication fails.
- **local-shared-token (opt-in):** uses that same dedicated identity to sign the official SDK handshake and authenticates with the existing selected instance token. Only literal loopback endpoints, 127.0.0.1 or [::1], are allowed, over HTTP or HTTPS; localhost and remote hostnames are rejected to avoid DNS or hosts-file changes disclosing the shared token. No device token or paired record is required. Device-token loading, storage and clearing are disabled in this mode, including SDK credential retries. This mode never becomes a fallback for another failed authentication attempt.

Both modes identify the client honestly as gateway-client/backend, role operator, caps=[], and request exactly operator.read and operator.write. Hello must grant exactly those two scopes and the operator role. Missing scopes, extras (including operator.admin), duplicate grants, or server denial stop the operation. No model/tool request is sent after a rejected handshake.

OpenClaw 2026.10.9 supports local backend shared authentication without self-pairing: shouldSkipLocalBackendSelfPairing permits an authenticated local gateway-client/backend connection, and a device token need not be issued when there is no paired record. A successful scoped hello without a device token is therefore valid in the explicitly selected local-shared-token mode; it is not a missing-permission workaround. The server still decides locality, admission, ownership and tool authority. A genuine pairing/authentication denial is not bypassed.

For an authorized local service using an existing dedicated identity, add:

~~~dotenv
MCP_DISCORD_SDK_AUTH=local-shared-token
~~~

Keep the selected instance's token in its existing private configuration; do not copy it into a new variable, source file or operation journal. The service does not turn the shared token into a device token or change Gateway configuration. To return to device authentication, explicitly set MCP_DISCORD_SDK_AUTH=device and provide its previously approved device grant. Neither mode switches automatically.

MCP_DISCORD_SDK_STATE_DIR must be private (0700); its identity/token files must be private (0600), regular, owner-controlled files. The default is gateway-sdk inside MCP_DISCORD_STATE_DIR. Storage uses the existing gatewayDiscoveryAuth format: the filename prefix is SHA-256(JSON.stringify([instanceName, normalizedWebSocketURL])). The identity file is <prefix>.identity.json and the device token, when used, is <prefix>.operator.json. The helper owns key validation, signing and conditional device-token updates. No CLI identity files are opened.

Identity creation and device-token provisioning are separate operator actions, not service startup effects. Both modes load an existing integration-owned identity and never generate a replacement. Device mode requires the supported Gateway approval/token flow; local-shared-token mode requires the operator's explicit authorization to use the configured shared credential locally. Do not edit token scope arrays, copy the CLI's identity, auto-approve pairing, or add admin.

Missing identity state returns SDK_SERVICE_IDENTITY_REQUIRED in local-shared-token mode; missing/insufficient device state returns SDK_APPROVED_DEVICE_REQUIRED in device mode. A readiness handshake verifies grants before thread creation or prompt publication. The host can call discordAgentTransport(...).ready() to check this gate without a model turn. Run it only from the authorized service/operator host; never strip agent provenance to run it from an agent shell.

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
