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

/** Generate a conversation key using the selected agent and display labels. */
export function createConversationKey(context: ConversationContext = {}, agentId?: string): string {
  const server = sessionLabel(context.serverLabel ?? conversationServerLabel(), 'local');
  const client = sessionLabel(context.clientName, 'unknown');
  const key = `mcp:${server}:${client}:${randomUUID()}`;
  return agentId ? `agent:${agentId}:${key}` : key;
}

/** Explicit/default agent selection also constrains supplied session keys. */
export async function resolveConversation(
  gateway: OpenClawGateway,
  selector: unknown,
  sessionId?: string
) {
  if (selector !== undefined) {
    const checked = validateId(selector, 'agent_id');
    if (!checked.valid) throw new Error(checked.error);
  }
  const resolved = await gateway.resolve(selector as string | undefined);
  const sessionAgent = sessionId?.match(/^agent:([^:]+):/i)?.[1];
  if (sessionAgent && sessionAgent.toLowerCase() !== resolved.agentId)
    throw new Error('agent_id conflicts with the agent in session_key');
  return { ...resolved, routingAgentId: resolved.agentId };
}
