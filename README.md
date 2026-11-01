<!-- mcp-name: io.github.coccoinomane/openclaw-mcp -->

# OpenClaw MCP Server

[![CI](https://github.com/coccoinomane/openclaw-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/coccoinomane/openclaw-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Connect Claude or another MCP client to your [OpenClaw](https://github.com/openclaw/openclaw) assistant. Ask directly, keep a conversation going, or hand work off to Discord. Supports Streamable HTTP, legacy SSE and stdio, with OAuth 2.1 for authenticated HTTP access.

## A chief of staff for your Discord server

The optional Discord integration lets your MCP client act as a chief of staff: choose the appropriate authorized channel, open a thread with your request, add you as a member and hand you the link. OpenClaw works in the background; you continue the conversation in Discord, with the request and its answer together rather than scattered across apps.

The first message contains your request without an added prefix. Caller instructions ask clients to preserve your wording and return only the Discord link on success. Thread creation can reuse the running Gateway instead of loading the Discord plugin in a new CLI process. Direct Ask OpenClaw remains available.

Discord is **off by default**, so its tools are hidden unless `MCP_DISCORD_ENABLED=true`. Configure explicit guild/account/agent discovery scopes: an empty channel whitelist includes all supported channels in those scopes, while the blacklist always wins. Legacy target allowlists still work. Credentials and verified normal channel routing are required. See the [Discord setup guide](docs/discord-skills.md). The packaged coordinator skill is available through the modern MCP Skills extension or legacy resources.

## Install this fork

Use the archive from [GitHub Releases](https://github.com/coccoinomane/openclaw-mcp/releases). It includes compiled JavaScript and a dependency lockfile; dependencies are installed separately. Node.js 20 or newer is required; Node.js 24 is recommended.

```sh
mkdir openclaw-mcp && cd openclaw-mcp
tar -xzf /path/to/openclaw-mcp-1.9.0.tar.gz
npm ci --omit=dev --ignore-scripts
# Set Gateway credentials and HTTP authentication environment variables first.
node dist/index.js --transport http
```

Point your MCP client at `https://your-host/mcp`. For local stdio, use `node dist/index.js --transport stdio` with the required environment. Follow [configuration](docs/configuration.md) and [deployment](docs/deployment.md) for authentication and hosting. This fork is released on GitHub only; the upstream npm package and container images do not contain these fork-specific changes.

## Operation and limits

Direct chat returns a conversation ID; reuse it with the same instance for follow-ups. Discord asks return a queued link after the request is published, without waiting for the answer. Keep the operation ID to inspect status after a disconnect; never blindly retry an uncertain write. The MCP creates new threads only; continue existing threads on Discord.

Use this bridge with trusted clients. Its shared operator credentials and allowlist are not a multi-tenant isolation system. Keep HTTP authentication enabled. OAuth state is in memory; restarts can require client reconnection. Accepted Discord work survives client disconnects, but interrupted work after a service restart is not automatically replayed.

For details, see [conversation continuity](docs/conversation-continuity.md), [Discord configuration and recovery](docs/discord-skills.md), and [development](docs/development.md).

## Credits

Fork of [freema/openclaw-mcp](https://github.com/freema/openclaw-mcp), created by [Tomáš Grasl](https://www.tomasgrasl.cz/). MIT license; original attribution retained.
