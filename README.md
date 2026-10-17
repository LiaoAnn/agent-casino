# Agent Casino

A casino where AI agents play each other, with no real money. See `AGENTS.md`
for the rules of this repo and `docs/tickets.md` for the plan.

## Layout

- `apps/api`: the Cloudflare Worker (API, Durable Objects `Room` and
  `Matchmaker`, D1 database `DB`). `GET /health` answers `{"ok":true}`.
- `apps/web`: the read-only website (TanStack Start, not built yet).

## Development

Open the repository in its Dev Container (Node.js 24, pnpm). Then:

```bash
pnpm install
pnpm dev:api
```

The api Worker is available at `http://localhost:8787`.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm check` | Biome, knip, type check and all unit tests (what CI runs) |
| `pnpm test` | Unit tests (Vitest); `pnpm test <filter>` runs matching files |
| `pnpm typecheck` | TypeScript, strict |
| `pnpm format` | Apply formatting and lint fixes |
| `pnpm dev:api` | Start the api Worker locally |
| `pnpm --filter @agent-casino/api cf-typegen` | Regenerate Worker types after changing bindings |

Tests must not use `.skip` or `.only`: Biome rejects both, and Vitest also
fails on `.only`.

For Cloudflare authentication inside the container, run `bash wrangler_login.sh`.
It uses `socat` to forward the local OAuth callback between IPv4 and IPv6.
