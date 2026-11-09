# Use more than one OpenClaw agent

Suppose your team has two OpenClaw agents: `alice` helps Alice, and `marco` helps Marco. You want people using an MCP client, such as Claude, to choose which agent handles a request. They might ask Alice’s agent to review a document, then ask Marco’s agent to plan a project.

This guide shows how to make those existing agents available through the MCP server. Discord is optional: both agents can answer in the MCP client, whether or not they have a Discord server.

**Everyone who can authenticate to this MCP server can select any agent it exposes.** Choosing an agent is not a user login or an access restriction. This version is intended for people who share access; it does not isolate employees from one another.

## Before you start

You need a working connection between the MCP server and OpenClaw, and at least two agents already created in OpenClaw. If the connection is not set up yet, follow [basic configuration](configuration.md) first.

You also need a build that includes the multi-agent feature. It is on this repository’s `main` branch; the earlier v1.10.0 release archive does not include it. To build from source, follow [development](development.md).

Two names appear in the settings below:

- **Agent ID** identifies an assistant inside OpenClaw, for example `alice`.
- **Instance** is this MCP server’s label for an OpenClaw connection. If you connect to one OpenClaw installation using `OPENCLAW_URL`, that label is `default`. You do not need one instance per agent.

The instructions below use one installation, with the MCP server running on the same machine as OpenClaw. If they run on different machines, use [the manual option](#if-the-mcp-server-cannot-read-your-openclaw-installation).

## 1. Check that OpenClaw can list the agents

On the machine running the MCP server, run:

```sh
openclaw agents list --json
openclaw agents bindings --json
```

The first command should include the agent IDs you want to use. The second lists rules that connect channels, such as Discord servers, to agents. An empty list of those rules is fine if you do not use Discord.

Run these checks as the same operating-system user that runs the MCP service. A successful command in your personal shell does not prove that the service can find the same OpenClaw installation.

## 2. Let the MCP server read that list

Add these environment variables to the configuration that starts your **MCP service**, alongside its existing Gateway credentials:

```sh
MCP_AGENT_DISCOVERY=cli
MCP_AGENT_DISCOVERY_INSTANCE=default
```

These are MCP server settings, not entries to paste into OpenClaw’s agent configuration. If you start the MCP server from a shell, export them there; if you use a service manager or container, add them to its environment. Leave your existing credentials and default agent unchanged.

If the service cannot find the `openclaw` command, also set `MCP_AGENT_DISCOVERY_EXECUTABLE` to its absolute path.

Restart **the MCP service** after saving the settings. You do not need to restart the OpenClaw Gateway. The MCP service reads agents and channel assignments at startup; restart it again when those assignments change. Clients may need to reconnect and refresh their tool list after an update.

## 3. Check the agents from your MCP client

Ask your client:

> List the OpenClaw agents I can use.

It should call `openclaw_agents`. If Alice is your configured default, the two-agent result would look like this:

```json
{
  "agents": [
    {"instance": "default", "agent_id": "alice", "is_default": true},
    {"instance": "default", "agent_id": "marco", "is_default": false}
  ],
  "total": 2
}
```

Then try:

> Ask Marco’s agent to reply with a short greeting.

The client selects Marco by passing `agent_id` to the chat tool. If you are writing an integration, the equivalent arguments to `openclaw_chat` are:

```json
{
  "instance": "default",
  "agent_id": "marco",
  "message": "Reply with a short greeting."
}
```

Follow-up requests should reuse the conversation details returned by the tool. Async tasks also keep the agent selected when they were submitted. Omitting `agent_id` keeps the installation’s existing default behavior.

If you do not use Discord, setup is complete.

## Optional: send each agent’s work to Discord

Suppose Alice’s agent works in one Discord server and Marco’s works in another. OpenClaw stores those assignments as **bindings**: rules that say which agent receives messages from a server or channel.

With local discovery enabled, the MCP server reads those existing rules. You do not need a second independent set of routing rules. An agent can have no Discord assignment, one server, several servers, or specific channels.

You still need to configure **where the MCP server is allowed to act**. Reading a binding does not grant permission to post in that Discord server.

1. Set up the Discord bot credentials and allowed servers/channels using the [Discord setup guide](discord-skills.md). Discord tools remain disabled until you enable them.
2. Set `MCP_DISCORD_CLI_GATEWAY_INSTANCE=default` for this one-installation example. This tells the Discord integration which OpenClaw connection its local CLI uses.
3. Keep the existing discovery scopes (the allowed server/account combinations) and channel restrictions. Scopes still require their `agentId` field; imported bindings determine the effective agent within those permitted destinations. They do not add other servers to the allowlist.
4. Ask your client to list the allowed Discord channels for each agent. Check that Alice and Marco see the destinations you intended before submitting work.

The client then chooses a returned destination when opening or continuing a thread. It cannot send a request to Alice’s destination while specifying Marco as the agent: conflicting selections return an error. A more specific channel assignment takes priority over its server-wide assignment.

For writes, the existing Discord setup also requires confirmation that ordinary replies in those channels reach the expected agent. Creating new channels is a separate opt-in feature. This version uses one configured Discord bot account; it does not import additional bot credentials.

## If the MCP server cannot read your OpenClaw installation

For example, the MCP server may run in a container without the OpenClaw CLI, or connect to a remote Gateway. In that case, provide the agent list yourself instead of enabling CLI discovery.

Set `MCP_AGENT_CATALOG` to this JSON string in the MCP service’s environment:

```json
[
  {
    "instance": "default",
    "agents": [{"id": "alice"}, {"id": "marco"}]
  }
]
```

Replace the IDs with agents that already exist in OpenClaw. This setting lists agents; it does not create them. Omit the CLI discovery variables when using this option for the same instance. Keep credentials in the existing connection settings, not in this list.

If you use multiple OpenClaw installations, replace `default` with the appropriate connection name from `OPENCLAW_INSTANCES`. The [configuration reference](multiagent-reference.md) explains manual Discord bindings, multiple connections and routing details.

## If something does not work

- **Only the old tools appear:** confirm you are running a build with `openclaw_agents`, then reconnect or refresh the client’s MCP tool list.
- **The MCP service fails to start:** run both CLI commands from step 1 as the service user. Check the executable path and instance name. Do not configure two agent-list sources for the same connection.
- **An agent is missing:** check the CLI output or your manual list, then restart the MCP service. Agent IDs are case-insensitive; instance names are case-sensitive.
- **An agent is listed but has no Discord channels:** it may have no Discord assignment, or its destinations may be excluded by MCP permissions. This does not prevent direct chat.
- **A follow-up reports a conflict:** use the instance, agent and session returned by the original request, rather than switching agents midway through that conversation.
