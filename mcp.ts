// MCP (Model Context Protocol) endpoint at /mcp, per specs/api-spec.md
// section 6. Supports the modern 2026-07-28 discovery handshake
// (server/discover, no initialize), the legacy 2025-11-25 initialize flow,
// tools/list (byte-identical across calls), tools/call for the six tools,
// and the standard JSON-RPC error codes.

import {
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
  createPullRecord,
  getIssue,
  getPr,
  globalId,
  mergePullRecord,
  stableId,
} from './store.ts';

export interface McpCtx {
  store: Store;
  viewer: string;
}

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'];

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  aliases: string[];
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    aliases: ['create-repository', 'repository.create', 'create_repository', 'repo_create'],
  },
  {
    name: 'list_repositories',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        per_page: { type: 'integer', description: 'Results per page.' },
        page: { type: 'integer', description: 'Page number.' },
      },
    },
    aliases: ['list-repositories', 'repositories.list', 'list_repos'],
  },
  {
    name: 'get_repository',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
    aliases: ['get-repository', 'repository.get'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    aliases: ['create-issue', 'issue.create'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter.' },
        per_page: { type: 'integer', description: 'Results per page.' },
        page: { type: 'integer', description: 'Page number.' },
      },
      required: ['owner', 'repo'],
    },
    aliases: ['list-issues', 'issues.list'],
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        number: { type: 'integer', description: 'Issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
    aliases: ['get-issue', 'issue.get'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    aliases: ['create-pull-request', 'pull.create', 'create_pr', 'pr_create', 'pull_request_create'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    aliases: ['merge-pull-request', 'pull.merge', 'merge_pr', 'pr_merge', 'pull_request_merge'],
  },
  {
    name: 'search_repositories',
    description: 'Search repositories by name or description.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        per_page: { type: 'integer', description: 'Results per page.' },
        page: { type: 'integer', description: 'Page number.' },
      },
      required: ['query'],
    },
    aliases: ['search-repositories', 'repositories.search'],
  },
];

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  for (const t of TOOLS) {
    if (t.name === lower) return t;
    if (t.aliases.includes(lower)) return t;
    // Suffix match: "github.list_repositories" or "forge.list_repositories".
    if (lower.endsWith(`.${t.name}`) || lower.endsWith(`/${t.name}`)) return t;
    for (const alias of t.aliases) {
      if (lower.endsWith(`.${alias}`) || lower.endsWith(`/${alias}`)) return t;
    }
  }
  return undefined;
}

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

function contentText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}

function repoSummary(r: { id: number; name: string; owner: string; private: boolean; description: string; defaultBranch: string }): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner },
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function issueSummary(ctx: McpCtx, repo: Repo, i: Issue): Record<string, unknown> {
  void ctx;
  return {
    id: i.id,
    node_id: globalId('Issue', repo.id, i.number),
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    user: { login: VIEWER_LOGIN },
    labels: i.labels.map((name) => ({ id: stableId(name), name, color: 'ededed' })),
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function prSummary(_ctx: McpCtx, repo: Repo, p: PullRequest): Record<string, unknown> {
  return {
    id: p.id,
    node_id: globalId('PullRequest', repo.id, p.number),
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merge_commit_sha: p.mergeCommitSha,
    head: { ref: p.head, sha: p.headSha },
    base: { ref: p.base, sha: p.baseSha },
    user: { login: VIEWER_LOGIN },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function callTool(ctx: McpCtx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (!tool) {
    throw new McpError(-32601, `Method not found: ${name}`);
  }
  const missing = ((tool.inputSchema.required as string[]) ?? []).filter((f) => args[f] === undefined || args[f] === null);
  if (missing.length > 0) {
    throw new McpError(-32602, `Invalid params: missing required field(s): ${missing.join(', ')}`);
  }
  switch (tool.name) {
    case 'create_repo': {
      const owner = typeof args.owner === 'string' && args.owner ? args.owner : ctx.viewer;
      const name = String(args.name ?? '');
      if (name.length === 0) throw new McpError(-32602, 'Invalid params: name must not be empty');
      const repo = ctx.store.createRepo(owner, name, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (!repo) throw new McpError(-32602, `Repository already exists: ${owner}/${name}`);
      return contentText(JSON.stringify(repoSummary(repo)));
    }
    case 'list_repositories': {
      const perPage = typeof args.per_page === 'number' ? args.per_page : 30;
      const page = typeof args.page === 'number' ? args.page : 1;
      const repos = ctx.store.repos
        .filter((r) => r.owner === ctx.viewer)
        .sort((a, b) => a.name.localeCompare(b.name));
      const slice = repos.slice((page - 1) * perPage, page * perPage);
      return contentText(JSON.stringify(slice.map(repoSummary)));
    }
    case 'get_repository': {
      const repo = ctx.store.getRepo(String(args.owner), String(args.repo));
      if (!repo) throw new McpError(-32602, `Repository not found: ${args.owner}/${args.repo}`);
      return contentText(JSON.stringify(repoSummary(repo)));
    }
    case 'create_issue': {
      const repo = ctx.store.getRepo(String(args.owner), String(args.repo));
      if (!repo) throw new McpError(-32602, `Repository not found: ${args.owner}/${args.repo}`);
      const title = String(args.title ?? '');
      if (title.length === 0) throw new McpError(-32602, 'Invalid params: title must not be empty');
      const labels: string[] = [];
      if (Array.isArray(args.labels)) {
        for (const lname of args.labels) {
          if (!repo.labels.has(String(lname))) throw new McpError(-32602, `Invalid params: unknown label ${lname}`);
          labels.push(String(lname));
        }
      }
      const number = ctx.store.nextIssueNumber(repo);
      const issue: Issue = {
        id: ctx.store.issueId(),
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels,
        createdSeq: ctx.store.nextSeq(),
      };
      repo.issues.push(issue);
      return contentText(JSON.stringify(issueSummary(ctx, repo, issue)));
    }
    case 'list_issues': {
      const repo = ctx.store.getRepo(String(args.owner), String(args.repo));
      if (!repo) throw new McpError(-32602, `Repository not found: ${args.owner}/${args.repo}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const perPage = typeof args.per_page === 'number' ? args.per_page : 30;
      const page = typeof args.page === 'number' ? args.page : 1;
      let list = [...repo.issues].sort((a, b) => a.number - b.number);
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return contentText(JSON.stringify(slice.map((i) => issueSummary(ctx, repo, i))));
    }
    case 'get_issue': {
      const repo = ctx.store.getRepo(String(args.owner), String(args.repo));
      if (!repo) throw new McpError(-32602, `Repository not found: ${args.owner}/${args.repo}`);
      const issue = getIssue(repo, Number(args.number));
      if (!issue) throw new McpError(-32602, `Issue not found: ${args.number}`);
      const summary = issueSummary(ctx, repo, issue);
      const comments = (repo.comments.get(issue.number) ?? []).map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN } }));
      return contentText(JSON.stringify({ ...summary, comments }));
    }
    case 'create_pull_request': {
      const repo = ctx.store.getRepo(String(args.owner), String(args.repo));
      if (!repo) throw new McpError(-32602, `Repository not found: ${args.owner}/${args.repo}`);
      const pull = createPullRecord(
        ctx.store,
        repo,
        String(args.head ?? ''),
        String(args.base ?? ''),
        String(args.title ?? ''),
        typeof args.body === 'string' ? args.body : '',
      );
      if (!pull) throw new McpError(-32602, 'Invalid params: head or base branch not found');
      return contentText(JSON.stringify(prSummary(ctx, repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = ctx.store.getRepo(String(args.owner), String(args.repo));
      if (!repo) throw new McpError(-32602, `Repository not found: ${args.owner}/${args.repo}`);
      const pull = getPr(repo, Number(args.pull_number));
      if (!pull) throw new McpError(-32602, `Pull request not found: ${args.pull_number}`);
      const result = mergePullRecord(repo, pull, 'merge');
      if (!result.ok) {
        throw new McpError(-32602, result.conflict ? 'Pull request is not mergeable' : 'Pull request cannot be merged');
      }
      return contentText(JSON.stringify({ ...prSummary(ctx, repo, pull), sha: result.mergeSha }));
    }
    case 'search_repositories': {
      const q = String(args.query ?? '');
      const perPage = typeof args.per_page === 'number' ? args.per_page : 30;
      const page = typeof args.page === 'number' ? args.page : 1;
      const repos = ctx.store.repos
        .filter((r) => q === '' || r.name.includes(q) || (r.description ?? '').includes(q))
        .sort((a, b) => a.name.localeCompare(b.name));
      const slice = repos.slice((page - 1) * perPage, page * perPage);
      return contentText(JSON.stringify(slice.map(repoSummary)));
    }
    default:
      throw new McpError(-32601, `Method not found: ${name}`);
  }
}

export class McpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Handle one JSON-RPC request object. Returns null for notifications. */
export function handleMcpMessage(ctx: McpCtx, msg: unknown): Record<string, unknown> | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    return jsonRpcError(m.id ?? null, -32600, 'Invalid Request');
  }
  const id = m.id ?? null;
  const params = (m.params ?? {}) as Record<string, unknown>;

  try {
    switch (m.method) {
      case 'server/discover': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
        const version = requested && PROTOCOL_VERSIONS.includes(requested) ? requested : '2026-07-28';
        return jsonRpcResult(id, {
          protocolVersion: version,
          supportedVersions: PROTOCOL_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'git-forge', version: '1.0.0' },
          tools: toolsListResult().tools,
        });
      }
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
        const version = requested && PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return jsonRpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'git-forge', version: '1.0.0' },
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress':
      case 'notifications/roots/list_changed':
        return null;
      case 'ping':
        return jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, toolsListResult());
      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = callTool(ctx, name, args);
        return jsonRpcResult(id, result);
      }
      default:
        return jsonRpcError(id, -32601, `Method not found: ${m.method}`);
    }
  } catch (e) {
    if (e instanceof McpError) return jsonRpcError(id, e.code, e.message);
    return jsonRpcError(id, -32603, e instanceof Error ? e.message : String(e));
  }
}

/** Handle a parsed JSON body: a single request or a batch array. */
export function handleMcpBody(ctx: McpCtx, body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const item of body) {
      const r = handleMcpMessage(ctx, item);
      if (r !== null) results.push(r);
    }
    return { status: 200, payload: results };
  }
  if (body && typeof body === 'object') {
    const r = handleMcpMessage(ctx, body);
    if (r === null) return { status: 202, payload: null };
    return { status: 200, payload: r };
  }
  return { status: 200, payload: jsonRpcError(null, -32700, 'Parse error') };
}

export { VIEWER_LOGIN };
