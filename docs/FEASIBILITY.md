# Milestone 0 feasibility report: tldraw 5.4.2 + native sync

Date: 2026-09-26 · Machine: Windows 11, Node 24.19.0 (32-core workstation — timings will be slower on Render) · Detailed engine facts with source citations: `docs/research/SYNTHESIS.md`.

## Recommendation

**The engine is suitable. Proceed to the dashboard and integrations** — with three conditions that are business/product decisions, not engineering blockers:

1. **License before any real deployment.** tldraw is free on localhost (watermark). On any HTTPS host without a domain-matching key the editor **goes blank after 5 s**, and the internal pilot counts as production. Price is quote-only. Get the quote before the pilot; if it is unacceptable, the fallback is Excalidraw with a narrower media scope (§8).
2. **Same-note typing is lease-based in v1.** Native sync replaces a note's whole rich-text document per keystroke, so two people typing in one note lose characters. We ship a server-enforced 5 s text lease (proven below). Character-level co-editing is a separate, later enhancement.
3. **Undo is per-record, not per-property.** Undoing your own change to a shape also reverts other people's later changes to that same shape (and can restore a shape someone else deleted). This is native behavior; it is documented and pinned by a test. A per-prop undo filter or server veto is a milestone-2 candidate.

Everything the prototype needed from the engine — shared editing, presence, durable per-board persistence, reconnect semantics, a custom shape with a shared schema and migrations, read-only enforcement, and a plug-in point for server-side write authorization — exists, works, and is verified below.

## Versions (pinned in `pnpm-workspace.yaml` catalog)

tldraw / @tldraw/sync / @tldraw/sync-core / @tldraw/tlschema / @tldraw/validate / @tldraw/assets **5.4.2** (lockstep) · React 19.3.0 · Vite 8.3.1 · TypeScript 7.0.2 · vitest 5.0.2 · Playwright 1.63.0 · ws 8.21.3 · node:sqlite (Node 24.19, no flag) · sharp 0.35.4 · pdfjs-dist 6.3.289 + @napi-rs/canvas 1.0.9 · ffmpeg/ffprobe 9.0.1 (system) · Biome 2.5.14. Supply-chain guards: `minimumReleaseAge` 24 h, `strictDepBuilds`, no dependency needs an install script.

## Verification summary (actual results, this machine)

`pnpm verify` = Biome lint (0 errors) + `tsc` on all 11 projects + vitest (**183 passed**, 1 POSIX-only test skipped) + Playwright (**10/10**). The e2e suite passed 3 consecutive runs; the lease test passed 20/20 with `--repeat-each`; the protocol suite passed 3 serial runs and 3 concurrent runs. Mutation checks on the sync server (37 mutants) and worker confirmed the tests fail when the guarded behavior is removed.

| # | Demonstration | Result | Evidence |
|---|---|---|---|
| 1 | Two sessions see each other and their edits | **Pass.** Presence list + collaborator cursors; notes typed through the real editor; text; a frame with children; an arrow bound to two shapes (moving a bound shape moves the arrow on the other client); an uploaded image resolved to a board-scoped derivative; local undo/redo propagating | `e2e/tests/collab-lifecycle.spec.ts` step 1 |
| 2 | Reload preserves content | **Pass.** Record-for-record identical document after reloading both tabs | `collab-lifecycle.spec.ts` step 2 |
| 3 | Killed/restarted server keeps acknowledged changes | **Pass.** Browser: SIGKILL after the peer rendered an edit → restart → fresh context sees it; clients go offline → online. Protocol: SIGKILL mid-stream, 3 rounds, **0 acked-but-missing**; graceful stop likewise | `collab-lifecycle.spec.ts` step 3; `apps/sync/test/protocol/durability.test.ts` |
| 4 | Network interruption does not restore an old board | **Pass.** A goes offline (Playwright `setOffline`), B edits, A edits another shape; on reconnect both converge and B's edits survive. The client never uploads a snapshot; it re-sends only fields it changed | `e2e/tests/network-interruption.spec.ts`; `protocol/reconnect.test.ts` |
| 5 | Same-note typing, edit/delete, undo after remote edit | **Documented + mitigated.** Text lease: bob cannot type into alice's note while she types (his change reverts, he sees "alice is editing this text" and an editing badge), he can still move it, his delete is vetoed, he can edit after expiry, lease released when alice leaves. Without a lease, crossing edits lose characters (pinned). Edit vs delete: delete wins in both orders. Undo after remote edit: reverts the other user's prop (pinned as a documented limitation) | `e2e/tests/conflicts.spec.ts`; `protocol/text-lease.test.ts`, `protocol/conflicts.test.ts` |
| 6 | Custom file-card shape with one shared schema + migration | **Pass.** `packages/canvas-schema` (React-free) is the server schema and the client ShapeUtil's props/migrations; a CI test asserts client and server schemas serialize identically. Migration `AddPosterDerivativeId`: v0 database migrated on load; older client served down-migrated records; newer client refused with `SERVER_TOO_OLD` | `packages/canvas-schema/src/*.test.ts`, `apps/web/src/schema.test.ts`, `protocol/schema.test.ts`, `e2e/tests/files.spec.ts` step 6 |
| 7 | Image, multipage PDF, short MP4 → usable previews, outside the sync loop | **Pass.** Upload → separate worker process → derivatives → cards update on both clients: PDF cover + "4 pages" + page strip; MP4 poster + duration, plays the original in Chrome; encrypted PDF fails with a readable message and keeps the download; a ZIP becomes an attachment card | `e2e/tests/files.spec.ts` step 7; `apps/worker/test/*.test.ts`; `docs/screenshots/file-cards-ready.png`, `video-playing.png` |

Screenshots from the final run: `docs/screenshots/` (two-browser collaboration, ready file cards, lease toast, offline state, video playback).

## Durability and persistence

- One SQLite database per board (`rooms/board-<id>.sqlite`) under the configurable `DRAFTROOM_DATA_DIR`; one `TLSocketRoom` per board per process, created synchronously (race-free — 20 simultaneous first connections share one room and one file).
- Each push is committed in one synchronous SQLite transaction **before** the server acknowledges or broadcasts it, so an acknowledgement is a persistence guarantee for process crashes. We set `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000` (the library sets none). Commit cost ≈0.9 ms on local NVMe; the synchronous fsync blocks the event loop, so Render disk latency must be measured in milestone 1.
- Not yet proven: OS crash / power loss (only process kill was tested), backups/restore drills (milestone 4).

## Hazards found in tldraw's own example wiring (fixed here; re-check on every upgrade)

1. Tombstone-prune timer throws after `db.close()` within 1 s of a delete and **kills the process** → `pruneTombstones.flush()` before close (`@internal` API).
2. Raw `ws` passed to `handleSocketConnect` lets a stale socket's late `close` kill the reconnected session → wrapper without `addEventListener` + current-socket guard.
3. Mixed-case board ids open two rooms on one file on case-insensitive filesystems → lowercase-only ids.
4. `new SQLiteSyncStorage({ snapshot })` on an existing database **wipes it** → never pass a snapshot to an initialized board.
5. No built-in size/rate limits (a 5 M-character record was accepted) → `maxPayload` 1 MiB, chunk-count cap, per-session token bucket.

## File handling (milestone-0 path)

Uploads stream to disk with size caps and hashing; a separate worker claims jobs by atomic rename, processes in killable child processes with timeouts, and writes derivatives before the metadata that references them. Canvas records hold only stable ids (`/files/<ast>/<ver>/original`, never URLs with hosts, signatures or base64). Negative fixtures produce specific, user-safe failures: decompression bomb, SVG (never rasterized), encrypted/garbage/truncated PDF, HEVC, truncated or disguised MP4. Measured on this machine: the whole fixture set processes in a few seconds; all timings are workstation numbers.

Limits of the prototype: previews are eager for PDF pages 1–8 only (lazy pages are milestone 3); video integrity is a container box scan, not a full decode; MP4 playback in e2e needs branded Chrome (the Playwright headless shell lacks H.264); the file store is local disk standing in for private object storage.

## Known limitations and open items

- **License** price/terms unresolved (questions for tldraw sales: `docs/research/license.md` §10). Commenting is a separate paid tldraw module — we build our own comments in Postgres.
- **Offline edits live in memory**: a reload while offline loses them. The UI says so ("kept in this tab only until reconnect") and never shows "Saved".
- **Last writer wins** for the same property, including a field changed on both sides while one client was offline (pinned by a test). Acceptable for canvas geometry; the text lease covers rich text.
- **An older client's patch to a file card resets `posterDerivativeId` to null** (down/up migration round-trip; pinned). Keep new props derivable, or deploy clients promptly after the server.
- **`user:` records** (name, color) persist in the board document when attribution is stamped — a retention consideration for milestone 1.
- **Windows-only caveats**: catchable SIGINT/SIGTERM can't be delivered to child processes (tests use an IPC shim that runs the same handlers); `node --watch` restarts kill the worker abruptly and its claim is requeued after 120 s.
- **Not covered yet**: non-Chromium browsers, OS-crash durability, load (20 editors / 2,000+ objects), Render disk latency.

## Reproduce

```bash
pnpm install
pnpm e2e:install
pnpm fixtures
pnpm verify
```

Manual demo: see `docs/DEMO.md`.
