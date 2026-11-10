# Use more than one OpenClaw agent

Suppose your team has two OpenClaw agents: `alice` helps Alice, and `marco` helps Marco. You want people using an MCP client, such as Claude, to choose which agent handles a request. They might ask Alice’s agent to review a document, then ask Marco’s agent to plan a project.

This guide shows how to make those existing agents available through the MCP server. Discord is optional: both agents can answer in the MCP client, whether or not they have a Discord server.

**Everyone who can authenticate to this MCP server can select any agent it exposes.** Choosing an agent is not a user login or an access restriction. This version is intended for people who share access; it does not isolate employees from one another.

## Before you start

You need a working connection between the MCP server and OpenClaw, and at least two agents already created in OpenClaw. If the connection is not set up yet, follow [basic configuration](configuration.md) first.

Multi-agent support is included in v2.0.0. Download the release archive or build from source following [development](development.md).

An **agent ID** identifies an assistant inside OpenClaw, for example `alice`. One MCP deployment connects to one OpenClaw installation, and several agents can share that connection. Use separate MCP deployments for multiple installations. You do not need a local OpenClaw CLI to retrieve the roster.

## 1. Enable agent discovery

Use Node.js 22.19 or newer (Node 24 recommended). This build pins the official Gateway SDK to 2026.10.9 and targets the matching Gateway release, using protocol v4. Other Gateway releases need a compatibility check before use.

Add this variable to the configuration that starts your **MCP service**, alongside its existing Gateway URL and token:

```sh
MCP_AGENT_DISCOVERY=gateway
```

Leave your existing default agent and credentials unchanged. Remote URLs must use HTTPS and accept WebSocket upgrades; loopback HTTP is supported. Remove obsolete CLI discovery settings if switching from a CLI-based release.

The service reads only the agent roster, once at startup. It does not read OpenClaw configuration or channel bindings. Restart **the MCP service** after agent-list changes; the Gateway does not need a restart. If Gateway discovery fails, startup fails rather than serving a partial roster.

## 2. Pair the MCP service when requested

Start the MCP service. On its first connection, the Gateway may require approval of the service’s device identity. The startup error identifies the device. An operator can review pending requests in that Gateway’s device-management interface. If the operator uses the OpenClaw CLI on the **Gateway host**, the equivalent commands are below; these are manual administration, not commands executed or required on the MCP bridge host:

```sh
openclaw devices list
openclaw devices approve <requestId>
```

Approve only the current request matching that device and the display name `openclaw-mcp agent discovery`. It requests `operator.read`, not admin access. Then start the MCP service again. Do not disable device checks to make discovery work.

The service keeps its own keys and device tokens in `~/.openclaw-mcp/gateway-discovery`, keyed by the normalized WebSocket endpoint. It does not reuse the CLI’s identity. Keep this directory private to the service user and persistent across restarts. For containers or a dedicated state volume, set `MCP_AGENT_DISCOVERY_STATE_DIR` to an absolute directory owned by that user (0700 directory, 0600 files on POSIX; restrict access with ACLs on Windows). Do not commit or share these files. A paired token is reused on later starts.

## 3. Check the agents from your MCP client

Ask your client:

> List the OpenClaw agents I can use.

It should call `openclaw_agents`. If Alice is your configured default, the two-agent result would look like this:

```json
{
  "agents": [
    {"agent_id": "alice", "is_default": true},
    {"agent_id": "marco", "is_default": false}
  ],
  "total": 2
}
```

Then try:

> Ask Marco’s agent to reply with a short greeting.

The client selects Marco by passing `agent_id` to the chat tool. If you are writing an integration, the equivalent arguments to `openclaw_chat` are:

```json
{
  "agent_id": "marco",
  "message": "Reply with a short greeting."
}
```

Follow-up requests should reuse the conversation details returned by the tool. Async tasks also keep the agent selected when they were submitted. Omitting `agent_id` keeps the installation’s existing default behavior.

If you do not use Discord, setup is complete.

## Optional: send each agent’s work to Discord

Suppose Alice’s agent works in one Discord server and Marco’s works in another. OpenClaw stores those assignments as **bindings**: rules that say which agent receives messages from a server or channel.

Gateway roster discovery does not import those rules. Keep your existing manual Discord routes, or supply explicit `bindings` alongside the discovered roster as shown in the [configuration reference](multiagent-reference.md#gateway-sdk-roster). An agent can have no Discord assignment, one server, several servers, or specific channels. CLI discovery is no longer supported.

You still need to configure **where the MCP server is allowed to act**. Reading a binding does not grant permission to post in that Discord server.

1. Set up the Discord bot credentials and allowed servers/channels using the [Discord setup guide](discord-skills.md). Discord tools remain disabled until you enable them.
2. Configure the [SDK service identity](discord-sdk.md#service-authentication) for the same Gateway connection used by direct chat.
3. Keep the existing discovery scopes (the allowed server/account combinations) and channel restrictions. Scopes still require their `agentId` field; imported bindings determine the effective agent within those permitted destinations. They do not add other servers to the allowlist.
4. Ask your client to list the allowed Discord channels for each agent. Check that Alice and Marco see the destinations you intended before submitting work.

The client then chooses a returned destination when opening or continuing a thread. It cannot send a request to Alice’s destination while specifying Marco as the agent: conflicting selections return an error. A more specific channel assignment takes priority over its server-wide assignment.

For writes, the existing Discord setup also requires confirmation that ordinary replies in those channels reach the expected agent. Creating new channels is a separate opt-in feature. This version uses one configured Discord bot account and the same Gateway connection for the complete workflow. See [the Discord connection setup](discord-skills.md#one-gateway-connection-per-mcp-service).

## If the MCP server cannot read your OpenClaw installation

If you prefer a fixed list, or cannot pair the service with a Gateway, provide the roster yourself instead of enabling discovery. This option does not need a WebSocket connection or a local CLI.

Set `MCP_AGENT_CATALOG` to this JSON string in the MCP service’s environment:

```json
{
  "agents": [{"id": "alice"}, {"id": "marco"}]
}
```

Replace the IDs with agents that already exist in OpenClaw. This setting lists agents; it does not create them. Omit `MCP_AGENT_DISCOVERY` and its related variables when using a static roster. Keep credentials in the existing connection settings, not in this list.

The [configuration reference](multiagent-reference.md) explains manual Discord bindings and routing details. For another OpenClaw installation, configure a separate MCP deployment.

## If something does not work

- **Only the old tools appear:** confirm you are running a build with `openclaw_agents`, then reconnect or refresh the client’s MCP tool list.
- **The MCP service fails to start:** check the Gateway URL, token and pairing approval, and the private state directory. A working HTTP connection does not prove WebSocket access. Do not combine a static roster with Gateway discovery. Only `gateway` or an unset discovery setting is supported; remove CLI-only settings as described in the [upgrade guide](discord-sdk.md#upgrade-from-cli-based-releases).
- **An agent is missing:** check the Gateway roster or your manual list, then restart the MCP service. Agent IDs are case-insensitive.
- **An agent is listed but has no Discord channels:** it may have no Discord assignment, or its destinations may be excluded by MCP permissions. This does not prevent direct chat.
- **A follow-up reports a conflict:** use the agent and session returned by the original request, rather than switching agents midway through that conversation.
