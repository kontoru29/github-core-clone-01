// REST v3 API surface, per specs/api-spec.md section 2 and the kit checks.
// All replies are application/json, carry X-GitHub-Request-Id, and use the
// exact status codes and bodies the checks expect. Built on the real store
// API (store.ts): Issue/PullRequest/Comment shapes, labels as name->color,
// global ids via globalId(kind, ...parts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Comment,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
  buildCommit,
  buildTreeFromFiles,
  createPullRecord,
  flattenTree,
  getIssue,
  getObject,
  getPr,
  globalId,
  isDescendant,
  mergePullRecord,
  parseCommit,
  parseTree,
  prMergeable,
  putObject,
  walkHistory,
  sha1Of,
  stableId,
} from './store.ts';
import { sendJson } from './githttp.ts';

let requestSeq = 0;

function reqId(): string {
  requestSeq += 1;
  return `req_${requestSeq.toString(16).padStart(8, '0')}`;
}

export interface RestCtx {
  store: Store;
  /** The viewer (from the token) — always adaiversen in practice. */
  viewer: string;
}

export type Handler = (ctx: RestCtx, req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: unknown, query: URLSearchParams) => void;

function ok(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(res, status, body, { 'x-github-request-id': reqId(), ...extra });
}

function err(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message }, { 'x-github-request-id': reqId() });
}

/** Parse page/per_page (defaults 1/30) and clamp per_page to [1,100]. */
export function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  let perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
  perPage = Math.min(100, Math.max(1, perPage));
  return { page, perPage };
}

/** The request's own origin (http://host:port), for absolute Link URLs. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

/** Slice a list and build the Link header (next/last/prev/first). Links are
 * absolute URLs: clients resolve `rel="next"` against its origin. */
export function paginate<T>(items: T[], page: number, perPage: number, baseUrl: string, extraQuery: string, origin = ''): { slice: T[]; link: string } {
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  const urlFor = (p: number): string => `<${origin}${baseUrl}?${extraQuery ? `${extraQuery}&` : ''}per_page=${perPage}&page=${p}>`;
  if (page < lastPage) parts.push(`${urlFor(page + 1)}; rel="next"`);
  if (page < lastPage) parts.push(`${urlFor(lastPage)}; rel="last"`);
  if (page > 1) parts.push(`${urlFor(page - 1)}; rel="prev"`);
  if (page > 1) parts.push(`${urlFor(1)}; rel="first"`);
  return { slice, link: parts.join(', ') };
}

/** Split a git ident "Name <email> epoch tz" into its parts. */
function parseIdent(ident: string): { name: string; email: string; date: string } {
  const m = ident.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: ident, email: '', date: FIXED_ISO };
  return { name: m[1], email: m[2], date: FIXED_ISO };
}

function repoJson(repo: Repo, owner: string): Record<string, unknown> {
  const name = repo.name;
  return {
    id: repo.id,
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner, id: owner === VIEWER_LOGIN ? VIEWER_ID : 1001, type: owner === 'faint-meadow-org' ? 'Organization' : 'User', avatar_url: `https://github.com/${owner}.png` },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    git_url: `git://github.com/${owner}/${name}.git`,
    ssh_url: `git@github.com:${owner}/${name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
  };
}

function userJson(login: string): Record<string, unknown> {
  const id = login === VIEWER_LOGIN ? VIEWER_ID : 1001;
  const name = login === VIEWER_LOGIN ? VIEWER_NAME : login;
  return {
    login,
    id,
    avatar_url: `https://github.com/${login}.png`,
    html_url: `https://github.com/${login}`,
    type: login === 'faint-meadow-org' ? 'Organization' : 'User',
    name,
    email: login === VIEWER_LOGIN ? VIEWER_EMAIL : null,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: stableId(`${repo.id}:${name}`),
    node_id: globalId('Label', repo.id, name),
    name,
    color: label?.color ?? 'ededed',
    description: '',
    url: `/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    default: false,
  };
}

function issueJson(issue: Issue, repo: Repo, owner: string): Record<string, unknown> {
  const pr = getPr(repo, issue.number);
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(VIEWER_LOGIN),
    labels: issue.labels.map((l) => labelJson(repo, l)),
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/repos/${owner}/${repo.name}`,
    ...(pr ? { pull_request: { url: `/repos/${owner}/${repo.name}/pulls/${issue.number}` } } : {}),
  };
}

function pullJson(pull: PullRequest, repo: Repo, owner: string): Record<string, unknown> {
  const mergeable = prMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(VIEWER_LOGIN),
    head: { ref: pull.head, sha: pull.headSha, label: `${owner}:${pull.head}`, repo: repoJson(repo, owner) },
    base: { ref: pull.base, sha: pull.baseSha, label: `${owner}:${pull.base}`, repo: repoJson(repo, owner) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    mergeable: mergeable === 'MERGEABLE',
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    merge_commit_sha: pull.mergeCommitSha,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}.patch`,
    labels: [],
    assignees: [],
    requested_reviewers: [],
  };
}

function commentJson(comment: Comment, repo: Repo, owner: string, number: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, number, comment.id),
    body: comment.body,
    user: userJson(VIEWER_LOGIN),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    url: `/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return null;
  const parts = parseCommit(obj.data);
  if (!parts) return null;
  const author = parseIdent(parts.author);
  const committer = parseIdent(parts.committer);
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: parts.message,
      tree: { sha: parts.tree, url: `/repos/x/y/git/trees/${parts.tree}` },
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: parts.parents.map((p) => ({ sha: p, url: `/repos/x/y/git/commits/${p}` })),
    html_url: '',
    url: `/repos/x/y/git/commits/${oid}`,
  };
}

/** Find a repo or reply 404. Returns null after replying. */
function needRepo(ctx: RestCtx, res: ServerResponse, owner: string, repoName: string): Repo | null {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    err(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function requireFields(res: ServerResponse, body: unknown, fields: string[]): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    err(res, 422, 'Validation Failed');
    return null;
  }
  const b = body as Record<string, unknown>;
  for (const f of fields) {
    if (b[f] === undefined || b[f] === null || (typeof b[f] === 'string' && b[f].length === 0)) {
      err(res, 422, 'Validation Failed');
      return null;
    }
  }
  return b;
}

function knownLogin(ctx: RestCtx, login: string): boolean {
  if (login === VIEWER_LOGIN || login === 'faint-meadow-org') return true;
  return ctx.store.repos.some((r) => r.owner === login);
}

const MIT_LICENSE = `SPDX-License-Identifier: MIT

MIT License

Copyright (c) 2026 the make.fun team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** Create the initial commit for auto_init repos (README, optional MIT LICENSE). */
function autoInitRepo(ctx: RestCtx, repo: Repo, licenseTemplate?: string): void {
  const files = new Map<string, { oid: string; mode: string }>();
  const readmeOid = putObject(repo, 'blob', Buffer.from(`# ${repo.name}\n`, 'utf8'));
  files.set('README.md', { oid: readmeOid, mode: '100644' });
  if (licenseTemplate === 'mit') {
    const licOid = putObject(repo, 'blob', Buffer.from(MIT_LICENSE, 'utf8'));
    files.set('LICENSE', { oid: licOid, mode: '100644' });
  }
  const treeOid = buildTreeFromFiles(repo, files);
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, [], 'Initial commit'));
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
}

// ---------------------------------------------------------------------------
// Root / meta / user / rate_limit
// ---------------------------------------------------------------------------

export const restRoot: Handler = (ctx, _req, res) => {
  void ctx;
  ok(res, 200, {
    current_user_url: '/api/v3/user',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    emojis_url: '/api/v3/emojis',
    user_search_url: '/api/v3/search/users?q={query}',
    rate_limit_url: '/api/v3/rate_limit',
    repository_search_url: '/api/v3/search/repositories?q={query}',
    code_search_url: '/api/v3/search/code?q={query}',
    issue_search_url: '/api/v3/search/issues?q={query}',
    user_url: '/api/v3/users/{user}',
    authorizations_url: '/api/v3/authorizations',
    organization_url: '/api/v3/orgs/{org}',
  }, { 'x-oauth-scopes': 'repo, read:org' });
};

export const restMeta: Handler = (ctx, _req, res) => {
  void ctx;
  ok(res, 200, {
    verifiable_password_authentication: true,
    installed_version: '1.0.0',
    hooks: ['127.0.0.1/32'],
    git: ['127.0.0.1/32'],
    github_enterprise_importer: ['127.0.0.1/32'],
    pages: ['127.0.0.1/32'],
    importer: ['127.0.0.1/32'],
    actions: ['127.0.0.1/32'],
    dependabot: ['127.0.0.1/32'],
    api: ['127.0.0.1/32'],
    domains: { website: ['example.invalid'], artifacts: ['example.invalid'] },
  });
};

export const restRateLimit: Handler = (ctx, _req, res) => {
  void ctx;
  ok(res, 200, {
    resources: {
      core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 },
      search: { limit: 30, remaining: 30, reset: 1735689600, used: 0 },
      graphql: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 },
      integration_manifest: { limit: 5000, remaining: 5000, reset: 1735689600, used: 0 },
    },
    rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 },
  });
};

export const restUser: Handler = (ctx, _req, res) => {
  ok(res, 200, userJson(ctx.viewer));
};

export const restUserByLogin: Handler = (ctx, _req, res, params) => {
  const login = params.login;
  if (!knownLogin(ctx, login)) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, userJson(login));
};

export const restUserRepos: Handler = (ctx, _req, res, _params, _body, query) => {
  const { page, perPage } = parsePagination(query);
  const repos = ctx.store.listRepos(ctx.viewer).sort((a, b) => a.name.localeCompare(b.name));
  const { slice, link } = paginate(repos, page, perPage, '/api/v3/user/repos', '', originOf(_req));
  ok(res, 200, slice.map((r) => repoJson(r, r.owner)), link ? { link } : {});
};

export const restOrgRepos: Handler = (ctx, _req, res, params, _body, query) => {
  const org = params.org;
  if (org !== 'faint-meadow-org' && !ctx.store.repos.some((r) => r.owner === org)) {
    err(res, 404, 'Not Found');
    return;
  }
  const { page, perPage } = parsePagination(query);
  const repos = ctx.store.listRepos(org).sort((a, b) => a.name.localeCompare(b.name));
  const { slice, link } = paginate(repos, page, perPage, `/api/v3/orgs/${org}/repos`, '', originOf(_req));
  ok(res, 200, slice.map((r) => repoJson(r, r.owner)), link ? { link } : {});
};

function createRepoHandler(ctx: RestCtx, res: ServerResponse, owner: string, body: unknown): void {
  const b = requireFields(res, body, ['name']);
  if (!b) return;
  const name = String(b.name);
  const repo = ctx.store.createRepo(owner, name, typeof b.description === 'string' ? b.description : '', b.private === true);
  if (!repo) {
    // GitHub's duplicate-name 422, whose body the kit's git client matches
    // on "already exists" before treating a re-create as success.
    ok(res, 422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
    return;
  }
  if (typeof b.default_branch === 'string' && b.default_branch.length > 0) repo.defaultBranch = b.default_branch;
  if (b.auto_init === true) {
    autoInitRepo(ctx, repo, typeof b.license_template === 'string' ? b.license_template : undefined);
  }
  ok(res, 201, repoJson(repo, owner));
}

export const restCreateUserRepo: Handler = (ctx, _req, res, _params, body) => {
  createRepoHandler(ctx, res, ctx.viewer, body);
};

export const restCreateOrgRepo: Handler = (ctx, _req, res, params, body) => {
  const org = params.org;
  if (org !== 'faint-meadow-org' && !ctx.store.repos.some((r) => r.owner === org)) {
    err(res, 404, 'Not Found');
    return;
  }
  createRepoHandler(ctx, res, org, body);
};

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export const restGetRepo: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  ok(res, 200, repoJson(repo, params.owner));
};

export const restDeleteRepo: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  ctx.store.deleteRepo(repo);
  res.writeHead(204, { 'x-github-request-id': reqId() });
  res.end();
};

export const restPatchRepo: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name === 'string' && b.name.length > 0 && b.name !== repo.name) {
    if (ctx.store.getRepo(params.owner, b.name)) {
      err(res, 422, 'Validation Failed');
      return;
    }
    repo.name = b.name;
  }
  if (typeof b.description === 'string' || b.description === null) repo.description = b.description === null ? '' : b.description;
  if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
  if (typeof b.private === 'boolean') repo.private = b.private;
  ok(res, 200, repoJson(repo, params.owner));
};

export const restListReposForUser: Handler = (ctx, _req, res, params, _body, query) => {
  if (!knownLogin(ctx, params.username)) {
    err(res, 404, 'Not Found');
    return;
  }
  const { page, perPage } = parsePagination(query);
  const repos = ctx.store.listRepos(params.username).sort((a, b) => a.name.localeCompare(b.name));
  const { slice, link } = paginate(repos, page, perPage, `/api/v3/users/${params.username}/repos`, '', originOf(_req));
  ok(res, 200, slice.map((r) => repoJson(r, r.owner)), link ? { link } : {});
};

// ---------------------------------------------------------------------------
// git/refs, git/commits, git/trees, git/blobs, git/tags
// ---------------------------------------------------------------------------

export const restListMatchingRefs: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const refPrefix = `refs/${params.ref}`;
  const matches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith(refPrefix))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (matches.length === 0) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, matches.map(([ref, oid]) => ({
    ref,
    node_id: globalId('Ref', repo.id, ref),
    url: `/repos/${params.owner}/${params.repo}/git/refs/${ref.slice(5)}`,
    object: { sha: oid, type: getObject(repo, oid)?.type ?? 'commit', url: `/repos/${params.owner}/${params.repo}/git/commits/${oid}` },
  })));
};

export const restGetRef: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const ref = `refs/${params.ref}`;
  const oid = repo.refs.get(ref);
  if (!oid) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, {
    ref,
    node_id: globalId('Ref', repo.id, ref),
    url: `/repos/${params.owner}/${params.repo}/git/refs/${params.ref}`,
    object: { sha: oid, type: getObject(repo, oid)?.type ?? 'commit', url: `/repos/${params.owner}/${params.repo}/git/commits/${oid}` },
  });
};

export const restCreateRef: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const b = requireFields(res, body, ['ref', 'sha']);
  if (!b) return;
  const ref = String(b.ref);
  const sha = String(b.sha);
  if (!ref.startsWith('refs/')) {
    err(res, 422, 'Validation Failed');
    return;
  }
  if (!getObject(repo, sha)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  if (repo.refs.has(ref)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  repo.refs.set(ref, sha);
  ok(res, 201, {
    ref,
    node_id: globalId('Ref', repo.id, ref),
    url: `/repos/${params.owner}/${params.repo}/git/refs/${ref.slice(5)}`,
    object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: `/repos/${params.owner}/${params.repo}/git/commits/${sha}` },
  });
};

export const restUpdateRef: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const ref = `refs/${params.ref}`;
  const current = repo.refs.get(ref);
  if (!current) {
    err(res, 404, 'Not Found');
    return;
  }
  const b = requireFields(res, body, ['sha']);
  if (!b) return;
  const sha = String(b.sha);
  if (!getObject(repo, sha)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const force = b.force === true;
  if (!force && !isDescendant(repo, sha, current)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  repo.refs.set(ref, sha);
  ok(res, 200, {
    ref,
    node_id: globalId('Ref', repo.id, ref),
    url: `/repos/${params.owner}/${params.repo}/git/refs/${params.ref}`,
    object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: `/repos/${params.owner}/${params.repo}/git/commits/${sha}` },
  });
};

export const restDeleteRef: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const ref = `refs/${params.ref}`;
  if (!repo.refs.has(ref)) {
    err(res, 404, 'Not Found');
    return;
  }
  repo.refs.delete(ref);
  res.writeHead(204, { 'x-github-request-id': reqId() });
  res.end();
};

export const restListBranches: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const { page, perPage } = parsePagination(query);
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ref, oid]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid, url: `/repos/${params.owner}/${params.repo}/git/commits/${oid}` },
      protected: false,
    }));
  const { slice, link } = paginate(branches, page, perPage, `/api/v3/repos/${params.owner}/${params.repo}/branches`, '', originOf(_req));
  ok(res, 200, slice, link ? { link } : {});
};

export const restGetBranch: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const oid = repo.refs.get(`refs/heads/${params.branch}`);
  if (!oid) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, {
    name: params.branch,
    commit: { sha: oid, url: `/repos/${params.owner}/${params.repo}/git/commits/${oid}` },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
  });
};

export const restGetCommit: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const c = commitJson(repo, params.sha);
  if (!c) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, c);
};

export const restListCommits: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const { page, perPage } = parsePagination(query);
  const sha = query.get('sha');
  // `sha` may be a branch name, a tag name, or a raw commit oid.
  const startOid = sha
    ? (repo.refs.get(`refs/heads/${sha}`) ?? repo.refs.get(`refs/tags/${sha}`) ?? (repo.objects.has(sha.toLowerCase()) ? sha.toLowerCase() : undefined))
    : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const out: Record<string, unknown>[] = [];
  if (startOid) {
    for (const oid of walkHistory(repo, startOid)) {
      const c = commitJson(repo, oid);
      if (c) out.push(c);
    }
  }
  const { slice, link } = paginate(out, page, perPage, `/api/v3/repos/${params.owner}/${params.repo}/commits`, sha ? `sha=${encodeURIComponent(sha)}` : '', originOf(_req));
  ok(res, 200, slice, link ? { link } : {});
};

export const restCreateBlob: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const b = requireFields(res, body, ['content']);
  if (!b) return;
  const content = String(b.content);
  const encoding = b.encoding === 'base64' ? 'base64' : 'utf-8';
  const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
  const oid = putObject(repo, 'blob', data);
  ok(res, 201, {
    sha: oid,
    url: `/repos/${params.owner}/${params.repo}/git/blobs/${oid}`,
    size: data.length,
  });
};

export const restGetBlob: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const obj = getObject(repo, params.sha);
  if (!obj) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, {
    sha: params.sha,
    node_id: globalId('Blob', params.sha),
    size: obj.data.length,
    url: `/repos/${params.owner}/${params.repo}/git/blobs/${params.sha}`,
    content: obj.data.toString('base64'),
    encoding: 'base64',
  });
};

export const restCreateTree: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.tree)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const baseTree = typeof b.base_tree === 'string' ? b.base_tree : undefined;
  const flat = new Map<string, { mode: string; oid: string }>();
  if (baseTree) {
    const base = getObject(repo, baseTree);
    if (base && base.type === 'tree') {
      for (const [path, entry] of flattenTree(repo, baseTree)) flat.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  for (const entry of b.tree as Record<string, unknown>[]) {
    if (typeof entry.path !== 'string' || typeof entry.sha !== 'string') {
      err(res, 422, 'Validation Failed');
      return;
    }
    if (!getObject(repo, entry.sha)) {
      err(res, 422, 'Validation Failed');
      return;
    }
    const mode = typeof entry.mode === 'string' ? entry.mode : '100644';
    flat.set(entry.path, { mode, oid: entry.sha });
  }
  const treeOid = buildTreeFromFiles(repo, flat);
  ok(res, 201, {
    sha: treeOid,
    url: `/repos/${params.owner}/${params.repo}/git/trees/${treeOid}`,
    tree: [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([path, e]) => ({
      path,
      mode: e.mode,
      type: e.mode === '40000' ? 'tree' : 'blob',
      sha: e.oid,
      url: `/repos/${params.owner}/${params.repo}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.oid}`,
    })),
    truncated: false,
  });
};

export const restGetTree: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const recursive = query.get('recursive') === '1';
  const obj = getObject(repo, params.sha);
  if (!obj || obj.type !== 'tree') {
    err(res, 404, 'Not Found');
    return;
  }
  if (recursive) {
    const flat = flattenTree(repo, params.sha);
    const tree = [...flat.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([path, e]) => ({
        path,
        mode: e.mode,
        type: 'blob',
        sha: e.oid,
        size: getObject(repo, e.oid)?.data.length,
        url: `/repos/${params.owner}/${params.repo}/git/blobs/${e.oid}`,
      }));
    ok(res, 200, { sha: params.sha, url: `/repos/${params.owner}/${params.repo}/git/trees/${params.sha}`, tree, truncated: false });
    return;
  }
  const tree = parseTree(obj.data).map((e) => ({
    path: e.name,
    mode: e.mode,
    type: e.mode === '40000' ? 'tree' : 'blob',
    sha: e.oid,
    size: e.mode === '40000' ? undefined : getObject(repo, e.oid)?.data.length,
    url: `/repos/${params.owner}/${params.repo}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.oid}`,
  }));
  ok(res, 200, { sha: params.sha, url: `/repos/${params.owner}/${params.repo}/git/trees/${params.sha}`, tree, truncated: false });
};

export const restCreateCommit: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const b = requireFields(res, body, ['message', 'tree']);
  if (!b) return;
  const tree = String(b.tree);
  if (!getObject(repo, tree)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const parents = Array.isArray(b.parents) ? b.parents.map(String) : [];
  for (const p of parents) {
    if (!getObject(repo, p)) {
      err(res, 422, 'Validation Failed');
      return;
    }
  }
  const oid = putObject(repo, 'commit', buildCommit(tree, parents, String(b.message)));
  const c = commitJson(repo, oid);
  ok(res, 201, c ?? { sha: oid });
};

export const restCreateTag: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const b = requireFields(res, body, ['tag', 'message', 'object', 'type']);
  if (!b) return;
  const object = String(b.object);
  if (!getObject(repo, object)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const tagger = (b.tagger as Record<string, string> | undefined) ?? {};
  const lines = [
    `object ${object}`,
    `type ${b.type}`,
    `tag ${b.tag}`,
    `tagger ${tagger.name ?? VIEWER_NAME} <${tagger.email ?? VIEWER_EMAIL}> 1735689600 +0000`,
    '',
    String(b.message),
  ];
  const data = Buffer.from(lines.join('\n'), 'utf8');
  const oid = putObject(repo, 'tag', data);
  ok(res, 201, {
    node_id: globalId('Tag', oid),
    tag: b.tag,
    sha: oid,
    url: `/repos/${params.owner}/${params.repo}/git/tags/${oid}`,
    message: b.message,
    object: { type: b.type, sha: object, url: `/repos/${params.owner}/${params.repo}/git/commits/${object}` },
    tagger: { name: tagger.name ?? VIEWER_NAME, email: tagger.email ?? VIEWER_EMAIL, date: FIXED_ISO },
  });
};

export const restGetTag: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const obj = getObject(repo, params.sha);
  if (!obj || obj.type !== 'tag') {
    err(res, 404, 'Not Found');
    return;
  }
  const text = obj.data.toString('utf8');
  const mObj = text.match(/^object ([0-9a-f]{40})$/m);
  const mType = text.match(/^type (\w+)$/m);
  const mTag = text.match(/^tag (.+)$/m);
  const mTagger = text.match(/^tagger (.*?) <(.*?)> /m);
  const sep = text.indexOf('\n\n');
  const message = sep >= 0 ? text.slice(sep + 2) : '';
  if (!mObj || !mType || !mTag) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, {
    node_id: globalId('Tag', params.sha),
    tag: mTag[1],
    sha: params.sha,
    url: `/repos/${params.owner}/${params.repo}/git/tags/${params.sha}`,
    message,
    object: { type: mType[1], sha: mObj[1], url: `/repos/${params.owner}/${params.repo}/git/commits/${mObj[1]}` },
    tagger: { name: mTagger?.[1] ?? VIEWER_NAME, email: mTagger?.[2] ?? VIEWER_EMAIL, date: FIXED_ISO },
  });
};

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

export const restGetContents: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const path = params.path ?? '';
  const refName = query.get('ref');
  let commitOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refName) {
    commitOid =
      repo.refs.get(`refs/heads/${refName}`) ??
      repo.refs.get(`refs/tags/${refName}`) ??
      repo.refs.get(refName) ??
      (getObject(repo, refName) ? refName : undefined);
  }
  if (!commitOid) {
    err(res, 404, 'Not Found');
    return;
  }
  const commitObj = getObject(repo, commitOid);
  if (!commitObj || commitObj.type !== 'commit') {
    err(res, 404, 'Not Found');
    return;
  }
  const parts = parseCommit(commitObj.data);
  if (!parts) {
    err(res, 404, 'Not Found');
    return;
  }
  const flat = flattenTree(repo, parts.tree);
  const fileEntry = (p: string, e: { mode: string; oid: string }): Record<string, unknown> => ({
    type: e.mode === '40000' ? 'dir' : 'file',
    name: p.split('/').pop() ?? p,
    path: p,
    sha: e.oid,
    size: e.mode === '40000' ? 0 : getObject(repo, e.oid)?.data.length ?? 0,
    url: `/repos/${params.owner}/${params.repo}/contents/${p}`,
    html_url: `https://github.com/${params.owner}/${params.repo}/blob/${repo.defaultBranch}/${p}`,
    git_url: `/repos/${params.owner}/${params.repo}/git/blobs/${e.oid}`,
    download_url: `https://raw.githubusercontent.com/${params.owner}/${params.repo}/${repo.defaultBranch}/${p}`,
  });
  if (path === '') {
    const top = new Map<string, { mode: string; oid: string }>();
    for (const [p, e] of flat) {
      const first = p.split('/')[0];
      if (!top.has(first)) top.set(first, e);
    }
    ok(res, 200, [...top.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, e]) => fileEntry(name, e)));
    return;
  }
  const entry = flat.get(path);
  if (entry && entry.mode !== '40000') {
    const blob = getObject(repo, entry.oid);
    if (!blob) {
      err(res, 404, 'Not Found');
      return;
    }
    ok(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: blob.data.toString('base64'),
      sha: entry.oid,
      url: `/repos/${params.owner}/${params.repo}/contents/${path}`,
      html_url: `https://github.com/${params.owner}/${params.repo}/blob/${repo.defaultBranch}/${path}`,
      git_url: `/repos/${params.owner}/${params.repo}/git/blobs/${entry.oid}`,
      download_url: `https://raw.githubusercontent.com/${params.owner}/${params.repo}/${repo.defaultBranch}/${path}`,
    });
    return;
  }
  const prefix = `${path}/`;
  const children = new Map<string, { mode: string; oid: string }>();
  for (const [p, e] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0];
    if (!children.has(first)) children.set(first, e);
  }
  if (children.size === 0) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, e]) => fileEntry(`${path}/${name}`, e)));
};

function contentsWrite(ctx: RestCtx, res: ServerResponse, params: Record<string, string>, body: unknown, isDelete: boolean): void {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const path = params.path ?? '';
  if (path === '') {
    err(res, 422, 'Validation Failed');
    return;
  }
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') {
    err(res, 422, 'Validation Failed');
    return;
  }
  const message = typeof b.message === 'string' ? b.message : null;
  if (!message) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const currentOid = repo.refs.get(ref);
  const currentCommit = currentOid ? getObject(repo, currentOid) : undefined;
  const currentParts = currentCommit?.type === 'commit' ? parseCommit(currentCommit.data) : null;
  const flat = new Map<string, { mode: string; oid: string }>();
  if (currentParts) {
    for (const [p, e] of flattenTree(repo, currentParts.tree)) flat.set(p, { mode: e.mode, oid: e.oid });
  }
  const existing = flat.get(path);
  const expectedSha = typeof b.sha === 'string' ? b.sha : undefined;
  if (isDelete) {
    if (!existing) {
      err(res, 404, 'Not Found');
      return;
    }
    if (expectedSha && expectedSha !== existing.oid) {
      err(res, 409, 'Conflict');
      return;
    }
    flat.delete(path);
  } else {
    if (typeof b.content !== 'string') {
      err(res, 422, 'Validation Failed');
      return;
    }
    const data = Buffer.from(b.content, 'base64');
    const blobOid = putObject(repo, 'blob', data);
    if (existing && expectedSha && expectedSha !== existing.oid) {
      err(res, 409, 'Conflict');
      return;
    }
    flat.set(path, { mode: '100644', oid: blobOid });
  }
  const treeOid = buildTreeFromFiles(repo, flat);
  const newCommit = putObject(repo, 'commit', buildCommit(treeOid, currentOid ? [currentOid] : [], message));
  repo.refs.set(ref, newCommit);
  // GitHub: 201 when the file is new, 200 when it replaces an existing one.
  const status = existing ? 200 : 201;
  const blobEntry = flat.get(path);
  ok(res, status, {
    content: blobEntry
      ? {
          type: 'file',
          encoding: 'base64',
          size: getObject(repo, blobEntry.oid)?.data.length ?? 0,
          name: path.split('/').pop() ?? path,
          path,
          content: getObject(repo, blobEntry.oid)?.data.toString('base64') ?? '',
          sha: blobEntry.oid,
          url: `/repos/${params.owner}/${params.repo}/contents/${path}`,
        }
      : null,
    commit: commitJson(repo, newCommit),
  });
}

export const restPutContents: Handler = (ctx, _req, res, params, body) => {
  contentsWrite(ctx, res, params, body, false);
};

export const restDeleteContents: Handler = (ctx, _req, res, params, body) => {
  contentsWrite(ctx, res, params, body, true);
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const restListLabels: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const { page, perPage } = parsePagination(query);
  const labels = [...repo.labels.keys()].sort((a, b) => a.localeCompare(b));
  const { slice, link } = paginate(labels, page, perPage, `/api/v3/repos/${params.owner}/${params.repo}/labels`, '', originOf(_req));
  ok(res, 200, slice.map((name) => labelJson(repo, name)), link ? { link } : {});
};

export const restCreateLabel: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const b = requireFields(res, body, ['name']);
  if (!b) return;
  const name = String(b.name);
  if (repo.labels.has(name)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  repo.labels.set(name, { name, color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed' });
  ok(res, 201, labelJson(repo, name));
};

export const restGetLabel: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  if (!repo.labels.has(params.name)) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, labelJson(repo, params.name));
};

export const restDeleteLabel: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  if (!repo.labels.has(params.name)) {
    err(res, 404, 'Not Found');
    return;
  }
  repo.labels.delete(params.name);
  for (const issue of repo.issues) {
    issue.labels = issue.labels.filter((l) => l !== params.name);
  }
  res.writeHead(204, { 'x-github-request-id': reqId() });
  res.end();
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function filterIssues(repo: Repo, query: URLSearchParams): Issue[] {
  let list = [...repo.issues].sort((a, b) => a.number - b.number);
  const state = query.get('state');
  if (state && state !== 'all') list = list.filter((i) => i.state === state);
  const labels = query.get('labels');
  if (labels) {
    const wanted = labels.split(',');
    list = list.filter((i) => wanted.every((w) => i.labels.includes(w)));
  }
  // sort=created|updated|comments with direction=asc|desc (GitHub default
  // when sort is given is newest first). Without sort params the list stays
  // in creation order.
  const sort = query.get('sort');
  if (sort) {
    const direction = query.get('direction') ?? 'desc';
    const keyOf = (i: Issue): number =>
      sort === 'comments' ? (repo.comments.get(i.number) ?? []).length : i.createdSeq;
    list = [...list].sort((a, b) => (direction === 'desc' ? keyOf(b) - keyOf(a) : keyOf(a) - keyOf(b)));
  }
  return list;
}

export const restListIssues: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const { page, perPage } = parsePagination(query);
  const list = filterIssues(repo, query);
  const { slice, link } = paginate(list, page, perPage, `/api/v3/repos/${params.owner}/${params.repo}/issues`, '', originOf(_req));
  ok(res, 200, slice.map((i) => issueJson(i, repo, params.owner)), link ? { link } : {});
};

export const restCreateIssue: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const b = requireFields(res, body, ['title']);
  if (!b) return;
  const labels: string[] = [];
  if (Array.isArray(b.labels)) {
    for (const name of b.labels) {
      if (!repo.labels.has(String(name))) {
        err(res, 422, 'Validation Failed');
        return;
      }
      labels.push(String(name));
    }
  }
  const number = ctx.store.nextIssueNumber(repo);
  const issue: Issue = {
    id: ctx.store.issueId(),
    number,
    title: String(b.title),
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open',
    labels,
    createdSeq: ctx.store.nextSeq(),
  };
  repo.issues.push(issue);
  ok(res, 201, issueJson(issue, repo, params.owner));
};

export const restGetIssue: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const issue = getIssue(repo, parseInt(params.number, 10));
  if (!issue) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, issueJson(issue, repo, params.owner));
};

export const restUpdateIssue: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const issue = getIssue(repo, parseInt(params.number, 10));
  if (!issue) {
    err(res, 404, 'Not Found');
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.title === 'string') issue.title = b.title;
  if (typeof b.body === 'string' || b.body === null) issue.body = b.body === null ? '' : b.body;
  if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
  if (Array.isArray(b.labels)) {
    const labels: string[] = [];
    for (const name of b.labels) {
      if (!repo.labels.has(String(name))) {
        err(res, 422, 'Validation Failed');
        return;
      }
      labels.push(String(name));
    }
    issue.labels = labels;
  }
  ok(res, 200, issueJson(issue, repo, params.owner));
};

export const restListIssueComments: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const issue = getIssue(repo, parseInt(params.number, 10));
  if (!issue) {
    err(res, 404, 'Not Found');
    return;
  }
  const { page, perPage } = parsePagination(query);
  const comments = repo.comments.get(issue.number) ?? [];
  const { slice, link } = paginate(comments, page, perPage, `/api/v3/repos/${params.owner}/${params.repo}/issues/${params.number}/comments`, '', originOf(_req));
  ok(res, 200, slice.map((c) => commentJson(c, repo, params.owner, issue.number)), link ? { link } : {});
};

export const restCreateIssueComment: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const issue = getIssue(repo, parseInt(params.number, 10));
  if (!issue) {
    err(res, 404, 'Not Found');
    return;
  }
  const b = requireFields(res, body, ['body']);
  if (!b) return;
  const comment: Comment = {
    id: ctx.store.commentId(),
    body: String(b.body),
    createdSeq: ctx.store.nextSeq(),
  };
  const list = repo.comments.get(issue.number) ?? [];
  list.push(comment);
  repo.comments.set(issue.number, list);
  ok(res, 201, commentJson(comment, repo, params.owner, issue.number));
};

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export const restListPulls: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const { page, perPage } = parsePagination(query);
  const state = query.get('state') ?? 'open';
  let list = [...repo.prs].sort((a, b) => a.number - b.number);
  if (state !== 'all') list = list.filter((p) => p.state === state);
  const { slice, link } = paginate(list, page, perPage, `/api/v3/repos/${params.owner}/${params.repo}/pulls`, '', originOf(_req));
  ok(res, 200, slice.map((p) => pullJson(p, repo, params.owner)), link ? { link } : {});
};

export const restCreatePull: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const b = requireFields(res, body, ['title', 'head', 'base']);
  if (!b) return;
  const pull = createPullRecord(ctx.store, repo, String(b.head), String(b.base), String(b.title), typeof b.body === 'string' ? b.body : '');
  if (!pull) {
    err(res, 422, 'Validation Failed');
    return;
  }
  ok(res, 201, pullJson(pull, repo, params.owner));
};

export const restGetPull: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const pull = getPr(repo, parseInt(params.number, 10));
  if (!pull) {
    err(res, 404, 'Not Found');
    return;
  }
  ok(res, 200, pullJson(pull, repo, params.owner));
};

export const restUpdatePull: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const pull = getPr(repo, parseInt(params.number, 10));
  if (!pull) {
    err(res, 404, 'Not Found');
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    err(res, 422, 'Validation Failed');
    return;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.title === 'string') pull.title = b.title;
  if (typeof b.body === 'string' || b.body === null) pull.body = b.body === null ? '' : b.body;
  if (b.state === 'open' || b.state === 'closed') pull.state = b.state;
  const issue = getIssue(repo, pull.number);
  if (issue) {
    if (typeof b.title === 'string') issue.title = b.title;
    if (typeof b.body === 'string' || b.body === null) issue.body = b.body === null ? '' : b.body;
    if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
  }
  ok(res, 200, pullJson(pull, repo, params.owner));
};

export const restMergePull: Handler = (ctx, _req, res, params, body) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const pull = getPr(repo, parseInt(params.number, 10));
  if (!pull) {
    err(res, 404, 'Not Found');
    return;
  }
  if (pull.state !== 'open') {
    err(res, 405, 'Method Not Allowed');
    return;
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const method = typeof b.merge_method === 'string' ? b.merge_method : 'merge';
  if (method !== 'merge' && method !== 'squash' && method !== 'rebase') {
    err(res, 422, 'Validation Failed');
    return;
  }
  const result = mergePullRecord(repo, pull, method);
  if (!result.ok) {
    if (result.conflict) err(res, 405, 'Pull Request is not mergeable');
    else err(res, 422, 'Validation Failed');
    return;
  }
  ok(res, 200, {
    sha: result.mergeSha,
    merged: true,
    message: 'Pull Request successfully merged',
  });
};

export const restListPullCommits: Handler = (ctx, _req, res, params, _body, query) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const pull = getPr(repo, parseInt(params.number, 10));
  if (!pull) {
    err(res, 404, 'Not Found');
    return;
  }
  const { page, perPage } = parsePagination(query);
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = pull.headSha;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const c = commitJson(repo, cur);
    if (!c) break;
    out.push(c);
    const obj = getObject(repo, cur);
    const parts = obj ? parseCommit(obj.data) : null;
    if (!parts || parts.parents.length === 0) break;
    if (parts.parents.includes(pull.baseSha)) break;
    cur = parts.parents[0];
  }
  const { slice, link } = paginate(out, page, perPage, `/api/v3/repos/${params.owner}/${params.repo}/pulls/${params.number}/commits`, '', originOf(_req));
  ok(res, 200, slice, link ? { link } : {});
};

export const restListPullFiles: Handler = (ctx, _req, res, params) => {
  const repo = needRepo(ctx, res, params.owner, params.repo);
  if (!repo) return;
  const pull = getPr(repo, parseInt(params.number, 10));
  if (!pull) {
    err(res, 404, 'Not Found');
    return;
  }
  const headObj = getObject(repo, pull.headSha);
  const baseObj = getObject(repo, pull.baseSha);
  if (!headObj || !baseObj) {
    err(res, 404, 'Not Found');
    return;
  }
  const headParts = parseCommit(headObj.data);
  const baseParts = parseCommit(baseObj.data);
  if (!headParts || !baseParts) {
    err(res, 404, 'Not Found');
    return;
  }
  const headFlat = flattenTree(repo, headParts.tree);
  const baseFlat = flattenTree(repo, baseParts.tree);
  const paths = new Set([...headFlat.keys(), ...baseFlat.keys()]);
  const files: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const h = headFlat.get(path);
    const b = baseFlat.get(path);
    if (h?.oid === b?.oid) continue;
    let status = 'modified';
    if (!b) status = 'added';
    if (!h) status = 'removed';
    const hData = h ? getObject(repo, h.oid)?.data : undefined;
    const bData = b ? getObject(repo, b.oid)?.data : undefined;
    files.push({
      sha: h?.oid ?? b?.oid,
      filename: path,
      status,
      additions: hData ? hData.toString('utf8').split('\n').length : 0,
      deletions: bData ? bData.toString('utf8').split('\n').length : 0,
      changes: 1,
      blob_url: `https://github.com/${params.owner}/${params.repo}/blob/${pull.headSha}/${path}`,
      raw_url: `https://github.com/${params.owner}/${params.repo}/raw/${pull.headSha}/${path}`,
      contents_url: `/repos/${params.owner}/${params.repo}/contents/${path}?ref=${pull.headSha}`,
    });
  }
  ok(res, 200, files);
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const restSearch: Handler = (ctx, _req, res, params, _body, query) => {
  const q = query.get('q') ?? '';
  const { page, perPage } = parsePagination(query);
  const kind = params.kind;
  if (kind === 'repositories') {
    const repos = ctx.store.repos
      .filter((r) => q === '' || r.name.includes(q) || (r.description ?? '').includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const { slice } = paginate(repos, page, perPage, '/api/v3/search/repositories', `q=${encodeURIComponent(q)}`);
    ok(res, 200, { total_count: repos.length, incomplete_results: false, items: slice.map((r) => repoJson(r, r.owner)) });
    return;
  }
  if (kind === 'issues') {
    const items: Record<string, unknown>[] = [];
    for (const repo of ctx.store.repos) {
      for (const issue of repo.issues) {
        if (q === '' || issue.title.includes(q) || (issue.body ?? '').includes(q)) {
          items.push(issueJson(issue, repo, repo.owner));
        }
      }
    }
    items.sort((a, b) => Number(a.number) - Number(b.number));
    const { slice } = paginate(items, page, perPage, '/api/v3/search/issues', `q=${encodeURIComponent(q)}`);
    ok(res, 200, { total_count: items.length, incomplete_results: false, items: slice });
    return;
  }
  if (kind === 'users') {
    const logins = new Set<string>([VIEWER_LOGIN]);
    for (const repo of ctx.store.repos) logins.add(repo.owner);
    const items = [...logins]
      .filter((l) => q === '' || l.includes(q))
      .sort()
      .map((l) => userJson(l));
    const { slice } = paginate(items, page, perPage, '/api/v3/search/users', `q=${encodeURIComponent(q)}`);
    ok(res, 200, { total_count: items.length, incomplete_results: false, items: slice });
    return;
  }
  if (kind === 'code') {
    const items: Record<string, unknown>[] = [];
    for (const repo of ctx.store.repos) {
      const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!headOid) continue;
      const headObj = getObject(repo, headOid);
      if (!headObj || headObj.type !== 'commit') continue;
      const parts = parseCommit(headObj.data);
      if (!parts) continue;
      for (const [path, entry] of flattenTree(repo, parts.tree)) {
        const blob = getObject(repo, entry.oid);
        if (!blob || blob.type !== 'blob') continue;
        const text = blob.data.toString('utf8');
        if (q === '' || text.includes(q)) {
          items.push({
            name: path.split('/').pop() ?? path,
            path,
            sha: entry.oid,
            url: `/repos/${repo.owner}/${repo.name}/contents/${path}`,
            git_url: `/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
            html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
            repository: repoJson(repo, repo.owner),
            score: 1,
          });
        }
      }
    }
    const { slice } = paginate(items, page, perPage, '/api/v3/search/code', `q=${encodeURIComponent(q)}`);
    ok(res, 200, { total_count: items.length, incomplete_results: false, items: slice });
    return;
  }
  err(res, 404, 'Not Found');
};
