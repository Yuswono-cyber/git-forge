// The GraphQL v4 surface: POST /api/graphql. A small parser for the document
// shapes gh and github-mcp-server send (operations, variables, aliases, inline
// fragments, input objects, enum lists, batching) and an executor over the same
// store the REST and git surfaces use, so every surface reads the same forge.
// Global ids are opaque base64 Relay-style ids, stable across reads.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, readBody, sendJson } from './http.ts';
import { forge, nextTime, viewer, type Issue, type Pull, type Repo } from './store.ts';

// -----------------------------------------------------------------------------------
// Global ids

function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (kind === undefined || kind === '') return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => globalId('Repository', repo.id);
const issueGlobalId = (repo: Repo, issue: Issue): string => globalId('Issue', repo.id, issue.number);
const pullGlobalId = (repo: Repo, pull: Pull): string => globalId('PullRequest', repo.id, pull.number);
const commentGlobalId = (repo: Repo, issue: Issue, commentId: number): string =>
  globalId('IssueComment', repo.id, issue.number, commentId);

function repoByGlobalId(id: string): Repo | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return undefined;
  const numeric = Number(parsed.parts[0]);
  for (const repo of forge.listRepos()) if (repo.id === numeric) return repo;
  return undefined;
}

// -----------------------------------------------------------------------------------
// Lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'punct', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:$=!'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        tokens.push({ kind: 'string', value: source.slice(at + 3, end === -1 ? source.length : end) });
        at = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16));
            at += 4;
          } else if (esc !== undefined) value += esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = at;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(at, end) });
      at = end;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = at;
      while (end < source.length && /[0-9.eE+-]/.test(source[end] as string)) end += 1;
      const text = source.slice(at, end);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E')
        ? { kind: 'float', value: Number(text) }
        : { kind: 'int', value: Number(text) });
      at = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// -----------------------------------------------------------------------------------
// Parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

type Selection =
  | { kind: 'field'; alias?: string; name: string; args: { name: string; value: Value }[]; selectionSet?: Selection[] }
  | { kind: 'inlineFragment'; typeCondition: string; selectionSet: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: Selection[];
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.at < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    if (this.atPunct('{')) {
      return { type: 'query', selectionSet: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`expected an operation, saw ${keyword}`);
    }
    let name: string | undefined;
    const nextToken = this.peek();
    if (nextToken !== undefined && nextToken.kind === 'name') name = this.expectName();
    if (this.atPunct('(')) this.skipVariableDefinitions();
    return { type: keyword === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.atPunct('...')) {
      this.next();
      const on = this.expectName();
      if (on !== 'on') throw new Error('named fragments are not supported');
      const typeCondition = this.expectName();
      return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'number', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.atPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -----------------------------------------------------------------------------------
// Schema and execution

interface TypedValue {
  __type: string;
  [key: string]: unknown;
}

interface FieldDef {
  type: string;
  list?: boolean;
  resolve: (source: TypedValue, args: Record<string, unknown>) => unknown;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'comments', 'labels', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function userValue(login: string): TypedValue {
  return { __type: 'User', login };
}

function repoValue(repo: Repo): TypedValue {
  return { __type: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): TypedValue {
  return { __type: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): TypedValue {
  return { __type: 'PullRequest', repo, pull };
}

function pullChangedFiles(repo: Repo, pull: Pull): string[] {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const mergeBase = repo.mergeBase(headTip, baseTip) ?? baseTip;
  const baseFiles = repo.filesOfCommit(mergeBase);
  const headFiles = repo.filesOfCommit(headTip);
  const paths = new Set<string>();
  for (const [path, entry] of headFiles) {
    const before = baseFiles.get(path);
    if (before === undefined || before.sha !== entry.sha) paths.add(path);
  }
  for (const path of baseFiles.keys()) if (!headFiles.has(path)) paths.add(path);
  return [...paths].sort();
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'UNKNOWN';
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const mergeBase = repo.mergeBase(headTip, baseTip);
  if (mergeBase === undefined) return 'UNKNOWN';
  const baseFiles = repo.filesOfCommit(mergeBase);
  const headFiles = repo.filesOfCommit(headTip);
  const currentBase = repo.filesOfCommit(baseTip);
  for (const [path, headEntry] of headFiles) {
    const atBase = baseFiles.get(path);
    if (atBase !== undefined && atBase.sha === headEntry.sha) continue;
    const now = currentBase.get(path);
    if (now !== undefined && atBase !== undefined && now.sha !== atBase.sha && now.sha !== headEntry.sha) return 'CONFLICTING';
    if (now !== undefined && atBase === undefined && now.sha !== headEntry.sha) return 'CONFLICTING';
  }
  for (const path of baseFiles.keys()) {
    if (headFiles.has(path)) continue;
    const now = currentBase.get(path);
    const atBase = baseFiles.get(path);
    if (now !== undefined && atBase !== undefined && now.sha !== atBase.sha) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`, 'utf8').toString('base64');

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match !== null ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function connection(items: TypedValue[], args: Record<string, unknown>, nodeType: string): TypedValue {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const start = cursorIndex(args.after);
  const slice = items.slice(start, start + first);
  const hasNext = start + slice.length < items.length;
  return {
    __type: `${nodeType}Connection`,
    nodes: slice,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length) : null,
    } as TypedValue,
    totalCount: items.length,
  };
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User', resolve: () => userValue(viewer.login) },
    repository: {
      type: 'Repository',
      resolve: (_source, args) => {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoValue(repo);
      },
    },
    node: {
      type: 'Node',
      resolve: (_source, args) => {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = repoByGlobalId(String(args.id));
          return repo === undefined ? null : repoValue(repo);
        }
        if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
          const repoId = Number(parsed.parts[0]);
          const number = Number(parsed.parts[1]);
          for (const repo of forge.listRepos()) {
            if (repo.id !== repoId) continue;
            if (parsed.kind === 'Issue') {
              const issue = repo.issues.get(number);
              return issue === undefined ? null : issueValue(repo, issue);
            }
            const pull = repo.pulls.get(number);
            return pull === undefined ? null : pullValue(repo, pull);
          }
        }
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_source, args) => {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] !== undefined) {
          return { __type: '__Type', name, kind: 'OBJECT', fieldNames: TYPE_FIELDS[name], enumNames: [] } as TypedValue;
        }
        if (ENUM_VALUES[name] !== undefined) {
          return { __type: '__Type', name, kind: 'ENUM', fieldNames: [], enumNames: ENUM_VALUES[name] } as TypedValue;
        }
        return null;
      },
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === undefined) throw new Error('repository not found');
        const when = nextTime().iso;
        const issue: Issue = {
          id: repo.nextIssueId++,
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          createdAt: when,
          updatedAt: when,
          comments: [],
        };
        repo.issues.set(issue.number, issue);
        return { __type: 'CreateIssuePayload', issue: issueValue(repo, issue) } as TypedValue;
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue') throw new Error('issue not found');
        const repoId = Number(parsed.parts[0]);
        const number = Number(parsed.parts[1]);
        for (const repo of forge.listRepos()) {
          if (repo.id !== repoId) continue;
          const issue = repo.issues.get(number);
          if (issue === undefined) throw new Error('issue not found');
          issue.state = 'closed';
          issue.updatedAt = nextTime().iso;
          return { __type: 'CloseIssuePayload', issue: issueValue(repo, issue) } as TypedValue;
        }
        throw new Error('issue not found');
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === undefined) throw new Error('repository not found');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        if (repo.branchTip(headRef) === undefined) throw new Error(`head branch ${headRef} does not exist`);
        if (repo.branchTip(baseRef) === undefined) throw new Error(`base branch ${baseRef} does not exist`);
        const when = nextTime().iso;
        const pull: Pull = {
          id: repo.nextIssueId++,
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef,
          baseRef,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdAt: when,
          updatedAt: when,
        };
        repo.pulls.set(pull.number, pull);
        return { __type: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull) } as TypedValue;
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (parsed === null || parsed.kind !== 'PullRequest') throw new Error('pull request not found');
        const repoId = Number(parsed.parts[0]);
        const number = Number(parsed.parts[1]);
        for (const repo of forge.listRepos()) {
          if (repo.id !== repoId) continue;
          const pull = repo.pulls.get(number);
          if (pull === undefined) throw new Error('pull request not found');
          if (pull.state !== 'open') throw new Error('pull request is not open');
          if (pullMergeable(repo, pull) === 'CONFLICTING') throw new Error('pull request has conflicts');
          const headTip = repo.branchTip(pull.headRef) as string;
          const baseTip = repo.branchTip(pull.baseRef) as string;
          const mergeBase = repo.mergeBase(headTip, baseTip) ?? baseTip;
          const mergedFiles = new Map(repo.filesOfCommit(baseTip));
          const baseFiles = repo.filesOfCommit(mergeBase);
          const headFiles = repo.filesOfCommit(headTip);
          for (const [path, entry] of headFiles) {
            const atBase = baseFiles.get(path);
            if (atBase === undefined || atBase.sha !== entry.sha) mergedFiles.set(path, entry);
          }
          for (const path of baseFiles.keys()) {
            if (!headFiles.has(path)) mergedFiles.delete(path);
          }
          const method = String(input.mergeMethod ?? 'MERGE');
          const message = method === 'SQUASH' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number}`;
          const sha = repo.commitFiles(pull.baseRef, mergedFiles, message);
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = nextTime().iso;
          pull.mergeCommitSha = sha;
          pull.updatedAt = pull.mergedAt;
          return { __type: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull) } as TypedValue;
        }
        throw new Error('pull request not found');
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue') throw new Error('subject not found');
        const repoId = Number(parsed.parts[0]);
        const number = Number(parsed.parts[1]);
        for (const repo of forge.listRepos()) {
          if (repo.id !== repoId) continue;
          const issue = repo.issues.get(number);
          if (issue === undefined) throw new Error('issue not found');
          const comment = {
            id: issue.comments.length + 1,
            body: String(input.body ?? ''),
            createdAt: nextTime().iso,
          };
          issue.comments.push(comment);
          const node: TypedValue = {
            __type: 'IssueComment',
            id: commentGlobalId(repo, issue, comment.id),
            body: comment.body,
          };
          return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node } as TypedValue } as TypedValue;
        }
        throw new Error('issue not found');
      },
    },
  },
  User: {
    id: { type: 'ID', resolve: (source) => globalId('User', source.login as string) },
    login: { type: 'String', resolve: (source) => source.login },
    name: { type: 'String', resolve: () => viewer.name },
  },
  Repository: {
    id: { type: 'ID', resolve: (source) => repoGlobalId(source.repo as Repo) },
    databaseId: { type: 'Int', resolve: (source) => (source.repo as Repo).id },
    name: { type: 'String', resolve: (source) => (source.repo as Repo).name },
    nameWithOwner: { type: 'String', resolve: (source) => (source.repo as Repo).fullName },
    owner: { type: 'User', resolve: (source) => userValue((source.repo as Repo).owner) },
    description: { type: 'String', resolve: (source) => (source.repo as Repo).description },
    isPrivate: { type: 'Boolean', resolve: (source) => (source.repo as Repo).isPrivate },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (source) => {
        const repo = source.repo as Repo;
        if (repo.branchTip(repo.defaultBranch) === undefined) return null;
        return { __type: 'Ref', name: repo.defaultBranch } as TypedValue;
      },
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    createdAt: { type: 'String', resolve: (source) => (source.repo as Repo).createdAt },
    updatedAt: { type: 'String', resolve: (source) => (source.repo as Repo).createdAt },
    issue: {
      type: 'Issue',
      resolve: (source, args) => {
        const repo = source.repo as Repo;
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueValue(repo, issue);
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (source, args) => {
        const repo = source.repo as Repo;
        let list = [...repo.issues.values()];
        const states = args.states as unknown[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.direction === 'DESC') list.sort((a, b) => b.number - a.number);
        else list.sort((a, b) => a.number - b.number);
        return connection(list.map((issue) => issueValue(repo, issue)), args, 'Issue');
      },
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (source, args) => {
        const repo = source.repo as Repo;
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullValue(repo, pull);
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (source, args) => {
        const repo = source.repo as Repo;
        const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        return connection(list.map((pull) => pullValue(repo, pull)), args, 'PullRequest');
      },
    },
  },
  Ref: {
    name: { type: 'String', resolve: (source) => source.name },
  },
  Issue: {
    id: { type: 'ID', resolve: (source) => issueGlobalId(source.repo as Repo, source.issue as Issue) },
    number: { type: 'Int', resolve: (source) => (source.issue as Issue).number },
    title: { type: 'String', resolve: (source) => (source.issue as Issue).title },
    state: { type: 'String', resolve: (source) => (source.issue as Issue).state.toUpperCase() },
    body: { type: 'String', resolve: (source) => (source.issue as Issue).body },
    author: { type: 'User', resolve: () => userValue(viewer.login) },
    createdAt: { type: 'String', resolve: (source) => (source.issue as Issue).createdAt },
    updatedAt: { type: 'String', resolve: (source) => (source.issue as Issue).updatedAt },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (source) => pullGlobalId(source.repo as Repo, source.pull as Pull) },
    number: { type: 'Int', resolve: (source) => (source.pull as Pull).number },
    title: { type: 'String', resolve: (source) => (source.pull as Pull).title },
    body: { type: 'String', resolve: (source) => (source.pull as Pull).body },
    state: {
      type: 'String',
      resolve: (source) => {
        const pull = source.pull as Pull;
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      },
    },
    merged: { type: 'Boolean', resolve: (source) => (source.pull as Pull).merged },
    mergeable: { type: 'String', resolve: (source) => pullMergeable(source.repo as Repo, source.pull as Pull) },
    headRefName: { type: 'String', resolve: (source) => (source.pull as Pull).headRef },
    baseRefName: { type: 'String', resolve: (source) => (source.pull as Pull).baseRef },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (source, args) => {
        const repo = source.repo as Repo;
        const pull = source.pull as Pull;
        const items = pullChangedFiles(repo, pull).map(
          (path) => ({ __type: 'PullRequestChangedFile', path }) as TypedValue,
        );
        return connection(items, args, 'PullRequestChangedFile');
      },
    },
    author: { type: 'User', resolve: () => userValue(viewer.login) },
    createdAt: { type: 'String', resolve: (source) => (source.pull as Pull).createdAt },
    updatedAt: { type: 'String', resolve: (source) => (source.pull as Pull).updatedAt },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (source) => source.path },
  },
  IssueConnection: {
    nodes: { type: 'Issue', list: true, resolve: (source) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (source) => source.pageInfo },
    totalCount: { type: 'Int', resolve: (source) => source.totalCount },
  },
  PullRequestConnection: {
    nodes: { type: 'PullRequest', list: true, resolve: (source) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (source) => source.pageInfo },
    totalCount: { type: 'Int', resolve: (source) => source.totalCount },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: 'PullRequestChangedFile', list: true, resolve: (source) => source.nodes },
    pageInfo: { type: 'PageInfo', resolve: (source) => source.pageInfo },
    totalCount: { type: 'Int', resolve: (source) => source.totalCount },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (source) => source.hasNextPage },
    hasPreviousPage: { type: 'Boolean', resolve: (source) => source.hasPreviousPage },
    startCursor: { type: 'String', resolve: (source) => source.startCursor },
    endCursor: { type: 'String', resolve: (source) => source.endCursor },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (source) => source.issue },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (source) => source.issue },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (source) => source.pullRequest },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (source) => source.pullRequest },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge', resolve: (source) => source.commentEdge },
  },
  CommentEdge: {
    node: { type: 'IssueComment', resolve: (source) => source.node },
    cursor: { type: 'String', resolve: () => cursorOf(1) },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (source) => source.id },
    body: { type: 'String', resolve: (source) => source.body },
  },
  __Type: {
    name: { type: 'String', resolve: (source) => source.name },
    kind: { type: 'String', resolve: (source) => source.kind },
    fields: {
      type: '__Field',
      list: true,
      resolve: (source) => ((source.fieldNames as string[]) ?? []).map((name) => ({ __type: '__Field', name }) as TypedValue),
    },
    enumValues: {
      type: '__EnumValue',
      list: true,
      resolve: (source) => ((source.enumNames as string[]) ?? []).map((name) => ({ __type: '__EnumValue', name }) as TypedValue),
    },
  },
  __Field: {
    name: { type: 'String', resolve: (source) => source.name },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (source) => source.name },
  },
};

interface GqlError {
  message: string;
}

function executeSelectionSet(
  typeName: string,
  source: TypedValue,
  selections: Selection[],
  variables: Record<string, unknown>,
  errors: GqlError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName || typeName === 'Node') {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, variables, errors));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const def = fields[selection.name];
    if (def === undefined) {
      errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = def.resolve(source, args);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(def, value, selection, variables, errors);
  }
  return out;
}

function completeValue(
  def: FieldDef,
  value: unknown,
  selection: Selection & { kind: 'field' },
  variables: Record<string, unknown>,
  errors: GqlError[],
): unknown {
  if (value === null || value === undefined) return null;
  if (selection.selectionSet === undefined) return value;
  if (def.list === true || Array.isArray(value)) {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) =>
      item !== null && typeof item === 'object'
        ? executeSelectionSet(def.type, item as TypedValue, selection.selectionSet as Selection[], variables, errors)
        : item,
    );
  }
  if (typeof value === 'object') {
    const typed = value as TypedValue;
    return executeSelectionSet(typed.__type ?? def.type, typed, selection.selectionSet, variables, errors);
  }
  return value;
}

function executeOperation(operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: GqlError[] } {
  const errors: GqlError[] = [];
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: TypedValue = { __type: rootType };
  const data = executeSelectionSet(rootType, root, operation.selectionSet, variables, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

function executeDocument(query: string, variables: Record<string, unknown>): { data?: Record<string, unknown>; errors?: GqlError[] } {
  let operations: Operation[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operations[0];
  if (operation === undefined) return { errors: [{ message: 'empty document' }] };
  return executeOperation(operation, variables);
}

// -----------------------------------------------------------------------------------
// Routing

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const item = (entry ?? {}) as { query?: string; variables?: Record<string, unknown> };
      return executeDocument(String(item.query ?? ''), item.variables ?? {});
    });
    sendJson(res, 200, results);
    return;
  }
  const single = (body ?? {}) as { query?: string; variables?: Record<string, unknown> };
  const result = executeDocument(String(single.query ?? ''), single.variables ?? {});
  sendJson(res, 200, result);
}
