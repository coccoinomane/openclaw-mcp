/**
 * Shared tool registration for MCP Server instances.
 *
 * Each HTTP connection needs its own Server + Transport pair,
 * but they all register the same set of tools. This module extracts
 * that registration logic into a reusable function.
 */

import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { InstanceRegistry } from '../openclaw/registry.js';
import { SERVER_ICON_SVG_BASE64 } from '../config/constants.js';
import { log, logError } from '../utils/logger.js';
import * as tools from '../mcp/tools/index.js';
import { conversationServerLabel } from '../mcp/conversation.js';
import type { ToolResponse } from '../utils/response-helpers.js';

export interface ToolRegistrationDeps {
  registry: InstanceRegistry;
  serverName: string;
  serverVersion: string;
  /** Trusted operator configuration; used only for conversation labels. */
  issuerUrl?: string;
}

/**
 * Create a new MCP Server instance with all tools registered.
 */
export function createMcpServer(deps: ToolRegistrationDeps): Server {
  const server = new Server(
    {
      name: deps.serverName,
      version: deps.serverVersion,
      icons: [
        {
          src: `data:image/svg+xml;base64,${SERVER_ICON_SVG_BASE64}`,
          mimeType: 'image/svg+xml',
          sizes: ['128x128'],
        },
      ],
    },
    { capabilities: { tools: {} } }
  );

  registerTools(server, deps);
  return server;
}

/**
 * Register all OpenClaw tools on an existing MCP Server instance.
 */
function registerTools(server: Server, deps: ToolRegistrationDeps): void {
  const { registry } = deps;

  // Identity of this MCP connection, used to scope async tasks.
  //
  // In stdio mode there is exactly one Server for the process lifetime, so
  // behaviour is unchanged. In HTTP mode createMcpServer() is called once per
  // connection, so each client gets its own namespace and cannot reach another
  // client's tasks.
  const ownerId = randomUUID();
  const serverLabel = conversationServerLabel(deps.issuerUrl);
  // Read after initialize, from this Server only. Never use it as ownerId.
  const conversationContext = () => ({
    serverLabel,
    clientName: server.getClientVersion()?.name,
  });

  const toolHandlers = new Map<string, (input: unknown) => Promise<ToolResponse>>([
    ['openclaw_chat', (input) => tools.handleOpenclawChat(registry, input, conversationContext())],
    ['openclaw_status', (input) => tools.handleOpenclawStatus(registry, input)],
    [
      'openclaw_chat_async',
      (input) => tools.handleOpenclawChatAsync(registry, input, ownerId, conversationContext()),
    ],
    ['openclaw_task_status', (input) => tools.handleOpenclawTaskStatus(registry, input, ownerId)],
    ['openclaw_task_list', (input) => tools.handleOpenclawTaskList(registry, input, ownerId)],
    ['openclaw_task_cancel', (input) => tools.handleOpenclawTaskCancel(registry, input, ownerId)],
    ['openclaw_instances', (input) => tools.handleOpenclawInstances(registry, input)],
  ]);

  const allTools = [
    tools.openclawChatTool,
    tools.openclawStatusTool,
    tools.openclawChatAsyncTool,
    tools.openclawTaskStatusTool,
    tools.openclawTaskListTool,
    tools.openclawTaskCancelTool,
    tools.openclawInstancesTool,
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    log(`Executing tool: ${name}`);

    const handler = toolHandlers.get(name);
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      // An object result also satisfies the SDK's extensible Result schema.
      return { ...(await handler(toolArgs)) };
    } catch (error) {
      logError(`Error executing tool ${name}`, error);
      throw error;
    }
  });
}
