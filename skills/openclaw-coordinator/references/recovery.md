# Recovering Discord operations

The service records an operation before the first write and records the thread identity before starting the agent. Records survive process restarts when the operator preserves the state directory. They contain a request digest, not the prompt.

- completed: for ask, the CLI reported a successful agent run; for channel creation, the channel was read back and persistently admitted. Keep the Discord link for follow-up.
- creation_partial: a thread exists but creation reported a partial result. No agent turn was started. Inspect the existing thread.
- created_unadmitted: a new channel exists but readback or admission was not confirmed. Its ID is retained. It is not available as a target; do not create a replacement.
- creation_rejected: channel creation was blocked before dispatch or returned a known policy/auth rejection. The sanitized error_code names the reason. Reusing the operation ID does not attempt the action again.
- run_failed: no successful agent result was confirmed. A created thread is retained when known.
- creation_unknown or run_unknown: a timeout, malformed response or command failure left the outcome uncertain. Inspect Discord and gateway logs; the service cannot prove that nothing happened.
- creating, created or running after a restart: the process may have stopped between an external action and recording its result. Treat it as uncertain.

Use the same operation ID to retrieve the record. Do not delete records or use a fresh ID to force a retry. After an operator establishes what happened and the user authorizes another turn, continue the verified existing thread with a new operation ID. Never create a replacement thread merely because the original response was lost.

Keep one private durable state directory per service deployment, shared by its workers. The file claim prevents concurrent duplicate operations on a local filesystem. Network filesystems and cross-host state replication are not supported. Record retention is an operator task; removing a record removes duplicate protection.
