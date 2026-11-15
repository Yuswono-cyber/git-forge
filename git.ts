// The git smart-HTTP surface: ref advertisement (protocol v0 and v2), v2 ls-refs,
// fetch (v2 sections and v0 sideband, with shallow/deepen support) and receive-pack
// pushes with report-status. Packs are built and read with node:zlib; objects the
// server sends are never delta-compressed, and packs it receives may be.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, readBody } from './http.ts';
import {
  forge,
  parseCommit,
  parseTree,
  peelTo,
  tagTarget,
  type ObjectStore,
  type ObjectType,
  type Repo,
} from './store.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

// -----------------------------------------------------------------------------------
// pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse pkt-lines from `start`; returns the packets and the offset just past them. */
function parsePackets(buffer: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = start;
  while (at + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
      break;
    }
    if (length < 4 || at + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, next: at };
}

function packetText(packet: Packet): string {
  return packet.payload.toString('utf8').replace(/\n$/, '');
}

// -----------------------------------------------------------------------------------
// Packfiles

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function buildPack(objects: readonly { type: ObjectType; payload: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.payload.length));
    parts.push(deflateSync(object.payload));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  offset: number;
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseSha?: string;
  resolved?: { type: ObjectType; payload: Buffer; sha: string };
}

/** Read a pack into the repo store, resolving deltas; throws on corruption. */
function ingestPack(store: ObjectStore, pack: Buffer): void {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const trailer = pack.subarray(pack.length - 20);
  const checksum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(checksum)) throw new Error('pack checksum mismatch');
  const count = pack.readUInt32BE(8);
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = at;
    let byte = pack[at] as number;
    at += 1;
    const type = CODE_TYPE[(byte >> 4) & 0x7];
    if (type === undefined) throw new Error('bad pack object type');
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
    }
    const entry: RawEntry = { offset: entryOffset, type, data: Buffer.alloc(0) };
    if (type === 'ofs-delta') {
      let value = pack[at] as number;
      at += 1;
      let base = value & 0x7f;
      while (value & 0x80) {
        value = pack[at] as number;
        at += 1;
        base = (base + 1) * 128 + (value & 0x7f);
      }
      entry.baseOffset = entryOffset - base;
    } else if (type === 'ref-delta') {
      entry.baseSha = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const inflated = inflateSync(pack.subarray(at), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = inflated.buffer;
    at += inflated.engine.bytesWritten;
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolve = (entry: RawEntry): { type: ObjectType; payload: Buffer; sha: string } => {
    if (entry.resolved !== undefined) return entry.resolved;
    let resolved: { type: ObjectType; payload: Buffer; sha: string };
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let baseObject: { type: ObjectType; payload: Buffer } | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing');
        const baseResolved = resolve(baseEntry);
        baseObject = { type: baseResolved.type, payload: baseResolved.payload };
      } else {
        const baseEntry = entries.find((candidate) => resolve(candidate).sha === entry.baseSha);
        if (baseEntry !== undefined) {
          const baseResolved = resolve(baseEntry);
          baseObject = { type: baseResolved.type, payload: baseResolved.payload };
        } else {
          const stored = store.get(entry.baseSha as string);
          if (stored !== undefined) baseObject = stored;
        }
      }
      if (baseObject === undefined) throw new Error('delta base missing');
      const payload = applyDelta(baseObject.payload, entry.data);
      resolved = { type: baseObject.type, payload, sha: store.put(baseObject.type, payload) };
    } else {
      resolved = { type: entry.type, payload: entry.data, sha: store.put(entry.type, entry.data) };
    }
    entry.resolved = resolved;
    return resolved;
  };
  for (const entry of entries) resolve(entry);
}

// -----------------------------------------------------------------------------------
// Reachability

interface Closure {
  objects: Map<string, { type: ObjectType; payload: Buffer }>;
  commits: Set<string>;
  /** Included commits with a parent that was cut off (depth / since / not). */
  boundary: string[];
}

/** Everything reachable from `tips`; with a depth, commits past it are cut off.
 *  Commits in `stopAt` (a fetch's declared shallow boundary) are included but
 *  their parents are not walked — the peer does not hold them. */
function closure(store: ObjectStore, tips: readonly string[], depth?: number, sinceEpoch?: number, notTips?: readonly string[], stopAt?: readonly string[]): Closure {
  const stop = new Set(stopAt ?? []);
  const objects = new Map<string, { type: ObjectType; payload: Buffer }>();
  const commits = new Set<string>();
  const excluded = new Set<string>();
  if (notTips !== undefined) {
    const stack = [...notTips];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (excluded.has(sha)) continue;
      excluded.add(sha);
      const object = store.get(sha);
      if (object?.type === 'commit') stack.push(...parseCommit(object.payload).parents);
    }
  }
  const addObject = (sha: string): void => {
    if (objects.has(sha)) return;
    const object = store.get(sha);
    if (object === undefined) return;
    objects.set(sha, object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.payload)) addObject(entry.sha);
    } else if (object.type === 'tag') {
      const target = tagTarget(object.payload);
      if (target !== undefined) addObject(target);
    }
  };
  const queue: { sha: string; generation: number }[] = tips.map((sha) => ({ sha, generation: 0 }));
  const seenCommit = new Map<string, number>();
  while (queue.length > 0) {
    const { sha, generation } = queue.shift() as { sha: string; generation: number };
    const object = store.get(sha);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      addObject(sha);
      const target = tagTarget(object.payload);
      if (target !== undefined) queue.push({ sha: target, generation });
      continue;
    }
    if (object.type !== 'commit') {
      addObject(sha);
      continue;
    }
    if (excluded.has(sha)) continue;
    if (seenCommit.has(sha) && (seenCommit.get(sha) as number) <= generation) continue;
    seenCommit.set(sha, generation);
    if (depth !== undefined && generation >= depth) continue;
    const info = parseCommit(object.payload);
    if (sinceEpoch !== undefined && generation > 0 && info.epoch < sinceEpoch) continue;
    commits.add(sha);
    objects.set(sha, object);
    addObject(info.tree);
    if (stop.has(sha)) continue;
    for (const parent of info.parents) queue.push({ sha: parent, generation: generation + 1 });
  }
  const boundary: string[] = [];
  for (const sha of commits) {
    const info = parseCommit((store.get(sha) as { payload: Buffer }).payload);
    if (info.parents.some((parent) => !commits.has(parent) && store.has(parent))) boundary.push(sha);
  }
  return { objects, commits, boundary };
}

// -----------------------------------------------------------------------------------
// Advertisements and ls-refs

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not object-format=sha1 agent=${AGENT} symref=HEAD:${headTarget(repo)}`
      : `report-status delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headTip = repo.branchTip(repo.defaultBranch);
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      first = false;
      const peeled = peelTo(repo.store, oid);
      if (peeled !== undefined && peeled.type === 'commit' && peeled.sha !== oid) {
        parts.push(pktLine(`${peeled.sha} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(repo: Repo): Buffer {
  void repo;
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=filter shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsLines(repo: Repo, args: LsRefsArgs): string[] {
  const lines: string[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  if (headTip !== undefined) {
    lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}`);
  } else if (args.unborn) {
    lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelTo(repo.store, oid);
      if (peeled !== undefined && peeled.type === 'commit' && peeled.sha !== oid) line += ` peeled:${peeled.sha}`;
    }
    lines.push(line);
  }
  if (args.prefixes.length === 0) return lines;
  return lines.filter((line) => {
    const name = line.split(' ')[1] ?? '';
    return args.prefixes.some((prefix) => name.startsWith(prefix));
  });
}

// -----------------------------------------------------------------------------------
// Fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  done: boolean;
}

function computeFetch(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const store = repo.store;
  const wanted = closure(store, args.wants, args.depth, args.deepenSince, args.deepenNot.length > 0 ? args.deepenNot : undefined);
  const held = closure(store, args.haves, undefined, undefined, undefined, args.shallowLines);
  const toSend: { type: ObjectType; payload: Buffer }[] = [];
  for (const [sha, object] of wanted.objects) {
    if (!held.objects.has(sha)) toSend.push(object);
  }
  const order: Record<ObjectType, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  toSend.sort((a, b) => order[a.type] - order[b.type]);
  const boundaryInClosure = wanted.boundary;
  const unshallow = args.shallowLines.filter((sha) => wanted.commits.has(sha) && !boundaryInClosure.includes(sha));
  return { pack: buildPack(toSend), shallow: boundaryInClosure, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  for (let at = 0; at < pack.length; at += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  if (!args.done) {
    const acks: string[] = [];
    for (const have of args.haves) {
      if (repo.store.has(have)) acks.push(`ACK ${have}`);
    }
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of acks) parts.push(pktLine(`${ack}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  const known = args.haves.filter((have) => repo.store.has(have));
  if (known.length > 0) parts.push(pktLine(`ACK ${known[known.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(packets: Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowLines: [], deepenNot: [], done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packetText(packet);
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

// -----------------------------------------------------------------------------------
// Receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  return repo.ancestors(descendant).includes(ancestor);
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, next } = parsePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packetText(packet);
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid !== undefined && newOid !== undefined && ref !== undefined) commands.push({ oldOid, newOid, ref });
  }
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const packBytes = body.subarray(next);
  let unpackError: string | null = null;
  const needsPack = commands.some((command) => command.newOid !== ZERO);
  if (needsPack) {
    if (packBytes.length === 0) unpackError = 'no packfile sent';
    else {
      try {
        ingestPack(repo.store, packBytes);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      fail(`unpack failed: ${unpackError}`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO) {
      // delete
      if (current === undefined) {
        fail('ref does not exist');
        continue;
      }
      if (current !== command.oldOid) {
        fail('stale info');
        continue;
      }
      if (command.ref === headTarget(repo)) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObject = repo.store.get(command.newOid);
    if (newObject === undefined) {
      fail('object not found');
      continue;
    }
    if (command.oldOid === ZERO) {
      if (current !== undefined) {
        fail('already exists');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    // update: require fast-forward (through tags, peel to commits)
    const oldPeeled = peelTo(repo.store, command.oldOid);
    const newPeeled = peelTo(repo.store, command.newOid);
    if (oldPeeled?.type === 'commit' && newPeeled?.type === 'commit') {
      if (oldPeeled.sha !== newPeeled.sha && !isAncestor(repo, oldPeeled.sha, newPeeled.sha)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!caps.has('report-status') && !caps.has('report-status-v2')) {
    return Buffer.concat(sidebandPackets(Buffer.alloc(0)).slice(0, 0));
  }
  const reportLines: string[] = [`unpack ${unpackError === null ? 'ok' : `error ${unpackError}`}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (caps.has('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 65500;
    for (let at = 0; at < reportStream.length; at += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + CHUNK)])));
    }
    packets.push(PKT_FLUSH);
    return Buffer.concat(packets);
  }
  return reportStream;
}

// -----------------------------------------------------------------------------------
// Routing

export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const endpoint = match[3] as string;
  const repo = forge.getRepo(owner, name);

  if (!isAuthed(req)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('authentication required\n');
    return true;
  }
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('repository not found\n');
    return true;
  }

  try {
    if (endpoint === 'info/refs' && (req.method ?? 'GET') === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad service\n');
        return true;
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
      const body = wantsV2 ? advertisementV2(repo) : advertisementV0(repo, service);
      res.writeHead(200, {
        'content-type': `application/x-${service}-advertisement`,
        'content-length': body.length,
        'cache-control': 'no-cache',
      });
      res.end(body);
      return true;
    }

    if (endpoint === 'git-upload-pack' && (req.method ?? '') === 'POST') {
      const body = await readBody(req);
      const { packets } = parsePackets(body);
      const firstData = packets.find((packet) => packet.kind === 'data');
      const firstLine = firstData !== undefined ? packetText(firstData) : '';
      const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2') || firstLine.startsWith('command=');
      let payload: Buffer;
      if (isV2 && firstLine === 'command=ls-refs') {
        const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const packet of packets) {
          if (packet.kind !== 'data') continue;
          const line = packetText(packet);
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
        }
        const lines = lsRefsLines(repo, args);
        payload = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
      } else if (isV2 && firstLine === 'command=fetch') {
        payload = fetchV2(repo, parseFetchArgs(packets));
      } else if (!isV2) {
        payload = fetchV0(repo, parseFetchArgs(packets));
      } else {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('unknown command\n');
        return true;
      }
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': payload.length,
      });
      res.end(payload);
      return true;
    }

    if (endpoint === 'git-receive-pack' && (req.method ?? '') === 'POST') {
      const body = await readBody(req);
      const payload = receivePack(repo, body);
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-result',
        'content-length': payload.length,
      });
      res.end(payload);
      return true;
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request\n');
    }
    return true;
  }

  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('method not allowed\n');
  return true;
}
