// The MCP surface: POST /mcp, stateless streamable-HTTP JSON-RPC. Both protocol
// eras are served: modern `server/discover` (2026-07-28) and the legacy
// `initialize` handshake (2025-11-25 and earlier). The six tools operate on the
// same store as REST/git/GraphQL and answer with the REST JSON shapes, so an
// object created over MCP is the same object over REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, readBody } from './http.ts';
import { forge, nextTime, viewer, buildTree, type Issue, type Pull, type Repo } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = { tools: { listChanged: false } };

type Json = Record<string, unknown>;

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
  run: (args: Record<string, unknown>) => unknown;
}

function requireRepo(args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

function requireArgs(args: Record<string, unknown>, required: readonly string[]): void {
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
      throw new Error(`missing required argument: ${key}`);
    }
  }
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    run: (args) => {
      requireArgs(args, ['name']);
      const created = forge.createRepo(
        String(args.name),
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (created === 'exists') throw new Error(`repository ${String(args.name)} already exists`);
      return repoJson(created);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    run: (args) => {
      requireArgs(args, ['owner', 'repo']);
      return repoJson(requireRepo(args));
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    run: (args) => {
      requireArgs(args, ['owner', 'repo', 'title']);
      const repo = requireRepo(args);
      const when = nextTime();
      const issue: Issue = {
        id: repo.nextIssueId,
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdAt: when.iso,
        updatedAt: when.iso,
        comments: [],
      };
      repo.nextIssueId += 1;
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return issueJson(issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    run: (args) => {
      requireArgs(args, ['owner', 'repo']);
      const repo = requireRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.number - a.number);
      return list.map(issueJson);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    run: (args) => {
      requireArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      const repo = requireRepo(args);
      const head = String(args.head).replace(/^[^:]+:/, '');
      const base = String(args.base).replace(/^[^:]+:/, '');
      if (repo.branchTip(head) === undefined || repo.branchTip(base) === undefined) {
        throw new Error('head or base branch does not exist');
      }
      const duplicate = [...repo.pulls.values()].some(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) throw new Error('a pull request already exists for this head and base');
      const when = nextTime();
      const pull: Pull = {
        id: repo.nextNumber,
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: when.iso,
        updatedAt: when.iso,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    run: (args) => {
      requireArgs(args, ['owner', 'repo', 'pull_number']);
      const repo = requireRepo(args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) throw new Error(`pull request ${String(args.pull_number)} not found`);
      if (pull.state !== 'open') throw new Error('pull request is not open');
      const headTip = repo.branchTip(pull.headRef);
      const baseTip = repo.branchTip(pull.baseRef);
      if (headTip === undefined || baseTip === undefined) throw new Error('pull request cannot be merged');
      const base = repo.mergeBase(baseTip, headTip);
      if (base === undefined || base === headTip) throw new Error('pull request is already up to date');
      const atBase = repo.filesOfCommit(base);
      const atHead = repo.filesOfCommit(headTip);
      const atTip = repo.filesOfCommit(baseTip);
      const mergedFiles = new Map(atTip);
      const paths = new Set([...atBase.keys(), ...atHead.keys()]);
      for (const path of paths) {
        const baseEntry = atBase.get(path);
        const headEntry = atHead.get(path);
        if (baseEntry?.sha === headEntry?.sha) continue;
        const tipEntry = atTip.get(path);
        if (tipEntry?.sha !== baseEntry?.sha && tipEntry?.sha !== headEntry?.sha) {
          throw new Error('pull request is not mergeable: conflicts');
        }
        if (headEntry === undefined) mergedFiles.delete(path);
        else mergedFiles.set(path, headEntry);
      }
      const tree = buildTree(repo.store, mergedFiles);
      const when = nextTime();
      const ident = `${viewer.name} <${viewer.email}> ${when.epoch} +0000`;
      const payload = `tree ${tree}\nparent ${baseTip}\nparent ${headTip}\nauthor ${ident}\ncommitter ${ident}\n\n${pull.title}`;
      const mergeSha = repo.store.put('commit', Buffer.from(payload, 'utf8'));
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = when.iso;
      pull.mergeCommitSha = mergeSha;
      pull.updatedAt = when.iso;
      return pullJson(repo, pull);
    },
  },
];

function toolsList(): Json[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

function toolResult(value: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Json,
    isError: false,
  };
}

function toolError(message: string): Json {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// -----------------------------------------------------------------------------------
// JSON-RPC

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function dispatch(message: Json): RpcResponse | null {
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Json;
  const isNotification = message.id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(id, toolResult(tool.run(args)));
      } catch (err) {
        return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': crypto.randomUUID() });
    res.end();
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  if (!isAuthed(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Unauthorized' }));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? dispatch(entry as Json) : null))
      .filter((entry) => entry !== null);
    send(200, responses);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    send(400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const message = parsed as Json;
  if (message.id === undefined) {
    // A notification: accepted, no response body.
    dispatch(message);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('');
    return;
  }
  const response = dispatch(message);
  send(200, response ?? rpcError(message.id ?? null, -32601, 'method not found'));
}
