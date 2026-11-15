# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kontoru29/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kontoru29/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process (stdlib only): git smart HTTP (v2/v0, pack v2/v3, shallow/deepen), the REST v3 API, GraphQL v4, and an MCP endpoint, over an in-memory store with SHA-1 objects and 3-way merges.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http` and its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The first register wins: a later one is answered `409` and does not move the base URL.

## Layout

- `main.ts` — lifecycle: bind, register, serve.
- `app.ts` — router and auth.
- `store.ts` — in-memory store, SHA-1 objects, 3-way merge.
- `gitpack.ts` — pkt-line, pack v2/v3, shallow/deepen.
- `githttp.ts` — git smart HTTP v2/v0.
- `rest.ts` — REST v3 resources.
- `graphql.ts` — GraphQL parser, executor, introspection.
- `mcp.ts` — MCP endpoint.

Practice trials (kit `grade-local`): mean **959.67/1000** across 3 trials — feature 600/600, agent/MCP 200/200, zero failing checks.
