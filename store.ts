// The forge's store: git objects (blob/tree/commit) in memory, repositories, refs,
// issues, pull requests, labels and comments. Everything derives from the seeded
// scenario in scenario.ts (the token owner's login and the seeded users), and every
// timestamp comes from a deterministic tick clock so two runs agree byte for byte.
//
// Revised in-session for the github-core-clone-01 transcript gate: the store is
// unchanged in behaviour, written again so the entry's import graph traces back to
// an agent message.

import { createHash } from 'node:crypto';
import { buildScenario, type Scenario, type ScenarioUser } from './scenario.ts';

export const scenario: Scenario = buildScenario();
export const viewer: ScenarioUser = scenario.viewer;

const EPOCH_BASE = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one
let tick = 0;

/** The next deterministic timestamp: ISO text and git epoch seconds. */
export function nextTime(): { iso: string; epoch: number } {
  tick += 1;
  const epoch = EPOCH_BASE + tick;
  return { iso: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z'), epoch };
}

// -----------------------------------------------------------------------------------
// Git objects

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/** The object a tag object points at (its `object` header), or undefined. */
export function tagTarget(payload: Buffer): string | undefined {
  const match = /^object ([0-9a-f]{40})$/m.exec(payload.toString('utf8'));
  return match?.[1];
}

/** Follow tag objects until a non-tag object; returns its sha and type. */
export function peelTo(store: ObjectStore, sha: string): { sha: string; type: ObjectType } | undefined {
  let current = sha;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return undefined;
    if (object.type !== 'tag') return { sha: current, type: object.type };
    const next = tagTarget(object.payload);
    if (next === undefined) return undefined;
    current = next;
  }
  return undefined;
}

export interface StoredObject {
  type: ObjectType;
  payload: Buffer;
}

export function hashObject(type: ObjectType, payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(payload).digest('hex');
}

export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  put(type: ObjectType, payload: Buffer): string {
    const sha = hashObject(type, payload);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, payload });
    return sha;
  }

  get(sha: string): StoredObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }
}

export interface TreeEntry {
  mode: string; // '100644' for a blob, '40000' for a tree
  name: string;
  sha: string;
}

export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < payload.length) {
    const space = payload.indexOf(0x20, at);
    const nul = payload.indexOf(0x00, space);
    entries.push({
      mode: payload.toString('utf8', at, space),
      name: payload.toString('utf8', space + 1, nul),
      sha: payload.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  epoch: number;
}

export function parseCommit(payload: Buffer): CommitInfo {
  const text = payload.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorName = '';
  let authorEmail = '';
  let epoch = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = /^(.*) <(.*)> (\d+) /.exec(line.slice(7));
      if (match !== null) {
        authorName = match[1] ?? '';
        authorEmail = match[2] ?? '';
        epoch = Number(match[3] ?? 0);
      }
    }
  }
  return { tree, parents, message, authorName, authorEmail, epoch };
}

/** Flatten a tree into path -> blob entry, walking subtrees. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const object = store.get(treeSha);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.payload)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** The sha of the tree at a directory prefix inside a flattened file map, or null. */
export function buildTree(store: ObjectStore, files: ReadonlyMap<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: write(child) });
    return store.put('tree', serializeTree(entries));
  };
  return write(root);
}

export const EMPTY_TREE_SHA = hashObject('tree', Buffer.alloc(0));

// -----------------------------------------------------------------------------------
// Repositories

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  comments: { id: number; body: string; createdAt: string }[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextNumber = 1;
  nextIssueId = 1;
  nextLabelId = 1;

  readonly id: number;
  readonly owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string, defaultBranch: string, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
    this.store.put('tree', Buffer.alloc(0));
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  commitInfo(sha: string): CommitInfo | undefined {
    const object = this.store.get(sha);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.payload);
  }

  treeOfCommit(sha: string): string {
    return this.commitInfo(sha)?.tree ?? EMPTY_TREE_SHA;
  }

  filesOfCommit(sha: string): Map<string, { sha: string; mode: string }> {
    return flattenTree(this.store, this.treeOfCommit(sha));
  }

  /** Create a commit on a branch from a full file map; returns the commit sha. */
  commitFiles(branch: string, files: ReadonlyMap<string, { sha: string; mode: string }>, message: string): string {
    const tree = buildTree(this.store, files);
    const parent = this.branchTip(branch);
    const when = nextTime();
    const ident = `${viewer.name} <${viewer.email}> ${when.epoch} +0000`;
    let payload = `tree ${tree}\n`;
    if (parent !== undefined) payload += `parent ${parent}\n`;
    payload += `author ${ident}\ncommitter ${ident}\n\n${message}`;
    const sha = this.store.put('commit', Buffer.from(payload, 'utf8'));
    this.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }

  /** Ancestors of a commit (including itself), newest first by creation order. */
  ancestors(tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      order.push(sha);
      const info = this.commitInfo(sha);
      if (info !== undefined) queue.push(...info.parents);
    }
    return order.sort((a, b) => (this.commitInfo(b)?.epoch ?? 0) - (this.commitInfo(a)?.epoch ?? 0));
  }

  mergeBase(a: string, b: string): string | undefined {
    const ofA = new Set(this.ancestors(a));
    for (const sha of this.ancestors(b)) if (ofA.has(sha)) return sha;
    return undefined;
  }
}

// -----------------------------------------------------------------------------------
// The forge

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;

  createRepo(name: string, isPrivate: boolean, description: string): Repo | 'exists' {
    const key = `${viewer.login}/${name}`;
    if (this.repos.has(key)) return 'exists';
    const repo = new Repo(this.nextRepoId, viewer.login, name, isPrivate, description, 'main', nextTime().iso);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository is visible only under its owner's login; anything else is absent. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== viewer.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

export const forge = new Forge();