import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { discordTools } from '../mcp/tools/discord.js';
import * as tools from '../mcp/tools/index.js';
import { log } from '../utils/logger.js';

const toolNames = new Set([
  tools.openclawChatTool.name,
  tools.openclawStatusTool.name,
  tools.openclawChatAsyncTool.name,
  tools.openclawTaskStatusTool.name,
  tools.openclawTaskListTool.name,
  tools.openclawTaskCancelTool.name,
  tools.openclawAgentsTool.name,
  ...discordTools.map((tool) => tool.name),
]);
const methods = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'completion/complete',
  'server/discover',
]);

// Allowlist client labels instead of trying to redact arbitrary strings.
export function httpDiagnostics(sessionKnown: (id: string) => boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path !== '/mcp') return next();
    const requestId = randomUUID();
    const session = req.headers['mcp-session-id'];
    const version =
      req.headers['mcp-protocol-version'] ??
      (req.body?.method === 'initialize'
        ? req.body?.params?.protocolVersion
        : req.body?.params?._meta?.['io.modelcontextprotocol/protocolVersion']);
    const diagnostic = {
      timestamp: new Date().toISOString(),
      requestId,
      method: ['POST', 'GET', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)
        ? req.method
        : 'other',
      path: '/mcp',
      mcpMethod: methods.has(req.body?.method)
        ? req.body.method
        : req.body?.method
          ? 'other'
          : 'none',
      tool:
        req.body?.method === 'tools/call' && toolNames.has(req.body?.params?.name)
          ? req.body.params.name
          : undefined,
      protocolVersion:
        version === undefined
          ? 'absent'
          : typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version)
            ? version
            : 'other',
      branch: 'unrouted',
      sessionPresent: session !== undefined,
      sessionKnown: typeof session === 'string' && sessionKnown(session),
      category: undefined as string | undefined,
    };
    res.locals.mcpDiagnostic = diagnostic;
    res.setHeader('X-Request-Id', requestId);
    let reported = false;
    const report = (aborted: boolean) => {
      if (reported) return;
      reported = true;
      const status = res.statusCode;
      const category =
        diagnostic.category ??
        (aborted
          ? 'aborted'
          : status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : status >= 500
                ? 'server_error'
                : status >= 400
                  ? 'request_rejected'
                  : 'ok');
      log('HTTP ' + JSON.stringify({ ...diagnostic, status, category }));
    };
    res.once('finish', () => report(false));
    res.once('close', () => report(!res.writableFinished));
    next();
  };
}
