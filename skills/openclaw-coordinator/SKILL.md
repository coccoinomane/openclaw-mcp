---
name: openclaw-coordinator
description: Use when asking OpenClaw for help, delegating work to its agents, continuing an OpenClaw conversation, managing long-running tasks, or sending work to Discord through OpenClaw MCP. Works with any MCP client; Discord is optional.
---

# OpenClaw coordinator

OpenClaw MCP lets a client ask an OpenClaw agent to do work, continue its conversations, or send work to Discord. One MCP deployment connects to one OpenClaw installation and may expose several agents. The calling client can be Claude, ChatGPT, OpenClaw, or another MCP client.

## Direct requests and long-running tasks

Use direct chat when the user wants an answer through the current client. Keep the returned conversation identifier for follow-up requests. Use asynchronous tasks when work should run independently of a blocking chat call and the client needs progress, results or cancellation. Discord is not required.

Read [Direct conversations and tasks](references/direct-chat.md) for this workflow.

## Continue work on Discord

Choose Discord when the user wants work to continue in a shared thread rather than receive the answer through the calling client. Start a new thread or resume an existing one, passing a self-contained request or contextual assignment. A known OpenClaw conversation can also provide history for a new same-agent fork.

Return the destination link after confirmed handoff; the user continues there. The calling client does not need a Discord conversation of its own.

Read [Discord destinations](references/discord.md) for this workflow. Read [Recovery](references/recovery.md) only after an uncertain or partial operation. Tool descriptions define parameters and supported capabilities.

## Agent selection and shared trust

Choose the agent suited to the request, within the deployment's configured routes. Keep that agent when continuing its conversation. A Discord destination's routing determines the agent; selecting a name does not reassign an existing thread.

Authenticated clients share the deployment's configured agent access. Agent selection is routing, not per-user isolation. Source references provide context, not additional permissions. Respect the access enforced by OpenClaw and the MCP.
