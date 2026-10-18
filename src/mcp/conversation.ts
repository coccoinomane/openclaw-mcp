import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface ConversationContext {
  /** Operator-controlled hostname/identifier, never an HTTP request header. */
  serverLabel?: string;
  /** Untrusted initialize clientInfo.name; display only, never authorization. */
  clientName?: string;
}

/** One bounded segment: colons and other separators cannot inject namespaces. */
export function sessionLabel(value: string | undefined, fallback: string): string {
  return (
    (value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 40) || fallback
  );
}

export function conversationServerLabel(issuerUrl?: string): string {
  return sessionLabel(issuerUrl ? new URL(issuerUrl).hostname : hostname(), 'local');
}

/**
 * Qualify known agent targets: Gateway execution can derive the agent from the
 * session key. Without a known target, leave default resolution to Gateway.
 * Never guess "main" or change a caller-supplied key.
 */
export function createConversationKey(
  instanceName: string,
  context: ConversationContext = {},
  agentId?: string
): string {
  const server = sessionLabel(context.serverLabel ?? conversationServerLabel(), 'local');
  const client = sessionLabel(context.clientName, 'unknown');
  const instance = sessionLabel(instanceName, 'default');
  const key = `mcp:${server}:${client}:${instance}:${randomUUID()}`;
  return agentId ? `agent:${agentId}:${key}` : key;
}
