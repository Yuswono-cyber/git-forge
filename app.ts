// The forge's HTTP server: a health probe for the env, the REST v3 surface under
// /api/v3 (rest.ts), and a JSON 404 for everything else. The git smart-HTTP,
// GraphQL and MCP surfaces plug into this same dispatcher.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sendJson } from './http.ts';
import { handleApi } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const url = new URL(req.url ?? '/', 'http://entry');
      handleApi(req, res, url).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      });
      return;
    }

    if (path === '/mcp') {
      handleMcp(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      });
      return;
    }

    if (path === '/api/graphql') {
      handleGraphql(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      });
      return;
    }

    if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
      const url = new URL(req.url ?? '/', 'http://entry');
      handleGit(req, res, url).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}
