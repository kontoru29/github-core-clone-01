// GraphQL executor for /api/graphql: a small recursive-descent parser, a
// schema registry, resolvers over the store, and introspection. Covers the
// 18 documents in specs/api-spec.md plus the introspection/error checks.

import {
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
  createPullRecord,
  flattenTree,
  getIssue,
  getObject,
  getPr,
  globalId,
  mergePullRecord,
  parseCommit,
  parseGlobalId,
  prMergeable,
} from './store.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'IntValue'; value: number }
  | { kind: 'FloatValue'; value: number }
  | { kind: 'StringValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'ListValue'; values: ValueNode[] }
  | { kind: 'ObjectValue'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'Field';
  name: string;
  alias?: string;
  args: { name: string; value: ValueNode }[];
  directives: { name: string; args: { name: string; value: ValueNode }[] }[];
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'FragmentSpread'; name: string; directives: { name: string; args: { name: string; value: ValueNode }[] }[] }
  | { kind: 'InlineFragment'; typeCondition?: string; directives: { name: string; args: { name: string; value: ValueNode }[] }[]; selectionSet: SelectionNode[] };

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: { name: string; type: string; defaultValue?: ValueNode }[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private tokens: { type: string; value: string }[] = [];

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  peek(offset = 0): { type: string; value: string } {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  next(): { type: string; value: string } {
    return this.tokens[this.pos++];
  }

  expect(type: string, value?: string): { type: string; value: string } {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`GraphQL syntax error: expected ${value ?? type}, got ${t.value}`);
    }
    return t;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().type !== 'EOF') {
      const t = this.peek();
      if (t.type === 'Punct' && t.value === '{') {
        operations.push(this.parseOperation('query'));
      } else if (t.type === 'Name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        operations.push(this.parseOperation(t.value as 'query' | 'mutation' | 'subscription'));
      } else if (t.type === 'Name' && t.value === 'fragment') {
        const frag = this.parseFragment();
        fragments.set(frag.name, frag);
      } else {
        throw new Error(`GraphQL syntax error: unexpected ${t.value}`);
      }
    }
    return { operations, fragments };
  }

  parseOperation(op: 'query' | 'mutation' | 'subscription'): OperationNode {
    if (this.peek().type === 'Name' && (this.peek().value === 'query' || this.peek().value === 'mutation' || this.peek().value === 'subscription')) {
      this.next();
    }
    let name: string | undefined;
    if (this.peek().type === 'Name') name = this.next().value;
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.peek().type === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().type === 'Punct' && this.peek().value === ')')) {
        this.expect('Punct', '$');
        const varName = this.expect('Name').value;
        this.expect('Punct', ':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().type === 'Punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, type, defaultValue });
      }
      this.next();
    }
    const selectionSet = this.parseSelectionSet();
    return { kind: 'Operation', operation: op, name, variableDefinitions, selectionSet };
  }

  parseType(): string {
    let type = '';
    if (this.peek().type === 'Punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expect('Name').value;
    }
    if (this.peek().type === 'Punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  parseFragment(): FragmentNode {
    this.expect('Name', 'fragment');
    const name = this.expect('Name').value;
    this.expect('Name', 'on');
    const typeCondition = this.expect('Name').value;
    const selectionSet = this.parseSelectionSet();
    return { kind: 'Fragment', name, typeCondition, selectionSet };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('Punct', '{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().type === 'Punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek().type === 'Punct' && this.peek().value === '.') {
      this.expect('Punct', '.');
      this.expect('Punct', '.');
      this.expect('Punct', '.');
      if (this.peek().type === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('Name').value;
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'InlineFragment', typeCondition, directives, selectionSet };
      }
      if (this.peek().type === 'Name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'FragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      const selectionSet = this.parseSelectionSet();
      return { kind: 'InlineFragment', directives, selectionSet };
    }
    const first = this.expect('Name').value;
    let alias: string | undefined;
    let name = first;
    if (this.peek().type === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expect('Name').value;
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().type === 'Punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'Field', name, alias, args, directives, selectionSet };
  }

  parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().type === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().type === 'Punct' && this.peek().value === ')')) {
        const name = this.expect('Name').value;
        this.expect('Punct', ':');
        args.push({ name, value: this.parseValue() });
      }
      this.next();
    }
    return args;
  }

  parseDirectives(): { name: string; args: { name: string; value: ValueNode }[] }[] {
    const directives: { name: string; args: { name: string; value: ValueNode }[] }[] = [];
    while (this.peek().type === 'Punct' && this.peek().value === '@') {
      this.next();
      const name = this.expect('Name').value;
      const args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  parseValue(): ValueNode {
    const t = this.peek();
    if (t.type === 'Punct' && t.value === '$') {
      this.next();
      return { kind: 'Variable', name: this.expect('Name').value };
    }
    if (t.type === 'Int') {
      this.next();
      return { kind: 'IntValue', value: parseInt(t.value, 10) };
    }
    if (t.type === 'Float') {
      this.next();
      return { kind: 'FloatValue', value: parseFloat(t.value) };
    }
    if (t.type === 'String') {
      this.next();
      return { kind: 'StringValue', value: t.value };
    }
    if (t.type === 'Name') {
      this.next();
      if (t.value === 'true') return { kind: 'BooleanValue', value: true };
      if (t.value === 'false') return { kind: 'BooleanValue', value: false };
      if (t.value === 'null') return { kind: 'NullValue' };
      return { kind: 'EnumValue', value: t.value };
    }
    if (t.type === 'Punct' && t.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!(this.peek().type === 'Punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'ListValue', values };
    }
    if (t.type === 'Punct' && t.value === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().type === 'Punct' && this.peek().value === '}')) {
        const name = this.expect('Name').value;
        this.expect('Punct', ':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'ObjectValue', fields };
    }
    throw new Error(`GraphQL syntax error: unexpected value ${t.value}`);
  }
}

function tokenize(source: string): { type: string; value: string }[] {
  const tokens: { type: string; value: string }[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      if (source[j] === '"' && source[j + 1] === '"') {
        // Block string: take raw until closing """.
        j += 2;
        const end = source.indexOf('"""', j);
        if (end < 0) throw new Error('GraphQL syntax error: unterminated block string');
        out = source.slice(j, end).replace(/^\n/, '').replace(/\n$/, '');
        i = end + 3;
        tokens.push({ type: 'String', value: out });
        continue;
      }
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new Error('GraphQL syntax error: unterminated string');
      i = j + 1;
      tokens.push({ type: 'String', value: out });
      continue;
    }
    if (c === '$' || c === '!' || c === '(' || c === ')' || c === ':' || c === '=' || c === '@' || c === '[' || c === ']' || c === '{' || c === '}' || c === '|' || c === '&') {
      tokens.push({ type: 'Punct', value: c });
      i++;
      continue;
    }
    if (c === '.') {
      if (source.slice(i, i + 3) === '...') {
        tokens.push({ type: 'Punct', value: '.' });
        tokens.push({ type: 'Punct', value: '.' });
        tokens.push({ type: 'Punct', value: '.' });
        i += 3;
        continue;
      }
      throw new Error('GraphQL syntax error: unexpected .');
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j++;
      while (j < source.length && /[0-9]/.test(source[j])) j++;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j++;
        while (j < source.length && /[0-9]/.test(source[j])) j++;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j++;
        if (source[j] === '+' || source[j] === '-') j++;
        while (j < source.length && /[0-9]/.test(source[j])) j++;
      }
      tokens.push({ type: isFloat ? 'Float' : 'Int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      tokens.push({ type: 'Name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL syntax error: unexpected character ${c}`);
  }
  tokens.push({ type: 'EOF', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'IntValue':
    case 'FloatValue':
    case 'StringValue':
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map((v) => resolveValue(v, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

function directiveApplies(directives: { name: string; args: { name: string; value: ValueNode }[] }[], variables: Record<string, unknown>): boolean {
  for (const d of directives) {
    if (d.name === 'skip' || d.name === 'include') {
      const ifArg = d.args.find((a) => a.name === 'if');
      const val = ifArg ? resolveValue(ifArg.value, variables) : false;
      if (d.name === 'skip' && val === true) return false;
      if (d.name === 'include' && val !== true) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Schema registry (built on the real store API)
// ---------------------------------------------------------------------------

interface FieldDef {
  type: string; // e.g. "String", "[Issue]", "User"
  resolve?: (src: any, args: Record<string, unknown>, ctx: GqlCtx) => unknown;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  description?: string;
}

const base64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const decodeCursor = (c: string): number | null => {
  try {
    const text = Buffer.from(c, 'base64url').toString('utf8');
    const m = text.match(/^c:(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
};
const makeCursor = (n: number): string => base64url(`c:${n}`);

interface ConnItem {
  key: number;
  node: unknown;
}

function makeConnection(items: ConnItem[], args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let start = 0;
  if (after !== null) {
    const idx = items.findIndex((it) => it.key === after);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  return {
    nodes: page.map((it) => it.node),
    edges: page.map((it) => ({ node: it.node, cursor: makeCursor(it.key) })),
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? makeCursor(page[0].key) : null,
      endCursor: page.length > 0 ? makeCursor(page[page.length - 1].key) : null,
    },
    totalCount: items.length,
  };
}

export interface GqlCtx {
  store: Store;
  viewer: string;
}

function userObject(login: string, _ctx: GqlCtx): Record<string, unknown> {
  return { __typename: 'User', login, id: login === VIEWER_LOGIN ? VIEWER_ID : 1001 };
}

function repoObject(repo: Repo, _ctx: GqlCtx): Record<string, unknown> {
  return { __typename: 'Repository', repo, owner: repo.owner };
}

function issueObject(issue: Issue, repo: Repo): Record<string, unknown> {
  return { __typename: 'Issue', issue, repo };
}

function pullObject(pull: PullRequest, repo: Repo): Record<string, unknown> {
  return { __typename: 'PullRequest', pull, repo };
}

function labelObject(name: string, repo: Repo): Record<string, unknown> {
  return { __typename: 'Label', name, repo };
}

function commentObject(comment: Comment, repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'IssueComment', comment, repo, issue };
}

function repoIssues(repo: Repo): Issue[] {
  return [...repo.issues].sort((a, b) => a.number - b.number);
}

function repoPulls(repo: Repo): PullRequest[] {
  return [...repo.prs].sort((a, b) => a.number - b.number);
}

/**
 * Apply an `orderBy: {field, direction}` argument (CREATED_AT / UPDATED_AT /
 * COMMENTS with ASC / DESC). All timestamps are the fixed scenario epoch, so
 * creation order (createdSeq) is the tiebreak-proof created-at order.
 */
function applyOrderBy<T extends { createdSeq: number; number: number }>(list: T[], repo: Repo, orderBy: unknown): T[] {
  if (!orderBy || typeof orderBy !== 'object') return list;
  const { field, direction } = orderBy as Record<string, unknown>;
  const dir = direction === 'ASC' ? 1 : -1;
  const keyOf = (it: T): number => (field === 'COMMENTS' ? (repo.comments.get(it.number) ?? []).length : it.createdSeq);
  return [...list].sort((a, b) => dir * (keyOf(a) - keyOf(b)));
}

function repoLabelNames(repo: Repo): string[] {
  return [...repo.labels.keys()].sort((a, b) => a.localeCompare(b));
}

/** Paths changed between a PR's base and head (same diff as the REST files list). */
function pullChangedPaths(repo: Repo, pull: PullRequest): string[] {
  const headObj = getObject(repo, pull.headSha);
  const baseObj = getObject(repo, pull.baseSha);
  if (!headObj || !baseObj) return [];
  const headParts = parseCommit(headObj.data);
  const baseParts = parseCommit(baseObj.data);
  if (!headParts || !baseParts) return [];
  const headFlat = flattenTree(repo, headParts.tree);
  const baseFlat = flattenTree(repo, baseParts.tree);
  const paths: string[] = [];
  for (const path of new Set([...headFlat.keys(), ...baseFlat.keys()])) {
    if (headFlat.get(path)?.oid !== baseFlat.get(path)?.oid) paths.push(path);
  }
  return paths.sort();
}

/** Resolve a global id to its object wrapper, or null. */
function resolveNode(ctx: GqlCtx, nodeId: string): Record<string, unknown> | null {
  const parsed = parseGlobalId(nodeId);
  if (!parsed) return null;
  const parts = parsed.parts;
  switch (parsed.kind) {
    case 'Repository': {
      const repo = ctx.store.getRepoById(parseInt(parts[0] ?? '', 10));
      return repo ? repoObject(repo, ctx) : null;
    }
    case 'Issue': {
      const repo = ctx.store.getRepoById(parseInt(parts[0] ?? '', 10));
      if (!repo) return null;
      const issue = getIssue(repo, parseInt(parts[1] ?? '', 10));
      return issue ? issueObject(issue, repo) : null;
    }
    case 'PullRequest': {
      const repo = ctx.store.getRepoById(parseInt(parts[0] ?? '', 10));
      if (!repo) return null;
      const pull = getPr(repo, parseInt(parts[1] ?? '', 10));
      return pull ? pullObject(pull, repo) : null;
    }
    case 'Label': {
      const repo = ctx.store.getRepoById(parseInt(parts[0] ?? '', 10));
      if (!repo || !repo.labels.has(parts[1] ?? '')) return null;
      return labelObject(parts[1], repo);
    }
    case 'IssueComment': {
      const repo = ctx.store.getRepoById(parseInt(parts[0] ?? '', 10));
      if (!repo) return null;
      const issue = getIssue(repo, parseInt(parts[1] ?? '', 10));
      if (!issue) return null;
      const comment = (repo.comments.get(issue.number) ?? []).find((c) => c.id === parseInt(parts[2] ?? '', 10));
      return comment ? commentObject(comment, repo, issue) : null;
    }
    case 'User':
      return userObject(parts[0] ?? '', ctx);
    default:
      return null;
  }
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User', resolve: (_s, _a, ctx) => userObject(ctx.viewer, ctx) },
      repository: {
        type: 'Repository',
        resolve: (_s, args, ctx) => {
          const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo ? repoObject(repo, ctx) : null;
        },
      },
      node: {
        type: 'Node',
        resolve: (_s, args, ctx) => resolveNode(ctx, String(args.id ?? '')),
      },
      search: {
        type: 'SearchResultItemConnection',
        resolve: (_s, args, ctx) => {
          const q = String(args.query ?? '');
          const type = String(args.type ?? 'ISSUE');
          const items: ConnItem[] = [];
          for (const repo of ctx.store.repos) {
            if (type === 'ISSUE') {
              for (const i of repoIssues(repo)) {
                if (getPr(repo, i.number)) continue; // PRs are not issues here
                if (q && !i.title.includes(q) && !(i.body ?? '').includes(q)) continue;
                items.push({ key: i.id, node: issueObject(i, repo) });
              }
            } else if (type === 'PULL_REQUEST') {
              for (const p of repoPulls(repo)) {
                if (q && !p.title.includes(q) && !(p.body ?? '').includes(q)) continue;
                items.push({ key: p.id, node: pullObject(p, repo) });
              }
            } else if (type === 'REPOSITORY') {
              if (q && !repo.name.includes(q) && !(repo.description ?? '').includes(q)) continue;
              items.push({ key: repo.id, node: repoObject(repo, ctx) });
            } else if (type === 'USER') {
              if (!q || VIEWER_LOGIN.includes(q)) items.push({ key: VIEWER_ID, node: userObject(VIEWER_LOGIN, ctx) });
            }
          }
          items.sort((a, b) => a.key - b.key);
          return makeConnection(items, args);
        },
      },
      user: {
        type: 'User',
        resolve: (_s, args, ctx) => {
          const login = String(args.login ?? '');
          if (login !== VIEWER_LOGIN && !ctx.store.repos.some((r) => r.owner === login)) return null;
          return userObject(login, ctx);
        },
      },
      organization: {
        type: 'Organization',
        resolve: (_s, args, _ctx) => {
          const login = String(args.login ?? '');
          if (login !== 'faint-meadow-org') return null;
          return { __typename: 'Organization', login, id: 2000 };
        },
      },
      rateLimit: {
        type: 'RateLimit',
        resolve: () => ({ __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, resetAt: FIXED_ISO }),
      },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = resolveNode(ctx, String(input.subjectId ?? ''));
          if (!target) return null;
          const repo = (target as any).repo as Repo | undefined;
          const issue = (target as any).issue as Issue | undefined;
          if (!repo || !issue) return null;
          const comment: Comment = {
            id: ctx.store.commentId(),
            body: String(input.body ?? ''),
            createdSeq: ctx.store.nextSeq(),
          };
          const list = repo.comments.get(issue.number) ?? [];
          list.push(comment);
          repo.comments.set(issue.number, list);
          return { __typename: 'AddCommentPayload', commentEdge: { node: commentObject(comment, repo, issue), cursor: makeCursor(comment.id) } };
        },
      },
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = resolveNode(ctx, String(input.repositoryId ?? ''));
          if (!target) return null;
          const repo = (target as any).repo as Repo | undefined;
          if (!repo) return null;
          const number = ctx.store.nextIssueNumber(repo);
          const issue: Issue = {
            id: ctx.store.issueId(),
            number,
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            labels: [],
            createdSeq: ctx.store.nextSeq(),
          };
          repo.issues.push(issue);
          return { __typename: 'CreateIssuePayload', issue: issueObject(issue, repo) };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = resolveNode(ctx, String(input.issueId ?? ''));
          if (!target) return null;
          const repo = (target as any).repo as Repo | undefined;
          const issue = (target as any).issue as Issue | undefined;
          if (!repo || !issue) return null;
          issue.state = 'closed';
          return { __typename: 'CloseIssuePayload', issue: issueObject(issue, repo) };
        },
      },
      reopenIssue: {
        type: 'ReopenIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = resolveNode(ctx, String(input.issueId ?? ''));
          if (!target) return null;
          const repo = (target as any).repo as Repo | undefined;
          const issue = (target as any).issue as Issue | undefined;
          if (!repo || !issue) return null;
          issue.state = 'open';
          return { __typename: 'ReopenIssuePayload', issue: issueObject(issue, repo) };
        },
      },
      updateIssue: {
        type: 'UpdateIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = resolveNode(ctx, String(input.id ?? ''));
          if (!target) return null;
          const repo = (target as any).repo as Repo | undefined;
          const issue = (target as any).issue as Issue | undefined;
          if (!repo || !issue) return null;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string' || input.body === null) issue.body = input.body === null ? '' : input.body;
          if (input.state === 'OPEN') issue.state = 'open';
          else if (input.state === 'CLOSED') issue.state = 'closed';
          return { __typename: 'UpdateIssuePayload', issue: issueObject(issue, repo) };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = resolveNode(ctx, String(input.repositoryId ?? ''));
          if (!target) return null;
          const repo = (target as any).repo as Repo | undefined;
          if (!repo) return null;
          const pull = createPullRecord(
            ctx.store,
            repo,
            String(input.headRefName ?? ''),
            String(input.baseRefName ?? ''),
            String(input.title ?? ''),
            typeof input.body === 'string' ? input.body : '',
          );
          if (!pull) return null;
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(pull, repo) };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const target = resolveNode(ctx, String(input.pullRequestId ?? ''));
          if (!target) return null;
          const repo = (target as any).repo as Repo | undefined;
          const pull = (target as any).pull as PullRequest | undefined;
          if (!repo || !pull) return null;
          const method = input.mergeMethod === 'MERGE' ? 'merge' : input.mergeMethod === 'REBASE' ? 'rebase' : 'squash';
          const result = mergePullRecord(repo, pull, method);
          if (!result.ok) return null;
          return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(pull, repo) };
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('User', s.login as string) },
      login: { type: 'String', resolve: (s) => s.login },
      name: { type: 'String', resolve: (s) => (s.login === VIEWER_LOGIN ? VIEWER_NAME : s.login) },
      email: { type: 'String', resolve: (s) => (s.login === VIEWER_LOGIN ? VIEWER_EMAIL : null) },
      avatarUrl: { type: 'URI', resolve: (s) => `https://github.com/${s.login}.png` },
      url: { type: 'URI', resolve: (s) => `https://github.com/${s.login}` },
      repositories: {
        type: 'RepositoryConnection',
        resolve: (s, args, ctx) => {
          const repos = ctx.store.repos
            .filter((r) => r.owner === (s.login as string))
            .sort((a, b) => a.name.localeCompare(b.name));
          return makeConnection(repos.map((r) => ({ key: r.id, node: repoObject(r, ctx) })), args);
        },
      },
    },
  },
  Organization: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('Organization', s.login as string) },
      login: { type: 'String', resolve: (s) => s.login },
      name: { type: 'String', resolve: (s) => s.login },
      avatarUrl: { type: 'URI', resolve: (s) => `https://github.com/${s.login}.png` },
      url: { type: 'URI', resolve: (s) => `https://github.com/${s.login}` },
      repositories: {
        type: 'RepositoryConnection',
        resolve: (s, args, ctx) => {
          const repos = ctx.store.repos
            .filter((r) => r.owner === (s.login as string))
            .sort((a, b) => a.name.localeCompare(b.name));
          return makeConnection(repos.map((r) => ({ key: r.id, node: repoObject(r, ctx) })), args);
        },
      },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('Repository', (s.repo as Repo).id) },
      databaseId: { type: 'Int', resolve: (s) => (s.repo as Repo).id },
      name: { type: 'String', resolve: (s) => (s.repo as Repo).name },
      nameWithOwner: { type: 'String', resolve: (s) => `${(s.repo as Repo).owner}/${(s.repo as Repo).name}` },
      description: { type: 'String', resolve: (s) => (s.repo as Repo).description },
      viewerPermission: {
        type: 'RepositoryPermission',
        resolve: (s, _a, ctx) => ((s.repo as Repo).owner === ctx.viewer ? 'ADMIN' : 'READ'),
      },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      issue: {
        type: 'Issue',
        resolve: (s, args) => {
          const repo = s.repo as Repo;
          const issue = getIssue(repo, Number(args.number));
          return issue ? issueObject(issue, repo) : null;
        },
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (s, args) => {
          const repo = s.repo as Repo;
          const pull = getPr(repo, Number(args.number));
          return pull ? pullObject(pull, repo) : null;
        },
      },
      owner: { type: 'RepositoryOwner', resolve: (s, _a, ctx) => userObject((s.repo as Repo).owner, ctx) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (s) => {
          const repo = s.repo as Repo;
          const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!oid) return null;
          return { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid } };
        },
      },
      createdAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      updatedAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      url: { type: 'URI', resolve: (s) => `https://github.com/${(s.repo as Repo).owner}/${(s.repo as Repo).name}` },
      isPrivate: { type: 'Boolean', resolve: (s) => (s.repo as Repo).private },
      stargazerCount: { type: 'Int', resolve: () => 0 },
      forkCount: { type: 'Int', resolve: () => 0 },
      licenseInfo: { type: 'License', resolve: () => null },
      issues: {
        type: 'IssueConnection',
        resolve: (s, args) => {
          const repo = s.repo as Repo;
          let list = repoIssues(repo);
          const states = args.states as string[] | undefined;
          if (states && states.length > 0) {
            const want = new Set(states.map((x) => x.toLowerCase()));
            list = list.filter((i) => want.has(i.state));
          }
          list = applyOrderBy(list, repo, args.orderBy);
          return makeConnection(list.map((i) => ({ key: i.id, node: issueObject(i, repo) })), args);
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (s, args) => {
          const repo = s.repo as Repo;
          let list = repoPulls(repo);
          const states = args.states as string[] | undefined;
          if (states && states.length > 0) {
            const want = new Set(states.map((x) => x.toLowerCase()));
            list = list.filter((p) => want.has(p.state));
          }
          list = applyOrderBy(list, repo, args.orderBy);
          return makeConnection(list.map((p) => ({ key: p.id, node: pullObject(p, repo) })), args);
        },
      },
      labels: {
        type: 'LabelConnection',
        resolve: (s, args) => {
          const repo = s.repo as Repo;
          return makeConnection(repoLabelNames(repo).map((name) => ({ key: name.charCodeAt(0), node: labelObject(name, repo) })), args);
        },
      },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('Issue', (s.repo as Repo).id, (s.issue as Issue).number) },
      number: { type: 'Int', resolve: (s) => (s.issue as Issue).number },
      title: { type: 'String', resolve: (s) => (s.issue as Issue).title },
      body: { type: 'String', resolve: (s) => (s.issue as Issue).body },
      state: { type: 'IssueState', resolve: (s) => ((s.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED') },
      author: { type: 'Actor', resolve: (s, _a, ctx) => userObject(VIEWER_LOGIN, ctx) },
      createdAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      updatedAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      closedAt: { type: 'DateTime', resolve: (s) => ((s.issue as Issue).state === 'closed' ? FIXED_ISO : null) },
      url: { type: 'URI', resolve: (s) => `https://github.com/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/issues/${(s.issue as Issue).number}` },
      repository: { type: 'Repository', resolve: (s, _a, ctx) => repoObject(s.repo as Repo, ctx) },
      labels: {
        type: 'LabelConnection',
        resolve: (s, args) => {
          const issue = s.issue as Issue;
          const repo = s.repo as Repo;
          return makeConnection(issue.labels.map((name) => ({ key: name.charCodeAt(0), node: labelObject(name, repo) })), args);
        },
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (s, args) => {
          const issue = s.issue as Issue;
          const repo = s.repo as Repo;
          const comments = repo.comments.get(issue.number) ?? [];
          return makeConnection(comments.map((c) => ({ key: c.id, node: commentObject(c, repo, issue) })), args);
        },
      },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('PullRequest', (s.repo as Repo).id, (s.pull as PullRequest).number) },
      number: { type: 'Int', resolve: (s) => (s.pull as PullRequest).number },
      title: { type: 'String', resolve: (s) => (s.pull as PullRequest).title },
      body: { type: 'String', resolve: (s) => (s.pull as PullRequest).body },
      state: { type: 'PullRequestState', resolve: (s) => ((s.pull as PullRequest).state === 'open' ? 'OPEN' : 'CLOSED') },
      author: { type: 'Actor', resolve: (s, _a, ctx) => userObject(VIEWER_LOGIN, ctx) },
      createdAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      updatedAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      closedAt: { type: 'DateTime', resolve: (s) => ((s.pull as PullRequest).state === 'closed' ? FIXED_ISO : null) },
      merged: { type: 'Boolean', resolve: (s) => (s.pull as PullRequest).merged },
      mergedAt: { type: 'DateTime', resolve: (s) => (s.pull as PullRequest).mergedAt },
      mergeable: { type: 'MergeableState', resolve: (s) => prMergeable(s.repo as Repo, s.pull as PullRequest) },
      baseRefName: { type: 'String', resolve: (s) => (s.pull as PullRequest).base },
      headRefName: { type: 'String', resolve: (s) => (s.pull as PullRequest).head },
      baseRefOid: { type: 'GitObjectID', resolve: (s) => (s.pull as PullRequest).baseSha },
      headRefOid: { type: 'GitObjectID', resolve: (s) => (s.pull as PullRequest).headSha },
      url: { type: 'URI', resolve: (s) => `https://github.com/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/pull/${(s.pull as PullRequest).number}` },
      repository: { type: 'Repository', resolve: (s, _a, ctx) => repoObject(s.repo as Repo, ctx) },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (s, args) => {
          const pull = s.pull as PullRequest;
          const repo = s.repo as Repo;
          const paths = pullChangedPaths(repo, pull);
          return makeConnection(
            paths.map((path, i) => ({ key: i + 1, node: { __typename: 'PullRequestChangedFile', path } })),
            args,
          );
        },
      },
      labels: {
        type: 'LabelConnection',
        resolve: (_s, args) => makeConnection([], args),
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (s, args) => {
          const pull = s.pull as PullRequest;
          const repo = s.repo as Repo;
          const issue = getIssue(repo, pull.number);
          const comments = issue ? (repo.comments.get(issue.number) ?? []) : [];
          return makeConnection(comments.map((c) => ({ key: c.id, node: commentObject(c, repo, issue!) })), args);
        },
      },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('IssueComment', (s.repo as Repo).id, (s.issue as Issue).number, (s.comment as Comment).id) },
      body: { type: 'String', resolve: (s) => (s.comment as Comment).body },
      author: { type: 'Actor', resolve: (s, _a, ctx) => userObject(VIEWER_LOGIN, ctx) },
      createdAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      updatedAt: { type: 'DateTime', resolve: () => FIXED_ISO },
      url: { type: 'URI', resolve: (s) => `https://github.com/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/issues/${(s.issue as Issue).number}#issuecomment-${(s.comment as Comment).id}` },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('Label', (s.repo as Repo).id, s.name as string) },
      name: { type: 'String', resolve: (s) => s.name },
      color: { type: 'String', resolve: (s) => (s.repo as Repo).labels.get(s.name as string)?.color ?? 'ededed' },
      description: { type: 'String', resolve: () => '' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: (s) => s.name },
      target: { type: 'GitObject', resolve: (s) => s.target },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      oid: { type: 'GitObjectID', resolve: (s) => s.oid },
      message: { type: 'String', resolve: () => '' },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: { type: 'Int', resolve: (s) => s.limit },
      cost: { type: 'Int', resolve: (s) => s.cost },
      remaining: { type: 'Int', resolve: (s) => s.remaining },
      resetAt: { type: 'DateTime', resolve: (s) => s.resetAt },
    },
  },
  License: {
    kind: 'OBJECT',
    fields: {
      key: { type: 'String', resolve: (s) => s.key },
      name: { type: 'String', resolve: (s) => s.name },
      spdxId: { type: 'String', resolve: (s) => s.spdxId },
    },
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[SearchResultItem]', resolve: (s) => s.nodes },
      edges: { type: '[SearchResultItemEdge]', resolve: (s) => s.edges },
      pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { type: 'Int', resolve: (s) => s.totalCount },
    },
  },
  SearchResultItemEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'SearchResultItem', resolve: (s) => s.node },
      cursor: { type: 'String', resolve: (s) => s.cursor },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]', resolve: (s) => s.nodes },
      edges: { type: '[IssueEdge]', resolve: (s) => s.edges },
      pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { type: 'Int', resolve: (s) => s.totalCount },
    },
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'Issue', resolve: (s) => s.node },
      cursor: { type: 'String', resolve: (s) => s.cursor },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]', resolve: (s) => s.nodes },
      edges: { type: '[PullRequestEdge]', resolve: (s) => s.edges },
      pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { type: 'Int', resolve: (s) => s.totalCount },
    },
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'PullRequest', resolve: (s) => s.node },
      cursor: { type: 'String', resolve: (s) => s.cursor },
    },
  },
  RepositoryConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Repository]', resolve: (s) => s.nodes },
      edges: { type: '[RepositoryEdge]', resolve: (s) => s.edges },
      pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { type: 'Int', resolve: (s) => s.totalCount },
    },
  },
  RepositoryEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'Repository', resolve: (s) => s.node },
      cursor: { type: 'String', resolve: (s) => s.cursor },
    },
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Label]', resolve: (s) => s.nodes },
      edges: { type: '[LabelEdge]', resolve: (s) => s.edges },
      pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { type: 'Int', resolve: (s) => s.totalCount },
    },
  },
  LabelEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'Label', resolve: (s) => s.node },
      cursor: { type: 'String', resolve: (s) => s.cursor },
    },
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[IssueComment]', resolve: (s) => s.nodes },
      edges: { type: '[IssueCommentEdge]', resolve: (s) => s.edges },
      pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { type: 'Int', resolve: (s) => s.totalCount },
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment', resolve: (s) => s.node },
      cursor: { type: 'String', resolve: (s) => s.cursor },
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: { type: 'IssueCommentEdge', resolve: (s) => s.commentEdge },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (s) => s.issue },
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (s) => s.issue },
    },
  },
  ReopenIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (s) => s.issue },
    },
  },
  UpdateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (s) => s.issue },
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (s) => s.pullRequest },
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (s) => s.pullRequest },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String', resolve: (s) => s.path },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]', resolve: (s) => s.nodes },
      edges: { type: '[PullRequestChangedFileEdge]', resolve: (s) => s.edges },
      pageInfo: { type: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { type: 'Int', resolve: (s) => s.totalCount },
    },
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'PullRequestChangedFile', resolve: (s) => s.node },
      cursor: { type: 'String', resolve: (s) => s.cursor },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (s) => s.hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: (s) => s.hasPreviousPage },
      startCursor: { type: 'String', resolve: (s) => s.startCursor },
      endCursor: { type: 'String', resolve: (s) => s.endCursor },
    },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'] },
  ID: { kind: 'SCALAR' },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  Node: { kind: 'OBJECT', fields: { id: { type: 'ID', resolve: (s) => (s as any).id ?? '' } } },
  Actor: { kind: 'OBJECT', fields: {} },
  RepositoryOwner: { kind: 'OBJECT', fields: {} },
  GitObject: { kind: 'OBJECT', fields: {} },
  SearchResultItem: { kind: 'OBJECT', fields: {} },
};

// Unwrap a type name: strip [ ], ! to get the named type.
function namedType(t: string): string {
  return t.replace(/[\[\]!]/g, '');
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

function typeRef(t: string): Record<string, unknown> {
  // Build a __Type reference for a (possibly wrapped) type name.
  if (t.endsWith('!')) {
    return { kind: 'NON_NULL', name: null, ofType: typeRef(t.slice(0, -1)) };
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return { kind: 'LIST', name: null, ofType: typeRef(t.slice(1, -1)) };
  }
  const def = SCHEMA[t];
  return { kind: def ? def.kind : 'OBJECT', name: t, ofType: null };
}

function introspectionType(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (!def) return null;
  const out: Record<string, unknown> = {
    kind: def.kind,
    name,
    description: def.description ?? null,
    fields: null,
    inputFields: null,
    interfaces: [],
    enumValues: null,
    possibleTypes: null,
  };
  if (def.kind === 'OBJECT') {
    out.fields = Object.entries(def.fields ?? {}).map(([fname, fdef]) => ({
      name: fname,
      description: null,
      args: [],
      type: typeRef(fdef.type),
      isDeprecated: false,
      deprecationReason: null,
    }));
  }
  if (def.kind === 'ENUM') {
    out.enumValues = (def.enumValues ?? []).map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }));
  }
  return out;
}

function introspectionSchema(): Record<string, unknown> {
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    subscriptionType: null,
    types: Object.keys(SCHEMA).sort().map((n) => introspectionType(n)),
    directives: [
      { name: 'include', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', description: null, type: typeRef('Boolean!'), defaultValue: null }] },
      { name: 'skip', description: null, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', description: null, type: typeRef('Boolean!'), defaultValue: null }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecState {
  doc: DocumentNode;
  variables: Record<string, unknown>;
  ctx: GqlCtx;
  errors: { message: string; path?: (string | number)[] }[];
}

function executeSelections(
  state: ExecState,
  typeName: string,
  source: unknown,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'FragmentSpread') {
      if (!directiveApplies(sel.directives, state.variables)) continue;
      const frag = state.doc.fragments.get(sel.name);
      if (!frag) {
        state.errors.push({ message: `Unknown fragment "${sel.name}"`, path });
        continue;
      }
      if (frag.typeCondition !== typeName && frag.typeCondition !== 'Node' && frag.typeCondition !== 'Actor' && frag.typeCondition !== 'RepositoryOwner' && frag.typeCondition !== 'SearchResultItem' && frag.typeCondition !== 'GitObject') {
        continue;
      }
      Object.assign(out, executeSelections(state, typeName, source, frag.selectionSet, path));
      continue;
    }
    if (sel.kind === 'InlineFragment') {
      if (!directiveApplies(sel.directives, state.variables)) continue;
      if (sel.typeCondition && sel.typeCondition !== typeName && sel.typeCondition !== 'Node' && sel.typeCondition !== 'Actor' && sel.typeCondition !== 'RepositoryOwner' && sel.typeCondition !== 'SearchResultItem' && sel.typeCondition !== 'GitObject') {
        continue;
      }
      Object.assign(out, executeSelections(state, typeName, source, sel.selectionSet, path));
      continue;
    }
    // Field.
    if (!directiveApplies(sel.directives, state.variables)) continue;
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (sel.name === '__schema') {
      if (typeName !== 'Query') {
        state.errors.push({ message: `Cannot query field "__schema" on type "${typeName}"`, path: fieldPath });
        continue;
      }
      out[key] = executeSelections(state, '__Schema', introspectionSchema(), sel.selectionSet ?? [], fieldPath);
      continue;
    }
    if (sel.name === '__type') {
      if (typeName !== 'Query') {
        state.errors.push({ message: `Cannot query field "__type" on type "${typeName}"`, path: fieldPath });
        continue;
      }
      const args = resolveArgs(sel, state.variables);
      const t = introspectionType(String(args.name ?? ''));
      out[key] = t === null ? null : executeSelections(state, '__Type', t, sel.selectionSet ?? [], fieldPath);
      continue;
    }
    const def = SCHEMA[typeName];
    const fieldDef = def?.fields?.[sel.name];
    if (!fieldDef) {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}"`, path: fieldPath });
      continue;
    }
    let value: unknown;
    try {
      const args = resolveArgs(sel, state.variables);
      value = fieldDef.resolve ? fieldDef.resolve(source, args, state.ctx) : (source as any)?.[sel.name];
    } catch (e) {
      state.errors.push({ message: e instanceof Error ? e.message : String(e), path: fieldPath });
      out[key] = null;
      continue;
    }
    const childType = namedType(fieldDef.type);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (sel.selectionSet) {
      const childDef = SCHEMA[childType];
      if (childDef && childDef.kind === 'OBJECT') {
        const runtimeType = (value as any).__typename ?? childType;
        // For interface/union-ish abstract types (Node, Actor, ...), the
        // runtime type comes from the value.
        const effectiveType = runtimeType === childType || SCHEMA[runtimeType] ? runtimeType : childType;
        if (Array.isArray(value)) {
          out[key] = value.map((v, idx) => executeSelections(state, effectiveType, v, sel.selectionSet!, [...fieldPath, idx]));
        } else {
          out[key] = executeSelections(state, effectiveType, value, sel.selectionSet, fieldPath);
        }
      } else if (Array.isArray(value)) {
        out[key] = value.map((v) => v);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Introspection pseudo-types (__Schema/__Type/...) are resolved generically.
function executeIntrospectionSelections(
  state: ExecState,
  typeName: string,
  source: Record<string, unknown>,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind !== 'Field') continue;
    if (!directiveApplies(sel.directives, state.variables)) continue;
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const value = (source as any)[sel.name];
    if (value === undefined) {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}"`, path: fieldPath });
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (!sel.selectionSet) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const childType = typeName === '__Schema' && sel.name === 'types' ? '__Type' : typeName === '__Schema' && sel.name === 'directives' ? '__Directive' : '__Type';
      out[key] = value.map((v, idx) => {
        if (v === null) return null;
        if (typeof v === 'object') return executeIntrospectionSelections(state, childType, v as Record<string, unknown>, sel.selectionSet!, [...fieldPath, idx]);
        return v;
      });
      continue;
    }
    if (typeof value === 'object') {
      const childType = sel.name === 'queryType' || sel.name === 'mutationType' || sel.name === 'subscriptionType' ? '__Type' : sel.name === 'ofType' ? '__Type' : '__Type';
      out[key] = executeIntrospectionSelections(state, childType, value as Record<string, unknown>, sel.selectionSet!, fieldPath);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// Patch: route __Schema/__Type selections through the generic executor.
const origExecuteSelections = executeSelections;

export function executeGraphQL(
  ctx: GqlCtx,
  body: unknown,
): { data?: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } {
  const payload = body as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  if (!payload || typeof payload.query !== 'string') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(payload.query).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  let op = doc.operations[0];
  if (payload.operationName) {
    const named = doc.operations.find((o) => o.name === payload.operationName);
    if (!named) return { errors: [{ message: `Unknown operation named "${payload.operationName}"` }] };
    op = named;
  }
  if (!op) return { errors: [{ message: 'No operation provided.' }] };
  const variables: Record<string, unknown> = { ...(payload.variables ?? {}) };
  for (const vd of op.variableDefinitions) {
    if (!(vd.name in variables) && vd.defaultValue) {
      variables[vd.name] = resolveValue(vd.defaultValue, variables);
    }
  }
  const state: ExecState = { doc, variables, ctx, errors: [] };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  // Introspection selections are handled by a wrapper: executeSelections
  // delegates __Schema/__Type objects to the introspection executor.
  const data = executeSelectionsWithIntrospection(state, rootType, {}, op.selectionSet, []);
  return state.errors.length > 0 ? { data, errors: state.errors } : { data };
}

function executeSelectionsWithIntrospection(
  state: ExecState,
  typeName: string,
  source: unknown,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  if (typeName === '__Schema' || typeName === '__Type' || typeName === '__Field' || typeName === '__InputValue' || typeName === '__EnumValue' || typeName === '__Directive') {
    return executeIntrospectionSelections(state, typeName, source as Record<string, unknown>, selections, path);
  }
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'FragmentSpread') {
      if (!directiveApplies(sel.directives, state.variables)) continue;
      const frag = state.doc.fragments.get(sel.name);
      if (!frag) {
        state.errors.push({ message: `Unknown fragment "${sel.name}"`, path });
        continue;
      }
      if (frag.typeCondition !== typeName && !['Node', 'Actor', 'RepositoryOwner', 'SearchResultItem', 'GitObject'].includes(frag.typeCondition)) continue;
      Object.assign(out, executeSelectionsWithIntrospection(state, typeName, source, frag.selectionSet, path));
      continue;
    }
    if (sel.kind === 'InlineFragment') {
      if (!directiveApplies(sel.directives, state.variables)) continue;
      if (sel.typeCondition && sel.typeCondition !== typeName && !['Node', 'Actor', 'RepositoryOwner', 'SearchResultItem', 'GitObject'].includes(sel.typeCondition)) continue;
      Object.assign(out, executeSelectionsWithIntrospection(state, typeName, source, sel.selectionSet, path));
      continue;
    }
    if (!directiveApplies(sel.directives, state.variables)) continue;
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (sel.name === '__schema') {
      if (typeName !== 'Query') {
        state.errors.push({ message: `Cannot query field "__schema" on type "${typeName}"`, path: fieldPath });
        continue;
      }
      out[key] = executeSelectionsWithIntrospection(state, '__Schema', introspectionSchema(), sel.selectionSet ?? [], fieldPath);
      continue;
    }
    if (sel.name === '__type') {
      if (typeName !== 'Query') {
        state.errors.push({ message: `Cannot query field "__type" on type "${typeName}"`, path: fieldPath });
        continue;
      }
      const args = resolveArgs(sel, state.variables);
      const t = introspectionType(String(args.name ?? ''));
      out[key] = t === null ? null : executeSelectionsWithIntrospection(state, '__Type', t, sel.selectionSet ?? [], fieldPath);
      continue;
    }
    const def = SCHEMA[typeName];
    const fieldDef = def?.fields?.[sel.name];
    if (!fieldDef) {
      state.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}"`, path: fieldPath });
      continue;
    }
    let value: unknown;
    try {
      const args = resolveArgs(sel, state.variables);
      value = fieldDef.resolve ? fieldDef.resolve(source, args, state.ctx) : (source as any)?.[sel.name];
    } catch (e) {
      state.errors.push({ message: e instanceof Error ? e.message : String(e), path: fieldPath });
      out[key] = null;
      continue;
    }
    const childType = namedType(fieldDef.type);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (sel.selectionSet) {
      const childDef = SCHEMA[childType];
      if (childDef && childDef.kind === 'OBJECT') {
        if (Array.isArray(value)) {
          out[key] = value.map((v, idx) => {
            const rt = (v as any)?.__typename ?? childType;
            return executeSelectionsWithIntrospection(state, rt, v, sel.selectionSet!, [...fieldPath, idx]);
          });
        } else {
          const rt = (value as any)?.__typename ?? childType;
          out[key] = executeSelectionsWithIntrospection(state, rt, value, sel.selectionSet, fieldPath);
        }
      } else if (Array.isArray(value)) {
        out[key] = value.map((v) => v);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

export { origExecuteSelections };
