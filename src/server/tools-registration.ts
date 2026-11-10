/**
 * Shared tool registration for MCP Server instances.
 *
 * Each HTTP connection needs its own Server + Transport pair,
 * but they all register the same set of tools. This module extracts
 * that registration logic into a reusable function.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { errorResponse } from '../utils/response-helpers.js';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readSkillResource, skillResources } from './skills.js';
import type { DiscordService } from '../openclaw/discord.js';
import { discordTools, handleDiscord } from '../mcp/tools/discord.js';
import { randomUUID } from 'node:crypto';
import { validateId, validateInputIsObject } from '../utils/validation.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { OpenClawGateway } from '../openclaw/gateway.js';
import { SERVER_ICON_SVG_BASE64 } from '../config/constants.js';
import { log, logError } from '../utils/logger.js';
import * as tools from '../mcp/tools/index.js';
import { conversationServerLabel } from '../mcp/conversation.js';
import type { ToolResponse } from '../utils/response-helpers.js';

export interface ToolRegistrationDeps {
  gateway: OpenClawGateway;
  discord?: DiscordService;
  skills?: SkillCatalog;
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
  if (deps.skills) {
    server.registerCapabilities({ resources: {} });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: skillResources(deps.skills!),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      readSkillResource(deps.skills!, request.params.uri)
    );
  }
  return server;
}

/**
 * Register all OpenClaw tools on an existing MCP Server instance.
 */
function toolSet(
  deps: ToolRegistrationDeps,
  clientName: () => string | undefined,
  ownerId: string = randomUUID()
) {
  const { gateway } = deps;

  // Identity of this MCP connection, used to scope async tasks.
  //
  // In stdio mode there is exactly one Server for the process lifetime, so
  // behaviour is unchanged. In HTTP mode createMcpServer() is called once per
  // connection, so each client gets its own namespace and cannot reach another
  // client's tasks.

  const serverLabel = conversationServerLabel(deps.issuerUrl);
  // Read after initialize, from this Server only. Never use it as ownerId.
  const conversationContext = () => ({
    serverLabel,
    clientName: clientName(),
  });

  const toolHandlers = new Map<string, (input: unknown) => Promise<ToolResponse>>([
    ['openclaw_chat', (input) => tools.handleOpenclawChat(gateway, input, conversationContext())],
    ['openclaw_status', (input) => tools.handleOpenclawStatus(gateway, input)],
    [
      'openclaw_chat_async',
      (input) => tools.handleOpenclawChatAsync(gateway, input, ownerId, conversationContext()),
    ],
    ['openclaw_task_status', (input) => tools.handleOpenclawTaskStatus(gateway, input, ownerId)],
    ['openclaw_task_list', (input) => tools.handleOpenclawTaskList(gateway, input, ownerId)],
    ['openclaw_task_cancel', (input) => tools.handleOpenclawTaskCancel(gateway, input, ownerId)],
    ['openclaw_agents', (input) => tools.handleOpenclawAgents(gateway, input)],
  ]);

  const allTools: import('@modelcontextprotocol/sdk/types.js').Tool[] = [
    tools.openclawChatTool,
    tools.openclawStatusTool,
    tools.openclawChatAsyncTool,
    tools.openclawTaskStatusTool,
    tools.openclawTaskListTool,
    tools.openclawTaskCancelTool,
    tools.openclawAgentsTool,
  ];

  if (deps.discord) {
    allTools.push(...discordTools);
    for (const tool of discordTools)
      toolHandlers.set(tool.name, async (input) => {
        if (validateInputIsObject(input) && input.agent_id !== undefined) {
          const checked = validateId(input.agent_id, 'agent_id');
          if (!checked.valid) return errorResponse(checked.error);
          try {
            gateway.resolve(checked.value);
          } catch (error) {
            return errorResponse(
              error instanceof Error ? error.message : 'Invalid Discord route selector'
            );
          }
        }
        return handleDiscord(deps.discord!, tool.name, input ?? {});
      });
  }
  // Low-level request handlers bypass the SDK's registered-tool output checks.
  // Use the same validators for legacy and modern transports, without rewriting payloads.
  const validator = new AjvJsonSchemaValidator();
  for (const tool of allTools) {
    if (!tool.outputSchema) continue;
    const validate = validator.getValidator(tool.outputSchema);
    const handler = toolHandlers.get(tool.name)!;
    toolHandlers.set(tool.name, async (input) => {
      const response = await handler(input);
      if (
        response.structuredContent === undefined
          ? !response.isError
          : !validate(response.structuredContent).valid
      ) {
        logError('Invalid structured output for tool ' + tool.name);
        return errorResponse(
          'Tool output could not be verified. Side effects may already have occurred; do not blindly retry writes.'
        );
      }
      return response;
    });
  }
  return { allTools, toolHandlers };
}

function registerTools(server: Server, deps: ToolRegistrationDeps) {
  const { allTools, toolHandlers } = toolSet(deps, () => server.getClientVersion()?.name);
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

export function createModernMcpServer(deps: ToolRegistrationDeps, ownerId?: string): McpServer {
  const mcp = new McpServer({ name: deps.serverName, version: deps.serverVersion });
  let requestClientName: string | undefined;
  const { allTools, toolHandlers } = toolSet(
    deps,
    () => requestClientName ?? mcp.server.getClientVersion()?.name,
    ownerId
  );
  mcp.server.registerCapabilities({ tools: {} });
  mcp.server.setRequestHandler('tools/list', async () => ({
    tools: JSON.parse(JSON.stringify(allTools)),
  }));
  mcp.server.setRequestHandler('tools/call', async ({ params }, ctx) => {
    requestClientName = ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientInfo']?.name;
    if (
      !ownerId &&
      [
        'openclaw_chat_async',
        'openclaw_task_status',
        'openclaw_task_list',
        'openclaw_task_cancel',
      ].includes(params.name)
    ) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Modern HTTP async tasks require authentication. Use authenticated HTTP or a stateful legacy connection.',
          },
        ],
        isError: true,
      };
    }
    const handler = toolHandlers.get(params.name);
    if (!handler) throw new Error('Unknown tool');
    return { ...(await handler(params.arguments ?? {})) };
  });
  deps.skills?.attach(mcp);
  return mcp;
}
