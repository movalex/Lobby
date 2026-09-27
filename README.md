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
| `apps/api` | Fastify API: accounts, workspaces, boards, permissions, files (milestone 1) |
| `apps/worker` | Preview worker: image thumbnails, PDF pages, MP4 posters |
| `packages/canvas-schema` | Custom shape schema + migrations shared by client and server |
| `packages/dev-assets` | Local file store + preview job queue (stand-in for object storage) |
| `e2e` | Playwright suites |
| `docs` | Plan, contracts, research, feasibility, progress |

## License note

tldraw requires a commercial license key for production deployments; without one the editor stops rendering on HTTPS hosts. Local development is unaffected (shows a watermark).
