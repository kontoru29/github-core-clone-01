// HTTP router: auth, git smart-HTTP, REST v3, GraphQL, MCP, /healthz.
// All API surfaces require a Bearer token (MAKEFUN_SHOP_TOKEN) except
// /healthz. Every REST reply carries X-GitHub-Request-Id (see rest.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack, parseGitPath, sendJson } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';
import {
  restCreateBlob,
  restCreateCommit,
  restCreateIssue,
  restCreateIssueComment,
  restCreateLabel,
  restCreateOrgRepo,
  restCreatePull,
  restCreateRef,
  restCreateTag,
  restCreateTree,
  restCreateUserRepo,
  restDeleteContents,
  restDeleteLabel,
  restDeleteRef,
  restDeleteRepo,
  restGetBlob,
  restGetBranch,
  restGetCommit,
  restGetContents,
  restGetIssue,
  restGetLabel,
  restGetPull,
  restGetRef,
  restGetRepo,
  restGetTag,
  restGetTree,
  restListBranches,
  restListCommits,
  restListIssueComments,
  restListIssues,
  restListLabels,
  restListMatchingRefs,
  restListPullCommits,
  restListPullFiles,
  restListPulls,
  restListReposForUser,
  restMergePull,
  restMeta,
  restOrgRepos,
  restPatchRepo,
  restPutContents,
  restRateLimit,
  restRoot,
  restSearch,
  restUpdateIssue,
  restUpdatePull,
  restUpdateRef,
  restUser,
  restUserByLogin,
  restUserRepos,
  type Handler,
  type RestCtx,
} from './rest.ts';
import type { Store } from './store.ts';
import { Store, VIEWER_LOGIN } from './store.ts';

export interface AppDeps {
  store: Store;
  token: string;
  viewer: string;
}

interface Route {
  method: string;
  pattern: RegExp;
  params: string[];
  handler: Handler;
}

function route(method: string, template: string, handler: Handler): Route {
  const params: string[] = [];
  const parts = template.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      const name = seg.slice(1);
      params.push(name);
      // Refs, branches and content paths may contain slashes (heads/main,
      // feature/foo, docs/a/b.txt), so those params match across segments.
      return name === 'ref' || name === 'path' || name === 'branch' ? '(.*)' : '([^/]+)';
    }
    if (seg === '*') {
      params.push('rest');
      return '(.*)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { method, pattern: new RegExp(`^${parts.join('/')}$`), params, handler };
}

const ROUTES: Route[] = [
  route('GET', '/api/v3', restRoot),
  route('GET', '/api/v3/', restRoot),
  route('GET', '/api/v3/meta', restMeta),
  route('GET', '/api/v3/rate_limit', restRateLimit),
  route('GET', '/api/v3/user', restUser),
  route('GET', '/api/v3/user/repos', restUserRepos),
  route('POST', '/api/v3/user/repos', restCreateUserRepo),
  route('GET', '/api/v3/users/:username', restUserByLogin),
  route('GET', '/api/v3/users/:username/repos', restListReposForUser),
  route('GET', '/api/v3/orgs/:org/repos', restOrgRepos),
  route('POST', '/api/v3/orgs/:org/repos', restCreateOrgRepo),
  route('GET', '/api/v3/search/:kind', restSearch),
  route('GET', '/api/v3/repos/:owner/:repo', restGetRepo),
  route('PATCH', '/api/v3/repos/:owner/:repo', restPatchRepo),
  route('DELETE', '/api/v3/repos/:owner/:repo', restDeleteRepo),
  route('GET', '/api/v3/repos/:owner/:repo/branches', restListBranches),
  route('GET', '/api/v3/repos/:owner/:repo/branches/:branch', restGetBranch),
  route('GET', '/api/v3/repos/:owner/:repo/git/refs/:ref', restGetRef),
  route('GET', '/api/v3/repos/:owner/:repo/git/matching-refs/:ref', restListMatchingRefs),
  route('POST', '/api/v3/repos/:owner/:repo/git/refs', restCreateRef),
  route('PATCH', '/api/v3/repos/:owner/:repo/git/refs/:ref', restUpdateRef),
  route('DELETE', '/api/v3/repos/:owner/:repo/git/refs/:ref', restDeleteRef),
  route('GET', '/api/v3/repos/:owner/:repo/commits', restListCommits),
  route('GET', '/api/v3/repos/:owner/:repo/commits/:sha', restGetCommit),
  route('POST', '/api/v3/repos/:owner/:repo/git/blobs', restCreateBlob),
  route('GET', '/api/v3/repos/:owner/:repo/git/blobs/:sha', restGetBlob),
  route('POST', '/api/v3/repos/:owner/:repo/git/trees', restCreateTree),
  route('GET', '/api/v3/repos/:owner/:repo/git/trees/:sha', restGetTree),
  route('POST', '/api/v3/repos/:owner/:repo/git/commits', restCreateCommit),
  route('POST', '/api/v3/repos/:owner/:repo/git/tags', restCreateTag),
  route('GET', '/api/v3/repos/:owner/:repo/git/tags/:sha', restGetTag),
  route('GET', '/api/v3/repos/:owner/:repo/contents', restGetContents),
  route('GET', '/api/v3/repos/:owner/:repo/contents/:path', restGetContents),
  route('PUT', '/api/v3/repos/:owner/:repo/contents/:path', restPutContents),
  route('DELETE', '/api/v3/repos/:owner/:repo/contents/:path', restDeleteContents),
  route('GET', '/api/v3/repos/:owner/:repo/labels', restListLabels),
  route('POST', '/api/v3/repos/:owner/:repo/labels', restCreateLabel),
  route('GET', '/api/v3/repos/:owner/:repo/labels/:name', restGetLabel),
  route('DELETE', '/api/v3/repos/:owner/:repo/labels/:name', restDeleteLabel),
  route('GET', '/api/v3/repos/:owner/:repo/issues', restListIssues),
  route('POST', '/api/v3/repos/:owner/:repo/issues', restCreateIssue),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number', restGetIssue),
  route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', restUpdateIssue),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', restListIssueComments),
  route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', restCreateIssueComment),
  route('GET', '/api/v3/repos/:owner/:repo/pulls', restListPulls),
  route('POST', '/api/v3/repos/:owner/:repo/pulls', restCreatePull),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', restGetPull),
  route('PATCH', '/api/v3/repos/:owner/:repo/pulls/:number', restUpdatePull),
  route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', restMergePull),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/commits', restListPullCommits),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', restListPullFiles),
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let appRequestSeq = 0;

/** Every JSON reply the router itself sends carries X-GitHub-Request-Id. */
function sendAppJson(res: ServerResponse, status: number, body: unknown): void {
  appRequestSeq += 1;
  sendJson(res, status, body, { 'x-github-request-id': `req_${appRequestSeq.toString(16).padStart(8, '0')}` });
}

function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  return JSON.parse(raw.toString('utf8'));
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port.
 * Deps default to a fresh store, the shop token from the environment, and the
 * scenario viewer, so main.ts can call createApp() with no arguments. */
export function createApp(deps: Partial<AppDeps> = {}): Server {
  const store = deps.store ?? new Store();
  const token = deps.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const viewer = deps.viewer ?? VIEWER_LOGIN;
  const ctx: RestCtx = { store, viewer };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      // /healthz is unauthenticated.
      if (path === '/healthz' && method === 'GET') {
        sendAppJson(res, 200, { ok: true });
        return;
      }

      // Auth: every other route needs the shop token.
      const auth = req.headers.authorization ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (bearer !== token) {
        sendAppJson(res, 401, { message: 'Bad credentials' });
        return;
      }

      // Git smart HTTP.
      const git = parseGitPath(path);
      if (git) {
        if (git.rest === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service') ?? '';
          handleInfoRefs(req, res, store, git.owner, git.repo, service);
          return;
        }
        if (git.rest === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          handleUploadPack(req, res, store, git.owner, git.repo, body);
          return;
        }
        if (git.rest === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          handleReceivePack(req, res, store, git.owner, git.repo, body);
          return;
        }
        sendAppJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL.
      if (path === '/api/graphql' && method === 'POST') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = parseJsonBody(raw);
        } catch {
          sendAppJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
          return;
        }
        if (Array.isArray(body)) {
          // Batched operations: one result per operation, in order.
          const results = body.map((op) => executeGraphQL(ctx, op));
          sendAppJson(res, 200, results);
          return;
        }
        sendAppJson(res, 200, executeGraphQL(ctx, body));
        return;
      }

      // MCP.
      if (path === '/mcp' && method === 'POST') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = parseJsonBody(raw);
        } catch {
          sendAppJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        const { status, payload } = handleMcpBody({ store, viewer }, body);
        if (status === 202) {
          res.writeHead(202);
          res.end();
          return;
        }
        sendAppJson(res, status, payload);
        return;
      }

      // REST v3.
      if (path.startsWith('/api/v3')) {
        for (const r of ROUTES) {
          if (r.method !== method) continue;
          const m = r.pattern.exec(path);
          if (!m) continue;
          const params: Record<string, string> = {};
          r.params.forEach((name, i) => {
            params[name] = decodeURIComponent(m[i + 1]);
          });
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = parseJsonBody(raw);
              } catch {
                sendAppJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          r.handler(ctx, req, res, params, body, url.searchParams);
          return;
        }
        sendAppJson(res, 404, { message: 'Not Found' });
        return;
      }

      sendAppJson(res, 404, { message: 'Not Found' });
    } catch (e) {
      // Never crash the process on a bad request.
      if (!res.headersSent) sendAppJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' });
      else res.end();
    }
  });
}
