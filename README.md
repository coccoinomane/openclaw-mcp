<!-- mcp-name: io.github.coccoinomane/openclaw-mcp -->

# OpenClaw MCP Server

[![CI](https://github.com/coccoinomane/openclaw-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/coccoinomane/openclaw-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Connect Claude or another MCP client to your [OpenClaw](https://github.com/openclaw/openclaw) assistant. Ask directly, keep a conversation going, or hand work off to Discord. Supports Streamable HTTP, legacy SSE and stdio, with OAuth 2.1 for authenticated HTTP access.

One MCP deployment connects to one OpenClaw installation. It can expose multiple agents on that Gateway. Use separate MCP deployments for multiple OpenClaw installations.

## A chief of staff for your Discord server

The optional Discord integration lets your MCP client act as a chief of staff: choose the appropriate authorized channel, open a thread with your request, add you as a member and hand you the link. OpenClaw works in the background; you continue the conversation in Discord, with the request and its answer together rather than scattered across apps.

The first bot message contains the submitted request or contextual assignment. Operators can set `MCP_DISCORD_FORWARDING_REQUESTER_NAME` to add `**Forwarding <name>’s request**` above new-thread requests; the server adds it, not the calling client. Clients may supply an optional `source` string: preferably the full originating client conversation URL, otherwise the declared client name plus session ID, otherwise the declared client name. Any client or domain is supported, including for forks. The caption shows `Forwarding <name>’s request from <source>`, or `Forwarding request from <source>` without a configured name. The source is visible text, never a masked Markdown link. HTML tags are stripped; unsafe formatting and mentions are neutralized. Omit it when unknown. Existing-thread replies and agent input stay unchanged. Clients preserve the work request or prepare a contextual handoff, then return the destination link (a native thread mention on Discord). Discord always uses the Gateway SDK for agent turns, Gateway HTTP for reads and creation, and Discord REST for membership and exact request publication. The bridge does not require or launch the OpenClaw CLI. Direct Ask OpenClaw remains available.

Discord is **off by default**. Enable MCP_DISCORD_ENABLED and provision the [SDK service identity](docs/discord-sdk.md#service-authentication). Select an agent before choosing its current bound destinations. Only that agent’s server/channel bindings grant access; other agents do not subtract it. Threads inherit their verified parent. See [setup](docs/discord-skills.md).

Seven Discord tools cover discovery, threads, asks, replies, channel messages, channel creation and operation status (15 tools with Discord enabled, 8 without). All advertise output schemas and validate structured results. The [coordinator skill](skills/openclaw-coordinator/SKILL.md) is available through MCP Skills and legacy resources. The separate [companion plugin](https://github.com/coccoinomane/openclaw-discord-coordination) provides local workflow guidance.

Call `openclaw_models` for the target agent before choosing a model. `openclaw_chat` (new sessions only) and `openclaw_discord_ask` accept an optional `model` that stays with the new session. Omission keeps the current defaults; Discord replies and async chat cannot change the model. OpenClaw validates the selection, without an extra inference probe.

To branch an existing conversation into a new Discord thread, pass its canonical OpenClaw session key as `fork_from_session` to `openclaw_discord_ask`. Source and destination must belong to the same agent on this Gateway. The native fork copies history through the last completed turn, then the separately supplied prompt is published and executed as the new assignment. Explicit `model` overrides apply only to the child; otherwise inherited model settings remain. Fork failure prevents prompt publication and agent execution; inspect the retained operation/thread rather than creating a replacement. Existing-thread replies cannot fork or replace their session history.

## Install this fork

Use the archive from [GitHub Releases](https://github.com/coccoinomane/openclaw-mcp/releases). It includes compiled JavaScript and a dependency lockfile; dependencies are installed separately. Node.js 22.19 or newer is required; Node.js 24 is recommended.

```sh
mkdir openclaw-mcp && cd openclaw-mcp
tar -xzf /path/to/openclaw-mcp-3.0.1.tar.gz
npm ci --omit=dev --ignore-scripts
# Set Gateway credentials and HTTP authentication environment variables first.
node dist/index.js --transport http
```

Point your MCP client at `https://your-host/mcp`. For local stdio, use `node dist/index.js --transport stdio` with the required environment. Follow [configuration](docs/configuration.md) and [deployment](docs/deployment.md) for authentication and hosting. This fork is released on GitHub only; the upstream npm package and container images do not contain these fork-specific changes. `server.json` records release metadata without registry package entries. For upgrades from 2.x, follow the [breaking configuration changes](docs/configuration.md#breaking-upgrade).

## Operation and limits

Direct chat returns a conversation ID; reuse it through the same MCP deployment for follow-ups. Discord asks return a queued link after the request is published, without waiting for the answer. Keep the operation ID to inspect status after a disconnect; never blindly retry an uncertain write. The MCP can create new threads or continue existing public threads.

Use this bridge with trusted clients. Its shared operator credentials and agent bindings are not a multi-tenant isolation system. Keep HTTP authentication enabled. OAuth state is in memory; restarts can require client reconnection. Accepted Discord work survives client disconnects, but interrupted work after a service restart is not automatically replayed.

For details, see [conversation continuity](docs/conversation-continuity.md), [Discord configuration and recovery](docs/discord-skills.md), and [development](docs/development.md).

## Credits

Fork of [freema/openclaw-mcp](https://github.com/freema/openclaw-mcp), created by [Tomáš Grasl](https://www.tomasgrasl.cz/). MIT license; original attribution retained.

## Agent selection

Have more than one OpenClaw agent? Follow [Use more than one OpenClaw agent](docs/multiagent.md) to list them in your MCP client and choose who handles a request. Agents share the configured OpenClaw installation; add Discord assignments only if you need them. Every authenticated client can select every configured agent.

Select agent_id explicitly or configure OPENCLAW_DEFAULT_AGENT_ID. OPENCLAW_AGENT_IS_MANDATORY=true always requires it. Discovery and validation refresh from Gateway on every call.
