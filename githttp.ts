// Git smart-HTTP handlers: info/refs advertisements, upload-pack (v2 and
// v0), and receive-pack. Implements the wire contract from specs/git-spec.md.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  type Repo,
  type Store,
  ZERO_OID,
  getObject,
  isDescendant,
  parseTag,
} from './store.ts';
import {
  DELIM,
  FLUSH,
  decodePktLines,
  packForPlan,
  parsePack,
  planFetch,
  pktLine,
  pktTextLines,
  sidebandPack,
} from './gitpack.ts';

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

export function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

/** Parse /{owner}/{repo}.git/<rest> — returns null when the path is not a git path. */
export function parseGitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
  if (!m) return null;
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), rest: m[3] };
}

function refLines(repo: Repo): { oid: string; ref: string; peeled?: string }[] {
  const out: { oid: string; ref: string; peeled?: string }[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    const obj = getObject(repo, oid);
    let peeled: string | undefined;
    if (obj && obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag) peeled = tag.object;
    }
    out.push({ oid, ref, peeled });
  }
  return out;
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** v0 advertisement body (with the # service preamble + flush). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', capabilities: string): Buffer {
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const lines = refLines(repo);
  const head = headOid(repo);
  const firstLine = (oid: string, ref: string): Buffer => pktLine(`${oid} ${ref}\0${capabilities}\n`);
  if (lines.length === 0) {
    chunks.push(firstLine(ZERO_OID, 'capabilities^{}'));
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  // HEAD line first (carries the capabilities), then the refs.
  chunks.push(firstLine(head, 'HEAD'));
  for (const l of lines) {
    chunks.push(pktLine(`${l.oid} ${l.ref}\n`));
    if (l.peeled) chunks.push(pktLine(`${l.peeled} ${l.ref}^{}\n`));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

const UPLOAD_V0_CAPS = 'side-band-64k shallow thin-pack ofs-delta symref=HEAD:refs/heads/main';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main';

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack') {
    const proto = req.headers['git-protocol'] ?? '';
    if (String(proto).includes('version=2')) {
      const body = Buffer.concat([
        pktLine('version 2\n'),
        pktLine('fetch=shallow filter\n'),
        pktLine('ls-refs=unborn\n'),
        pktLine('object-format=sha1\n'),
        FLUSH,
      ]);
      sendBuffer(res, 200, UPLOAD_AD_CT, body);
      return;
    }
    sendBuffer(res, 200, UPLOAD_AD_CT, v0Advertisement(repo, 'git-upload-pack', UPLOAD_V0_CAPS));
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, RECEIVE_AD_CT, v0Advertisement(repo, 'git-receive-pack', RECEIVE_CAPS));
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const refs = refLines(repo);
  const want = (ref: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => ref.startsWith(p));
  // HEAD line (with symref-target) when it matches the prefixes (or none).
  const head = headOid(repo);
  if (want('HEAD')) {
    if (head === ZERO_OID) {
      if (args.unborn) lines.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      lines.push(pktLine(`${head} HEAD symref-target:refs/heads/main\n`));
    }
  }
  for (const r of refs) {
    if (!want(r.ref)) continue;
    let line = `${r.oid} ${r.ref}`;
    if (args.peel && r.peeled) line += ` peeled:${r.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  thinPack: boolean;
}

function parseV2Fetch(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, thinPack: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = parseInt(line.slice(7).trim(), 10);
    else if (line === 'thin-pack') args.thinPack = true;
  }
  return args;
}

function fetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.deepen);
  const pack = packForPlan(plan);
  const chunks: Buffer[] = [];
  // Real git (and the protocol) expects the acknowledgments section only
  // when the client sent haves: with no haves the response goes straight to
  // the packfile section, and a git client dies on 'acknowledgments' there.
  if (args.haves.length > 0) {
    chunks.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of args.haves) {
      if (getObject(repo, have)) {
        chunks.push(pktLine(`ACK ${have.toLowerCase()}\n`));
        acked = true;
      }
    }
    if (!acked) chunks.push(pktLine('NAK\n'));
    chunks.push(DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(DELIM);
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(sidebandPack(pack));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

/** v0 fetch response: NAK/shallow text lines, then sideband pack, then flush. */
function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.deepen);
  const pack = packForPlan(plan);
  const chunks: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  chunks.push(sidebandPack(pack));
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let items;
  try {
    items = decodePktLines(body);
  } catch {
    // Malformed pkt-line input: never crash; answer 400 and stay up.
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  // Lines from the items just decoded (pktTextLines would decode again).
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === 'data') lines.push(it.data.toString('utf8').replace(/\n$/, ''));
  }
  const first = lines[0] ?? '';
  const isV2 = req.headers['git-protocol'] !== undefined && String(req.headers['git-protocol']).includes('version=2');
  try {
    if (first.startsWith('command=')) {
      const command = first.slice('command='.length);
      if (command === 'ls-refs') {
        const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        let seenDelim = false;
        for (const line of lines.slice(1)) {
          if (line === '') continue;
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        }
        void seenDelim;
        sendBuffer(res, 200, UPLOAD_RESULT_CT, handleLsRefs(repo, args));
        return;
      }
      if (command === 'fetch') {
        // Arguments start after the delim packet.
        const delimIdx = items.findIndex((it) => it.kind === 'delim');
        const argItems = delimIdx >= 0 ? items.slice(delimIdx + 1) : items.slice(1);
        const argLines: string[] = [];
        for (const it of argItems) {
          if (it.kind === 'data') argLines.push(it.data.toString('utf8').replace(/\n$/, ''));
        }
        const args = parseV2Fetch(argLines);
        sendBuffer(res, 200, UPLOAD_RESULT_CT, fetchResponse(repo, args));
        return;
      }
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    // v0 fetch: two sections separated by flushes (wants, then haves+done).
    const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, thinPack: false };
    for (const line of lines) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim();
        args.wants.push(rest.split(' ')[0]);
        if (rest.includes('thin-pack')) args.thinPack = true;
      } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = parseInt(line.slice(7).trim(), 10);
    }
    void isV2;
    sendBuffer(res, 200, UPLOAD_RESULT_CT, fetchResponseV0(repo, args));
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
  }
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // Split the command list (pkt-lines up to the first flush) from the pack.
  let packStart = body.length;
  let cmdEnd = body.length;
  try {
    let i = 0;
    while (i + 4 <= body.length) {
      const len = parseInt(body.subarray(i, i + 4).toString('utf8'), 16);
      if (Number.isNaN(len) || len < 0) break;
      if (len === 0) {
        cmdEnd = i;
        packStart = i + 4;
        break;
      }
      i += len;
    }
  } catch {
    // fall through with an empty command list
  }
  const cmdBuf = body.subarray(0, cmdEnd);
  const commands: PushCommand[] = [];
  try {
    for (const line of pktTextLines(cmdBuf)) {
      if (line === '') continue;
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const parts = clean.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0].toLowerCase(), newOid: parts[1].toLowerCase(), ref: parts[2] });
    }
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }

  // Unpack first (objects are stored even when a ref update is refused).
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const entries = parsePack(packBytes, (oid) => getObject(repo, oid));
      for (const [oid, entry] of entries) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: entry.type, data: entry.data });
      }
    } catch {
      // A corrupt pack: report unpack failure rather than crashing.
      const inner = Buffer.concat([pktLine('unpack unpack failed\n'), FLUSH]);
      const framed = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
      sendBuffer(res, 200, RECEIVE_RESULT_CT, framed);
      return;
    }
  }

  // Apply ref updates per command (per-ref atomicity, not all-or-nothing).
  const reportLines: string[] = ['unpack ok'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      // Create.
      if (cmd.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else if (!getObject(repo, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    // Update: old must match and new must descend from old.
    if (cmd.oldOid !== current) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    if (!isDescendant(repo, cmd.newOid, current)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }

  // The report is a pkt-line stream (one pkt-line per line, ending with an
  // inner flush) carried as sideband band-1 data — exactly how git's own
  // receive-pack builds it — and the outer stream ends with a flush too.
  const inner = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), FLUSH]);
  const bodyOut = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
  sendBuffer(res, 200, RECEIVE_RESULT_CT, bodyOut);
}

export { DEFAULT_BRANCH };
