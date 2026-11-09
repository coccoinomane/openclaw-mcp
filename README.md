<!-- mcp-name: io.github.coccoinomane/openclaw-mcp -->

# OpenClaw MCP Server

[![CI](https://github.com/coccoinomane/openclaw-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/coccoinomane/openclaw-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Connect Claude or another MCP client to your [OpenClaw](https://github.com/openclaw/openclaw) assistant. Ask directly, keep a conversation going, or hand work off to Discord. Supports Streamable HTTP, legacy SSE and stdio, with OAuth 2.1 for authenticated HTTP access.

## A chief of staff for your Discord server

The optional Discord integration lets your MCP client act as a chief of staff: choose the appropriate authorized channel, open a thread with your request, add you as a member and hand you the link. OpenClaw works in the background; you continue the conversation in Discord, with the request and its answer together rather than scattered across apps.

The first bot message contains your unchanged request. Operators can set `MCP_DISCORD_FORWARDING_REQUESTER_NAME` to add `**Forwarding <name>’s request**` above new-thread requests; the server adds it, not the calling client. Existing-thread replies and agent input stay unchanged. Caller instructions ask clients to preserve your wording and return only the Discord link on success. Discord always uses the Gateway SDK for agent turns, Gateway HTTP for reads and creation, and Discord REST for membership and exact request publication. The bridge does not require or launch the OpenClaw CLI. Direct Ask OpenClaw remains available.

Discord is **off by default**, so its tools are hidden unless `MCP_DISCORD_ENABLED=true`. Configure explicit guild/account/agent discovery scopes: an empty channel whitelist includes all supported channels in those scopes, while the blacklist always wins. Legacy target allowlists still work. Credentials and verified normal channel routing are required. Set the required `MCP_DISCORD_GATEWAY_INSTANCE` and provision the [SDK service identity](docs/discord-sdk.md#service-authentication). See the [Discord setup guide](docs/discord-skills.md). Upgrading from a CLI-based release requires [removing obsolete settings](docs/discord-sdk.md#upgrade-from-cli-based-releases); there are no compatibility aliases. The packaged coordinator skill is available through the modern MCP Skills extension or legacy resources.

`openclaw_discord_reply` adds existing-public-thread handoff to the shared tool set (14 tools with Discord enabled, 8 without). It reuses configured normal routing and Gateway-backed dispatch for active or archived unlocked public threads. See [existing-thread requirements](docs/discord-reply.md).

All six Discord tools advertise MCP `outputSchema` and validate `structuredContent`, while retaining JSON text responses. Thread names and archive timestamps/cursors are optional strings; `archived` is an optional boolean. Malformed values return a tool error rather than a success payload. These schemas do not change OpenClaw CodeMode type generation; clients decide how to consume them.

## Install this fork

Use the archive from [GitHub Releases](https://github.com/coccoinomane/openclaw-mcp/releases). It includes compiled JavaScript and a dependency lockfile; dependencies are installed separately. Node.js 22.19 or newer is required; Node.js 24 is recommended.

```sh
mkdir openclaw-mcp && cd openclaw-mcp
tar -xzf /path/to/openclaw-mcp-1.10.0.tar.gz
npm ci --omit=dev --ignore-scripts
# Set Gateway credentials and HTTP authentication environment variables first.
node dist/index.js --transport http
```

Point your MCP client at `https://your-host/mcp`. For local stdio, use `node dist/index.js --transport stdio` with the required environment. Follow [configuration](docs/configuration.md) and [deployment](docs/deployment.md) for authentication and hosting. This fork is released on GitHub only; the upstream npm package and container images do not contain these fork-specific changes.

## Operation and limits

Direct chat returns a conversation ID; reuse it with the same instance for follow-ups. Discord asks return a queued link after the request is published, without waiting for the answer. Keep the operation ID to inspect status after a disconnect; never blindly retry an uncertain write. The MCP can create new threads or continue existing public threads.

Use this bridge with trusted clients. Its shared operator credentials and allowlist are not a multi-tenant isolation system. Keep HTTP authentication enabled. OAuth state is in memory; restarts can require client reconnection. Accepted Discord work survives client disconnects, but interrupted work after a service restart is not automatically replayed.

For details, see [conversation continuity](docs/conversation-continuity.md), [Discord configuration and recovery](docs/discord-skills.md), and [development](docs/development.md).

## Credits

Fork of [freema/openclaw-mcp](https://github.com/freema/openclaw-mcp), created by [Tomáš Grasl](https://www.tomasgrasl.cz/). MIT license; original attribution retained.

## Agent selection

Have more than one OpenClaw agent? Follow [Use more than one OpenClaw agent](docs/multiagent.md) to list them in your MCP client and choose who handles a request. Start with one OpenClaw installation; add Discord assignments only if you need them. Every authenticated client can select every configured agent.
