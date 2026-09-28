# Draftroom

A Miro-style collaborative board for creative teams: live multi-user canvas, sticky notes, frames, connectors, files with previews, and (coming) comments, templates, facilitation tools and sharing.

Built on [tldraw](https://tldraw.dev) 5.4.2 with its native sync engine, one SQLite database per board, and a separate preview worker. Plan and decisions: [`docs/Miro_Clone_Build_Plan.md`](docs/Miro_Clone_Build_Plan.md) · progress: [`docs/PROGRESS.md`](docs/PROGRESS.md) · engine evidence: [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md).

## Run it locally

Requires Node 24 LTS, pnpm 10, and ffmpeg/ffprobe on PATH.

```bash
pnpm install
pnpm fixtures
pnpm dev
```

Open http://127.0.0.1:5173. Local development uses explicit **dev identities** (no passwords) that exist only behind the `DRAFTROOM_DEV_AUTH=1` guard in `dev.env` files — never in a deployment. Manual walkthrough: [`docs/DEMO.md`](docs/DEMO.md).

## Checks

```bash
pnpm e2e:install
pnpm verify
```

`verify` runs Biome, TypeScript on every package, vitest (unit + protocol tests against the real sync server) and Playwright (two-browser e2e including server kill/restart and network interruption).

## Layout

| Path | What |
|---|---|
| `apps/web` | React + Vite client (tldraw canvas, file cards, board chrome) |
| `apps/sync` | Node WebSocket server: one tldraw room per board, SQLite persistence, text-edit lease |
| `apps/api` | Fastify API: accounts, workspaces, boards, permissions, files (streamed to the blob store, metadata in Postgres), preview-job routes for workers |
| `apps/worker` | Preview worker: image thumbnails, PDF pages, MP4 posters. An HTTP client of the api (`/api/worker/*`); holds no database or storage credentials |
| `packages/canvas-schema` | Custom shape schema + migrations shared by client and server |
| `packages/blob-store` | Object storage: a local directory (dev, e2e) or Cloudflare R2 (staging) |
| `packages/dev-assets` | Asset types, ids, limits and URL builders; the worker's local scratch layout |
| `deploy/nas` | Deploys a preview worker to the NAS |
| `e2e` | Playwright suites |
| `docs` | Plan, contracts, research, feasibility, progress |

## License note

tldraw requires a commercial license key for production deployments; without one the editor stops rendering on HTTPS hosts. Local development is unaffected (shows a watermark).
