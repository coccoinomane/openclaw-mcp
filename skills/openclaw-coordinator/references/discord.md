# Discord destinations

Select agent_id from openclaw_agents, then discover its current Discord channels. Reuse concrete channel_id, server_id and discord_account_id; replies also need thread_id. No destination aliases are accepted.

Use the Discord tools when the user wants an OpenClaw conversation to continue in a Discord thread. Choose an allowed channel for new work, or resume the specified existing thread. New threads include their associated OpenClaw session; do not create another session separately.

Thread lists are scoped to channel_id and default to limit 30. For all active threads, use limit 0; has_more signals truncation. Archived public threads require limit 1..100 and alone support before_archive_timestamp.

Forward a self-contained request faithfully. For a contextual handoff, include the decisions, materials and constraints needed to carry out the assignment. Include known source OpenClaw session keys and conversation links when available. Do not invent source identifiers or require the calling client to have a Discord origin.

A native fork can copy a known OpenClaw session into a new same-agent thread on the connected Gateway. For example, a session_key returned by an earlier MCP chat can supply the source key if it is canonical and agent-qualified (agent:<agent>:...). If a returned key is unqualified, do not invent an agent prefix; use a contextual handoff unless a trusted source provides the canonical key. The client's own Claude or ChatGPT conversation is not an OpenClaw source session. If that is the context to transfer, summarize it in a handoff instead.

Forks inherit history through the last completed turn. Keep the new assignment separate and include relevant unfinished-turn details. If the user requests a cross-agent fork, explain the same-agent limit before substituting a handoff.

The submitted prompt is visible in Discord. After confirmed handoff, return each destination link to the user; use native thread mentions when replying on Discord. Do not wait for the generated answer. Discord handoffs can run for a long time, but use operation status for recovery rather than the direct asynchronous task API.
