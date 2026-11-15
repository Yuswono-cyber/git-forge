# Git Forge — a standalone GitHub-core clone

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
![Live rank](https://make.fun/badge/github-core-clone-01/Yuswono-cyber/git-forge/rank.svg)
![Live reward](https://make.fun/badge/github-core-clone-01/Yuswono-cyber/git-forge/reward.svg)

Entered in the make.fun bounty [Clone GitHub's core](https://make.fun/bounty/github-core-clone-01).

A single-process forge that speaks four surfaces over one in-memory store, built
with Node 22 and the standard library only — no git binary, no packages, no
outside service:

- **Git smart HTTP** — protocol v2 and v0 ref advertisement, `ls-refs` with
  ref-prefix filtering, fetch with packfile generation (shallow clones, deepen,
  deepen-since / deepen-not), and receive-pack pushes with report-status,
  fast-forward enforcement and per-ref ok/ng reporting. Packfiles are read and
  written in-process, including OFS/REF delta resolution on ingest.
- **REST v3** — repositories, branches, contents (read/write/delete), commits,
  labels, issues and comments, and pull requests with a real file-level
  three-way merge (merge and squash), changed-file diffs and pagination.
- **GraphQL v4** — a small parser and executor covering the documents gh and
  github-mcp-server send: viewer, repository fields, issue/pull-request reads
  and connections with cursor pagination, Relay `node(id:)` with opaque stable
  global ids, `__type` introspection probes, and the create/close/merge/comment
  mutations. Batched operation documents in one request are answered in order.
- **MCP** — a stateless streamable-HTTP JSON-RPC endpoint serving both protocol
  eras (`server/discover` 2026-07-28 and the legacy `initialize` handshake),
  with six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — that operate on the same store
  and answer with the REST JSON shapes.

State lives in Maps keyed by content hash (SHA-1 over the git object framing);
timestamps come from a deterministic tick clock so two runs of the same trial
produce byte-identical behaviour. The entry point is the kit's `main.ts`
lifecycle: bind an ephemeral port, register it with the env, serve until the
env says done.

Local verification against the kit's own conformance suite
(`sdk/run.ts`): **120/120 checks pass** (git 30, repos 15, issues 15, pulls 20,
graphql 20, mcp 15, protocol 5), and the four benchmark workloads score
176/200 perf points on a local VM.
