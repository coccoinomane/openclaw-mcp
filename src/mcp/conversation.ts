import type { OpenClawGateway } from '../openclaw/gateway.js';
import { validateId } from '../utils/validation.js';
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
export function createConversationKey(context: ConversationContext = {}, agentId?: string): string {
  const server = sessionLabel(context.serverLabel ?? conversationServerLabel(), 'local');
  const client = sessionLabel(context.clientName, 'unknown');
  const key = `mcp:${server}:${client}:${randomUUID()}`;
  return agentId ? `agent:${agentId}:${key}` : key;
}

/** Resolve routing once while preserving legacy caller-supplied session semantics. */
export function resolveConversation(
  gateway: OpenClawGateway,
  selector: unknown,
  sessionId?: string
) {
  let selected: string | undefined;
  if (selector !== undefined) {
    const checked = validateId(selector, 'agent_id');
    if (!checked.valid) throw new Error(checked.error);
    selected = checked.value.toLowerCase();
  }
  const sessionAgent = sessionId?.match(/^agent:([^:]+):/i)?.[1];
  if (selected && sessionAgent && selected !== sessionAgent.toLowerCase()) {
    throw new Error('agent_id conflicts with the agent in session_id');
  }
  const resolved = gateway.resolve(selected);
  const normalizedSessionAgent = sessionAgent?.toLowerCase();
  // Returned agent_id must be reusable as an explicit selector. Legacy keys
  // can name agents outside the local catalog without making them selectable.
  const agentId = normalizedSessionAgent
    ? gateway.listAgents().some((agent) => agent.agentId === normalizedSessionAgent)
      ? normalizedSessionAgent
      : undefined
    : resolved.agentId;
  return {
    ...resolved,
    routingAgentId: selected ? resolved.agentId : undefined,
    agentId,
  };
}
