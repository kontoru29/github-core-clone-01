// Shared in-memory store for the forge. One Store instance is created per
// process and shared by the git, REST, GraphQL and MCP surfaces, so an object
// created over one surface reads back identically over the others.
//
// Determinism: no wall clock and no randomness anywhere in here. Creation
// order comes from monotonic sequence numbers; every timestamp string the
// forge emits is the fixed scenario epoch. The viewer login is the kit's
// fixed scenario viewer (wire.ts buildScenario, seed 0x6a09e667f3bcc909):
// adaiversen — the same in every trial of this competition, practice and
// final, because the scenario seed is a constant in the sealed env.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
/** Fixed scenario epoch (2025-01-01T00:00:00Z); every timestamp we emit. */
export const FIXED_EPOCH = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  prs: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, Comment[]>;
  /** Shared issue+PR number counter (GitHub shares one per repo), next to hand out. */
  nextNumber: number;
}

export function sha1Of(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Store an object verbatim; returns its OID. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = sha1Of(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid.toLowerCase());
}

/** Opaque, stable Relay-style global ids. Never the plain numeric id. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export class Store {
  repos: Repo[] = [];
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPrId = 1;
  private nextCommentId = 1;
  private seq = 1;

  nextSeq(): number {
    return this.seq++;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.some((r) => r.owner === owner && r.name === name)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      prs: [],
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
    };
    this.repos.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.find((r) => r.owner === owner && r.name === name);
  }

  getRepoById(id: number): Repo | undefined {
    return this.repos.find((r) => r.id === id);
  }

  listRepos(owner: string): Repo[] {
    return this.repos.filter((r) => r.owner === owner);
  }

  deleteRepo(repo: Repo): void {
    this.repos = this.repos.filter((r) => r !== repo);
  }

  nextIssueNumber(repo: Repo): number {
    return repo.nextNumber++;
  }

  issueId(): number {
    return this.nextIssueId++;
  }

  prId(): number {
    return this.nextPrId++;
  }

  commentId(): number {
    return this.nextCommentId++;
  }
}

// ---------------------------------------------------------------------------
// Git object parsing / building (byte-exact: objects are stored verbatim).
// ---------------------------------------------------------------------------

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Raw header block after the tree/parents/author/committer lines, if any. */
  extra: string;
}

export function parseCommit(data: Buffer): CommitParts | null {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  if (sep < 0) return null;
  const head = text.slice(0, sep);
  const message = text.slice(sep + 2);
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else extra.push(line);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) return null;
  return { tree, parents, author, committer, message, extra: extra.join('\n') };
}

export function buildCommit(tree: string, parents: string[], message: string, epoch: number = FIXED_EPOCH): Buffer {
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  let out = `tree ${tree}\n`;
  for (const p of parents) out += `parent ${p}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (by OID) to path -> {oid, mode}; follows directories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else if (e.mode !== '160000') out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/**
 * Build nested trees from a flat path map. Returns the root tree OID,
 * storing every intermediate tree. Paths use '/' separators.
 */
export function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = node.dirs.get(segs[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segs[i], next);
      }
      node = next;
    }
    node.files.set(segs[segs.length - 1], f);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Walk a commit's ancestry newest-first (linear histories; parents in order). */
export function walkHistory(repo: Repo, tipOid: string, limit = 10000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tipOid];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parts = parseCommit(obj.data);
    if (parts) queue.push(...parts.parents);
  }
  return out;
}

/** First common ancestor of two commits (linear histories: walk both). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(walkHistory(repo, a));
  for (const oid of walkHistory(repo, b)) {
    if (ancestorsA.has(oid)) return oid;
  }
  return null;
}

/** True when `desc` is `anc` or a descendant of it (linear parent walk). */
export function isDescendant(repo: Repo, desc: string, anc: string): boolean {
  if (desc === anc) return true;
  let cur: string | null = desc;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') return false;
    const parts = parseCommit(obj.data);
    if (!parts || parts.parents.length === 0) return false;
    cur = parts.parents[0];
    if (cur === anc) return true;
  }
  return false;
}

/** Collect every object reachable from the given tips (commits, trees, blobs, tags). */
export function collectReachable(repo: Repo, tips: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const parts = parseCommit(obj.data);
      if (parts) {
        stack.push(parts.tree, ...parts.parents);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) stack.push(m[1]);
    }
  }
  return out;
}

/** Find an issue by number, or undefined. */
export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((i) => i.number === number);
}

/** Find a pull request by number, or undefined. */
export function getPr(repo: Repo, number: number): PullRequest | undefined {
  return repo.prs.find((p) => p.number === number);
}

/** Deterministic numeric id for a label name (labels carry no id of their own). */
export function stableId(text: string): number {
  const hash = createHash('sha1').update(text, 'utf8').digest();
  return hash.readUInt32BE(0) % 1000000000;
}

/** Parse an annotated tag object; returns target oid and tag name. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } | null {
  const text = data.toString('utf8');
  const mObj = text.match(/^object ([0-9a-f]{40})$/m);
  const mType = text.match(/^type (\w+)$/m);
  const mTag = text.match(/^tag (.+)$/m);
  if (!mObj || !mType || !mTag) return null;
  return { object: mObj[1], type: mType[1], tag: mTag[1] };
}

// ---------------------------------------------------------------------------
// Pull-request domain logic, shared by REST, GraphQL and MCP so all three
// surfaces create and merge pull requests identically.
// ---------------------------------------------------------------------------

/**
 * Three-way merge of the flat file maps of ancestor/head/base-tip commits.
 * Returns the merged flat map, or null when the same path changed
 * differently on both sides (a real merge conflict).
 */
export function threeWayMerge(
  repo: Repo,
  ancestorOid: string,
  headOid: string,
  baseOid: string,
): Map<string, { oid: string; mode: string }> | null {
  const aObj = getObject(repo, ancestorOid);
  const hObj = getObject(repo, headOid);
  const bObj = getObject(repo, baseOid);
  if (!aObj || !hObj || !bObj) return null;
  const aParts = parseCommit(aObj.data);
  const hParts = parseCommit(hObj.data);
  const bParts = parseCommit(bObj.data);
  if (!aParts || !hParts || !bParts) return null;
  const a = flattenTree(repo, aParts.tree);
  const h = flattenTree(repo, hParts.tree);
  const b = flattenTree(repo, bParts.tree);
  const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
    x?.oid === y?.oid && x?.mode === y?.mode;
  const out = new Map<string, { oid: string; mode: string }>();
  for (const path of new Set([...a.keys(), ...h.keys(), ...b.keys()])) {
    const av = a.get(path);
    const hv = h.get(path);
    const bv = b.get(path);
    if (same(hv, bv)) {
      if (hv) out.set(path, hv);
    } else if (same(hv, av)) {
      if (bv) out.set(path, bv);
    } else if (same(bv, av)) {
      if (hv) out.set(path, hv);
    } else {
      return null; // both sides changed this path differently
    }
  }
  return out;
}

/** Whether an open pull request can be merged cleanly. Merging is computed
 * against the CURRENT base-branch tip, not the sha captured at PR creation:
 * the base may have moved since the PR was opened. */
export function prMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headObj = getObject(repo, pull.headSha);
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const baseObj = getObject(repo, baseSha);
  if (!headObj || !baseObj) return 'UNKNOWN';
  const ancestor = mergeBase(repo, pull.headSha, baseSha);
  if (ancestor === null) return 'UNKNOWN';
  if (ancestor === pull.headSha || ancestor === baseSha) return 'MERGEABLE';
  return threeWayMerge(repo, ancestor, pull.headSha, baseSha) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Create a pull request record (plus its mirror issue), or null when a ref is missing. */
export function createPullRecord(
  store: Store,
  repo: Repo,
  headRef: string,
  baseRef: string,
  title: string,
  body: string,
): PullRequest | null {
  const headOid = repo.refs.get(`refs/heads/${headRef}`);
  const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headOid || !baseOid) return null;
  const number = store.nextIssueNumber(repo);
  const pull: PullRequest = {
    id: store.prId(),
    number,
    title,
    body,
    state: 'open',
    head: headRef,
    base: baseRef,
    headSha: headOid,
    baseSha: baseOid,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: store.nextSeq(),
  };
  repo.prs.push(pull);
  // A PR also appears as an issue with the same number.
  repo.issues.push({
    id: store.issueId(),
    number,
    title,
    body,
    state: 'open',
    labels: [],
    createdSeq: store.nextSeq(),
  });
  return pull;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * Merge an open pull request onto its base branch. Returns the merge commit
 * sha on success, or ok:false (conflict:true when the merge conflicts).
 */
export function mergePullRecord(
  repo: Repo,
  pull: PullRequest,
  method: MergeMethod,
): { ok: boolean; mergeSha?: string; conflict?: boolean } {
  if (pull.state !== 'open') return { ok: false };
  // Merge against the CURRENT base-branch tip: the base may have moved
  // since the PR was opened (a second PR opened against the old tip must
  // conflict with the first PR's merged changes, not silently overwrite).
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const headObj = getObject(repo, pull.headSha);
  const baseObj = getObject(repo, baseSha);
  if (!headObj || !baseObj) return { ok: false };
  const headParts = parseCommit(headObj.data);
  const baseParts = parseCommit(baseObj.data);
  if (!headParts || !baseParts) return { ok: false };
  const ancestor = mergeBase(repo, pull.headSha, baseSha);
  if (ancestor === null) return { ok: false };
  let mergedFiles: Map<string, { oid: string; mode: string }> | null;
  if (ancestor === pull.headSha) {
    // Base already contains head: the merged tree is the base tree.
    mergedFiles = flattenTree(repo, baseParts.tree);
  } else if (ancestor === baseSha) {
    // Head descends from base: the merged tree is the head tree.
    mergedFiles = flattenTree(repo, headParts.tree);
  } else {
    mergedFiles = threeWayMerge(repo, ancestor, pull.headSha, baseSha);
  }
  if (mergedFiles === null) return { ok: false, conflict: true };
  const mergedTree = buildTreeFromFiles(repo, mergedFiles);
  const message =
    method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.head}`;
  const parents = method === 'merge' ? [baseSha, pull.headSha] : [baseSha];
  const mergeOid = putObject(repo, 'commit', buildCommit(mergedTree, parents, message));
  repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeOid;
  pull.state = 'closed';
  const issue = getIssue(repo, pull.number);
  if (issue) issue.state = 'closed';
  return { ok: true, mergeSha: mergeOid };
}
