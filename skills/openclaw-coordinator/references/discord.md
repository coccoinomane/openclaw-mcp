# Discord destinations

Use the Discord tools when the user wants an OpenClaw conversation to continue in a Discord thread. Choose an allowed channel for new work, or resume the specified existing thread. New threads include their associated OpenClaw session; do not create another session separately.

Forward a self-contained request faithfully. For a contextual handoff, include the decisions, materials and constraints needed to carry out the assignment. Include known source OpenClaw session keys and conversation links when available. Do not invent source identifiers or require the calling client to have a Discord origin.

A native fork can copy a known OpenClaw session into a new same-agent thread on the connected Gateway. For example, a session_id returned by an earlier MCP chat can supply the source key. The client's own Claude or ChatGPT conversation is not an OpenClaw source session. If that is the context to transfer, summarize it in a handoff instead.

Forks inherit history through the last completed turn. Keep the new assignment separate and include relevant unfinished-turn details. If a requested fork is unsupported or its destination uses another agent, explain before substituting a handoff. Never simulate a fork by copying transcript messages into a session.

The submitted prompt is visible in Discord. After confirmed handoff, return each destination link to the user; use native thread mentions when replying on Discord. Do not wait for the generated answer. Discord handoffs can run for a long time, but use operation status for recovery rather than the direct asynchronous task API.
