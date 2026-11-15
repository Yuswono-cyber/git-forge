// The REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the store in store.ts. Every reply follows the
// shared protocol discipline (JSON, a message on errors, the exact statuses the
// suite's contract names).

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { baseUrlOf, isAuthed, readBody, sendEmpty, sendJson } from './http.ts';
import {
  buildTree,
  forge,
  nextTime,
  scenario,
  viewer,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

type Json = Record<string, unknown>;

const NOT_FOUND: Json = { message: 'Not Found' };

function userJson(login: string): Json {
  const user = scenario.users.find((entry) => entry.login === login) ?? viewer;
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: '',
    gravatar_id: '',
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: '',
    clone_url: '',
    ssh_url: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    topics: [],
  };
}

function labelJson(label: Label): Json {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
    url: '',
  };
}

export function issueJson(issue: Issue): Json {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(viewer.login),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: '',
    url: '',
  };
}

export function pullJson(repo: Repo, pull: Pull): Json {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: repo.branchTip(pull.headRef) ?? '',
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: repo.branchTip(pull.baseRef) ?? '',
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    user: userJson(viewer.login),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: '',
    url: '',
  };
}

function commitJson(repo: Repo, sha: string): Json {
  const info = repo.commitInfo(sha);
  const date = info === undefined ? '' : new Date(info.epoch * 1000).toISOString().replace('.000Z', 'Z');
  const matched = scenario.users.find((user) => user.email === info?.authorEmail);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: { name: info?.authorName ?? '', email: info?.authorEmail ?? '', date },
      committer: { name: info?.authorName ?? '', email: info?.authorEmail ?? '', date },
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '' },
      comment_count: 0,
    },
    author: matched === undefined ? null : userJson(matched.login),
    committer: matched === undefined ? null : userJson(matched.login),
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// -----------------------------------------------------------------------------------
// Pagination

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

function paginate(req: IncomingMessage, url: URL, items: readonly unknown[]): Page {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages || page > 1) {
    const linkFor = (target: number): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('per_page', String(perPage));
      params.set('page', String(target));
      return `<${baseUrlOf(req)}${url.pathname}?${params.toString()}>`;
    };
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`${linkFor(page + 1)}; rel="next"`);
      links.push(`${linkFor(totalPages)}; rel="last"`);
    }
    if (page > 1) {
      links.push(`${linkFor(page - 1)}; rel="prev"`);
      links.push(`${linkFor(1)}; rel="first"`);
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { items: slice, headers };
}

function sendList(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly unknown[]): void {
  const page = paginate(req, url, items);
  const text = `${JSON.stringify(page.items)}\n`;
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...page.headers,
  });
  res.end(text);
}

// -----------------------------------------------------------------------------------
// Contents helpers

function wrapBase64(bytes: Buffer): string {
  const raw = bytes.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 60) lines.push(raw.slice(i, i + 60));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function resolveCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.branchTip(repo.defaultBranch);
  return repo.branchTip(ref) ?? (repo.store.has(ref) && repo.store.get(ref)?.type === 'commit' ? ref : undefined);
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    const oldSet = new Map<string, number>();
    for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const left = oldSet.get(line) ?? 0;
      if (left > 0) {
        common += 1;
        oldSet.set(line, left - 1);
      }
    }
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }
  const dp: number[] = new Array(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      const current = dp[j] as number;
      dp[j] = oldLines[i - 1] === newLines[j - 1] ? prev + 1 : Math.max(dp[j] as number, dp[j - 1] as number);
      prev = current;
    }
  }
  const lcs = dp[newLines.length] as number;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

// -----------------------------------------------------------------------------------
// The router

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => decodeURIComponent(piece));

  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  let body: Json = {};
  if (rawBody.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Json;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  }

  // The API root is the one unauthenticated route; everything else needs the token.
  const isRoot = segments.length === 0;
  if (!isRoot && !isAuthed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (isRoot && method === 'GET') {
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '3.18.0', github_hostname: 'forge.local', github_npm_registry: '' });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson(viewer.login));
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      sendList(req, res, url, forge.listRepos().map(repoJson));
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Repository creation failed: name is required' });
        return;
      }
      const created = forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (created === 'exists') {
        sendJson(res, 422, { message: 'Repository creation failed: name already exists on this account' });
        return;
      }
      sendJson(res, 201, repoJson(created));
      return;
    }
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          forge.repos.delete(`${repo.owner}/${repo.name}`);
          repo.name = body.name;
          forge.repos.set(`${repo.owner}/${repo.name}`, repo);
        }
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        sendEmpty(res, 204);
        return;
      }
    }

    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendList(req, res, url, branches);
      return;
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = resolveCommit(repo, url.searchParams.get('sha') ?? undefined);
      const commits = tip === undefined ? [] : repo.ancestors(tip).map((sha) => commitJson(repo, sha));
      sendList(req, res, url, commits);
      return;
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || repo.store.get(sha)?.type !== 'commit') {
        sendJson(res, 422, { message: 'Invalid ref or object sha' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: '', url: '', object: { sha, type: 'commit', url: '' } });
      return;
    }

    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const commit = resolveCommit(repo, url.searchParams.get('ref') ?? undefined);
        if (commit === undefined) {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        const files = repo.filesOfCommit(commit);
        const direct = files.get(filePath);
        if (direct !== undefined) {
          const blob = repo.store.get(direct.sha);
          const bytes = blob?.payload ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: direct.sha,
            content: wrapBase64(bytes),
            url: '',
            html_url: '',
            git_url: '',
            download_url: null,
          });
          return;
        }
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
        for (const [path, entry] of files) {
          if (!path.startsWith(prefix)) continue;
          const tail = path.slice(prefix.length);
          const head = tail.split('/')[0] as string;
          if (tail.includes('/')) {
            if (!children.has(head)) {
              const sub = new Map<string, { sha: string; mode: string }>();
              for (const [subPath, subEntry] of files) {
                if (subPath.startsWith(`${prefix}${head}/`)) sub.set(subPath.slice(prefix.length + head.length + 1), subEntry);
              }
              children.set(head, { type: 'dir', sha: buildTree(repo.store, sub), size: 0 });
            }
          } else {
            children.set(head, { type: 'file', sha: entry.sha, size: repo.store.get(entry.sha)?.payload.length ?? 0 });
          }
        }
        if (children.size === 0 && filePath !== '') {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        const listing = [...children.entries()]
          .map(([childName, child]) => ({
            type: child.type,
            size: child.size,
            name: childName,
            path: prefix + childName,
            sha: child.sha,
            url: '',
            html_url: '',
            git_url: '',
            download_url: null,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, listing);
        return;
      }
      if (method === 'PUT') {
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const tip = repo.branchTip(branch);
        if (tip === undefined && repo.refs.size > 0) {
          sendJson(res, 404, { message: 'Branch not found' });
          return;
        }
        const files = tip === undefined ? new Map<string, { sha: string; mode: string }>() : repo.filesOfCommit(tip);
        const existing = files.get(filePath);
        const sentSha = typeof body.sha === 'string' ? body.sha : undefined;
        if (existing !== undefined) {
          if (sentSha === undefined) {
            sendJson(res, 422, { message: "sha wasn't supplied" });
            return;
          }
          if (sentSha.toLowerCase() !== existing.sha.toLowerCase()) {
            sendJson(res, 409, { message: `${filePath} does not match ${sentSha}` });
            return;
          }
        } else if (sentSha !== undefined) {
          sendJson(res, 422, { message: 'sha must not be supplied when creating a file' });
          return;
        }
        const bytes = Buffer.from(String(body.content ?? '').replace(/[\r\n\t ]+/g, ''), 'base64');
        const blobSha = repo.store.put('blob', bytes);
        files.set(filePath, { sha: blobSha, mode: '100644' });
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const commitSha = repo.commitFiles(branch, files, message);
        sendJson(res, existing === undefined ? 201 : 200, {
          content: {
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: blobSha,
            size: bytes.length,
            type: 'file',
            encoding: 'base64',
            url: '',
            html_url: '',
            git_url: '',
            download_url: null,
          },
          commit: {
            sha: commitSha,
            message,
            tree: { sha: repo.treeOfCommit(commitSha) },
            parents: (repo.commitInfo(commitSha)?.parents ?? []).map((parent) => ({ sha: parent })),
          },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const tip = repo.branchTip(branch);
        if (tip === undefined) {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        const files = repo.filesOfCommit(tip);
        const existing = files.get(filePath);
        if (existing === undefined) {
          sendJson(res, 404, NOT_FOUND);
          return;
        }
        const sentSha = typeof body.sha === 'string' ? body.sha : undefined;
        if (sentSha === undefined) {
          sendJson(res, 422, { message: "sha wasn't supplied" });
          return;
        }
        if (sentSha.toLowerCase() !== existing.sha.toLowerCase()) {
          sendJson(res, 409, { message: `${filePath} does not match ${sentSha}` });
          return;
        }
        files.delete(filePath);
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const commitSha = repo.commitFiles(branch, files, message);
        sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
        return;
      }
    }

    if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') {
        sendJson(res, 422, { message: 'Label name is required' });
        return;
      }
      if (repo.labels.has(labelName)) {
        sendJson(res, 422, { message: 'Label already exists' });
        return;
      }
      const label: Label = {
        id: repo.nextLabelId,
        name: labelName,
        color: typeof body.color === 'string' ? body.color : 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.nextLabelId += 1;
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(label));
      return;
    }

    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'POST') {
        const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) {
            sendJson(res, 422, { message: `Label '${labelName}' does not exist` });
            return;
          }
          labels.push(label);
        }
        const when = nextTime();
        const issue: Issue = {
          id: repo.nextIssueId,
          number: repo.nextNumber,
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          labels,
          createdAt: when.iso,
          updatedAt: when.iso,
          comments: [],
        };
        repo.nextIssueId += 1;
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, issueJson(issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendList(req, res, url, list.map(issueJson));
        return;
      }
    }

    if (rest[0] === 'issues' && rest.length >= 2) {
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (issue === undefined) {
        sendJson(res, 404, NOT_FOUND);
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(issue));
          return;
        }
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels: Label[] = [];
            for (const entry of body.labels) {
              const labelName = typeof entry === 'string' ? entry : '';
              const label = repo.labels.get(labelName);
              if (label === undefined) {
                sendJson(res, 422, { message: `Label '${labelName}' does not exist` });
                return;
              }
              labels.push(label);
            }
            issue.labels = labels;
          }
          issue.updatedAt = nextTime().iso;
          sendJson(res, 200, issueJson(issue));
          return;
        }
      }
      if (rest[1] !== undefined && rest[2] === 'comments' && rest.length === 3) {
        if (method === 'POST') {
          const when = nextTime();
          const comment = {
            id: issue.id * 1_000_000 + issue.comments.length + 1,
            body: typeof body.body === 'string' ? body.body : '',
            createdAt: when.iso,
          };
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id,
            node_id: `IC_${comment.id}`,
            body: comment.body,
            user: userJson(viewer.login),
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            html_url: '',
            url: '',
          });
          return;
        }
        if (method === 'GET') {
          sendList(
            req,
            res,
            url,
            issue.comments.map((comment) => ({
              id: comment.id,
              node_id: `IC_${comment.id}`,
              body: comment.body,
              user: userJson(viewer.login),
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
              html_url: '',
              url: '',
            })),
          );
          return;
        }
      }
    }

    if (rest[0] === 'pulls' && rest.length === 1) {
      if (method === 'POST') {
        const head = typeof body.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
        const base = typeof body.base === 'string' ? body.base.replace(/^[^:]+:/, '') : '';
        if (repo.branchTip(head) === undefined || repo.branchTip(base) === undefined) {
          sendJson(res, 422, { message: 'Head or base branch does not exist' });
          return;
        }
        const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (duplicate) {
          sendJson(res, 422, { message: 'A pull request already exists for this head and base' });
          return;
        }
        const when = nextTime();
        const pull: Pull = {
          id: repo.nextNumber,
          number: repo.nextNumber,
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : '',
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
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.number - a.number);
        sendList(req, res, url, list.map((pull) => pullJson(repo, pull)));
        return;
      }
    }

    if (rest[0] === 'pulls' && rest.length >= 2) {
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) {
        sendJson(res, 404, NOT_FOUND);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const headTip = repo.branchTip(pull.headRef);
        const baseTip = repo.branchTip(pull.baseRef);
        if (headTip === undefined || baseTip === undefined) {
          sendJson(res, 200, []);
          return;
        }
        const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
        const before = repo.filesOfCommit(base);
        const after = repo.filesOfCommit(headTip);
        const files: Json[] = [];
        const paths = new Set([...before.keys(), ...after.keys()]);
        for (const path of [...paths].sort()) {
          const oldEntry = before.get(path);
          const newEntry = after.get(path);
          if (oldEntry?.sha === newEntry?.sha) continue;
          const oldText = oldEntry === undefined ? '' : (repo.store.get(oldEntry.sha)?.payload.toString('utf8') ?? '');
          const newText = newEntry === undefined ? '' : (repo.store.get(newEntry.sha)?.payload.toString('utf8') ?? '');
          const { additions, deletions } = lineDiff(oldText, newText);
          files.push({
            sha: newEntry?.sha ?? oldEntry?.sha ?? '',
            filename: path,
            status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
            additions,
            deletions,
            changes: additions + deletions,
            patch: '',
          });
        }
        sendJson(res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull Request is not open' });
          return;
        }
        const headTip = repo.branchTip(pull.headRef);
        const baseTip = repo.branchTip(pull.baseRef);
        if (headTip === undefined || baseTip === undefined) {
          sendJson(res, 405, { message: 'Pull Request cannot be merged' });
          return;
        }
        const base = repo.mergeBase(baseTip, headTip);
        if (base === undefined || base === headTip) {
          sendJson(res, 405, { message: 'Pull Request is already up to date' });
          return;
        }
        const atBase = repo.filesOfCommit(base);
        const atHead = repo.filesOfCommit(headTip);
        const atTip = repo.filesOfCommit(baseTip);
        const mergedFiles = new Map(atTip);
        let conflict = false;
        const paths = new Set([...atBase.keys(), ...atHead.keys()]);
        for (const path of paths) {
          const baseEntry = atBase.get(path);
          const headEntry = atHead.get(path);
          if (baseEntry?.sha === headEntry?.sha) continue;
          const tipEntry = atTip.get(path);
          if (tipEntry?.sha !== baseEntry?.sha && tipEntry?.sha !== headEntry?.sha) {
            conflict = true;
            break;
          }
          if (headEntry === undefined) mergedFiles.delete(path);
          else mergedFiles.set(path, headEntry);
        }
        if (conflict) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable: conflicts' });
          return;
        }
        const method2 = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
        const tree = buildTree(repo.store, mergedFiles);
        const when = nextTime();
        const ident = `${viewer.name} <${viewer.email}> ${when.epoch} +0000`;
        let payload = `tree ${tree}\nparent ${baseTip}\n`;
        if (method2 === 'merge') payload += `parent ${headTip}\n`;
        payload += `author ${ident}\ncommitter ${ident}\n\n${pull.title}`;
        const mergeSha = repo.store.put('commit', Buffer.from(payload, 'utf8'));
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = when.iso;
        pull.mergeCommitSha = mergeSha;
        pull.updatedAt = when.iso;
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }
  }

  sendJson(res, 404, NOT_FOUND);
}
