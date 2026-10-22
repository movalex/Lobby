# Lobby

Dark Burn Creative's internal collaborative whiteboard. Every DBC project gets its own **lobby**, which holds that project's **boards**: a Miro-style live multi-user canvas with sticky notes, frames, connectors, files with previews, comments, templates, facilitation tools and sharing.

## Naming

The product is **Lobby** (the sign-in lockup reads "DBC Lobby"); boards stay "boards". The code keeps its original code name **draftroom** wherever renaming would break something or buy nothing: the repository, package names (`@draftroom/*`), environment variables (`DRAFTROOM_*`), the `dr_session` cookie, the `dr-` CSS prefix, `draftroom:*` localStorage keys, document meta keys, the `draftroom-board` archive format, hostnames and database ids. Board exports download as `<title>.lobby.json`; files exported before the rename (`<title>.draftroom.json`) still import under their own title. Brand artwork lives in `apps/web/src/brand/Wordmark.tsx` (inline mark), `apps/web/public/favicon.svg` (tile icon; PNGs via `node apps/web/scripts/make-icons.mjs`) and `apps/web/public/brand/lobby-hero.svg` (sign-in hero).

Built on [Excalidraw](https://github.com/excalidraw/excalidraw) (a pinned nightly; it replaced tldraw on 2026-10-01) with Lobby's own element sync server, one SQLite database per board, and a separate preview worker. Plan and decisions: [`docs/Miro_Clone_Build_Plan.md`](docs/Miro_Clone_Build_Plan.md) · progress: [`docs/PROGRESS.md`](docs/PROGRESS.md) · engine evidence: [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md).

## For developers

- **Start here:** [`docs/DEVELOPER-HANDOFF.md`](docs/DEVELOPER-HANDOFF.md): the codebase map, running it, the architecture, the rules not to break, how sign-in works and where Okta/Entra plugs in, testing, deploys and kill switches.
- **Binding rules:** [`AGENTS.md`](AGENTS.md).
- **Going live on DBC's Azure** (Okta and Microsoft sign-in): [`docs/GO-LIVE-AZURE.md`](docs/GO-LIVE-AZURE.md).
- **Today's staging deploy:** [`docs/DEPLOY.md`](docs/DEPLOY.md). **History:** [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/CUTOVER-LOG.md`](docs/CUTOVER-LOG.md).
- **For the people using it:** [`docs/team/Welcome-to-Lobby.md`](docs/team/Welcome-to-Lobby.md).

## Run it locally

Requires Node 24 LTS, pnpm 10, and ffmpeg/ffprobe on PATH.

```bash
pnpm install
pnpm fixtures
pnpm dev
```

Open http://127.0.0.1:5173. Local development uses explicit **dev identities** (no passwords) that exist only behind the `DRAFTROOM_DEV_AUTH=1` guard in `dev.env` files — never in a deployment. `pnpm dev` creates each app's `dev.env` from its `dev.env.example` on first run; `dev.env` is ignored by git. Manual walkthrough: [`docs/DEMO.md`](docs/DEMO.md).

## Checks

```bash
pnpm e2e:install
pnpm verify
```

`verify` runs Biome, TypeScript on every package, vitest (unit + protocol tests against the real sync server) and Playwright (two-browser e2e including server kill/restart and network interruption).

## Layout

| Path | What |
|---|---|
| `apps/web` | React + Vite client (the Excalidraw canvas behind `apps/web/src/canvas`, file cards, board chrome, features) |
| `apps/sync` | Node WebSocket server: one element room per board (the canvas authority), SQLite persistence, text-edit lease, signed backups |
| `apps/api` | Fastify API: accounts, workspaces, boards, permissions, files (streamed to the blob store, metadata in Postgres), preview-job routes for workers |
| `apps/worker` | Preview worker: image thumbnails, PDF/Office/PSD/TIFF pages, video posters, and file ops (text extraction, deck pages, background removal). An HTTP client of the api (`/api/worker/*`); holds no database or storage credentials |
| `packages/canvas-schema` | Element schemas, invariants, limits, the wire protocol and migrations shared by client and server |
| `packages/blob-store` | Object storage: a local directory (dev, e2e) or Cloudflare R2 (staging) |
| `packages/dev-assets` | Asset types, ids, limits and URL builders; the worker's local scratch layout |
| `packages/*` (others) | contracts, db, permissions, auth tickets, board ops, archives, templates, icon sets, Miro and tldraw importers: one line each in [`docs/DEVELOPER-HANDOFF.md`](docs/DEVELOPER-HANDOFF.md) |
| `deploy/nas` | Deploys a preview worker to the NAS (and the separate theater Lobby) |
| `e2e` | Playwright suites |
| `docs` | Plan, contracts, research, feasibility, progress |

## License note

No production dependency may need a paid licence or carry a copyleft licence (`pnpm licence:check`). tldraw is no longer used at run time; the only tldraw code left is its MIT data packages inside `packages/tldraw-import`, which converts old boards.
