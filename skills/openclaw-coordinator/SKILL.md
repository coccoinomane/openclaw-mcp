---
name: openclaw-coordinator
description: Use when asking OpenClaw for help, delegating work to its agents, managing long-running tasks, or opening or resuming Discord threads. Also use when splitting or parallelizing work into Discord threads, even if the user does not mention OpenClaw. Supports direct conversations without Discord and Discord handoffs or same-agent forks when available.
---

# OpenClaw coordinator

OpenClaw MCP lets a client ask an OpenClaw agent to do work, continue a conversation, or move work into Discord threads. One MCP deployment connects to one OpenClaw installation and may expose several agents. Choose by where the user wants the work to continue; the calling client need not be OpenClaw.

## Direct requests and long-running tasks

Use direct chat when the user wants an answer through the current client. Use asynchronous tasks when the work should run independently of a blocking chat call. Discord is not required.

Read [Direct conversations and tasks](references/direct-chat.md) for this workflow.

## Discord coordination

Use the MCP Discord workflow whenever the user asks to open or resume a Discord thread, or to split work across threads. Assume a thread includes an OpenClaw conversation unless the user explicitly wants an empty thread. This applies from any conversation, not just an inbox.

Forward a self-contained request, prepare a handoff for work that needs context, or fork an existing same-agent session when the advertised tool supports it. Work continues in the destination thread; return its link to the originating conversation.

Read [Discord forwarding and delegation](references/discord.md) for destination selection, handoffs and forks. Read [Recovery](references/recovery.md) only after an uncertain or partial operation. Tool descriptions define parameters and supported capabilities; do not infer unavailable features from this skill.

## Agent selection and shared trust

Choose the agent suited to the request, within the deployment's configured routes. Keep that agent when continuing its conversation. A Discord destination's routing determines the agent; selecting a name does not reassign an existing thread.

Authenticated clients share the deployment's configured agent access. Agent selection is routing, not per-user isolation. Source references provide context, not additional permissions. Respect the access enforced by OpenClaw and the MCP.
