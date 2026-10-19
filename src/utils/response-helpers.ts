export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function successResponse(text: string): ToolResponse {
  return {
    content: [{ type: 'text', text }],
  };
}

export function errorResponse(message: string): ToolResponse {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function jsonResponse(data: unknown): ToolResponse {
  return successResponse(JSON.stringify(data, null, 2));
}

/** Keep the existing JSON text contract and expose the same object to SDK clients. */
export function structuredJsonResponse(data: Record<string, unknown>): ToolResponse {
  return { ...jsonResponse(data), structuredContent: data };
}

/** Preserve the first text block, including existing error text and isError. */
export function withConversation(
  response: ToolResponse,
  sessionId: string,
  instance: string
): ToolResponse {
  const metadata = { session_id: sessionId, instance };
  return {
    ...response,
    content: [...response.content, { type: 'text', text: `\n\n${JSON.stringify(metadata)}` }],
    structuredContent: metadata,
  };
}
