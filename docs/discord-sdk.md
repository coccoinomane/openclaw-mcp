# Discord without a local OpenClaw CLI

All ordinary new-thread and existing-thread workflows use @openclaw/gateway-client 2026.10.9 for agent execution, observation and explicit cancellation. Channel discovery, thread lists, permissions and exact-ID readback use the existing authenticated Gateway HTTP /tools/invoke adapter. Thread creation stays on that HTTP adapter; membership and exact request publication stay on Discord REST.

No OpenClaw CLI is installed or launched. Agents and bindings are read live through agents.list and config.get. Configure the [agent-first access rules](multiagent-reference.md), credentials and private state in [configuration](configuration.md). No live test is implied by the automated suite.

## Service authentication

HTTP reads/creation use the configured Gateway bearer credential and its tool policy. The read adapter sends no conversationReadOrigin, runtime identity or direct-operator override. HTTP server policy supplies the read context. It is selected up front, not used as a fallback for a denied WebSocket read.

SDK authentication is selected explicitly with MCP_DISCORD_SDK_AUTH:

- **device (default):** requires a pre-provisioned integration-owned identity and an operator-approved device token containing operator.read and operator.write for the exact Gateway endpoint. It never supplies the shared Gateway token if device authentication fails.
- **local-shared-token (opt-in):** uses that same dedicated identity to sign the official SDK handshake and authenticates with the configured Gateway token. Only literal loopback endpoints, 127.0.0.1 or [::1], are allowed, over HTTP or HTTPS; localhost and remote hostnames are rejected to avoid DNS or hosts-file changes disclosing the shared token. No device token or paired record is required. Device-token loading, storage and clearing are disabled in this mode, including SDK credential retries. This mode never becomes a fallback for another failed authentication attempt.

Both modes identify the client honestly as gateway-client/backend, role operator, caps=[], and request exactly operator.read and operator.write. Hello must grant exactly those two scopes and the operator role. Missing scopes, extras (including operator.admin), duplicate grants, or server denial stop the operation. No model/tool request is sent after a rejected handshake.

OpenClaw 2026.10.9 supports local backend shared authentication without self-pairing: shouldSkipLocalBackendSelfPairing permits an authenticated local gateway-client/backend connection, and a device token need not be issued when there is no paired record. A successful scoped hello without a device token is therefore valid in the explicitly selected local-shared-token mode; it is not a missing-permission workaround. The server still decides locality, admission, ownership and tool authority. A genuine pairing/authentication denial is not bypassed.

For an authorized local service using an existing dedicated identity, add:

~~~dotenv
MCP_DISCORD_SDK_AUTH=local-shared-token
~~~

Keep the Gateway token in its existing private configuration; do not copy it into a new variable, source file or operation journal. The service does not turn the shared token into a device token or change Gateway configuration. To return to device authentication, explicitly set MCP_DISCORD_SDK_AUTH=device and provide its previously approved device grant. Neither mode switches automatically.

MCP_DISCORD_SDK_STATE_DIR must be private (0700); its identity/token files must be private (0600), regular, owner-controlled files. The default is gateway-sdk inside MCP_DISCORD_STATE_DIR. The gatewayDiscoveryAuth filename prefix is SHA256(JSON.stringify([url])), where url is the normalized WebSocket URL. Convert HTTP to ws and HTTPS to wss with URL parsing, preserve the endpoint path, then serialize with URL.toString(). For example, https://gateway.example.com becomes wss://gateway.example.com/. The identity file is <prefix>.identity.json and the device token, when used, is <prefix>.operator.json. The helper owns key validation, signing and conditional device-token updates. No CLI identity files are opened. Older name-qualified filenames are not read or migrated at runtime; prepare the integration-owned identity and matching device grant before deployment as described in [deployment preparation](configuration.md#breaking-upgrade).

Identity creation and device-token provisioning are separate operator actions, not service startup effects. Both modes load an existing integration-owned identity and never generate a replacement. Device mode requires the supported Gateway approval/token flow; local-shared-token mode requires the operator's explicit authorization to use the configured shared credential locally. Do not edit token scope arrays, copy the CLI's identity, auto-approve pairing, or add admin.

Missing identity state returns SDK_SERVICE_IDENTITY_REQUIRED in local-shared-token mode; missing/insufficient device state returns SDK_APPROVED_DEVICE_REQUIRED in device mode. A readiness handshake verifies grants before thread creation or prompt publication. The host can call discordAgentTransport(...).ready() to check this gate without a model turn. Run it only from the authorized service/operator host; never strip agent provenance to run it from an agent shell.

A write scope does not grant local-admin tool parity. Gateway role ceilings, ownership/sharing, session lifecycle and send policy remain authoritative. A revoked or denied grant is a failure, not a reason to switch transports. /new and /reset can require admin and are not elevated by this adapter.

## Native session forks

New-thread asks may supply `fork_from_session_key`. The existing Discord SDK identity calls `sessions.resolve` to check that the fresh thread's destination session is absent, then `sessions.create` with a same-agent parent, `fork: true` and `forkFrom: "last-completed"`. The create request contains no initial message or task. An explicit model is supplied at creation so the Gateway checks fork capacity against that model. The ordinary prompt publication and agent turn follow only after a verified fork receipt.

The durable operation records the source and fork stage before the mutation. Uncertain or interrupted forks are never replayed; their destination claims are retained. SDK idempotency is supplementary and is not a substitute for that journal. An existing destination is rejected rather than deliberately reforked.

Gateway session creation currently has no atomic create-if-absent option. The fresh-thread workflow, local claim and existence check do not lock out unrelated native Discord messages between the check and creation. A receipt reporting a replaced session stops publication and execution, but cannot undo that replacement. This limitation needs a Gateway-level conditional-create primitive for a strict concurrency guarantee.

Protocol and behavior are covered by fake-transport tests and checked against installed Gateway source. No live fork or deployment is performed by this PR.

## Execution and recovery

The agent payload preserves the exact message, configured agent, canonical ordinary thread sessionKey, deliver=true, replyChannel=discord, replyTo=channel:<thread>, replyAccountId and timeout=600. It does not supply a session ID, history reset, synthetic inbound event or caller identity.

The operation journal records an operation-derived agent_idempotency_key before dispatch, separate from creation/publication stage keys. The SDK uses expectFinal=true. Acceptance persists the authoritative run ID only after its session and agent match the admitted route. Callback persistence is awaited before final handling or recovery; acceptance is not completion. The MCP handoff still returns queued after verified publication, while the host owns generation independently of the caller's connection.

After a disconnect with a durably accepted receipt, the worker reconnects with the same approved identity and calls agent.wait for that exact run. It never submits agent again. Pending/timeout observations are not success; observation has a bounded budget and a delay between immediately returning queued observations. Unknown outcomes, lost receipt persistence, route mismatches and denied observation remain uncertain. A timeout does not imply cancellation. Process restart retains the existing fail-closed behavior: old operations are reported interrupted and are not resumed, rewritten or replayed.

Explicit cancellation is a host API, DiscordService.cancel(operationId, selectors), for a currently owned, durably accepted SDK run. It sends chat.abort with exact run/session/agent and requires an acknowledgment naming that run. Duplicate calls share the same cancellation promise; uncertain aborts are not retried. cancellation_status reports requested, acknowledged or unknown, separately from generation. Closing a request/socket or calling shutdown never claims cancellation; shutdown drains owned work. The MCP tool surface is unchanged and does not expose a new cancellation tool.

Generation completion does not prove a Discord reply. delivery_verified remains false unless an exact message ID is returned and read back. Do not regenerate or republish on a delivery timeout. Preserve operation files and uncertain session locks.

## Live release gates and existing limits

Before production use, use the authorized service harness to check readiness and bounded HTTP reads, including one denied target. Then test an approved text-parent new thread, an active MCP-origin thread and an active human-origin thread with existing OpenClaw history. Verify agent/account/session equality, topic context, one prompt, one answer, membership and delivery receipts. Test accepted-run disconnect/observation, duplicate operation IDs and explicit cancellation. Do not use agent-origin tooling to bypass provenance checks for these tests.

Announcement parents are not live-verified, even with the default silent starter. Archiving on Discord 2026.10.9 can delete the OpenClaw session entry, so reopening can lose prior context. Human discussion never processed by OpenClaw is not imported automatically. Private and locked threads remain unsupported. Access checks intentionally do not inspect runtime ownership or groupScope routing. See the [independent audit](gateway-sdk-feasibility.md).

## Breaking upgrade

Drain active work and preserve journals, uncertain claims and identity state. Remove static agent catalogs, local destination lists and policy selectors. Set OPENCLAW_DEFAULT_AGENT_ID or require explicit agent_id with OPENCLAW_AGENT_IS_MANDATORY=true. Retain approved SDK authentication, bot credentials and private directories. There are no compatibility aliases or automatic migrations. See [configuration](configuration.md).

## Remaining HTTP/REST calls and SDK feasibility

This inventory covers outbound calls made by the bridge itself. The MCP HTTP/SSE listener, OAuth routes and local `/health` endpoint are incoming server APIs; removing them would break client transport rather than replace an OpenClaw CLI dependency. The Node launcher and `openclaw-mcp` command start this bridge, not the OpenClaw CLI.

| Purpose | Current request and code | SDK migration advice |
| --- | --- | --- |
| Direct sync/async chat | `POST /v1/chat/completions` in [OpenClawClient.chat](../src/openclaw/client.ts), with the configured Gateway, model, agent header and session header/body | Keep HTTP for this change. A future `agent` or chat RPC adapter must preserve response/usage fields, session-key reuse, agent routing, task ownership and timeout behavior; it is not a drop-in fetch replacement. |
| Gateway reachability | `OpenClawClient.health` posts to the same endpoint with `model: health-check`, empty messages and `max_tokens: 1`; any 2xx–4xx response reports reachability | An SDK readiness/health probe is feasible as a separate change, but would measure a different authentication/protocol path. Preserve the distinction between reachability and agent authorization. |
| Discord metadata, threads, permissions and answer readback | [channelReader](../src/openclaw/discord-read.ts) posts `message` to `/tools/invoke`; allowed actions are `channel-list`, `channel-info`, `thread-list`, `permissions` and `read`. The last requires the exact message ID and `limit: 1`. | A closed SDK `tools.invoke`/`message.action` adapter is plausible. Verify deployed method/schema support, write-scope requirements for tool RPCs, conversation-read authority and response shape. Do not retry denied SDK reads over HTTP or broaden scopes for parity. |
| New thread | [threadInvoker](../src/openclaw/discord-thread.ts) posts `message/thread-create` to `/tools/invoke` with configured account, parent, title, operation idempotency key and, by default, a freshly posted silent starter message ID | Feasible through a constrained SDK tool/action call after equivalent policy, ancestry and partial-result tests. Preserve unknown outcomes and no-replay behavior. Announcement parents remain unverified. |
| Optional normal text channel | [channelInvoker](../src/openclaw/discord-channels.ts) posts `message/channel-create` to `/tools/invoke` with verified guild/category/account, `channelType: 0` and idempotency key | Feasible with the same authorization, readback and durable operation checks. Keep explicit user authorization for creation; do not expose arbitrary SDK methods. |
| New-thread membership | [threadMemberAdder](../src/openclaw/discord-thread.ts) sends one `PUT`, then one `GET`, to `https://discord.com/api/v10/channels/{thread}/thread-members/{configuredUser}` | Retain REST. The inspected Gateway message surface has no thread-member-add action. An SDK client cannot add a missing server capability; a Gateway feature would be needed first. |
| Exact prompt publication and verification | [requestPublisher](../src/openclaw/discord-request.ts) sends one `POST` to `https://discord.com/api/v10/channels/{thread}/messages`, then `GET .../messages/{returnedId}`. Long prompts use multipart `richiesta.txt`. Both new-thread and existing-thread requests use it. | Retain REST until a Gateway method preserves exact bytes/whitespace, disables all mentions and reply mentions, suppresses embeds, supports attachments and returns IDs for readback. The inspected message/send path lacks the required public allowed-mentions control and trims trailing whitespace. |

Gateway HTTP adapters use the configured Gateway bearer token; Discord REST uses the configured bot token. Discord calls reject redirects and use 30-second request deadlines. SDK device authentication does not replace either HTTP credential. None of these writes retries through a different transport.

Roster discovery already uses SDK `agents.list` in [gateway-discovery.ts](../src/openclaw/gateway-discovery.ts). Discord generation, reconnect observation and explicit cancellation already use `agent`, `agent.wait` and `chat.abort` in [discord-agent.ts](../src/openclaw/discord-agent.ts). Move remaining Gateway reads first only if there is a concrete need to consolidate transports; test denied targets and actual device authority before migrating writes. Keep membership and exact publication on REST until equivalent server capabilities exist. This section is feasibility advice, not an implementation or live-equivalence claim.
