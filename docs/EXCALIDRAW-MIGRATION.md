# Lobby canvas migration: tldraw → Excalidraw (revised plan)

Status: **plan, spike A done, spike B next. Revision 3.2**, written 2026-09-29. It folds in spike A's results (`spike/excalidraw` at 5203e41, `docs/research/excalidraw/SPIKE-A-REPORT.md`), the owners' and the integration's plan corrections and the independent verifier's result, closes open items 3–7, and adds the spike B execution plan (§8.6). Revision 3.1 was revision 3 plus the tracked open items, written 2026-09-28 against `integration/wave3` at 715b0fb (the deployed build is 5fe35f2). Revision 2 replaced the first draft and applied every "must" and "should" item from the review (`critique.json`), and most "could" items. Revision 3 applies the recheck of revision 2: its 3 unresolved musts and its 11 new problems. Appendix C maps each review and recheck item to the section that answers it; the table below maps spike A's findings.

The owner decided to move Lobby's canvas from tldraw 5.4.2, which needs a paid production licence, to Excalidraw (MIT), so that Lobby costs no licence fee to run. Hosting still costs money; this plan says where the move changes that (§2.13).

Until the cut-over (§7.5), `docs/research/SYNTHESIS.md` remains the reference for the running tldraw build.

**Inputs.** Four research reports and their scratch probes, plus the review:
- **[API]**: the Excalidraw API report;
- **[SYNC]**: the sync design report;
- **[FEAT]**: the feature-mapping report;
- **[DATA]**: the data-conversion report;
- **[REV]**: the review of the first draft, with its probes `critic/next/probe1.mjs` and `probe2.mjs`.

Tags: **[plan-run]** marks checks from the first draft. **[rev-run]** marks checks I ran for revision 2, against the installed `0.18.0-1118751` packages under `critic/next` and the repo (read-only). **[r3-run]** marks checks run for revision 3, against the same packages and the same repo. **[spike-A]** marks spike A results: measured in the spike's code on `spike/excalidraw` 5203e41, 3 runs each, evidence in `docs/research/excalidraw/spike-a/<check>.md`. **[verify-A]** marks the independent verifier's re-runs and probes of spike A. **[repo]** marks code I read in the repo. **UNVERIFIED** marks anything no one has checked. Evidence paths are in Appendix A.

File shorthand for dist line numbers, all `0.18.0-1118751` `dist/dev`: **X** = `@excalidraw/excalidraw/dist/dev/index.js`, **F** = `…/excalidraw/dist/dev/chunk-FN755BR4.js`, **E** = `@excalidraw/element/dist/dev/index.js`, **C** = `@excalidraw/common/dist/dev/index.js`. Older sections write `index.js:<line>` for X and `element index.js:<line>` for E.

---

## What changed in revision 3.2 (spike A)

Spike A ran A1–A17 in one browser and in Node: **14 PASS, 2 PARTIAL (A12, A14), 1 FAIL as written (A16)** [spike-A]. The verifier reproduced most results and found **two guard bugs in Lobby's own code**, not in the engine (A6, A16) [verify-A]. A fix round is running on `spike/excalidraw` and will be re-verified 3/3 before spike B fans out (§8.6.1). No result hits the §8.5 "stop and re-plan" row.

| Area | Revision 3.1 | Revision 3.2 (evidence) | Where |
|---|---|---|---|
| Keys inside the text editor | Ctrl+S, Cmd+S and Ctrl+Shift+S blocked | **Being fixed.** Ctrl+Alt+S reached the save picker 20/20, because Lobby's save test required no Alt and Excalidraw's key test ignores Alt (X 11606, 25388) [verify-A]. Rule: inside the editor, Ctrl/Cmd/Alt chords are an **allowlist**. Text typed with AltGr (reported as Ctrl+Alt on Windows) and macOS Option still passes. Outside the editor, blocked chords are also `preventDefault`-ed, except browser chords, and Tab is stopped. | §2.3.3 |
| Editor-open guard | Ran only with no Lobby session or in the idle phase | **Being fixed.** An editor opened on note B while A's request was pending was writable with no lease, and text with no keydown landed in it (20/20) [verify-A]. Rule: **any `editingTextElement` that is not the element of a granted lease is unrequested, whatever the session phase**; Lobby's state and the engine's are reconciled on every change. | §2.9.2 |
| Editor-open paths | P3 stopped by `dblclick`; an arrow double-click opens the linear editor | P3 on a label opens on the second pointer-up, so it is P5 and guard-caught (X 51679-51686, 44727). A plain double-click on a simple arrow edits its **label**, leased on the arrow (X 44838-44864); only a line or Ctrl/Cmd+double-click toggles the linear editor (X 44741-44744). Opening the editor re-measures the label's `x` and `width` (X 49918, 25212). The swallowed touchstart is `preventDefault`-ed on every platform. The criterion is "0 ops pushed before the grant". | §2.9.2, §8.2 A16 |
| Bound arrows under a container fit (open item 3) | Open | **Closed.** The server recomputes bound-arrow endpoints whenever it applies a `fit`, in the same clock. The holder never pushes them. They are derived writes under `gclock.fit`. Auto-fit rewrote arrows from the holder's copy (X 49806-49838, 49845, 49864-49868; non-sticky 25133, 25147) [spike-A A17]. | §2.9.4 rule 7, §2.4.3, B3 L6/L10 |
| Lease ordering (item 5) | Lease messages queued at stage 1 only | **Closed.** `lease.acquire` and `lease.release` go through the per-session FIFO at stage 0. | §2.4.3 |
| New-element grant (item 7) | "The server always grants…" | **Closed.** A grant never overrides another session's live lease. | §2.9.2 |
| Drag previews (item 6) | Ids in every frame; not in the budget | **Closed.** Ids once per drag, then dx/dy. Read-only sessions cannot send drags. At L1, about 0.5 MB/s out and 5–20 ms CPU/s. B9 measures it. | §2.7, §2.13, B9 |
| B8 drill stand-in (item 4) | Current tldraw sync, unchanged | **Closed.** The stand-in gets R0's born-after pre-open check and the per-table byte-identity check of `lb_*`. | §8.3 B8, §8.6 |
| Host props | `initialData: null`; "Lobby yellow" undefined | `initialData` carries the `appState` defaults and no elements. The note default is Butter `#f8e48f`. Readiness is `onInitialize` (X 49441), not `onExcalidrawAPI` (X 49154). Read-only roles get their tool through `appState.activeTool`, because `setActiveTool` refuses every tool but laser and custom for them (X 44343-44350). | §2.3.2, §2.3.4 |
| Fonts, hosts, CSP | The esm.sh rewrite was one of three layers; a fixed host list; the CSP as drafted | The font fallback must be **same-origin**: every font has an esm.sh source (F 1225-1249, 1277), and Chrome checks CSP when a FontFace is constructed (230 violations otherwise). The static host must 404 under `/excalidraw-assets/`. Every URL host in the engine's 266-package tree is rewritten and verified at build time. The server accepts `fontFamily` 5, 6 and 8 only. The inline theme script moves to a file, zod runs `jitless`, and SVG export does not use Excalidraw's font inlining, so the CSP needs **no `unsafe-eval`** (decided). | §2.12, §3.5 |
| Server text layout (A3) | A per-character width table | Per-character advances **plus pair kerning**, per-class widths and regional-indicator advances: 0/208 labels differ with kerning, 6/208 without. The metrics provider is installed at start-up; the server never instantiates `Scene`; server-made labels set `created: null`. | §2.11 |
| Converter | Uses `convertToExcalidrawElements` | It needs `regenerateIds: false` or ids and `created` are regenerated (E 24527-24528), and it throws on an arrow bound to a `stickynote` (E 24382-24441). Note bindings are built by hand. | §5.1 |
| Undo (A15) | Compare-and-set "per field group" (§2.8) or "per field" (the table) | Per group for coupled geometry (`pos`, `shape`, `layout`) and per field elsewhere. A no-op is not a skip. Redo re-applies only what the undo applied. A life-version check stops a redo from reviving an element someone else deleted again. B2 U10 counts "≤". | §2.8 |
| Render overrides and the hit guard (A10) | Opacity on the container hides the branch | Opacity must name bound labels and frame children. The hover cursor, touch input and the dead zone at a moving note's document position get rules. | §2.3.1, §2.7, §4.7, B12 |
| Limits | Coordinates ±1e7; +1 budget 12 KiB | ±1e6 (Excalidraw logs errors above it, E 16334-16343). +1 budget 16 KiB, with uids of at most 60 characters. Client rounding covers arrow points. | §3.5 |
| Image loader (A7) | One `addFiles` per image | `resolveUrl` needs the asset, the derivative and `?board=`. `addFiles` is batched per frame and over a 100 ms window. No SVG through `blob:`. A failed file is never handed to the engine (it never retries). | §2.10.3 |
| E3 label order | "dev builds throw otherwise" | False for the npm builds (E 18947-18958, C 34, 2945). Lobby's pre-pass and the server are the only guards. | §2.5.5 |
| Bundle (A13) | ≈881 KiB gzip today | That baseline does not reproduce. Today's tldraw board route is **1086 KiB**; the spike's Excalidraw route is **1307 KiB**, because today's app shell carries 472 KiB of tldraw. Projected after cut-over: **≈1066 KiB** with pdf-lib lazy, and about 945 KiB with mermaid stubbed. | §2.2 |
| Render and fit (A14) | Gate ≥ 24 fps at fit; "today's median is 29" | Same method, same browser: **both engines are below 24 fps at fit** (Excalidraw 13.9 at the true fit, zoom 0.054; tldraw 18.2 at zoom 0.05). Excalidraw's own fit clamps at zoom 0.1 (F 642-644, 501). The §8.5 level-of-detail conditional **applies** (+3 pd in wave 3b), and fit is Lobby's own camera. At 0.25 and 1 both are above 30. Open: 0.67–0.70 s for Excalidraw from static JSON with **no sync server**, against 3.7–3.9 s for tldraw through the real stack: not comparable. | §4.2, §6.4, §8.5 |
| Downloads in A6 and B5 | "0 downloads" | Excalidraw's save and open paths call File System Access pickers in Chromium. A picker call counts as a download. | §8.2 A6, §8.3 B5 |
| Spike B execution | Not planned | New §8.6: a serial contracts step, then 5 owners plus a lead with disjoint files, ports, NAS and privacy rules, three independent verifiers and the report. | §8.6 |
| Estimate | ≈261 pd; spike B 56 pd | **≈266 pd.** Spike B stays at **56 pd**: spike A's code removes 3 pd; the new items add 1.75; three independent verifiers add 1.5; the contracts step becomes explicit. Waves: level of detail +3 and camera +0.5 (3b), bound arrows +0.5 (2A), hit guard +0.5 (3d), SVG fonts and lazy pdf-lib +0.5 (3e). The calendar stays at about 20 working days (§7.3 says what spike A's 4 hours imply). | §7.2, §7.3, §8.1 |

## What changed in revision 3

| Recheck item | Revision 2 | Revision 3 |
|---|---|---|
| Text lease: editor-open paths | Enter, double-click and printable keys asked for the lease. Three verified paths opened the editor without asking. | Every editor-open path in `next` is listed with its interception: seven `startTextEditing` call sites and two `handleTextWysiwyg` calls. Note and text are Lobby custom tools. A capture-phase double-tap detector handles touch. A guard catches any open that did not come from a grant: no key lands and nothing is pushed until the grant (§2.9.2). Spike checks A16 and B3 L2, L9 and L11. |
| Text lease: container geometry | "Exactly one writer" covered the label only. The sticky-note auto-fit wrote the container's `x`, `y`, `height` and `baseHeight` in unleased groups. | The container's **fit** (the geometry the editor writes) is sent only by the lease holder, as a conditional write. The server drops it if anyone else changed the container's position or shape after its base, and the holder re-fits. The holder no longer holds its container back (§2.9.4). Spike B3 L6 and L10. |
| Irreversible change in the window | `dr_deleted_*` converted in place. The table is shared with R0, and its schema has a CHECK constraint. | A new `lb_deleted` table. `dr_deleted_*` is untouched until `drop-legacy`, and R0 never writes or trims `lb_*`. It only checks whether `lb_meta.converted_from` exists (§2.6, §5.4, §5.9, §5.10). |
| Spike scope | Real staging data optional. The out-of-scope list contradicted B1.2, U2, R2 and B12. Routes A1/A2 arrived after the spike. Spike B was 16 pd. | Spike B converts **every staging board**: a read-only restore of the latest R2 offsite backups with the existing drill tooling. The rollback drill also runs on a real board. The scope includes what the checks need: tags, +1, comment pin, vote tool, phone sheet, timer, and routes A1–A3 in the spike branch. Spike B is re-estimated at **56 pd**, in the waves' units, over 5 days (§8.1, §7.2). |
| Roll-forward merge | Assumed the converter's output was stable. It is not: indices are regenerated board-wide, and page offsets depend on page-1 bounds. | The merge works at the tldraw record level against an **in-file base** (`lb_source`). Only touched records are converted, in a local mode with frozen page offsets. It merges by field group, applies z-order by relative position, and runs the invariants afterwards. It does not depend on whole-board determinism (§5.9). |
| Final backup | Taken before maintenance was turned on | Taken after maintenance is on and every socket is closed, and cross-checked against `lb_source`. The base is refreshed on every roll-forward, so a second cycle is sound (§5.6, §5.9, §7.5). |
| Boards born after cut-over | No rule | R0 refuses to open a board without `converted_from`, with a clear message, and never creates tldraw tables in it. Roll-forward serves those boards unchanged. Boards born during a rollback are converted lazily (§5.9). |
| Viewer presence | `onPointerUpdate`, which is silent for read-only roles under `interaction` | Lobby's own pointer listener for every role (§2.7) |
| Undo recording | Diffed against `confirmed`; server fixes were not folded in | Diffs against the previous local snapshot. Acked `fix` values are folded into their entry, and server fixes never create a step. Ctrl+Z inside the text editor stays native (§2.8, §2.3.3). |
| Ctrl+A | Delegated to Excalidraw | Owned by Lobby, which filters out collapsed mind-map items. Box and lasso selections are post-filtered too (§2.3.3, §4.7). |
| Remote-drag hit test | Not stated | A stated deviation, with a guard (§2.7) |
| Conversion worker | No memory limit; no concurrency cap | `resourceLimits`, one conversion process-wide, and an RSS gate for runtime conversions (§5.3, §2.13) |
| Estimate | Spikes A and B at about 1 pd per owner-day (6 and 16 pd), against 7 pd per owner-day for the waves | Everything in human-engineer pd. Spike A is 14 pd and spike B 56 pd. Total **≈261 pd**, about **20 working days** to cut-over (26 with buffer) (§7.2, §7.3). |

## Open items (tracked; updated for revision 3.2)

The recheck of revision 3 (2026-09-28) found all 3 open musts and all 11 new problems resolved, and gave a **go for spike A**. It listed smaller gaps. They are tracked here and each must be closed at the gate named. Revision 3.2 closes items 3–7 and records item 8's answers; items 1–2 are being fixed in spike A's fix round.

**Folded into spike A (A6, A16): being fixed, re-verified before spike B fans out (§8.6.1):**
1. **Keys inside the text editor.** The textarea's own `onkeydown` runs `actionSaveToActiveFile` (X 25388-25391), and `executeAction` skips predicates (X 23095-23106), so `canvasActions.saveToActiveFile: false` does not stop it: 1 `showSaveFilePicker` call per press [spike-A A6]. Spike A blocked Ctrl+S, Cmd+S and Ctrl+Shift+S, but the verifier showed Ctrl+Alt+S (and Cmd+Alt+S under macOS emulation) still reaching the picker 20/20, because Lobby's save test required no Alt and Excalidraw's key test ignores Alt (X 11606) [verify-A]. **Rule now:** inside the editor, Ctrl/Cmd/Alt chords are an allowlist (§2.3.3). **Status: being fixed**; closed when A6 and its verifier probe pass 3/3 on the fix commit.
2. **Double-click capture and the guard.** Stop only the double-clicks that would open text editing; forward a line double-click, Ctrl/Cmd+double-click on an arrow, elbow segment editing and entering a group (X 44741-44825). A plain double-click on a simple arrow is a text path (§2.9.2). The swallowed touchstart is `preventDefault`-ed on every platform. The verifier found that an editor opened on another note while a Lobby request was pending was writable with no lease [verify-A]. **Rule now:** any `editingTextElement` that is not the element of a granted lease is unrequested, whatever the session phase (§2.9.2). **Status: being fixed**; closed when A16 with the verifier's pending-request probes passes 3/3 on the fix commit.

**Before spike B: closed in revision 3.2:**
3. **Container fit and bound arrows.** Confirmed by spike A17: auto-fit rewrites bound arrows from the holder's copy (X 49806-49838, 49845, 49864-49868; non-sticky X 25133, 25147). **Closed:** the server recomputes bound-arrow endpoints whenever it applies a fit; the holder never pushes them. §2.9.4 rule 7, §2.4.3 step 9, §6.2, B3 L6 and L10.
4. **B8 drill stand-in.** **Closed:** the stand-in runs R0's born-after pre-open check, read-only, and the drill checks every `lb_*` table's bytes and the table list. §8.3 B8 ("The R0 stand-in"), §8.6.3 (owner O4).
5. **Lease message ordering.** **Closed:** `lease.acquire` and `lease.release` go through the per-session FIFO at stage 0. §2.4.3 stage 0, §6.2 `text-lease`.
6. **Drag-preview relay in the capacity budget.** **Closed:** ids once per drag, then dx/dy, with numbers in the budget. §2.7, §2.13, B9.
7. **Wording of the "New element" grant.** **Closed:** a grant never overrides another session's live lease. §2.9.2.
8. **Owner confirmations. Answered:**
   - Appendix B 3 (NAS spike containers): under the standing NAS approval for `draftroom-*` containers, with the rules in §8.6.6;
   - Appendix B 13 and the restore: answered on 2026-09-28: restore, verify signatures, and delete the copies when the spike ends. Four staging boards are restored (§8.6.7).

**Before the migration waves (R0, 2B, runbook): stay open for the waves:**
9. R0's backup, drill and `readBoardDb` (backup.ts:139-147) throw on a file that has only `lb_*` tables. They need a code path and a gate test. (The B8 drill keeps the born-after file out of the stand-in's backup pass until R0 has this path; §8.3 B8.)
10. Roll-forward must mirror R0's `removeRestored` and trims (store.ts:508-521) into `lb_deleted`, so an element restored during a rollback is not still listed as deleted.
11. The new sync build must boot in maintenance (an env flag) for cut-over step 6 and rollback step 2. R0's maintenance is a runtime POST and does not survive a redeploy.
12. Define how binding-record diffs map to the arrow's binding and the target's `boundElements` in local mode.

**Minor (fix in the wave that owns the code):**
- A normal-concurrency violation uses a code that does not count toward the abuse close.
- Index collisions with deleted elements.
- `resourceLimits` caps only the V8 heap, not `node:sqlite` native memory in the worker. A roll-forward storm after a redeploy queues serially behind the RSS gate; that is intended.
- Keys with `keyCode` 229 (Android soft keyboards, IME "Process" or "Unidentified") cannot be buffered, so A2's "no key lost" covers desktop keydown only [verify-A]. Before a grant no text input has focus, so a soft keyboard does not type into the canvas; the guard's `readOnly` blocks input with no keydown. Checked on the real device (Appendix B 11) and in B12 under emulation.
- A build with `VITE_LOBBY_ENGINE=excalidraw` but no dev auth still emits `dist/excalidraw-assets` (233 files, 14 MB), because the asset plugin checks only the engine flag [verify-A]. No engine code ships. Wave 4 fixes the plugin's condition.
- Double-clicking a label opens the editor with all its text selected (X 51685, 25613-25614), so keys typed before the grant replace the text. That is Excalidraw's own behaviour with an instant lease too. Wave 3a decides whether Lobby moves the caret to the end after a guard-caught open.

## What changed from the first draft (revision 2, updated for revision 3)

| Area | First draft | This revision |
|---|---|---|
| Echo | "Any echo is a bug" | Nine named echo sources, each with a suppression rule and a test (§2.5.5). Image `status` is never synced. Clients re-key only their own unacknowledged elements. |
| Undo | Built on Excalidraw's `StoreDelta` | Lobby's own field-level undo with a 3-way compare-and-set per field, per `customData` key and per group id (§2.8). Excalidraw's deltas are not applied. |
| customData | One client-writable bag | Five classes: server-owned, create-only, identity-bound, api-validated, free (§3.3). |
| Server authority | Per-element checks | Plus cross-element invariants: label ↔ container, bindings, `frameId`, group nesting, with lease and lock enforced through them (§2.4.4). |
| File checks | "Through the api's asset table" | A new batched internal route `GET /internal/boards/:bid/file-refs`, called before the commit drain, fail-closed (§2.10.2). |
| Keys | Block list | Capture-phase allowlist, plus Excalidraw's `interaction` config for read-only roles, plus every `canvasActions` flag off (§2.3.3). |
| Text lease | Implicit, 5 s | Explicit `lease.acquire` / `lease.release`. Every editor-open path goes through the grant, the holder is the only writer of the label layout and the container fit, the lease is renewed by presence while open, and others see "X is typing" (§2.9). |
| Wire and load | Full elements every 50 ms | Field-group patches; gestures commit once at pointer-up; drags preview through presence and render overrides; `changes` serialized once for everyone (§2.5.3, §2.7). |
| Limits | 64 KiB element, 8,000 points, 8 KiB customData | Reconciled with measured element sizes: per-type byte limits, rounded points, +1s outside the customData budget, the cap counted in items (§3.5). |
| Conversion | Separate `convert-all` command, lazy on the event loop | Inside the sync process, one board at a time in a worker thread, with disk checks (§5.3). |
| Rollback | 48 h window that loses post-cut-over edits | A bridge release first, nothing irreversible before the window closes, and a roll-forward that merges edits from both sides at the tldraw record level against an in-file base (§5.9). |
| Capacity | One commit timed on a 32-core PC | A budget for 200+ users on 0.5 CPU / 512 MB, and a load test in a NAS container with those limits (§2.13, §8). |
| Third parties | Font fallback noted; CSP a follow-up | Foreign hosts rewritten out of the bundle at build time, CSP shipped at cut-over (§2.12). |
| Spike | 2 days, mostly one-client API checks | Spike A (engine checks; done). Spike B (5 days at most, 56 pd): 2–3 real browsers, 200 simulated clients, conversion of every staging board from the R2 backups, a rollback drill on real data, and a NAS load test (§8, execution in §8.6). |
| Estimate | ≈160 pd, 10 working days | ≈266 pd, about 20 working days to cut-over (26 with buffer). No cut-over date before the spike go/no-go (§7). |

---

## 0. Summary

- **What stays.** Everything outside the canvas:
  - api, Postgres, R2, the NAS worker;
  - accounts, permissions, guests, comments, AI, search, checkpoints and backups.

  The sync process (`apps/sync`) also stays, with its tickets, access re-checks, join queue, per-board SQLite, backups and internal routes.
- **What changes:**
  - **Canvas engine**: tldraw is replaced by Excalidraw **0.18.0-1118751**, the npm `next` snapshot, pinned exactly.
  - **Room**: TLSocketRoom is replaced by **ElementRoom**, a Lobby-owned, server-authoritative element sync. It stays one room per board and one SQLite file per board.
  - **Tests**: e2e drives a Lobby test facade whose writes go through the real sync path, instead of `window.editor`.
  - **api**: five named additions (§1, "api and contract changes").
- **How edits merge:**
  - The server orders every write.
  - The last writer wins per *field group* of an element (position, text, style…), per `customData` key, and per id in `boundElements`.
  - Deletes win.
  - Acks are sent only after COMMIT, and "Saved" is computed from those acks.
  - The server assigns z-order and keeps cross-element references valid.
  - An explicit text lease stops two people from typing in the same note, and everyone sees who is typing.
  - The server stamps attribution and identity-bound data from the ticket.
- **First step: two spikes** (§8). A checked the engine and is done: 14 PASS, 2 PARTIAL, 1 FAIL as written, with two guard bugs in Lobby's code being fixed (§8.2). B (5 days at most, 56 pd) proves convergence, undo, the lease, durability, server enforcement, files, capacity, and the conversion and rollback of **every staging board**, using real browsers, a load test and a read-only restore of the R2 backups. Its execution plan is §8.6.
- **Effort:** about **266 person-days** (human-engineer equivalents, the unit used throughout). With parallel agents at the 26–28 Sep pace, that is about **20 working days** to cut-over, or 26 with a 30% buffer. Spike B re-estimates it (§7.3).
- **Staging** stays on tldraw until a rehearsal on a copy of its data passes, including a rollback → roll-forward drill, and the owner signs off. The staging tldraw key's expiry is a hard deadline (§7.5).

| # | Decision | One-line reason |
|---|---|---|
| D1 | Pin `@excalidraw/excalidraw` **0.18.0-1118751**, plus `element`, `common`, `math` and `fractional-indexing` at the same version. The fallback is 0.18.1. | Native sticky notes. The element package runs in Node. Boards migrate once, onto the upcoming data model (§2.2). |
| D2 | Lobby-owned sync (ElementRoom) in `apps/sync` | The only option that keeps server validation, exact Saved, attribution and the internal endpoints. |
| D3 | Last writer wins per field group; per key in `customData.lobby`; delete wins; stale offline writes need confirmation | Keeps today's per-property guarantees, and stops a week-old offline edit from silently winning. |
| D4 | Apply remote changes with `updateScene({ captureUpdate: CaptureUpdateAction.NEVER })`, never through `reconcileElements` | The default mode puts remote edits into the local undo stack (dbg4). Reconcile replaces whole elements. |
| D5 | The server assigns and validates `index`. A client re-keys only its own unacknowledged elements, before `updateScene`. | `updateScene` re-keys any collision in place and bumps the version, which would echo someone else's element (probe1). |
| D6 | Lobby's own field-level undo with a 3-way compare-and-set | Excalidraw's deltas treat `customData` and `groupIds` as whole values and revert other people's +1s and groups (probe2). |
| D7 | File cards are `image` elements plus card data plus Lobby overlays and viewers, not embeddables | Embeddables sit above all canvas content, need a click to activate, and export as empty boxes. |
| D8 | Images keep `fileId` = the Lobby version id. Lobby's loader fetches the bytes and hands Excalidraw `blob:` URLs. `status` is local-only. | No base64 or signed URLs stored, no failed-load echo, capped concurrent fetches. |
| D9 | Presence comes from the ticket: an uncapped roster, a capped cursor stream, and drag previews. Lobby reads the pointer itself and draws the cursors. | `Collaborator.color` is ignored; 200 people need a bounded fan-out; `onPointerUpdate` is silent for read-only roles. |
| D10 | Plain text only, with an explicit, server-enforced text lease. Every editor-open path goes through it; the holder is the only writer of the label layout and the container fit. | Excalidraw has no rich text, text merges as a whole string, and seven code paths open its editor. |
| D11 | Board-level settings live in an `lb_doc` table synced by the same protocol | Excalidraw has no document record. |
| D12 | Keep element ids; api contracts keep `shape:<id>` refs; a new deep-link format plus a legacy parser | No Postgres migration of comment anchors, AI ids or votes; old links keep working. |
| D13 | Only five MIT tldraw packages stay, inside `packages/tldraw-import`: `tlschema`, `utils`, `store`, `state`, `validate` | The legacy converter needs them. Every non-MIT tldraw package is removed. |
| D14 | The wire carries field-group patches; each commit batch is serialized once and sent to every session | Fits 0.5 CPU: no per-recipient serialization, no full elements on moves. |
| D15 | Conversion runs inside the sync process, one board at a time, in a memory-capped worker. Rollback goes to a tldraw *bridge* release, and a roll-forward merges both sides at the tldraw record level against an in-file base. | One writer per board file, no OOM of the only sync process, and no edit lost in either direction. |
| D16 | Keys go through a capture-phase allowlist; read-only roles use Excalidraw's `interaction` config | Excalidraw's built-ins can download the board, load files and change element types. |
| D17 | `customData.lobby` keys are split into five classes, checked by the server | Keys that carry identity (+1s, private-note authors) must not be forgeable. |

---

## 1. Goal and non-goals

### Goals

1. **No licence fee** for 200+ DBC people plus name-only guests. No runtime dependency needs a paid key. CI checks every production dependency tree (web, sync, api, worker, and `packages/tldraw-import`) for licences.
2. **Feature parity** with today's Lobby (§4). Every gap is named in §4 with a reason.
3. **The same guarantees as today:**
   - permissions enforced server-side, including on element references and identity-bearing data;
   - a truthful "Saved";
   - 0 acknowledged edits lost on SIGKILL;
   - presence never stored;
   - no base64, `data:`, `blob:` or signed URLs in durable data;
   - undo never reverts other people's changes.
4. **tldraw fully removed.** `tldraw`, `@tldraw/editor`, `@tldraw/sync`, `@tldraw/sync-core` and `@tldraw/assets` (all "SEE LICENSE IN LICENSE.md") leave every package [repo]. `packages/tldraw-import` keeps `@tldraw/tlschema`, `utils`, `store`, `state` and `validate` 5.4.2, all MIT [repo][REV].
5. **Staging stays on tldraw** until the cut-over is verified (§7.5).
6. **Reversible cut-over**: a rollback and a later roll-forward lose no edit made on either side (§5.9).

### Non-goals

- No product redesign and no new features. Laser pointer and eraser are exceptions: they come built in and are enabled only if they fit Lobby's toolbar.
- No Yjs or CRDT, no Excalidraw collab server, Firebase or end-to-end encryption, and no Liveblocks.
- No rich text. Bold, italic, headings and code are dropped; lists become "• " and "1. " lines (§5.2).
- No multiple pages. Extra tldraw pages are laid out to the right of page 1.
- No new hosting and no new paid resources. The rehearsal and the load test run on the NAS (owner OK needed, Appendix B). If the load test says staging's sync plan is too small, a bigger plan is an owner decision (§2.13).
- No fork of Excalidraw. A fork is a last resort, only if the spike finds a blocker.

### api and contract changes (the first draft said "payload readers only"; that was wrong)

| # | Change | Where | Why |
|---|---|---|---|
| A1 | `GET /internal/boards/:bid/file-refs?ids=ver_a,ver_b,…` (≤ 100 ids), internal secret | new api route; sync client in `apps/sync/src/file-refs.ts`. A1–A3 are first written in the spike branch (§8.1); R0 and wave 2F ship the reviewed versions. | The sync server checks every `fileId` against the board's workspace (§2.10.2). A GET, like `touched` and `session-ended`, because the api's root CSRF hook refuses server-to-server POSTs (`apps/sync/src/touch.ts:23-26`) [rev-run]. |
| A2 | `GET /internal/boards/:bid/workshop-state` (sync pulls on room open) and `POST <sync>/internal/boards/:bid/workshop-state` (api pushes on change) | new api route + new sync route | The server refuses new +1s and drops selection presence while a dot vote is open (§3.3, §2.7). Today that rule is client-side only (`PlusOnes.tsx:55-57`) [rev-run]. |
| A3 | Optional `guest` claim in `TicketClaims` | `packages/auth-tickets` | Guest limits are enforced by sync. Additive: `TicketClaims` has no such field today (`index.ts:9-18`) [rev-run]. |
| A4 | Checkpoint bodies v1 and v2, the new `engine-migration` reason (migration `0021`) | api history | Shipped first in the tldraw **bridge release** so a rollback lands on a build that understands them (§5.10). |
| A5 | Snapshot readers: `ai/sources.ts`, `workshops/shapes.ts`, `search/indexer.ts`, `history/*`, `files/gc-refs.ts` | api | Read `lobby-elements` through `canvas-schema/items.ts`. |
| C1 | `PrivateTarget.pageId` keeps its type; after cut-over clients send the constant `page:page`; sync maps a legacy page id through `lb_doc.import.legacyPages` | contracts unchanged; sync `place-notes` | Sessions still open at cut-over reveal notes in the right place (§5.8). |
| C2 | Deep links: new `?el=<id>,<id>` and `?view=x,y,w,h`; the legacy `?d=` parser stays | web (`copy-link.ts`, `content-search.ts`) | tldraw links use `.` separators, and converted ids contain `.` (§3.6). |

---

## 2. Target architecture

### 2.1 Picture

```
Browser: apps/web                                         apps/sync: one process, one room per board
┌──────────────────────────────────────────────────┐      ┌───────────────────────────────────────────────┐
│ Lobby UI: toolbar, style panel, menus, panels    │      │ upgrade: Origin allowlist, HMAC ticket,       │
│ Lobby overlay: cursors, names, comment pins,     │      │ sid = uid:tab, replaced-socket guard,         │
│ vote badges, card chips, "X is typing"           │      │ token buckets, JoinQueue              (kept)  │
│ Key allowlist (capture) · role → interaction cfg │      │ per-session FIFO → pre-validate (zod, limits, │
│          │ CanvasPort (the only engine API)      │ JSON │   file-refs lookup, async)                    │
│ ┌────────▼────────────────┐ ┌──────────────────┐ │ WS   │ ElementRoom drain (sync, BEGIN IMMEDIATE):    │
│ │ <Excalidraw> 0.18.0-    │◄┤ sync engine core │ │◄────►│  role → lock/lease (via refs) → customData    │
│ │ 1118751, ui={false}     │ │ (pure) + adapter │ │      │  classes → merge → cross-ref invariants →     │
│ └─────────────────────────┘ └──────────────────┘ │      │  index → upsert → COMMIT → changes (once)     │
│ Undo: Lobby field-level stack                    │      │ lease table · roster · capped cursors (memory)│
│ Image loader: fetch → blob: → api.addFiles       │      │ board-<id>.sqlite: lb_meta, lb_elements,      │
│ (runtime only, never synced)                     │      │ lb_doc, lb_deleted, lb_source (+ tldraw and   │
└──────────────┬───────────────────────────────────┘      │ dr_deleted_*: untouched until drop-legacy)    │
               │ /api, /files (same origin)               │ conversion: capped worker, one at a time      │
               ▼                                          └──────────▲───────────────────┬────────────────┘
      apps/api (Fastify, Postgres, R2) ── /internal/* (secret; sync→api GETs: access,     │
               touched, session-ended, file-refs, workshop-state) ────┘                   │
               ◄── api→sync POSTs: seed, place-notes, access-changed, workshop-state ─────┘
      apps/worker (NAS): unchanged
```

### 2.2 Engine choice

[API] recommends the nightly `next` build. [SYNC] recommends 0.18.1 and says `next` "is older than latest". That claim is wrong. `npm view @excalidraw/excalidraw time` shows [plan-run]:
- 0.18.1 on 2026-04-20;
- 0.18.0-afa3a65, the sticky-notes merge, on 2026-09-10;
- 0.18.0-1118751 on 2026-09-24.

`next` is a newer snapshot of master with a lower semver. Both builds declare React `^17.0.2 || ^18.2.0 || ^19.0.0` as a peer [plan-run].

**Decision: pin `0.18.0-1118751` exactly** (D1).

| Why next | Evidence |
|---|---|
| **Native sticky notes.** `stickynote` has a label that fits by shrinking its font, like Lobby's notes today. On 0.18.1 the stand-in (rectangle plus bound text) grows and never shrinks its font. | [API] dbgnext; `element/src/stickyNote.d.ts` |
| **The server can lay out notes and check references with Excalidraw's own code.** `@excalidraw/element` imports in Node 24.19.0. `getStickyNoteLayout` ran with a custom metrics provider. `isBindableElement` and `isTextBindableContainer` (both include `stickynote`) are plain functions. | [plan-run] `plan/node-layout.mjs`; [rev-run] element `dist/dev/index.js:3659-3670` |
| **One migration, not two.** `next` already has master's data model (`FixedPointBinding`, `created`, renamed arrowheads). Converting to 0.18.1 now would likely mean converting every board again. | [API]; `element/src/types.d.ts` |
| **Dependencies clean for React 19.** 0.18.1 bundles `@radix-ui/react-tabs` 1.0.2, whose peer is React ≤ 18 (`npm ls` reports React 19 as invalid); `next` has 1.1.13. | [plan-run][REV] |
| **More room for Lobby's own UI.** `ui={false}` (WIP), `interaction`, `setElementRenderOverrides` (opacity and offset), `onDuplicate` with a data argument, `imageOptions`. | [rev-run] `excalidraw/types.d.ts:549-790, 896-913, 655-667` |

| Cost of next | Mitigation |
|---|---|
| **API churn**: `excalidrawAPI` → `onExcalidrawAPI`, `scrollToContent` → `setViewport`, `restore` removed, `fontSizeMax` → `baseFontSize` within two weeks [API]. | Pin all five `@excalidraw/*` packages exactly. Only `apps/web/src/canvas/**` and `packages/canvas-schema/src/engine/**` import them (lint rule). The probe suite moves into the repo (§6.5). A bump is always its own PR. |
| **Sticky notes are 18 days old.** | Spike A checks and the in-repo probe suite. |
| **Bundle**: eager JS+CSS about 719 KiB gzip (next) vs 385 KiB (0.18.1), both including React [API]. Measured by spike A13 with one method for both routes (static-import closure, gzip level 6) [spike-A]: today's tldraw board route is **1086.2 KiB** (1045.7 JS; 908.7 KiB brotli). The first draft's ≈881 KiB does not reproduce. The spike's Excalidraw route is **1306.9 KiB**, but it still carries tldraw, because today's app shell holds 471.7 KiB of tldraw. | Load Excalidraw only on the board route. **Projection after cut-over: ≈1066 KiB** (the engine route minus the shell's tldraw, plus the Lobby board code of today's `BoardPage` chunk), if pdf-lib (≈132 KiB, PDF export) becomes a lazy import (wave 3e); ≈1197 KiB if it stays eager. Stubbing `@excalidraw/mermaid-to-excalidraw`, whose mermaid, d3 and marked parts rolldown hoists into eager chunks (≈120 KiB), brings it to about 945 KiB (wave 4). |

**Fallback.** If spike A finds a blocker in `next` that cannot be fixed or worked around in one day, switch to 0.18.1:
- notes become a rectangle plus a bound text label;
- [DATA]'s converter already targets 0.18.1;
- the sync design does not depend on `next`-only APIs. The undo design (§2.8) no longer needs `onIncrement` or `StoreDelta`; it runs on the engine's own diff, so it works on both builds;
- the server validator and layout become Lobby code, because 0.18.1 has no separate element package and cannot be imported in Node (+5 pd);
- pnpm needs a `peerDependencyRules` entry for `@radix-ui/react-tabs` 1.0.2, plus a runtime check that its tabs work under React 19 (+0.5 pd) [REV].

### 2.3 Web canvas

#### 2.3.1 Modules

`apps/web/src/canvas/**` is the **only** web code that imports `@excalidraw/*`. On the server, only `packages/canvas-schema/src/engine/**` does, and it re-exports typed wrappers (layout, bindability, index helpers). A Biome `noRestrictedImports` rule enforces both. The wrappers exist because the element package's `.d.ts` files import `@excalidraw/excalidraw` types, which resolve to `any` on the server under `skipLibCheck` [REV].

Today about 160 files in `apps/web/src` import tldraw, and 102 files use 137 distinct `editor.*` members [repo]. They move to the port.

| Module | Job |
|---|---|
| `canvas/engine/ExcalidrawHost.tsx` | Mounts `<Excalidraw>` with fixed props (below) and holds the imperative API. |
| `canvas/port.ts` | The engine-neutral interface features use: `items()`, `get(id)`, `bounds(id)`, `selection`; `viewport` (get/set/fit), `sceneToScreen`, `screenToScene`; `transact(label, fn)`, which is one undo step; `setTool`; events (`changed`, `selectionChanged`, `viewportChanged`, `pointer`). |
| `canvas/sync/` | The pure engine core (Node-testable) plus the Excalidraw adapter (§2.5). |
| `canvas/history/` | Lobby's field-level undo stack (§2.8). |
| `canvas/overlay/` | One DOM layer above the canvas for cursors, name tags, comment pins, vote badges, card chips, "X is typing" and "(guest)" badges. Positioned with `sceneCoordsToViewportCoords` on `onScrollChange`/`onChange`. |
| `canvas/overrides.ts` | The single owner of `setElementRenderOverrides`. It merges drag previews (offsets, §2.7) and mind-map collapse (opacity, §4.7), because each call replaces the whole snapshot [rev-run `types.d.ts:1095-1110`]. **Offsets go on the container**: an offset on a bound label alone is ignored, and the container's offset moves its label too. **Opacity must name every id**: a container at opacity 0 still draws its bound label, and frame children are not hidden with their frame, so the override lists labels and frame children explicitly [spike-A A10]. |
| `canvas/input/` | The key allowlist (§2.3.3) and capture-phase `contextmenu`, `dblclick`, `paste`, `drop` and `copy` listeners on the wrapper div. |
| `canvas/files/` | Lobby's image loader, derivative choice and card faces (§2.10). |
| `canvas/registries.ts` | Extension points so features never edit shared files: key handlers, overlay layers, selection-bar items, `customData.lobby` key specs. Frozen in wave 1 (§7.1). |
| `canvas/test-facade.ts` | `window.lobbyCanvas`, only behind the dev-auth guard. Every write goes through `CanvasPort.transact` and then the sync engine, so e2e tests the real path (§6.3). |

#### 2.3.2 Excalidraw props

Names checked in `next` `dist/types/excalidraw/types.d.ts` [plan-run][rev-run]:

| Prop | Value |
|---|---|
| `onExcalidrawAPI` | Receives the API. It fires **before** the editor is initialised (X 49154) [spike-A]. |
| `onInitialize` | Lobby's readiness signal: it fires after the initial scene loads (X 49441). The sync adapter applies `welcome` only after it. |
| `initialData` | `{ appState: { currentItemFontFamily: 6, currentItemRoughness: 0, currentItemStickynoteBackgroundColor: '#f8e48f' } }` with **no elements**: the scene arrives in `welcome`. It cannot be `null`, because the new-element defaults must be in place before the first scene [spike-A scaffold]. `#f8e48f` is "Butter", the first swatch and today's default note colour (`features/canvas-ux/palette.ts:45-50`) [repo]; the spike used a placeholder, `#ffd966`. |
| `viewModeEnabled` | Not used for roles; see `interaction`. |
| `interaction` | Editors: omitted (`true`). Commenters, viewers and limited guests: `{ enabled: { navigation: true, links: true, tools: { custom: true } } }`. Note that `tools` sits **inside** `enabled` [rev-run `types.d.ts:549-633`]; the review's snippet had it outside. |
| `theme` | Set from Lobby's theme. |
| `langCode` | `'en'` |
| `handleKeyboardGlobally` | `false` |
| `aiEnabled` | `false` |
| `UIOptions` | `{ tools: { image: false }, canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: false } }` [rev-run `types.d.ts:900-927`] |
| `imageOptions` | Not relevant: Excalidraw's own image insert path is never reached (§2.10). |
| `validateEmbeddable` | `() => false` |
| `renderEmbeddable` | `() => null` |
| `onPaste` | Lobby's handler (§2.10.4). |
| `onDuplicate` | Lobby's handler: strips or re-links keys and sets `created: null` on notes (§3.3). It may return modified elements [rev-run `types.d.ts:741-745`]. |
| `onLinkOpen` | Lobby's handler, which calls `preventDefault`. |
| `onPointerUpdate` | **Not used.** Under the `interaction` config, `savePointer` returns before calling it unless the active tool is supported (`index.js:47780-47786`) [r3-run], so it would be silent for commenters, viewers and limited guests in the normal state. Presence reads the pointer through Lobby's own listener (§2.7). |
| `gridModeEnabled`, `objectsSnapModeEnabled` | From Lobby's settings. |
| `ui` | `false` (marked WIP; fallback: hide by CSS, pinned by a visual test). Spike A5: 0 visible matches for 33 selectors in 6 states. It still mounts empty `.layer-ui__wrapper` containers and a full-size, empty `div.SVGLayer > svg` (X 30857, 39927-39941); nothing is painted [spike-A]. |

Before Excalidraw loads, the page sets `window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'` and `window.EXCALIDRAW_THROTTLE_RENDER = true` [plan-run]. The asset path is read when the first font registers, not when the module loads (F 3072-3082, 3207); the throttle flag is read on every render (X 24464) and works only on React 18 or later [spike-A scaffold].

The defaults for new elements go through `appState`, set in `initialData` (above): `currentItemFontFamily: 6` (Nunito), `currentItemRoughness: 0`, `currentItemStickynoteBackgroundColor: '#f8e48f'`.

**One instance per page.** Two `<Excalidraw>` instances on one page share the module-level jotai store (a Tab in instance B converted a shape in A), one `throttleRAF` static render that keeps only the last caller's arguments (A missed 10 of 20 repaints) and i18n state (X 43955-43980, 52656; F 3786-3790; C 2662-2680) [spike-A A11]. Lobby never mounts two (§4.6).

#### 2.3.3 Keys: an allowlist, not a block list

The first draft blocked four Excalidraw shortcuts. The review found more that bypass the export policy or data integrity [rev-run]:
- **Ctrl+Shift+S** (`saveFileToDisk`) has `viewMode: true` and no predicate, so it downloads the whole board even for limited viewers (`index.js:11608-11651`).
- **Ctrl+O** (`loadScene`) replaces the scene unless `canvasActions.loadScene` is false (`:11667-11672`).
- **Alt+Shift+C** copies the board as PNG.
- **Tab** converts the selected element's type in place, with the same id (`:43960-43977`).
- **Ctrl+Arrow** creates flowchart nodes; **Alt+Arrow** walks them.
- Tool letters and digits switch tools.

Spike A measured the size of the problem: without the allowlist, **54 of 70 probed keys act**. Among them, Tab sets a hidden type-conversion popup (a jotai atom that `appState` does not show, X 43960-43977) and the next Shift+Tab converts the selected shape's type in place; Q toggles the tool lock (X 43673-43695); Shift+X activates `autoshape` [spike-A A6].

**Rule.** One capture-phase `keydown` listener on the board wrapper sees every key first. It calls `stopPropagation()` on every key that is not in the **delegated** list, so Excalidraw never sees it. Keys Lobby handles are handled there. The list lives in `canvas/input/keymap.ts`, is filled through the key registry, and is pinned by `keyboard-map.test.ts`.

- **Blocked chords are also `preventDefault`-ed.** A blocked key with Ctrl, Cmd or Alt gets `preventDefault()` too, so the browser does not save the page, print, open a file or go back. **Browser chords pass untouched**: reload (Ctrl/Cmd+R, F5), new, close and reopen tab or window (Ctrl/Cmd+T, W, N, Shift+T, Shift+N), tab switching (Ctrl+Tab, Ctrl+PgUp/PgDn, Ctrl/Cmd+1–9), the address bar (Ctrl/Cmd+L, Alt+D), devtools (F12, Ctrl/Cmd+Shift+I/J/C) and fullscreen (F11) [spike-A A6].
- **Tab is stopped.** Outside a mind map, Tab gets `stopPropagation()` (so it never arms the conversion popup) and no `preventDefault()` (so focus still leaves the canvas).
- **Inside the text editor, Ctrl/Cmd/Alt chords are an allowlist.** A chord reaches the textarea (its own handler and the browser's default) only if it is on this list: Ctrl/Cmd+Z, Ctrl/Cmd+Y, Ctrl/Cmd+Shift+Z (native textarea undo, §2.8); Ctrl/Cmd+A (select the text); Ctrl/Cmd+C, X and V (the textarea's own clipboard); and word or line movement and deletion: Arrow, Home, End, Backspace and Delete with Ctrl, Cmd or Alt, with or without Shift. Every other Ctrl, Cmd or Alt chord is stopped and `preventDefault`-ed, whatever Shift and Alt are, except the browser chords above. This replaces revision 3.1's list of three blocked chords, which missed Ctrl+Alt+S (open item 1) [verify-A]. **Text input is not a chord:** a key with `getModifierState('AltGraph')` (Windows reports AltGr as Ctrl+Alt) whose `key` is one printable character other than an ASCII letter, and a macOS Option key (Alt without Ctrl or Cmd) whose `key` is one printable character, reach the textarea, so `@`, `€`, `ś` or `ß` can be typed. Ctrl+Alt with an ASCII letter (Ctrl+Alt+S gives `key` `s` on a US layout) is a chord and is blocked. `keymap.test.ts` pins the list, including an AltGr case per common European layout and the verifier's Ctrl+Alt+S and Cmd+Alt+S probes. It also checks that no key let through as text input matches a key test of the textarea's own `onkeydown` (the save test at X 11606, indent and outdent), since those tests look at `ctrlKey`, which AltGr sets.

| Class | Keys | Who acts |
|---|---|---|
| Delegated to Excalidraw (editors only) | Arrow keys and Shift+Arrow (nudge), Delete, Backspace, Escape, Ctrl+D (duplicate, through `onDuplicate`), Ctrl+G, Ctrl+Shift+G, Ctrl+Shift+L (lock), Ctrl+[ ] and Ctrl+Shift+[ ] (z-order), Space (hold to pan), Ctrl+= / Ctrl+- (zoom), Shift (modifier), Alt (drag-duplicate modifier) | Excalidraw |
| Delegated while the text editor is focused and its lease is granted | Keys without Ctrl, Cmd or Alt, except the mind-map keys (§4.7); text input made with AltGr or macOS Option; and the editor's chord allowlist (above). **Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z stay in the textarea** for its native undo of the typing. Excalidraw's own key handler returns early inside a writable element (`index.js:44005-44011`) [r3-run], so they never reach its history (confirmed, spike A17). Closing the editor makes the whole edit one step on Lobby's stack (§2.8). Ctrl+A selects the text. | Excalidraw's textarea |
| Editor open, lease still pending (§2.9.2) | Printable keys, Enter, Backspace and Delete are buffered (`preventDefault`) and replayed on the grant; Escape cancels | Lobby |
| Lobby-owned | N, L (arrow), P, T, R, O, F, H, C, V, E, K (tools); M; Ctrl+F; **Ctrl+A** (select all, minus hidden collapsed mind-map items; §4.7); Alt+1, Alt+2, Ctrl+0; Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z outside the text editor; Enter and printable keys on a selected note (lease flow, §2.9); Tab/Shift+Tab/Enter in mind maps; PgUp/PgDn; Ctrl+Alt+Enter; Shift+F10; F6 and Alt+Arrow (accessibility traversal, §4.8) | Lobby |
| Tab outside a mind map | Stopped (`stopPropagation`) but not prevented, so Excalidraw never sees it and the browser moves focus out of the canvas | Browser |
| Everything else | Includes Ctrl+S, Ctrl+Alt+S, Ctrl+Shift+S, Ctrl+O, Alt+Shift+C, Ctrl+Shift+E, Ctrl+/, Ctrl+P, Ctrl+Backspace, Ctrl+Arrow, Alt+Arrow (unless the a11y handler takes it), G, S, I, Q, Shift+X, Shift+F, Shift+S, Shift+G, ?, digits. Chords among them are also `preventDefault`-ed. | Nobody |

**Clipboard.** Ctrl+C, Ctrl+X and Ctrl+V are not keydown actions in Excalidraw: they arrive as document `copy`, `cut` and `paste` events (`index.js:49346`) [rev-run], so the allowlist does not block them. Paste goes through `onPaste` (§2.10.4). A capture-phase `copy`/`cut` listener applies the export policy.

**Ctrl+A (Lobby-owned).** Lobby builds the selection itself. It takes the set Excalidraw's select-all would take (live, unlocked, bound labels excluded, each group expanded to its outermost group), removes every element hidden by a mind-map collapse (§4.7), and installs it with `updateScene({ appState: { selectedElementIds, selectedGroupIds } })`. That is a selection change: no document change, no push. Box and lasso selections, which Excalidraw makes itself, are **post-filtered**: on `selectionChanged`, hidden ids are removed from the selection before any Lobby action or copy sees it. Tested in spike B12.

**Read-only roles.** Commenters, viewers and limited guests get Excalidraw's `interaction` config (above). It keeps panning, zooming, links and custom tools, and it turns off the keyboard, clipboard and drag-and-drop inside Excalidraw [rev-run `types.d.ts:549-633, 750-765`]. Confirmed in spike A4: with the allowlist off, 11 keys including Ctrl+Shift+S, Ctrl+S and Delete changed nothing for a viewer, because Excalidraw's `onKeyDown` returns when interaction is disabled (X 43927) [verify-A]. For these roles Excalidraw registers no copy, cut or paste listener and **no drop guard** (`addEventListeners` returns at X 49327; `onDrop` is undefined, X 48682), so the browser's default drop is not prevented: Lobby's capture `drop` listener prevents it for every role [spike-A A4]. Lobby's custom tools cover what these roles do on the canvas: placing comments, click-to-vote and double-click-to-open a file card. A capture-phase `copy` listener also enforces the export policy for limited viewers.

**Evidence required:** an e2e spec per role (editor, commenter, viewer, limited guest) presses every key in the "Everything else" row and asserts: no download, no dialog, no element change, no push (§8, check B5). **A download includes a File System Access picker.** Excalidraw's file I/O goes through `browser-fs-access` 0.38.0, which calls `showSaveFilePicker` or `showOpenFilePicker` when the browser has them; Chromium does, so a save or open fires no Playwright `download` or `filechooser` event. The specs therefore count picker calls through `e2e/spike/support/watch.ts` (`instrumentFilePickers`), and "0 downloads" means 0 downloads, 0 file choosers and 0 picker calls [spike-A scaffold, A6].

#### 2.3.4 Menus and tools

- **Context menu.** Lobby's own menu (right-click and Shift+F10). Excalidraw's menu is a fixed list with no extension point [API].
- **Custom tools.** Note (N), text (T), comment, vote, open-card and file card use `setActiveTool({ type: 'custom', customType, locked: true })` plus `api.onPointerDown`. With a custom tool, Excalidraw creates nothing [API]. `locked: true` is required or the tool reverts after one click [rev-run `types.d.ts:620-630`]. Note and text are custom so that Excalidraw's `stickynote` and `text` tools are never active: their clicks open the text editor directly (`index.js:46338-46380`, `51240-51257`, `51295-51320`) [r3-run], bypassing the lease (§2.9.2). Lobby never activates the `autoshape` tool either, since its double-click also opens the editor (`index.js:44733`). `CanvasPort.setTool` refuses `text`, `stickynote` and `autoshape` (and `image`, `embeddable`, `magicframe` and `bucketfill`) [spike-A A16].
- **Read-only roles and tools.** Under the `interaction` config, `api.setActiveTool` refuses every tool except `laser` and `custom`, the selection tool included (X 44343-44350; `isToolSupported` X 42465-42479; console: `"selection" tool cannot be activated while the editor is non-interactive`). A commenter in the comment tool could not get back to selection through the API, and a primary-button drag pans only when no capturing tool is active (X 28808-28815, 48043-48048). So for read-only roles, `CanvasPort.setTool('select')` (and any non-custom tool) writes `appState.activeTool` through `updateScene({ appState: { activeTool } })` [spike-A A4].
- **Actions.** Undo and redo replace Excalidraw's built-ins through `api.registerAction` [API].

### 2.4 Sync protocol and server (apps/sync)

#### 2.4.1 Files

**Kept as is, or with small edits:**
- `app.ts`: the upgrade path, Origin check, `verifyTicket` before upgrade, `sid = uid:clientSessionId`, replaced-socket guard, token bucket and 4099 terminal reasons;
- `access.ts`, `join-queue.ts`, `touch.ts`, `session-end.ts`, `config.ts`, `permissions.ts`, `server.ts`;
- `backup/**` (its readers change);
- `http/**` (their payloads change).

**`deleted/**`** gets a new store on the new `lb_deleted` table (§2.6), with the same limits and trim rules. The new build never writes, trims or rebuilds `dr_deleted_*`. It reads them only for conversion and for the asset-ref collector, until `drop-legacy`.

**Replaced:** `rooms.ts` (the registry stays; TLSocketRoom and SQLiteSyncStorage go), `lease.ts`, `attribution.ts` (its ledger is ported), `presence.ts`, `snapshot.ts`.

**Deleted:** `user-records.ts`: there are no user records in board data any more.

**New**, in `apps/sync/src/room/`:
- `element-room.ts` (queue, drain, fan-out), `store.ts` (SQLite), `merge.ts`, `invariants.ts` (cross-element rules), `custom-data.ts` (key classes), `lease.ts`, `index-keys.ts`;
- `outbound.ts` (one ordered queue per session, global memory budget);
- `file-refs.ts` (batched lookup and LRU), `workshop-state.ts`;
- `metrics.ts`, served at `GET /internal/metrics`;
- `migrate/` (conversion worker with `resourceLimits` and a process-wide queue of one, and the record-level roll-forward merge; §5.3, §5.9).

**Engine code on the server: pure functions only** [spike-A A3, A16-static]:
- The sync process calls `setCustomTextMetricsProvider` once at start-up, before any layout. Without it, `newTextElement` and `getStickyNoteLayout` throw `document is not defined` in Node (E 5731-5735, created lazily at 5754-5758).
- It never instantiates `Scene`. In plain Node, `Scene.replaceAllElements` throws `window is not defined` on its first call in any 60 s window (E 18949), and its lodash throttle timer keeps the process alive for 60 s. Only pure helpers are used, through `packages/canvas-schema/src/engine/**`: layout (`getStickyNoteLayout`, text wrapping), bindability predicates, bound-point helpers (§2.9.4 rule 7) and `fractional-indexing`.

#### 2.4.2 Wire protocol

JSON, one message per frame, types in `packages/canvas-schema/src/protocol.ts`. The server parses every client message with zod. The endpoint and query are unchanged: `/connect/:boardId?sessionId=…&ticket=…` [SYNC]. `proto: 1`.

**Ops are patches.** A create carries the full element. An update carries only the field groups that changed. A position patch is about 75 bytes, against about 470 bytes for a whole rectangle [rev-run `plan2/sizes.mjs`].

```ts
type Op =
  | { k: 'c'; el: WireElement }                              // create or undelete
  | { k: 'p'; id: string; pv: number                         // pv = the server version this edit is based on
      g?: Partial<Record<GroupName, Record<string, unknown>>> // changed groups, with only their fields
      c?: Record<string, unknown | null>                      // customData.lobby keys; null = remove
      b?: { add: { id: string; type: 'arrow' | 'text' }[]; rm: string[] }  // boundElements
      fit?: { height: number; width?: number; x?: number; y?: number }  // container fit, lease holder only, conditional (§2.9.4)
      off?: number }                                         // age in ms, only on replays from the offline queue
```

| Direction | Message | Content |
|---|---|---|
| client→server | `hello` | `{proto:1, schema, since, epoch, tab}` |
| | `push` | `{seq, base, ops: Op[] (≤500, frame ≤1 MiB), doc?: {set: Record<key, value \| null>}}` |
| | `lease.acquire` / `lease.release` | `{req, id}` / `{id}` (§2.9) |
| | `presence` | `{pointer, button, sel, view, idle, editing, drag?}`. No identity fields. `drag` is `{d, ids?, dx, dy} \| null`: `d` names the drag (a per-session counter), `ids` (≤ 500) is sent **only in the drag's first message**, and later messages carry `dx`/`dy` alone (§2.7). |
| | `ping` | |
| server→client | `welcome` | `{sid, you:{uid,name,color,role,guest}, readonly, epoch, clock, reset, doc, leases, roster, workshop, limits}` plus either catch-up `changes` or a snapshot (a binary gzip frame, compressed once per cached snapshot) |
| | `changes` | `{clock, ops}`: one commit batch, **serialized once and sent to every session**, including the writer. Each op carries the new server `v`, the previous `pv`, `updated`, and `lobbyServer` when it changed. |
| | `ack` | `{seq, clock, r: [{id, ok:true, v, fix?} \| {id, ok:true, v, denied:{groups, code}} \| {id, ok:false, code, el \| null}]}`. `fix` lists only fields the server rewrote (index, a repaired binding, rounded points), or `fitDropped: true` when a conditional fit was not applied (§2.9.4). |
| | `lease` | Broadcast `{id, holder: {sid, uid, name} \| null}`; to the requester `lease.grant {req, id, ttlMs}` or `lease.deny {req, id, holder}`. |
| | `roster` | Uncapped join, leave and update events (§2.7). |
| | `presence` | 10 Hz, capped cursors (§2.7). |
| | `workshop` | `{voteOpen, anonymous}` |
| | `notice` | `SLOW_DOWN`, `LIMIT_NEAR`, `RESYNC`, `DISK` |
| | `pong` | |

A client that receives a patch whose `pv` is not the version it holds asks for `RESYNC` (a `hello` with its `since`). That cannot happen while the prefix invariant holds, so it is a cheap safety net and a metric.

**Reject codes.**

| Code | Retryable | Counts toward the abuse close | UI |
|---|---|---|---|
| `READ_ONLY`, `LOCKED`, `LEASED`, `GONE`, `ELEMENT_LIMIT`, `GUEST_LIMIT`, `VOTE_OPEN`, `STALE` | no | no | "Change not saved" with the reason |
| `INVALID`, `TOO_LARGE`, `TYPE_CHANGE` | no | **yes** | "Change not saved" |
| `RATE` | yes, with backoff after `SLOW_DOWN` | no | stays "Saving…" |
| `UNAVAILABLE` (file lookup down, COMMIT failed, disk full) | yes | no | "Saving…", then "Can't save right now — retrying" after 30 s |

More than 50 abuse-counting rejects in a minute close the session with 4099 `INVALID_MESSAGE`.

**Terminal closes** (4099): `NOT_AUTHENTICATED`, `FORBIDDEN`, `INVALID_MESSAGE`, `CLIENT_TOO_OLD`, `SERVER_TOO_OLD`, `RATE_LIMITED`, `UNKNOWN_ERROR`. **Non-terminal**: 4000 `RECONNECT` (role change, backpressure). **Maintenance**: 4099 `MAINTENANCE` with a "Lobby is updating" reason. **Old tabs**: a tldraw `connect` message gets 4099 `CLIENT_TOO_OLD`; a new client that gets a tldraw-protocol reply shows "Reload" (§7.5).

#### 2.4.3 Accept algorithm

**Stage 0: per-session FIFO, then async pre-validation** (outside the drain). The FIFO holds every ordered message of the session: `push`, `lease.acquire` and `lease.release`. Only `presence` and `ping` bypass it (a presence renewal of a lease only extends a lease the session already holds; it never grants one).
1. zod shape check and the size limits (§3.5) → `INVALID` or `TOO_LARGE`.
2. Collect `fileId`s the room has not seen. Resolve them with one `file-refs` call (A1), cached per room (§2.10.2). On an api error, ops that need an unknown id are answered `UNAVAILABLE` (fail closed); other ops go on.
3. A push waits here until its lookup finishes. Later messages **from the same session**, pushes and lease messages alike, wait behind it, so a session's order is kept. Other sessions are not blocked.

So a `lease.release` sent after the editor's final push can never overtake that push, even when the push is parked on a file-refs lookup (open item 5). The cost: an `acquire` sent right after a push that carries a new image waits for that lookup (at most the 3 s api timeout); the client's key buffer covers the wait. Tested in `text-lease` (§6.2): a release queued behind a push whose file-refs lookup is delayed takes effect after that push commits.

**Stage 1: the drain.** Pushes and lease messages enter the room queue in the order they leave stage 0, so a release takes effect after the push sent before it. A drain (on `setImmediate`, at least 25 ms after the previous commit of this room when busy) takes up to 64 pushes, or about 8 ms of work, into one `BEGIN IMMEDIATE`, with a `SAVEPOINT` per push. Each push gets its own clock (+1).

Each op goes through these steps:
1. The session is read-only → `READ_ONLY`.
2. Load the stored element (an indexed point read).
3. A patch for an unknown id → `GONE`. A create checks the item and guest caps (§3.5). A create for a tombstone id is an undelete.
4. A `type` change → `TYPE_CHANGE`.
5. **Lock.** If the element — or, for a bound label, its container — is `locked` and the op does not unlock it, deny every group except `meta.locked`, `z` and `bound` (`LOCKED`). Guests cannot lock or unlock.
6. **Lease.** If the element, or the container it names in its stored **or pushed** `containerId`, is leased by another session, deny `text`, `layout` and `life` (`LEASED`). Other groups in the same op are still accepted (partial accept). A `fit` from any session but the container's lease holder is dropped silently (`fitDropped`; it never counts toward the abuse close and shows no toast).
7. **customData classes** (§3.3): server-owned keys are replaced by stored values; create-only keys are accepted only in a create, stamped with the writer; `plusOne:<uid>` needs uid = the writer and no open vote (`VOTE_OPEN`); `file` is canonicalized from the lookup; `tag:<id>` needs the tag in `lb_doc`.
8. **Stale offline writes** (§2.5.6): a replayed op older than 10 minutes, for a group someone else wrote after its `base`, gets `STALE`. A `text` write whose `base` is below the text group's last write by someone else gets `STALE` at any age.
9. **Merge:** start from the stored element, overlay each allowed group; `boundElements`: stored + add − remove; `customData.lobby`: per key; `customData.lobbyServer`: stamped; `updated` = server time; `version` = max(stored, client) + 1; per-group write clocks (`gclock`) updated. A holder's **`fit`** is applied last, and only if no ordinary write to the container's `pos` or `shape` group was committed after the push's `base` (`gclock.pos` and `gclock.shape` ≤ `base`). Otherwise it is dropped with `fitDropped`. Fit writes advance `gclock.fit`, never `gclock.pos` or `gclock.shape` (§2.9.4). **When a fit is applied, the server recomputes the endpoints of every arrow bound to that container**, in the same savepoint and clock, as a derived write (§2.9.4 rule 7). The same re-snap runs when an ordinary write to an arrow was based on geometry older than its bound target's last `fit`, `pos` or `shape` write (rule 7, case c).

After the last op of a push, before `RELEASE SAVEPOINT`:

10. **Cross-element invariants** (§2.4.4), which may reject ops (`INVALID`, `LEASED`, `LOCKED`) or add server repairs.
11. **Index.** A null key, or one used by another id, gets a new key between its neighbours. A bound label must sort after its container; if not, the label is re-keyed. Both come back as `fix`.
12. **Upsert** with this clock. When `isDeleted` flips to true, record it for "Recently deleted" in `lb_deleted`, in the same transaction.

**After COMMIT, and only then:**
- update in-memory state (lease table, attribution ledger, group-parent map, the index cache);
- serialize the batch's `changes` once and enqueue the same bytes for every session;
- enqueue the acks, then lease events;
- call touch and session-end.

**Failures.**
- A bug thrown while applying one push rolls back only that push's `SAVEPOINT`. Its ops are answered `INVALID` and only ids are logged.
- If `COMMIT` itself fails (disk full, I/O error): `ROLLBACK`; every push in the batch is answered `UNAVAILABLE`; nothing in memory changed; the room closes its connection and reopens the board file from disk; sessions get 4000 `RECONNECT` and resync from `since`. A `DISK` notice goes out when free space is below 5%. A durability test injects a COMMIT failure (§6.2).

**Prefix invariant (core correctness rule).** A message carrying clock C goes to a session only after that session has been sent every accepted write with clock ≤ C. Because `changes` go to everyone, including the writer, this holds by construction. A reconnect with `since` = the last clock it processed never skips a write. It is tested as a property (§6.2).

#### 2.4.4 Cross-element invariants (new)

`invariants.ts` checks these after each push, with `@excalidraw/element`'s own `isBindableElement` and `isTextBindableContainer` through the canvas-schema wrappers [rev-run]:

| Invariant | On violation |
|---|---|
| A text with `containerId: X` needs X to exist, be live and be a text container (`rectangle`, `stickynote`, `diamond`, `ellipse`, `arrow`) | `INVALID` |
| Container ↔ label is one-to-one: X's `boundElements` lists exactly one text, and that text names X | A second label for X → `INVALID`. The server keeps X's `boundElements` in step when a label is created or deleted (a server repair in the same clock). |
| Creating a label for X, or pointing a text at X, **inherits X's lease and lock**: the writer must hold X's lease or X must be unleased, and X must be unlocked | `LEASED` / `LOCKED` |
| A label sorts after its container | Label re-keyed (`fix`) |
| Deleting a container deletes its label in the same clock | Cascade by the server; blocked by step 6 if the label is leased by someone else |
| `startBinding`/`endBinding.elementId` exists, is live and is bindable | The binding is set to null (`fix`); the arrow keeps its points |
| Bindings are symmetric: a bound arrow is listed in its target's `boundElements` | Repaired by the server (the target's `bound` group, allowed even when the target is locked) |
| `frameId` names a live `frame` | `INVALID`; a frame deleted concurrently → `frameId` set to null (`fix`) |
| Group nesting is consistent: each group id has one parent group across all elements | `INVALID` |
| `type` is one of §3.1 | `INVALID` |

Each rule has a property test and a negative protocol test (§6.2).

#### 2.4.5 Rates and backpressure

Inbound, per session:
- messages: 400 burst, 200/s → 4099 `RATE_LIMITED` (kept);
- ops: 2,000 burst, 500/s sustained → op rejected with `RATE` plus a `SLOW_DOWN` notice; never closes;
- bytes: 4 MiB burst, 1 MiB/s; `maxPayload` 1 MiB;
- guests: half of each.

Normal use stays far below this, because a gesture commits once at pointer-up (§2.5.3): dragging a frame with 100 notes is one push of about 200 patch ops (about 15 KB), not 4,000 ops/s.

Outbound:
- one ordered queue per session;
- per session: above 256 KiB `bufferedAmount`, skip cursor frames; above 8 MiB, close with 4000 so the client resyncs;
- **global budget 64 MiB** across all sessions: when exceeded, the session with the largest buffer is closed with 4000 first;
- the reset snapshot is cached per board for up to 5 s (one entry per board, 64 MiB total LRU). A joiner gets the cached snapshot plus a catch-up since its clock.

#### 2.4.6 Internal endpoints

Routes and the secret check stay; payloads change [SYNC]. New routes are marked.

| Route | Payload | Consumer |
|---|---|---|
| `GET …/snapshot` | `{format:'lobby-elements', schema, clock, elements (live only), doc}` | checkpoints, AI sources, vote eligibility |
| `POST …/seed` | `{elements, doc}`: validated with the same schema, limits and invariants, indexed, clock 0. Still 409 if the board is initialized. | new board from a template, duplicate, restore-as-new, import |
| `POST …/place-notes` | Same request. The server builds `stickynote` + label pairs laid out with `@excalidraw/element` (§2.11), ids derived from the draft id, `lobbyServer.privateNote` set, legacy `pageId` mapped (C1). | private-brainstorm reveal |
| `GET …/asset-refs` | Image `fileId`s, `customData.lobby.file`, plus `lb_deleted` rows, plus (read-only, until `drop-legacy`) `dr_deleted_records` rows | asset GC |
| `GET …/text?since` | `originalText`, frame names, alt text, file names | search indexer |
| `GET/POST …/deleted` | From `lb_deleted`: captured from `isDeleted` false→true transitions; a container, its label and a frame's children in one batch | Recently deleted |
| `POST …/workshop-state` (**new**, A2) | `{voteOpen, anonymous}` | api, on vote open and close |
| `POST /internal/migrate/convert-all`, `GET /internal/migrate/status` (**new**) | §5.3: queue position, the running board, worker peak heap, failures | the cut-over runbook |
| `GET /internal/metrics` (**new**) | Prometheus text: rooms, sessions by role, joins, resets, pushes, ops by result code, commit ms and pushes per commit, receive→ack ms, fsync ms, event-loop delay, outbound bytes and closes, presence in/out, lease grants and denials, file-refs hits and misses, per-board elements, tombstones and DB size | the watch after cut-over; the load test |
| `POST …/access-changed`, `GET …/backups/status` | unchanged | |

### 2.5 Client sync engine

#### 2.5.1 State

- `confirmed`: the last server copy of each element (a clone, because Excalidraw mutates elements in place [SYNC]).
- `known`: `(version, versionNonce)` of each element as last applied or last seen.
- `dirty`: per element, the changed groups, `customData.lobby` keys and `boundElements` changes, plus `isNew`.
- `inFlight`: at most 4 pushes.
- `offline`: the per-tab IndexedDB queue (§2.5.6).

#### 2.5.2 Finding local edits

- On `onChange`, find elements whose `(version, versionNonce)` differs from `known`. A full scan costs 0.5 ms at 20k elements [API].
- Diff each one against its `confirmed` clone to get the changed groups. **Local-only fields are ignored**: `status` (§2.5.5 E1) and the derivative suffix of a local `fileId` (§2.10.3).
- The engine does not depend on `onIncrement`, so it works on both builds.

**Vanishing ids.** Excalidraw sometimes drops an element from the scene array without setting `isDeleted`: a touch freedraw of under 10 points (`index.js:45638-45657`), Escape on a new element, and `loadScene` (disabled) [REV]. The rule:
- an id that was never pushed is dropped locally, with its dirty state;
- a confirmed id that vanished is re-inserted from `confirmed` at the next apply. It is not a delete: deletes only happen through `isDeleted: true`.

Each removal path has a unit test.

#### 2.5.3 Pushing: coalescing and gestures

| Situation | What is pushed | When |
|---|---|---|
| A one-shot edit (click a colour, nudge, delete, paste) | The changed groups | Within 50 ms, coalesced |
| A gesture: drag, resize, rotate, point edit, crop, freedraw | Nothing durable while it runs | One push at the end of the gesture (pointer-up) |
| A drag in progress | A `drag` preview on the presence channel: the ids (≤ 500) once, in the drag's first message, then only `dx`, `dy` | ≤ 20 Hz in, 10 Hz out (§2.7) |
| `newElement` / `multiElement` being drawn | Nothing | When finalized |
| Typing under the lease | The `text` and `layout` groups of that label | At most every 500 ms while typing, and a final push when the editor closes |

A gesture is detected from `appState` (next): `selectedElementsAreBeingDragged`, `isResizing`, `isRotating`, `resizingElement`, `newElement`, `multiElement`, `selectedLinearElement?.isEditing`, `isCropping` [rev-run `types.d.ts:236-433`; `linearElementEditor.d.ts:41`].

Each push carries at most 500 ops or 512 KiB. Freedraw, line **and arrow** points are rounded to 2 decimals when the element is finalized, before its first push (§3.5). Arrows are included because 1,000 unrounded arrow points are 39.6 KB, over the 32 KiB element limit; rounded, they are 15.5 KB [spike-A A16-static].

**Why this fits 0.5 CPU.** Durable writes happen once per gesture, not 20 times a second. Drag previews are relayed like cursors: never validated, merged, stored or committed. Numbers are in §2.13.

**What others see.** Drags move live (preview). Resizes, rotations, point edits and strokes appear when the gesture ends. Typing appears twice a second. This is a stated change from tldraw, which streams every change at its 30 fps client schedule.

#### 2.5.4 Applying server state

- Build each element from the server copy (`confirmed` plus the patch), overlaid with the client's still-dirty groups.
- **Hold back** remote changes to elements in an active gesture until it ends: the elements named by `resizingElement`, `newElement`, `multiElement` and `selectedLinearElement`, and **the selected elements** while `selectedElementsAreBeingDragged`, `isResizing`, `isRotating` or `isCropping` is set. For these gestures, a container and its label are always held, and released, together.
- **The text editor is different.** While it is open, only the edited label's `text` and `layout` are held back, and only the holder writes them anyway. Remote changes to its **container** (move, resize, style) are applied at once. Excalidraw's editor follows scene updates (`textWysiwyg` subscribes to `scene.onUpdate`, `index.js:25600`) [r3-run], and the holder then re-fits (§2.9.4), so its fit is never computed on stale geometry.
- Before calling `updateScene`, run the **index pre-pass** (§2.5.5 E2). It sorts the whole array: about 15 ms at 20k elements in Node [spike-A A8]. It is skipped when the client has no unacknowledged element of its own; if spike B's apply-path numbers (§8.4) still show it, it is scoped to the changed neighbourhood.
- Call `updateScene({ elements: all elements sorted by (index, id), captureUpdate: CaptureUpdateAction.NEVER })`.
- Clear drag-preview offsets for elements whose committed position arrived.
- Never use `reconcileElements`: its tie-break keeps whichever copy has the lower `versionNonce`, which can keep a write the server rejected [SYNC].

#### 2.5.5 Echo sources and suppression rules

A client that only receives changes must push nothing. The review confirmed two sources the first draft missed. Each source now has a rule and a test.

| # | Echo source | Evidence | Suppression rule | Test |
|---|---|---|---|---|
| E1 | **Image load failure.** `updateImageCache` replaces a failed image with `newElementWith(el, {status: "error"})`, which bumps its version. A failed load is never retried in the session: the error stays in the image cache and both `addNewImagesToImageCache` and `addMissingFiles` skip known ids. | [rev-run] X 47089-47111; confirmed at X 47091-47111, never retried E 22637-22641, X 47113-47118, 43789-43821 [spike-A A7] | `status` is **local-only**: in no group, never pushed, stored by the server as `'saved'` and ignored in diffs. Lobby's loader fetches bytes itself and calls `addFiles` only with a `blob:` URL that already loaded (§2.10.3), so Excalidraw never fetches. | A browser whose derivative returns 404 pushes 0 ops and shows Lobby's placeholder (spike B7; e2e) |
| E2 | **Index collision.** `updateScene` → `replaceAllElements` → `syncInvalidIndices` re-keys a colliding element in place and bumps its version. Two people creating at the top of the order both get `keyBetween(max, null)`. | [REV] probe1, re-run: B went `a1`/v1 → `a1V`/v2 [rev-run]; element `index.js:12728` | **Pre-pass:** before each `updateScene`, the engine checks the final array. It re-keys only **its own unacknowledged** elements, strictly between their confirmed neighbours. A re-key of an element whose push is not yet sent goes out with that push; a re-key of an element already in flight stays local, because the server will assign a key and return it as `fix`. Confirmed elements are never re-keyed: the server guarantees unique keys and label-after-container order (§2.4.3 step 11). | Concurrent creates at the same end of the order from two browsers, 50 each: a third, receiving browser pushes 0 ops; keys unique; all converge (spike B10; protocol and e2e) |
| E3 | Bound-text order: a label must sort after its container. **Nothing in the npm builds enforces it** (revision 3.1 said dev builds throw; that is false): `validateIndicesThrottled` runs only when `isDevEnv()`/`isTestEnv()` is true or `window.DEBUG_FRACTIONAL_INDICES` is set, `isDevEnv()` is always false because common's `import.meta.env` has no `MODE`, and `syncInvalidIndices` never fixes label order. A label sorted below its container is accepted silently. | E 18947-18958, 12713; C 34, 2945 [spike-A A8] | Server re-keys the label (§2.4.4); the pre-pass applies the same rule to the client's own new labels. These are the only guards; tests must not rely on Excalidraw throwing. | Included in E2 tests |
| E4 | A remote change applied with the default `captureUpdate` | [API] dbg4 | Only the adapter calls `updateScene`, always with `NEVER`; a lint rule forbids other calls | Probe suite (§6.5) |
| E5 | Font loading | `Fonts.onLoaded` only clears shape caches and triggers a redraw; no version change [rev-run `chunk-FN755BR4.js:3026-3052`]. Confirmed: 17 elements, 27 font files, 0 ops [spike-A A9]. Labels are **not** re-measured after a late font load; a stale layout is fixed when the editor next closes on that label (1 op, `x` and `width`), by its lease holder. | None needed | Probe: load a board with every font, count version changes (0) |
| E6 | Normalization on apply (`restoreElements`, sticky-note normalization) | [API] `restoreElements` bumps versions | The engine never calls `restoreElements` on server data. The server stores already-normalized elements (it runs the same `@excalidraw/element` normalizers on create). | Apply 1,000 server elements of every type: 0 version changes |
| E7 | A remote container change while a label is shown, and sticky-note auto-fit | `updateScene` runs no sticky-note re-layout: `relayoutStickyNotes` is called only by the paste-styles action (`index.js:11819`). The fit runs in the editor (`index.js:49806-49848`), in resizes, and in `redrawTextBoundingBox` [r3-run] | A watcher never re-lays out on apply (confirmed: a remote shrink stayed at 200 px until the holder re-fit, spike A17). While a lease is held, the label layout and the container fit have one writer, the holder (§2.9.4), and bound-arrow endpoints are recomputed by the server (rule 7). Without a lease, the client that caused the change writes them. | Spike B3 L6 and L10: C pushes 0 ops |
| E8 | A vanished id re-inserted | §2.5.2 | Re-inserted from `confirmed` with its server version; `known` updated first | Unit test per removal path |
| E9 | A local derivative swap of `fileId` | §2.10.3 | The suffix is stripped at the adapter boundary before diffing | Unit test |

**Global guard.** In dev and test builds, the engine asserts after every apply that no element whose last change came from the server changed version without a local gesture. A violation logs `echo_suspect` with the element id and fails the test run. In production it is a metric. **Three expected local writes in the lease holder's editor window are exempt** (§2.9.4) [spike-A A16, A17]:
- the editor re-positions the label after a remote container move (`updateWysiwygStyle` writes the label's `x`/`y`, X 25212);
- it re-measures the label when it opens (X 49918);
- it rewrites the endpoints of arrows bound to the container while the holder types (X 49845, 49864-49868).

The first two are the label's `layout` group and are pushed only by the holder. The third is **never pushed**: the server's recompute replaces it (rule 7).

#### 2.5.6 Reconnect and the offline queue

- **Reconnect.** `hello{since, epoch}`. The server sends a catch-up (tombstones included) or a reset. The client rebases its dirty groups on top and pushes again.
- **Offline queue, per tab.** IndexedDB, keyed by board, user and tab. The tab holds a Web Locks lock (`lobby-offline:<board>:<tab>`). On load, a tab adopts queues of the same user and board whose lock is free (a closed tab), so their edits are replayed, not lost, and two tabs never replay the same queue.
- **What is queued:** the latest element, its dirty groups, the base clock and the time it was queued.
- **Staleness.** Replayed ops carry `off` (their age). The server applies the `STALE` rules in §2.4.3 step 8. The client then shows a review list ("3 offline changes conflict with newer edits"): **Keep mine** re-pushes them with a fresh base; **Discard** drops them. For text, the client offers "Copy my text".
- **Limits.** 5,000 elements or 20 MB. At the cap, editing is blocked with a banner ("Too many unsaved changes on this device — reconnect to keep editing"). Edits are never dropped.
- **Privacy.** Guests get no offline persistence (memory only). The queue is purged on sign-out, "sign out everywhere", a `FORBIDDEN` close and a revocation.
- **Horizon.** Tombstones are kept 14 days (§2.6), longer than any queue can wait unnoticed.

Today offline edits live only in memory (SYNTHESIS §11), so this is an improvement.

#### 2.5.7 Saved, exactly

"Saved" shows only when **all** of these hold:
- no dirty groups, no push in flight, no queued offline op;
- no upload in flight;
- no open text editor with unsent text;
- every sent push has its ack. Acks are sent after `COMMIT` with `synchronous=FULL`, so Saved means on disk.

The other states:

| State | When |
|---|---|
| "Saving…" | Anything above is pending, including `RATE` and `UNAVAILABLE` retries |
| "Offline — N changes on this device" | No socket; N from the queue |
| "Change not saved" + reason | A non-retryable reject (for example `LEASED` → "Alice is typing in this note") |
| "Can't save right now — retrying" | `UNAVAILABLE` for more than 30 s |

The labels in `sync-quality/copy.ts` stay. `saveTracker.ts`, `perPropUndo.ts` and `rebaseGuard.ts` are retired; their tested semantics move to §2.5 and §2.8.

### 2.6 Persistence

Per board file, same pragmas as today: WAL, `synchronous=FULL`, `busy_timeout` 5000, plus `cache_size = -4000` (4 MB page cache per open board, §2.13).

```sql
CREATE TABLE lb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- clock, horizon, epoch, schemaVersion, converted_from (JSON, §5.3)
CREATE TABLE lb_elements (id TEXT PRIMARY KEY, clock INTEGER NOT NULL, idx TEXT NOT NULL,
  deleted INTEGER NOT NULL, deleted_clock INTEGER, deleted_at INTEGER, type TEXT NOT NULL,
  version INTEGER NOT NULL, gclock TEXT NOT NULL,   -- JSON {group: clock, 'c:<key>': clock}
  data TEXT NOT NULL);
CREATE INDEX lb_elements_clock ON lb_elements(clock);
CREATE INDEX lb_elements_order ON lb_elements(idx, id);
CREATE TABLE lb_doc (key TEXT PRIMARY KEY, clock INTEGER NOT NULL, value TEXT);  -- NULL = removed
CREATE TABLE lb_deleted (seq INTEGER PRIMARY KEY AUTOINCREMENT, batch INTEGER NOT NULL,
  element_id TEXT NOT NULL, type TEXT NOT NULL, container_id TEXT, frame_id TEXT,
  data TEXT NOT NULL, deleted_by TEXT NOT NULL, deleted_by_name TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, epoch TEXT NOT NULL, origin TEXT NOT NULL);  -- 'live' | 'converted'
CREATE INDEX lb_deleted_element ON lb_deleted(element_id, seq);
CREATE INDEX lb_deleted_batch ON lb_deleted(batch);
CREATE TABLE lb_source (id TEXT PRIMARY KEY, state BLOB NOT NULL);
  -- converted boards only: the tldraw `documents` rows this board was last converted or merged from
  -- (the roll-forward base, §5.9); dropped by drop-legacy
```

- The room keeps **no parsed element cache**. Merges read the stored row by id. Welcome snapshots concatenate stored `data` strings in `ORDER BY idx, id`. This keeps memory per room small (§2.13).
- **Recently deleted** lives in `lb_deleted`. It has the same limits and trim rules as today's store, applied only to `lb_deleted`. **`dr_deleted_records` and `dr_deleted_schemas` stay exactly as they are**, tldraw-only. The new build never writes, trims or rebuilds them; their `kind IN ('shape','binding')` CHECK constraint [repo `apps/sync/src/deleted/store.ts:55`] is never touched. They are dropped only by `drop-legacy`. Their rows are copied into `lb_deleted` when a board is converted (§5.4).
- **Tombstones.** A deleted element's row is its tombstone. Compaction runs at room open and in the backup pass. It purges tombstones older than **14 days**, or the oldest beyond 10,000, then sets `horizon`. A client whose `since` is below `horizon`, or whose epoch differs, gets a reset.
- **Ordering.** `ORDER BY idx, id` in SQLite matched Excalidraw's comparator on 492 rows, including equal indices [SYNC].
- **Migrations.** Stored rows are migrated to the current `schemaVersion` when a room opens, using migrations in `packages/canvas-schema`.
- **Restores.** Every restore — staged, drill, lazy-converted or roll-forward — writes a **new epoch** and a clock above any value a client has seen (the existing bump logic). A stale client then gets a reset instead of keeping ghost elements (SYNTHESIS §7). Tested (§6.2).

### 2.7 Presence

**Pointer source.** Lobby does not use `onPointerUpdate`. Under the `interaction` config it never fires for read-only roles in the normal state (§2.3.2), which would silence about 160 of L1's 200 cursors. Instead, Lobby's own passive listeners on the board wrapper read the pointer for **every role**: capture-phase `pointermove`, `pointerdown`, `pointerup` and `pointerleave`. They convert client coordinates to scene coordinates with `CanvasPort.screenToScene` and throttle to 20 Hz. They never call `preventDefault` or `stopPropagation`, so Excalidraw's input is unaffected. `pointerleave` sends `pointer: null`. Tested per role in spike A4 (11–12 samples per 30 moves, about 15–16 Hz; `onPointerUpdate` 0 with no tool) and B5 R1. `savePointer` also returns early when `clientX` or `clientY` is 0 (X 47787-47789), one more reason not to depend on it [spike-A A4].

**Input.** Clients send only `{pointer, button, sel, view, idle, editing, drag?}`. The server adds `sid`, `uid`, `name`, `color` and `guest` from the ticket and keeps them in memory. This keeps the authz-004 fix by construction. Input is capped at 20 Hz. `sel` is capped at 1,000 ids; above 200, a count is sent instead. **While a dot vote is open, the server drops `sel`** (ballots leaked through selection before; `workshops.spec.ts:257-267`) [REV].

**Two output channels:**

| Channel | Content | Rate | Cap |
|---|---|---|---|
| `roster` | join, leave, name, role, guest | on change | **none**: the people list, search over 200+ people, and "(guest)" come from here |
| `presence` | cursors, selections, `view`, `editing`, `drag` | 10 Hz, changed peers only | 40 cursors per recipient, preferring peers inside the recipient's `view`. **Always included:** the peer the recipient follows, the presenter, and anyone who summoned the recipient ("Bring to me") |

Coordinates are rounded to integers. Clients interpolate cursors between frames.

**Drawing.** Lobby draws cursors, name tags and "(guest)" in the overlay, in Lobby's palette colours, and honours "hide cursors". Excalidraw gets `updateScene({ collaborators })` only for remote selection outlines, which use hashed colours because `Collaborator.color` is never read [API]. That is a stated deviation (§4).

**Drag previews.** A `drag` entry is applied on receipt as a render offset through `canvas/overrides.ts` (`setElementRenderOverrides`) [rev-run `types.d.ts:655-667`]. The offset goes on the container; its bound label follows it, and an offset on a label alone is ignored [spike-A A10]. It never touches the document, undo or `onChange`. It is cleared when the committed positions arrive, when the peer's `drag` ends, or when the peer leaves. Arrows bound to dragged elements catch up at commit. Spike A measured the client side: a 100-note preview with the offsets replaced every frame ran at 60 fps, about 60 override updates per second [spike-A A14].

**The relay (open item 6).**
- **Ids once per drag.** The dragger's first presence message of a drag carries `drag: {d, ids, dx, dy}`; later ones carry `{d, dx, dy}`, and the end sends `drag: null`. `dx`/`dy` are scene units rounded to 0.1. The drag rides in the presence message the client already sends at ≤ 20 Hz, so it adds no message.
- **Server.** It keeps each session's active drag (`d` and `ids`) in memory. It puts `ids` into the next outgoing presence frame after the start, and only `{sid, d, dx, dy}` after that. It includes the active drags, with their ids, in `welcome` and after a reconnect, so a late joiner can show them. Drag entries are **not** subject to the 40-cursor cap: everyone who sees the elements must see them move. A recipient that missed the start (a skipped frame under backpressure) ignores deltas for an unknown `d` and sees the move at commit.
- **Checks.** Shape and caps only: ≤ 500 ids, id syntax, one active drag per session, rate as presence. The ids are not looked up. **A read-only session's `drag` is dropped**, so a viewer cannot make elements appear to move for everyone (B5 R1).
- **Budget.** In §2.13; measured in B9.

**Stated deviation: hit tests during a remote drag.** Render overrides move only the drawing. Hit tests, selection and editing keep using the document position until the drop commits (`types.d.ts:1095-1110`) [r3-run; confirmed spike-A A10]. While Bob drags a note, a click on the note's **drawn** position misses it, and a click on its **old** spot would hit it. Lobby's capture-phase `pointerdown` guard, the same one that stops clicks on hidden mind-map items (§4.7), swallows a pointerdown on an element under a remote drag preview and shows "Bob is moving this". Clicks on the drawn position still miss until the commit, typically under one second. The owner accepts this deviation (Appendix B 2). tldraw moved the shape itself for everyone, so it had no such gap.

The guard has three gaps that spike A found, with these rules [spike-A A10]:
- **The dead zone at the old spot.** The old spot may show something else, such as the frame or a note that was under the moving one. A click there hits the moving note and would be swallowed, so what the user sees there cannot be clicked. Rule: when the guard swallows a pointerdown, it runs Lobby's own hit test at that point, skipping elements under a preview and hidden elements. If that finds a visible element, the guard selects it through `appState` (selection only; a drag needs a second press) and shows the toast. The rest of the dead zone lasts until the commit and is part of the stated deviation.
- **The hover cursor.** Excalidraw keeps the `move` cursor over hidden elements and over elements under a preview (X 45504-45525). Lobby's passive `pointermove` listener runs the same hit test and toggles a wrapper class that forces `cursor: default` over them.
- **Touch.** The guard also runs for touch and pen pointers, and the double-tap detector (§2.9.2 P4) swallows a double-tap on a hidden element or on one under a preview without asking for a lease. None of this was tested in spike A. B12 tests taps, double-taps and long-presses under touch emulation.

**Follow, "Bring to me" and present-to-everyone** use `view` and `api.setViewport`, not Excalidraw's `userToFollow`.

**Voting** is a custom tool: a click votes through the api and never selects the note.

### 2.8 Undo

**Goal.** Per-user, per-field undo that never reverts another person's change and never resurrects an element someone else deleted. "One Ctrl+Z undoes one real change" (keyboard-safety round 3). This is today's `perPropUndo.ts` contract, re-implemented [repo `perPropUndo.ts:1-22`].

**Why not Excalidraw's history or deltas.** Excalidraw's deltas treat `customData` and `groupIds` as whole values; only `boundElements` and `points` are array-diffed. The review's probe2, which I re-ran [rev-run]:
- I add a +1, Bob adds his +1, I undo → `customData.lobby` becomes `{tag:x}`: Bob's +1 is gone;
- I group, Bob wraps it in an outer group, I undo → `groupIds` becomes `[]`: Bob's group is gone.

`applyTo` also redraws bound arrows and label boxes on other elements, which can overwrite concurrent edits or touch a leased label. A plain selection change is also its own step [API].

**Decision (D6): a Lobby-owned, field-level stack** in `canvas/history/`.

**Recording.** The history module keeps its own **`lastLocal`** snapshot: a clone of each element as it stood at the end of the previous recorded step, including local changes the server has not acknowledged yet. At a step boundary it diffs the current local scene against `lastLocal`, **not** against `confirmed`, records the diff as one entry, and moves `lastLocal` forward. An earlier step that is still unacknowledged is therefore never absorbed into the next entry: two quick edits are two entries, and one Ctrl+Z reverts exactly one of them. The sync engine's diff against `confirmed` (§2.5.2) is separate: it decides what to push, not what to undo.

Entries are recorded at Lobby's granularity:

| Part of an element | Recorded as |
|---|---|
| Top-level fields, per field group | `[before, after]` values |
| `customData.lobby.<key>` | `[before, after]` per key |
| `groupIds` | ids added and ids removed |
| `boundElements` | ids added and ids removed |
| `isDeleted` | `[before, after]` |

- Step boundaries: the end of a gesture, a text-editor close, one keyboard action, or one `CanvasPort.transact` (a template insert, an AI result, a mind-map re-layout join the user's step).
- Selection and viewport changes are never recorded.
- Each entry remembers the push `seq` that carried it. When an op is rejected, its part of the entry is dropped, so undo never replays a change the server refused.
- **Server fixes are folded in, never recorded.** When an ack carries `fix` (a re-keyed index, rounded points, a binding set to null), the fixed values replace the entry's `after` for those fields, and `lastLocal` is updated too. The compare-and-set then compares against what the server actually stored, so a fix never causes a false "1 change kept". The same goes for the client's own index re-key of unacknowledged elements (E2) and for server repairs to other elements (label cascade, `boundElements` symmetry). The repairs arrive as `changes`, are applied with `NEVER`, and update `lastLocal`. **No fix or repair ever creates an undo step.**
- **Text-editor sessions.** While the editor is open, Ctrl+Z and Ctrl+Y belong to the textarea's native undo (§2.3.3). Closing the editor records the whole session as one entry (`originalText` before → after, plus the layout).
- `api.registerAction({ name: 'undo' | 'redo' })` replaces the built-ins, so keys and menus use Lobby's stack. Lobby calls `api.history.clear()` when idle so Excalidraw's own unused stack stays small.

**Applying an undo (redo is the mirror image).** A 3-way compare-and-set against the current scene. **The compare-and-set unit** [spike-A A15]: changes are recorded per field, but they are compared and restored **per group for coupled geometry** (`pos`, `shape`, `layout`: the fields of that group which this entry recorded go back together or not at all) and **per field elsewhere** (`style`, `textStyle`, `meta`, `bind`, `z`, `file`, and each `customData` key). Only recorded fields are compared, so a field this entry never touched never blocks it. Why neither simpler rule works: per field left U7's child 2 at C's `x` with A's old `y`, a position nobody chose; per whole group would block A's resize undo because Bob rotated the element (`angle` is in the same `shape` group).

| Case | Rule | Skip reason |
|---|---|---|
| Coupled geometry (`pos`, `shape`, `layout`) | Set the recorded fields of the group back to `before` only if every one of them still equals the entry's `after` | `changed` |
| Any other field, or a `customData` key | Set it back to `before` only if its current value still equals the entry's `after` | `changed` (someone edited it since) |
| Already at the target | The current value already equals `before` (someone moved it back, or a repair already nulled a binding): nothing is written and nothing is reported. A no-op is not a skip. | — |
| `groupIds` | Remove the ids this entry added, if still present; re-add the ids it removed, if that group still exists. Other ids stay | — |
| `boundElements` | Same, id by id. Skips here are silent: they are bookkeeping, which the server keeps symmetric (§2.4.4). | — (silent) |
| Element deleted by someone else since | Not touched, never revived | `deleted` |
| Undo of my own create | Set `isDeleted: true`, unless another user has since put children in it (frame) or bound to it | `has-foreign-children` |
| Undo of my own delete | Revive, unless the id was purged or the revive would point at a missing parent or binding target | `orphan` |
| A label leased by someone else | `text` and `layout` groups not touched | `locked` |

**Side effects.** After the fields are set, the applier recomputes the geometry that depends on them — bound arrow endpoints and label layout — only for elements this entry touched, with `@excalidraw/element` helpers. The results go out as ordinary `pos`/`shape`/`layout` patches. It never writes `text` or `layout` of a label leased by someone else.

The result is installed with `updateScene(…, NEVER)` and pushed by the engine as an ordinary edit. When fields were skipped, a small toast says so ("1 change kept — Bob edited it since"), as today.

**Redo re-applies only what the undo applied.** A part the undo skipped leaves nothing to redo. That is what keeps "never resurrected, including by redo" true (U6).

**Life-version check (spike A15's known edge).** If A deletes X by an undo, someone restores X, and someone deletes it again, A's redo of that entry would revive it. So each entry that changes `isDeleted` records X's `gclock.life` as it stood after the undo or redo, and the next redo or undo of that entry changes `isDeleted` only if `gclock.life` is still that value. Otherwise the part is skipped (`deleted`). Unit test in wave 2C.

**An entry that becomes empty is dropped.** When a `fix` cancels an entry's only change (a bind to an element the server found deleted), the entry is removed, so Ctrl+Z never spends a press on a no-op. A fix never adds a step. So in browsers the stack length is **at most** the number of real actions (B2 U10) [spike-A A15].

**Known edge: bound endpoints.** `points` is one field. If the server re-snaps a bound arrow's endpoint (§2.9.4 rule 7) after B moved one of that arrow's midpoints, B's undo of the midpoint move is skipped as `changed`. This is rare and visible ("1 change kept"). Wave 2C may refine it by comparing `points` without the bound endpoints.

**Limits.** An element someone else deleted is never brought back, including by redo. This removes the first draft's documented "redo resurrects" limitation.

**Tests (unit, Node, pure):** the probe2 cases (+1, tag, group, outer group); move vs remote recolour; same-field conflict skipped; remote delete not resurrected; foreign children; leased label untouched; rejected op dropped from its entry; **two steps inside one round trip undo one at a time**; **an index/points/binding `fix` folded into `after`, so undo applies with no false skip**; **a server repair creates no entry**; coupled-geometry units (U7, resize vs remote rotate); no-op not a skip; redo only of what was applied; the life-version check. Spike A15 passed 31/31 of these in Node, 3 runs, with `record()` at about 5 ms for 20,000 elements (`apps/web/src/canvas/history/`) [spike-A]. In real browsers: spike B2 (§8), including U9 and U10.

### 2.9 Text lease

#### 2.9.1 Why explicit

The first draft's lease was implicit: taken on the first `originalText` change and lapsing after 5 s. If A paused for 6 s, B could take it and A's later keystrokes were rejected. Two people could also open the same editor. The explicit lease fixes both.

#### 2.9.2 Protocol

| Step | Client | Server |
|---|---|---|
| Open | Any editor-open path (table below) sends `lease.acquire {req, id}`. `id` is the container for a label, or the text element for free text. Keys typed meanwhile are buffered. | Grants if the id is free or already held by this session; else `lease.deny {req, id, holder}`. |
| Granted | Opens Excalidraw's editor with a synthetic Enter (allowlist bypass flag, spike A2), replays the buffered keys. **Caret:** a Lobby-initiated open (P1, P2, P3 off the label, P4, the T tool) replays at the end of the text, as today's type-to-edit does (A11Y-12; Excalidraw's own Enter would select all). A guard-caught open (P3 on the label, P5) keeps Excalidraw's caret or selection: the click point for P5, all the text after a double-click (X 51685, 25613-25614) [spike-A A2, A16]. The textarea is focused in a `setTimeout` (X 25545-25561) and `updateScene({appState})` only schedules a React update (X 43825-43851), so the synthetic Enter first flushes the selection with `flushSync`. | Broadcasts `lease {id, holder}` |
| Denied | No editor. Toast: "Alice is typing in this note". Buffered keys dropped. | — |
| Typing | Pushes `text` + `layout`, plus the container `fit` when the editor changed it (§2.9.4), at most every 500 ms | Accepts them from the holder only |
| Idle | Nothing extra: presence carries `editing: id` at least every 2 s while the editor is open, which renews the lease | TTL 10 s from the last renewal |
| Close | Final push, then `lease.release {id}` | Applies the release after that push commits (same queue); broadcasts `lease {id, holder: null}` |
| New element | A note or text created by this session: the editor opens at once, writable, and the acquire is sent right after the create push (the per-session FIFO keeps that order, §2.4.3). Its `text` and `layout` pushes wait for the grant; they are queued, not dropped. | Grants like any other acquire: when no **other** session holds a live lease on the id. An id it has not stored yet is free by definition. Creating an element gives **no** priority over another session's live lease. In practice no one else can know the id before the create's `changes` go out, and the creator's acquire is already queued behind its create by then, so a deny cannot happen in normal use. If one happens anyway, the creator gets the Denied path's toast, its editor closes through the guard's deny step, and its typed text is offered with **Copy my text** (§2.9.3). (Revision 3.1 said the server "always grants" here, which could override a live lease; open item 7.) |

A pause of any length keeps the lease while the editor is open and the socket is alive. A lease is held per **session** (tab), shown with the user's name. A second tab of the same user is refused ("You're editing this note in another tab").

**Editor-open paths in `next` (all of them).** `App.startTextEditing` has seven call sites and `handleTextWysiwyg` two [r3-run, `excalidraw/dist/dev/index.js`]. Spike A confirmed the count in `dist/dev` and in the minified `dist/prod`, where the method names survive: 7 and 2, one definition each, none in chunks [spike-A A16-static]. Each path is intercepted before Excalidraw acts, caught by the guard, or made unreachable:

| # | Path | Where in `next` | Interception |
|---|---|---|---|
| P1 | Enter on a selected text or text container | `onKeyDown` → `startTextEditing` (`44150-44185`) | Enter is Lobby-owned (allowlist): acquire, then a synthetic Enter on the grant |
| P2 | Printable key on a selected note (type-to-edit) | not an Excalidraw path | Lobby-owned: acquire, buffer, synthetic Enter, replay |
| P3a | Mouse double-click **off a label**: on a note's body, on an unlabelled container, on a text, or on a plain simple arrow | React `onDoubleClick` → `handleCanvasDoubleClick` (`48930`, `44726-44871`) | Capture-phase `dblclick` on the wrapper stops it; Lobby's handler acquires. `canvas/input/dblclick.ts` mirrors `handleCanvasDoubleClick` branch by branch and stops only what would become text editing. **A plain double-click on a simple arrow edits the arrow's label** (it falls through to `startTextEditing`, X 44838-44864), so it is a text path with lease id = the arrow [spike-A A16]. |
| P3b | Mouse double-click **on the label** of a note (or container) that the first click selected | The second **pointer-up** calls `startTextEditing` through the P5 code (X 51679-51686) before the browser fires `dblclick`; `handleCanvasDoubleClick` then returns because `editingTextElement` is set (X 44727) | This is P5: the capture `dblclick` stop cannot prevent it. **The guard** catches it: read-only from the first frame [spike-A A16] |
| — | **Forwarded** (not text paths) | a double-click on a `line`, or Ctrl/Cmd+double-click on a simple arrow, toggles the linear editor (X 44741-44744); an elbow arrow with a selected linear state goes to segment editing (X 44746); a double-click on a group member enters the group | `dblclick.ts` lets these through to Excalidraw with no acquire. Revision 3.1 wrongly said a plain arrow double-click opens the linear editor (open item 2). |
| P4 | **Touch double-tap** | `onTouchStart` on the interactive canvas → `handleCanvasDoubleClick` (`43477-43517`, attached at `47143-47148`); no `dblclick` fires. `onTouchStart` deselects first (X 43506-43516), so a double-tap is always a text path, never a linear-editor or group case. | Capture-phase `touchstart` (`passive: false`) on the wrapper runs Lobby's own tap-twice detector with Excalidraw's thresholds (`TAP_TWICE_TIMEOUT` 300 ms, `DOUBLE_TAP_POSITION_THRESHOLD` 35 px, `common` `1892`, `2069`). On a one-finger second tap it calls `stopPropagation()` **and `preventDefault()` on every platform** on that `touchstart` only (pinch and pan pass through), then runs the same handler as P3. Excalidraw calls `preventDefault` only on iOS (X 43481-43483); elsewhere the second tap's compatibility `mousedown`, 1–2 ms after `touchend`, steals focus from the new textarea, and 1 in 5 Excalidraw-opened editors closed again at once [spike-A A16]. |
| P5 | **Second click on a selected text, or on the label of the only selected container** (mouse or pen, on pointer-up, no drag) | `51679-51686`, `getSelectedTextEditingContainerAtPosition` `49945-49965` | Cannot be stopped without breaking selection and drag, so **the guard** (below) handles it |
| P6 | **Text-tool click** on a container, a text, an arrow endpoint or empty canvas; text drawn by drag | `handleTextOnPointerDown` (`46338-46380`); `handleTextWysiwyg` for a new text (`51240-51257`) | Unreachable: T is a Lobby custom tool (§2.3.4). Its click hit-tests: on a text or container it runs the lease flow; on empty canvas it creates a text through `transact` (a new element) |
| P7 | Sticky-note tool click, and dropping the sticky-note tool from Excalidraw's toolbar | `51295-51320`; `AppToolDrag` `onDrop` (`27822-27829`) | Unreachable: N is a Lobby custom tool, and `ui={false}` has no toolbar to drag from |
| P8 | Double-click with the `autoshape` tool | `handleCanvasDoubleClick` (`44733`) | Unreachable: `autoshape` is never activated |

**The guard (backstop for P3b, P5 and any path not yet known).**

**The invariant (revision 3.2; being fixed in spike A's fix round).** At every moment, a writable text editor in this tab belongs to the element of a **granted lease held by this tab**. **Any `editingTextElement` whose lease id (the container for a label, the text itself for free text) is not the id of a granted lease is unrequested, whatever the session phase**: idle, pending for another id, opening, or open on another id. Spike A's guard ran only when Lobby had no session or was idle (`editorLease.ts:150-155`, `CanvasInput.ts:248`). The verifier opened note B's editor by a double-click or P5 while Lobby's request for note A was pending. B's textarea was writable, no acquire was ever sent for B, `insertText` (as an IME or dictation would, with no keydown) changed B's label, and afterwards Lobby's state and Excalidraw's disagreed: A's lease was released before A's final write (20/20) [verify-A]. The engine path itself is sound, so this is a guard bug in Lobby's code, not a "stop and re-plan" finding (§8.5).

**Detection.** Three ways, each enough on its own:
- on `onChange`, when `appState.editingTextElement` names an element that is not the element of a granted lease of this tab;
- in the capture `keydown` listener, when a key's target is Excalidraw's textarea (`.excalidraw-wysiwyg`, inside Lobby's wrapper) for such an element;
- in a capture `beforeinput` listener on the wrapper, for input with no keydown (IME, dictation, `insertText`).

The textarea is appended synchronously (X 25633), so the guard sets `readOnly` in the same task, before any input can land. With `readOnly` set, `insertText` changes nothing: 5/5 in the verifier's idle-guard control [verify-A].

**Reconciliation.** On every `onChange`, Lobby compares its lease session with Excalidraw's `editingTextElement`. If they disagree, the engine's editor wins as the user's latest intent. Lobby cancels its own session for the other id: a pending request is abandoned and its buffered keys are dropped, and a granted lease is released **only after that element's final push**, through the FIFO. Then it treats the engine's editor as a guard-caught open (steps 1–5). A tab has at most one editor intent at a time.

An element this session has just created follows the "New element" row: its editor opens writable while the acquire is in flight, and its text pushes wait for the grant.

**Steps:**
1. It sends `lease.acquire` for the lease id.
2. It sets the textarea `readOnly` and buffers keys (§2.3.3) until the answer. IME composition starts only after the grant.
3. The engine pushes **nothing** for that label, its container fit, or arrows bound to the container while the lease is pending or held by someone else. That includes the create of a label Excalidraw made for an unlabelled container, and the **open-time layout writes**: opening the editor re-measures the label and can rewrite its `x` and `width` with a version bump before any key (`handleTextWysiwyg` ends with `updateElement`, X 49918; `updateWysiwygStyle` writes `x`/`y`, X 25212) [spike-A A16]. Those writes are the label's `layout` group and are held back like typing. (Spike A's cold-open test attributed the re-measure to a label laid out before Nunito loaded, but its own log shows the font already loaded, so the cause is not shown [verify-A]. The rule does not depend on the cause.)
4. **Grant:** `readOnly` is cleared and the buffered keys are replayed at Excalidraw's caret (above). The user notices nothing beyond one round trip.
5. **Deny:** a synthetic Escape on the textarea closes the editor with the text unchanged. Any local-only label Excalidraw created is dropped (it was never pushed; §2.5.2). The label, the container and any bound arrows are reset from `confirmed`, and the toast says "Alice is typing in this note".

**What the checks count.** "Nothing pushed before a grant" is measured as **0 ops pushed**, not "0 local element changes": opening the editor can change the label locally (step 3).

The server enforces the same thing regardless (steps 6 and 10, §2.4.4). The guard is what keeps the client from showing an editor it cannot save.

**Pinned by the probe suite (§6.5).** A probe counts the `startTextEditing` and `handleTextWysiwyg` call sites in the pinned bundle (7 and 2). An Excalidraw bump that adds a path fails the probe until the path is added to this table.

#### 2.9.3 Losing the lease

If A's socket is down for more than 10 s, the lease expires and B may take it. When A reconnects, `welcome.leases` shows B as holder. A's editor stays open with its buffer and a banner: "Not saved — Bob is editing this note now" with **Copy my text**. A's buffer never overwrites B's text.

#### 2.9.4 What the lease protects

- `text` group: `originalText` (the words).
- `layout` group: the wrapped `text`, and for a **bound label** also `fontSize`, `x`, `y`, `width`, `height`; for free text, `width` and `height`.
- `life` of the label and of its container.
- **The container's fit** (new in revision 3): the container geometry that Excalidraw's text editor writes as a side effect of typing.

While a lease is held, only the holder writes these. Everyone else's other groups are accepted (move, resize, style, tags).

**Why the container's fit needs a rule** [r3-run]. Typing writes the **container**, not only the label:
- For a `stickynote`, every editor update runs `getStickyNoteLayout` and replaces the container with its output (`index.js:49806-49848`). That output is `x`, `y`, `width`, `height` and `baseHeight` (`element` `index.js:6964-7040`). `height` = max(`baseHeight`, text height + inset). `x`/`y` move only when a rotated note grows, through the top-anchor shift of `getPositionAfterHeightChange` (`element` `16091-16108`). `width` and `baseHeight` are written back unchanged unless the note is below the minimum size.
- For a `rectangle`, `ellipse` or `diamond` label, the editor grows the container's `height` while the text overflows, and shrinks it back towards the original (`index.js:25125-25147`). `redrawTextBoundingBox` can widen it for a word wider than the box (`element` `6320-6326`).

These fields sit in the unleased `pos` and `shape` groups. Without a rule, A's auto-grow would be pushed from A's copy and would overwrite B's concurrent resize or move.

Spike A17 recorded exactly what Excalidraw writes while the holder types [spike-A A17]:
- **The container (sticky note):** `height` only. `x`, `y`, `width` and `baseHeight` are written back unchanged for an unrotated note (X 49822-49824).
- **The label:** `originalText`, `text`, `fontSize`, `width`, `height`, `x`, `y`. The font shrinks before the note grows (E 6906-6963).
- **Bound arrows:** `points`, `width` and `height`, rewritten from the holder's **local** copy by `updateBoundElements` after every sticky-note update (X 49845), and for the label through the `onChange` wrapper (X 49864-49868; E 9055-9123 → `LinearElementEditor.movePoints`). Non-sticky containers do the same in the text editor (X 25133, 25147). After a remote move or resize, the holder's first re-fit rewrote the arrow from its own copy.
- **After a remote move** the editor writes only the label's `x`/`y` (X 25212); it writes nothing back to the container.

**The rule: fit writes are the holder's, and conditional.**
1. **What counts as fit.** On the holder's client, any change to the edited label's container made while the editor is open and no gesture runs (§2.5.3) is **fit**, not a user edit: `height`, and `x`/`y`/`width` when the editor changed them. For an unrotated note that is `height` alone. `baseHeight` is not on the wire and does not need to be: the editor never changes it above the minimum size. The adapter never puts fit into the container's `pos` or `shape` dirty groups. It sends it as the op's `fit` field (§2.4.2).
2. **Only the holder sends fit.** Other clients never send `fit` for a container leased by someone else, and the server drops it if they do (§2.4.3 step 6). Their own resizes and moves go out as ordinary `pos`/`shape` writes and are accepted. Their local re-layout of the leased label is not pushed; it is replaced by the holder's layout when that arrives.
3. **Fit never overwrites a user edit.** The server applies a `fit` only if no ordinary `pos` or `shape` write to that container was committed after the push's `base`. Otherwise it drops the fit (`fitDropped`). A fit write does not advance `gclock.pos` or `gclock.shape`.
4. **The holder re-fits on newer geometry.** The holder does not hold its container back while editing (§2.5.4). When a remote `pos`/`shape` change to its container arrives, or a `fitDropped` comes back, it applies the change. The open editor follows it (`index.js:25600`). The holder then re-runs the layout with Excalidraw's own helper (`updateStickyNoteLayout`, or `redrawTextBoundingBox` for other containers) and sends `fit` + label `layout` with a new base, coalesced within 50 ms. This is the holder's designated write, not an echo; watchers push nothing.
5. **Close.** The final push carries `text`, the label `layout` and one last `fit`, computed on the latest container.
6. **Lease expiry.** If the holder vanished and the container's geometry changed after its last fit, **the server** re-fits the label and the container in Node with the same helpers and the metrics table (§2.11).
7. **Bound arrows follow a fit on the server (open item 3, closed).** The server recomputes the endpoints of arrows bound to a container whenever it applies a fit. The holder never pushes them.
   - **Holder's client.** A change to an arrow bound to the leased container or its label, made by the engine while the editor is open and no gesture runs, is **fit-derived**. It is local-only: never dirty, never pushed, exempt from the echo guard (§2.5.5). If a `fitDropped` comes back, the adapter resets those arrows from `confirmed`, as the deny step does. The server's values replace the local ones when they arrive.
   - **Server: when.** Every time the drain applies a `fit` to container X (§2.4.3 step 9), after the fit is merged, in the same savepoint and clock. Also on a lease-expiry re-fit (rule 6) and on the roll-forward's re-fit (§5.9 step g).
   - **Server: which arrows.** Every live arrow A listed in X's stored `boundElements` whose `startBinding.elementId` or `endBinding.elementId` is X, or X's label.
   - **Server: which fields.** Only the endpoint or endpoints bound to X move. The arrow's other points keep their stored values. For a straight or curved arrow: `points`, `width` and `height`, plus `x`/`y` when the start point is the bound one (a linear element's `x`/`y` is its first point). For an elbow arrow: its route (`points`, `fixedSegments`, `width`, `height`, `x`, `y`), recomputed by the element package's elbow routing with a map of X, A and A's other target. The endpoint comes from the stored `FixedPointBinding` (`fixedPoint`, `mode`) and X's new geometry, computed by the pure bound-point helpers of `@excalidraw/element` behind `packages/canvas-schema/src/engine/binding.ts`. **UNVERIFIED:** that elbow routing runs in Node without `Scene` (§2.4.1). The room owner probes it on day 1 of spike B. If it does not run, elbow arrows fall back to the other option (below) and the spike report says so.
   - **Server: how it is recorded.** A derived write in X's clock. It advances **A's `gclock.fit`, never `gclock.pos` or `gclock.shape`**, and is attributed to the server. So it never makes someone's later arrow write `STALE`, never counts as "ours changed" in a roll-forward (whose step g re-derives it anyway), and never blocks a container fit. It goes out in the same `changes` frame as the fit, so every client sees the note and its arrows move together. It is allowed on a locked arrow: a locked arrow follows its bound target, as it does in Excalidraw.
   - **Composition with people editing the arrow.**
     a. *B's arrow write was committed before the fit* (earlier in the batch or earlier): the recompute starts from the stored A, which includes B's write, and moves only the bound endpoint. B's change of the free end or of the midpoints survives.
     b. *B is dragging A while A types* (B's gesture holds back remote changes to A, §2.5.4): B sees the recompute only after the drop. B's pointer-up push carries B's points.
     c. *B's arrow write is based on geometry older than X's* (`base` < X's `gclock.fit`, or < X's `gclock.pos` or `gclock.shape`), for example case b, or B's client had not yet received the fit: B's `pos`/`shape` write is accepted, and then the server **re-snaps** A's endpoints that are still bound to X, in the same clock, as another derived write. B's other points are kept, and an endpoint B unbound is left alone. Without this, B's stale endpoint would sit off X's edge until X next changed. The `pos`/`shape` half also covers the ordinary case with no lease (B edits an arrow while C moves its target); it costs one bound-point computation per such write.
     d. *B moved or resized X itself*: that is an ordinary write, and the fit is dropped by rule 3. When B's client resized X, Excalidraw on B's client moved the bound arrows as B's ordinary write, as without a lease.
   - **Undo.** The derived writes arrive as `changes`, are applied with `NEVER` and absorbed into `lastLocal`; they never create a step (§2.8).
   - **The rejected option.** The alternative was to send the arrow writes as fit-derived ops in the holder's push, with the fit's base, dropped together with the fit. It was rejected for three reasons. It puts a second element under a conditional write form. The holder's copy of the whole arrow can be stale: its other end or midpoints, moved by someone else, would be written back from the holder's copy and revert that edit. And it gives the arrow two writers. The server has the latest state of X and A at drain time, and it keeps one writer.
   - **Tested:** §6.2 ("Text lease, container fit") and spike B3 L6 and L10, with a straight and an elbow arrow bound to the container and a third browser dragging the arrow's free end.

So at any moment exactly one party writes the fit: the holder while leased, the server on expiry, and the client that caused the change when no lease is held. Arrows bound to a fitted container have one writer too: the server, whenever it applies a fit. A fit computed on stale geometry is never kept.

**Resize while typing (B3 L6).** B resizes A's note. B's `pos`/`shape` write is accepted as B's user geometry: `width`, `baseHeight`, `x`, `y`, and the `height` B's client computed with its own copy of the text. A fit that A already had in flight, computed on the old size, is dropped by the condition in rule 3. A receives B's resize, its editor follows, and A re-fits: `height` = max(B's `baseHeight`, A's text height), and the label is re-wrapped for B's width. A pushes that, and it replaces B's interim `height` within one round trip. The server then moves the bound arrows' endpoints to the note's final edge (rule 7). The stored note ends with B's size, A's words and A's layout, and its arrows end on its edge; C pushes nothing. A rotated note moved by B while A types behaves the same way: the top-anchor shift is recomputed on B's position. Spike A17 showed the client half of this: after a remote shrink to 200 px, the note stayed at 200 until the holder re-fit, and the re-fit (to 652 px) was a pure `fit` write [spike-A].

Without a lease, any client may write `layout` and the container's geometry (for example, a resize re-wraps the label), as ordinary writes.

**Programmatic text writes** (AI, find-and-replace, template insert) need no editor. They are accepted when nobody else holds the lease.

#### 2.9.5 Visible state

`EditingBadges.tsx` shows "Alice is typing…" on the note from `lease` events, within 300 ms p95 (spike B3). The badge also shows on the people list entry.

### 2.10 Files, images and file cards

#### 2.10.1 Images

- An `image` element stores `fileId` = the Lobby **version id** (`ver_…`), or `ver_….p<n>` for a placed PDF page. `crop` and `scale` hold flips and crops. `status` is local-only (E1); the server stores `'saved'`.
- Elements never hold bytes. The files map is runtime-only and never synced.
- **Uploads.** Paste goes through `onPaste`, which returns `false`; drop goes through a capture-phase `drop` listener; Excalidraw's image tool is off. Lobby uploads to the api, then creates the element through `CanvasPort.transact`. Excalidraw's built-in path makes base64 copies, shrinks images to 1440 px and refuses anything over 4 MiB [API], so it must never run.

#### 2.10.2 File authorization (new route)

The sync server must know that a `fileId` belongs to the board's workspace. It has no such route today: it calls only `/internal/access`, `touched` and `session-ended` [repo]. And an HTTP call cannot run inside the synchronous drain.

- **Route (A1):** `GET <api>/internal/boards/:bid/file-refs?ids=ver_a,ver_b,…` with the internal secret, at most 100 ids. The api checks each version's asset against the board's workspace (the same check `/files/…` routes use). Answer: `{ ok: [{versionId, assetId, kind, name, mimeType, sizeBytes, pageCount}], foreign: [versionId], missing: [versionId] }`.
- **Where it runs:** in stage 0 (§2.4.3), before the drain, once per push for all its unknown ids.
- **Cache:** per room, LRU of 10,000 entries; positive answers kept 10 minutes, negative 30 seconds.
- **Failure:** an api timeout (3 s) or error fails closed: ops needing an unresolved id get `UNAVAILABLE`, and the client retries.
- **Use:** a `foreign` or `missing` id → `INVALID`. `customData.lobby.file` is canonicalized from the answer (§3.3).

#### 2.10.3 Lobby's image loader

Excalidraw loads every uncached image at once with no retry, and a failed load echoes (E1). Lobby therefore loads bytes itself:
- Visible images first, then the rest, at most **6 concurrent fetches** (like `meta-store.ts` `DEFAULT_MAX_CONCURRENT_META`) [repo], with retries at 1, 2, 4… s up to 5 minutes.
- **URLs.** `resolveUrl` takes the asset id, the version id, the derivative id and the board id, because the real derivative route requires `?board=` (`apps/api/src/files/serve.ts:58-63`) [spike-A A7]. So the loader is fed from asset metadata (the file-refs answer or `meta-store`), not from the element alone.
- The bytes become a `blob:` URL. Lobby calls `api.addFiles([{ id, mimeType, dataURL: blobUrl, created }])` **only after** the image decoded, and never for a load that failed: Excalidraw never retries a file it has marked as failed (E1). Until then Excalidraw draws its pending placeholder (`#E7E7E7` / `#2E2E2E`, E 13559-13572), which is never marked, and the overlay shows Lobby's placeholder.
- **Batching.** Every `addFiles` call repaints the whole scene (X 43789-43796). One call per image kept the heavy board busy for 4.9–6.5 s after open; one call per animation frame gave 0.8–1.8 s on the render branch but up to 4.2 s on the merged branch, where 3–43 calls ran while images trickled in [spike-A A14]. The loader therefore collects decoded files for up to **100 ms**, or until every visible image is ready, whichever comes first, and hands them over in one call. B7 measures it on the mood board.
- **SVG.** `addMissingFiles` re-encodes `image/svg+xml` by parsing the URL as a `data:` URL, so an SVG given as `blob:` throws (X 43806-43818). SVG images use their raster derivative. If there is none, the loader hands the engine a runtime-only `data:` URL, never stored or synced.
- **Revoking.** Blobs are revoked only when no scene element and no export still uses that file key.
- **Derivatives by zoom.** Each derivative gets its own local file key: the scene element's `fileId` is `ver_X@thumb` or `ver_X@display` locally, while the wire and the server only ever see `ver_X` (stripped at the adapter boundary, E9). Default: `thumb` (512 px). When an image is shown larger than 512 device pixels for 300 ms, it switches to `display` (2,048 px). At most 60 upgrades per session; beyond that, images stay `thumb`. The original is never loaded on the canvas.
- Memory is measured on the mood-board case in spike B7 (200 images).

#### 2.10.4 File cards, embeddables, clipboard, exports

- **File cards** (PDF, video, Office, other) are `image` elements (D7). The face is the worker's poster, cover or thumbnail; files without a preview get a client-drawn card (icon, name, size) as a `blob:` URL. Stable card facts live in `customData.lobby.file` (§3.3). Live facts — processing status, page count, duration, poster — come from the api at runtime (`meta-store`), never from the element, so the element never needs updating when processing ends. Overlay chips show status, pages, duration and a play button. Double-click (a custom-tool hit test for read-only roles) opens `file-card/PdfViewer.tsx`, a video player overlay, or open original.
- **No embeddables.** An embeddable draws a DOM layer at z-index 2 above all canvas content, takes clicks only after a hover and click, and exports as an empty box or an `<a>` [API]. The server refuses `embeddable` and `iframe`; `validateEmbeddable` returns false.
- **Clipboard across boards.** Excalidraw's clipboard JSON carries `files` [API]. The paste handler drops base64 `files` pasted from outside and uploads them properly. An image whose version belongs to another workspace is removed from the paste before any element is created, with a specific toast ("Images from another workspace can't be pasted yet"), so nothing is refused later as "Change not saved". A permission-checked asset copy route is a backlog item.
- **PNG export** draws faces and images from the runtime map; it stays untainted because `blob:` URLs are same-origin.
- **SVG export.** `exportToSvg` writes the file's `dataURL` verbatim into `<image href>` (`chunk-FN755BR4.js:4276`) [REV]; a `blob:` or `/files` URL would be dead in a downloaded file. The exporter builds an **export-only** files map with `data:` URLs fetched at export time. It is never stored or synced, so the durable-data rule holds. An e2e test opens an exported SVG with the network off.
  - **Fonts in SVG: `skipInliningFonts: true`, and Lobby embeds its own `@font-face` rules (decided).** Excalidraw's own font inlining subsets glyphs in WebAssembly through Emscripten glue that calls `new Function` (`chunk-Z5NKEFVG`), so under the CSP it needs `'unsafe-eval'` (`'wasm-unsafe-eval'` does not help). Without it, the subset worker throws, and the export embeds whole fonts: a 506 KB SVG with 1 violation and 3 `EvalError`s [spike-A A12]. The subset worker also failed with `document is not defined` under some chunkings in the spike's early builds (F near 1095-1106), one more reason not to depend on it. Lobby does not add `'unsafe-eval'`, which would weaken the CSP for every page to serve one export. Instead the exporter calls `exportToSvg` with `skipInliningFonts: true` (0 violations measured) and adds `@font-face` rules for the families the exported text uses (5, 6 and 8), embedding as `data:` URLs only the self-hosted woff2 files whose `unicode-range` covers the exported characters. That is subsetting by file, with no WebAssembly. Such SVGs are larger than subset ones; wave 3e reports the size on the heavy board's largest frame.

### 2.11 Notes, text, ordering

- **Notes** are `stickynote` elements with a bound text label:
  - `baseHeight` = the note size (Lobby uses 200 px);
  - the label's `baseFontSize` is the size the user picked; auto-fit shrinks the font towards 16 px and only then grows the note [API];
  - `roughness` 0; background from Lobby's 13-colour palette.
- **`created: null` on notes** hides Excalidraw's creation-date footer (`getStickyNoteFooter` returns null) [plan-run]. Excalidraw stamps `created` at creation, and `duplicateElement` sets `created = updated` on every copy (element `index.js:17933-17939`) [rev-run]. `mutateElement`'s update type excludes `created` (`mutateElement.d.ts:3`), but `newElement` accepts it (`newElement.d.ts:3`, `index.js:16371`) [rev-run]. So:
  - Lobby builds notes itself with `created: null` (its N tool is a custom tool), so the first render has no footer flash;
  - `onDuplicate` sets `created: null` on duplicated notes (Ctrl+D, Alt-drag, paste);
  - the server always stores `null` for `stickynote`, including on duplicates; strict zod accepts null;
  - the footer probe stays in the probe suite.

  Confirmed by spike A1: footer ink pixels 0 for Lobby's note and for Ctrl+D and Alt-drag copies, against 171 for the controls. `duplicateElement` sets `created = updated` on every copy, even from `null` (E 17932-17939), and `reconcileDuplicatedElements` merges the host's `onDuplicate` result into the copy (E 18139-18163), so Lobby's stamp works for Ctrl+D (X 3737) and Alt-drag (X 28491, 28547). `created` is excluded from `ElementUpdate` by type only; `newElementWith(el, { created })` writes it at runtime [spike-A].
- **Text** is plain. Bound labels use `containerId` and the container's `boundElements`. Free text uses `autoResize`. The lease covers the words (`originalText`) and the derived layout (§2.9.4).
- **Server-made text** (place-notes, the converter, AI seeds, lease-expiry re-layout) is laid out in Node with `@excalidraw/element` (`getStickyNoteLayout`, `newTextElement`) and `setCustomTextMetricsProvider`, installed once at start-up (§2.4.1), for families 5, 6 and 8, measured in Chromium from the real fonts.
  - **The table needs pair kerning** [spike-A A3]. `getWrappedTextLines` measures whole test lines with `getLineWidth` (E 6085, 6113), so the fonts' pair kerning changes where lines break. The revision-3 per-character table got **6 of 208** labels wrong (the A3 criterion is ≤ 3). The table in `packages/canvas-schema/src/engine/text-metrics-table.json` has per-character advances plus **measured pair kerning** (generic ASCII and Latin-1 pairs), per-class widths (Han, kana and full-width 1 em; Hangul under Excalifont 0.893–0.949 em, a median; emoji 1.373 em) and per-letter regional-indicator advances (flags are two letters on Windows, 0.73–1.16 em each). With it, **0 of 208** labels differ and 0 font sizes differ. Chromium's `measureText` widths are linear in font size (maximum relative error 1.4e-6 from 16 to 36 px), so one table at 100 px is enough. `charWidth` caches by the first UTF-16 unit (E 5772-5796), so astral characters sharing a high surrogate share a width; both runtimes do this, so layouts still match.
  - **Scope.** The table reproduces **Windows Chromium**. CJK and emoji use OS fallback fonts, so macOS and iOS may break lines differently; the lease holder's re-fit (§2.9.4) corrects a label as soon as someone edits it. If B8 finds real Korean text, a per-syllable Hangul table is added.
  - **Upkeep.** The table is re-measured with `apps/web/test/engine-probe/a3/calibrate-table.ts` on every engine or font bump, and A3 runs in the probe suite (§6.5).
  - **Determinism.** `newTextElement` stamps `created` with the wall clock unless given one (E 16371), so server-made labels pass `created: null`. Spike A's determinism test caught this in 1 run of 3.
- **Ordering.**
  - The server keeps `index` valid and unique with `@excalidraw/fractional-indexing` at the pinned version (CC0), and labels after their containers.
  - A collision is rewritten between the neighbours and returned as `fix`.
  - Clients re-key only their own unacknowledged elements (E2).

### 2.12 Fonts, third-party endpoints, CSP, licences

**Fonts.** Self-host `dist/prod/fonts` under `/excalidraw-assets/`, **without `Liberation/`**. The bundled Liberation Sans 1.05 is not OFL or MIT and is server-side only [API]. The folder is 14 MB, mostly CJK subsets fetched on demand [plan-run]. `dist/dev/fonts` and `dist/prod/fonts` are identical; the CSS's four Assistant UI fonts are bundled by Vite into `/assets/` [spike-A scaffold]. The asset plugin is `apps/web/build/excalidraw-assets.ts`.

**Every font falls back to esm.sh, so the host rewrite is mandatory** [spike-A scaffold, A12]. `ExcalidrawFontFace.createUrls` always appends `ASSETS_FALLBACK_URL`, `https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/`, as the last source of every font (F 1225-1249, 1277; the bundle's version string is `0.18.0`, not the pinned nightly). A missing local font triggers it: a text element with `fontFamily` 9 (Liberation Sans, not served) requested `/excalidraw-assets/fonts/Liberation/…`, got a 404, then requested esm.sh. Consequences:
- **The fallback becomes same-origin.** Rewriting only its host is not enough: Chrome checks every source of a `FontFace` against the CSP **when the FontFace is constructed**, and the engine constructs about 230 faces at its first render, so a merely rewritten host gave 230 `font-src` violations and 230 blocked requests on every board load, although every local font loaded. The host-rewrite plugin replaces the fallback with `${location.origin}/excalidraw-assets/` (0 violations).
- **The static host answers 404 under `/excalidraw-assets/`.** A 200 `index.html` (the SPA fallback) makes the browser treat the font as broken and move on to the next source. The spike's dev and preview servers answer 404 under that prefix (and under `/assets/`). Render's static-site rewrite (`/* → /index.html`) needs a rule that keeps it off that prefix; how Render expresses that is **UNVERIFIED** and is checked at the rehearsal (§7.5) with a request for a missing font file, which must get a 404.
- **The server refuses fonts Lobby does not serve.** `fontFamily` must be 5 (Excalifont), 6 (Nunito) or 8 (Comic Shanns), the self-hosted families that the metrics table covers (§3.5). 9 (Liberation Sans) is not served, 10 is not registered at all (fonts registry near F 3155), and the others are not in Lobby's font picker. The paste handler maps any other family to 5 before creating elements; the converter maps tldraw's fonts to 5, 6 and 8 (§5.1).

**Third-party endpoints, removed from the build.** The `next` production bundle hard-codes these hosts [rev-run, grep of `dist/prod`]. **This list is incomplete** [spike-A A12]: the engine also names `excalidraw-room-persistence.firebaseapp.com` and `.appspot.com`, `raw.githubusercontent.com`, `link.excalidraw.com` and the element package's embed allowlist (drive.google.com, forms.microsoft.com, giphy.com, reddit.com, embed.reddit.com, stackblitz.com, twitter.com, platform.twitter.com, www.figma.com), and its dependencies add more (mermaid's parser: chevrotain.io, langium.org, en.wikipedia.org). A fixed list is the wrong tool (layer 2 below).

| Host | Used by |
|---|---|
| `esm.sh` | Font fallback (`ExcalidrawFontFace.ASSETS_FALLBACK_URL`) |
| `json.excalidraw.com` | Share-link export |
| `libraries.excalidraw.com`, `us-central1-excalidraw-room-persistence.cloudfunctions.net` | Library browser and publish |
| `excalidraw-room-persistence.firebaseio.com`, `oss-collab.excalidraw.com` | Excalidraw's own collaboration |
| `oss-ai.excalidraw.com` | AI features |
| `plus.excalidraw.com`, `app.excalidraw.com`, `docs.excalidraw.com`, `github.com`, `discord.gg`, `x.com`, `mermaid.js.org` | Links in menus and dialogs |
| `www.youtube.com`, `player.vimeo.com` | The default embed whitelist |

Three layers:
1. **Disabled paths.** `aiEnabled={false}`, `ui={false}`, every `canvasActions` flag false, `validateEmbeddable` false, no library UI, no share export.
2. **Rewritten out of the bundle, and verified at build time.** The plugin `apps/web/build/excalidraw-host-rewrite.ts`, built and tested in spike A12, replaces revision 3.1's `renderChunk` list [spike-A A12]:
   - **Scope: the engine's whole dependency tree.** That is `@excalidraw/excalidraw` and every package it depends on, transitively (dependencies and optional dependencies, not peers): **266 packages**, read from the installed `package.json` files. React, tldraw and Lobby's own code are not touched.
   - **Only literals.** It finds string, template and regex literals with Vite's parser, never module specifiers, code or comments, so licence notices stay verbatim. The host of every absolute URL becomes `blocked.invalid` (RFC 6761), except the XML-namespace host `www.w3.org` and local hosts. The named hosts are also rewritten as bare text (as in the embed regexes). The font fallback becomes same-origin (above).
   - **Build-time verification.** After the rewrite, every module's literals are scanned again, and a foreign host left fails the build. An engine bump that adds a host breaks the build until the host is handled. Spike build: 2,402 engine-tree modules, 29 URL hosts rewritten, 0 left; the engine route went from 68 foreign hosts to 41, none of them from the engine's tree. Every flow made 0 foreign requests.
   - **CI rule, scoped.** Revision 3.1's "grep `apps/web/dist` and fail if any listed host remains" cannot pass while tldraw is built: it names 9 of the listed hosts, and pdf-lib, Lobby's PDF export, names `github.com`. It would still fail after cut-over on pdf-lib, react.dev and zod's json-schema.org. The rule is instead the plugin's build-time check plus `e2e/spike/csp/dist-report.ts`'s per-package attribution through source maps: **no host literal from the engine's dependency tree**. After cut-over, CI also asserts that no tldraw package is in the build.
3. **CSP, shipped at cut-over.** The static site gets a `Content-Security-Policy` header in `render.yaml` (it has none today; `render.yaml:80-92`) [rev-run]. Spike A12 ran revision 3.1's policy against the real api, sync and preview worker. It logged 2 violations per flow, both from Lobby's own app code, not the engine [spike-A A12]:
   - **`index.html`'s inline theme script** (the no-flash dark-mode boot) is blocked by `script-src 'self'`. **Decision: move it to a same-origin file** (`/theme-boot.js`, a blocking `<script src>` in `<head>`, which still runs before first paint), rather than adding its sha256 to `script-src`. The header in `render.yaml` is static, so a hash would have to be updated by hand on every edit of the script, and a wrong hash fails silently into a flash of the wrong theme. A test asserts that `index.html` has no inline script.
   - **zod's eval probe.** zod 4.6.5 runs `new Function("")` once to choose its JIT (`node_modules/zod/v4/core/util.js:218-230`). The throw is caught, but Chrome reports a `script-src` violation on every page. **Fix: `z.config({ jitless: true })` at app bootstrap**, before any schema runs, as zod's own comment advises under a strict CSP. This is Lobby app code and exists today, so it can ship in wave 4 or earlier.
   - With both fixes: **0 violations** in the sign-in and board flows, 3 runs (the zod fix was emulated in the spike and is not yet committed).
   - **SVG font inlining** is the one engine path that needs `'unsafe-eval'` (§2.10.4). **Decision: no `'unsafe-eval'`**; SVG export uses `skipInliningFonts: true` and Lobby's own `@font-face`.

   The policy Lobby ships (staging form):

```
default-src 'self';
script-src 'self' https://<clerk-fapi-host> [https://challenges.cloudflare.com];
connect-src 'self' https://draftroom-staging-sync.onrender.com wss://draftroom-staging-sync.onrender.com https://<clerk-fapi-host> [https://clerk-telemetry.com];
img-src 'self' blob: data: https://img.clerk.com;
font-src 'self';
style-src 'self' 'unsafe-inline';
worker-src 'self' blob:;
frame-src [https://challenges.cloudflare.com];
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`img-src data:` is needed for Excalidraw's placeholder and cursor images; it has nothing to do with durable data. `style-src 'unsafe-inline'` is needed because the text editor and canvas elements are styled inline. `worker-src 'self'` covers the subset worker, a same-origin module chunk, and `blob:` stays for Clerk. `font-src 'self'` is enough once the fallback is same-origin.

**Clerk origins: UNVERIFIED.** The spike had no Clerk keys and signed in nowhere real, so they are derived from code (`@clerk/react` 6.17.2, `@clerk/shared` 4.36.0), not measured [spike-A A12]. The frontend-API host is inside the publishable key (`pk_…` + base64 of `<host>$`; `@clerk/shared/dist/keys.mjs`); it can be decoded from staging's publishable key, which is public by design, without signing in. `img.clerk.com` and `clerk-telemetry.com` come from code (telemetry is off with `telemetry={false}`). `challenges.cloudflare.com` (bot protection) comes from Clerk's documentation. The rehearsal (§7.5) records the real origins from the sign-in flow's network log with the header enforced, and runs the full e2e and DEMO.md with it. The e2e check that no request leaves Lobby's own origins and Clerk's stays. Today's tldraw board also fetches a `data:application/json` URL (2 `connect-src` violations per load), which is another reason the CSP ships only with the cut-over.

**Licences.** npm licences of both builds are permissive; no copyleft package [API]. CI fails on any non-permissive licence in the production trees of web, sync, api and worker, and asserts that `packages/tldraw-import`'s tree contains only the five MIT tldraw packages (D13).

### 2.13 Capacity at 200+ users (new)

Staging sync runs on Render's **0.5 CPU / 512 MB** plan with a 1 GB disk (`render.yaml:196-207`) [repo]. Every measurement so far is from a 32-core PC. This section is a **design budget**, with estimates to be replaced by spike B's measurements.

**Load profile L1, "all-hands workshop":**
- one board of about 2k objects (about 4k elements);
- 200 sessions on it: 40 editors (one gesture commit every 3 s each; 10 of them typing), 160 watchers with cursors moving half the time;
- 20 other boards with 3 sessions each, light editing (one push every 5 s per session);
- a join ramp of 200 sessions in 60 s at the start; one SIGKILL and restart at minute 8.

**Load profile L2, "heavy board":** 30 sessions on the heavy perf board (4,500 notes, 200 images, 20 frames, about 9,200 elements), 10 editors, 20 remote edits/s.

| Budget item (L1) | Estimate | Design rule that bounds it |
|---|---|---|
| Presence in: ~2,000 msg/s | ~30 ms CPU/s | 20 Hz cap per session; invalid frames dropped |
| Presence out: 10 Hz × 200 recipients | ~80 ms CPU/s; ~3 MB/s out | ≤ 40 cursors per recipient, changed peers only, integer coordinates. Spike B compares one shared frame (serialized once) against per-view frames and picks the cheaper. |
| **Drag-preview relay** (open item 6). About 13 gestures/s from 40 editors; about half are drags of about 0.8 s, so about 7 drag starts/s and about 5 drags in progress at any time | **In:** no extra messages (the drag rides in the ≤ 20 Hz presence message already counted above), about 40 B more per message while dragging. **Out, ids once:** 7 starts/s × 199 recipients × about 150 B (1–5 ids) ≈ 0.2 MB/s; a 100-note frame drag adds about 2.3 KB × 199 ≈ 0.46 MB once. **Out, deltas:** 200 recipients × 10 Hz × 5 drags × about 30 B ≈ 0.3 MB/s. **Total ≈ 0.5 MB/s; ≈ 5 ms CPU/s with one shared frame, ≤ 20 ms with per-view frames** | Ids once per drag, then `{sid, d, dx, dy}` (§2.7); ≤ 500 ids; one drag per session; read-only sessions' drags dropped. For comparison, sending the ids in every frame would cost about 1.1 MB/s, plus about 4.6 MB/s for as long as a 100-note frame drag lasts. |
| Pushes: ~20/s on the big board (after gesture coalescing) + 12/s elsewhere | ~10 ms CPU/s for validate + merge | Patches, not full elements |
| Commits: ≤ 40/s process-wide | ~12 ms CPU/s, plus **fsync time with the event loop blocked** (node:sqlite is synchronous) | Group commit; a busy room commits at most every 25 ms |
| `changes` fan-out: ~20 frames/s × 200 sessions = 4,000 sends/s | ~60 ms CPU/s; ~3 MB/s out | One serialization per batch, same bytes for all |
| Join storm: 200 welcomes in 60 s | one snapshot (≈4.5 MB JSON, est. ≈0.6 MB gzip) compressed once per 5 s | Cached gzip snapshot + catch-up; `JoinQueue` kept |
| Bound-arrow re-snaps (§2.9.4 rule 7): one per applied fit (≤ 2 per second per typist; 10 typists) and per stale arrow write | < 2 ms CPU/s | Pure helper per bound arrow; no `Scene` |
| **CPU total** | **≈ 205–270 ms/s of 500 ms/s** | Target ≤ 80% of quota in any 10 s window |

| Memory item | Estimate | Rule |
|---|---|---|
| Node, code, `@excalidraw/element` | ~80 MB | — |
| Per open board | SQLite page cache ≤ 4 MB + group-parent map and lease table (~150 B per element; 20k elements ≈ 3 MB) + attribution ledger ≤ 1 MB → ≤ 8 MB | No parsed element cache (§2.6); idle rooms evicted as today |
| 21 open boards | ≤ 170 MB | — |
| Snapshot cache | ≤ 64 MB | LRU, one entry per board, 5 s life |
| Outbound buffers | ≤ 64 MB | Global budget (§2.4.5) |
| **RSS total, steady state** | **≤ 380 MB** | Target ≤ 400 MB in a 512 MB container |
| Conversion worker (lazy conversion or roll-forward at runtime) | Heap cap from spike B8: 1.5 × the measured peak of the largest board, at most 128 MB, plus about 10 MB of worker overhead | **At most one conversion process-wide.** A runtime conversion starts only when RSS + the cap ≤ 440 MB, after flushing the snapshot cache. If that still does not fit, it waits and its joiners see "Preparing this board…". A worker that hits its cap is terminated by Node (`ERR_WORKER_OUT_OF_MEMORY`); the main process and every room keep running (§5.3). |

Element sizes behind these numbers [rev-run `plan2/sizes.mjs`]: a rectangle ≈ 470 B; a 22-character label ≈ 730 B; a note with its label ≈ 1.2 KB, so a 20k-element board is about 12–15 MB of JSON.

**What is measured so far.** [SYNC]'s prototype (`node:sqlite`, WAL, `synchronous=FULL`, the 32-core PC): one 1-element push per commit 1.01 ms; 20 pushes in one commit 1.38 ms; a 500-element paste 7.0 ms. Group commit is therefore required.

**fsync is the unknown.** node:sqlite blocks the event loop during `COMMIT` with `synchronous=FULL`. At 40 commits/s, a 3 ms fsync blocks 12% of wall time; a 10 ms fsync blocks 40%, which would break the event-loop target. The mitigation ladder, decided from spike B's numbers:
1. raise the minimum interval between a busy room's commits from 25 ms to 50 ms (adds ≤ 50 ms to acks);
2. move SQLite writes to one storage `worker_thread` (+4 pd);
3. WAL with `synchronous=NORMAL`: still safe against a SIGKILL; only an OS or power crash can lose the last commits. Needs the owner's explicit acceptance (Appendix B).

Render's disk fsync time is **UNVERIFIED**; the NAS measures its own disk, which is a proxy. Measuring Render's needs a one-off command on the staging sync service (owner OK, no deploy; Appendix B).

**Bandwidth.** L1 sends about 6.5 MB/s out (presence 3, changes 3, drag relay 0.5), about 23 GB per hour of a 200-person session. Render's outbound bandwidth pricing for this plan is **UNVERIFIED**; the spike reports bytes so the owner can check the cost. "Hide cursors" in workshops removes most presence traffic.

**Targets (go/no-go in §8.5):** p95 ack ≤ 150 ms and p99 ≤ 400 ms; event-loop delay p99 ≤ 50 ms; RSS ≤ 400 MB; CPU ≤ 80% of quota; presence delay p95 ≤ 200 ms; no backpressure close at steady state; after the SIGKILL, all 260 sessions back within 30 s, no OOM, 0 acked-but-missing.

If the targets fail after the ladder, a larger sync plan is an **owner decision**: "free to run" removes the licence fee, not the hosting cost.

---

## 3. Element schema, customData and formats

All of this lives in `packages/canvas-schema` (new files: `elements.ts`, `groups.ts`, `protocol.ts`, `doc.ts`, `limits.ts`, `refs.ts`, `items.ts`, `custom-data.ts`, `invariants.ts`, `hash.ts` (the convergence hash, §8.6.2), and `engine/` with the typed `@excalidraw/element` wrappers: spike A built `bindability.ts`, `fractional.ts`, `layout.ts`, `raw.ts`, `text-metrics.ts` with its table, and `types.ts`; spike B adds `binding.ts` for bound endpoints). The package must export `./engine` (spike A's `package.json` exports only `.`, so `apps/sync` cannot import the wrappers yet; the contracts step fixes this, §8.6.2). Web, sync, api readers, the converter and archive import all use it (AGENTS invariant). It is frozen at the end of wave 1 (§7.1).

### 3.1 Allowed element types

| Type | Lobby use | Notes |
|---|---|---|
| `stickynote` + `text` label | sticky notes | 13-colour palette; `created: null` |
| `rectangle`, `ellipse`, `diamond` (+ optional `text` label) | shapes | Other tldraw geos exist only in converted boards (§5.1). |
| `text` | free text | plain |
| `arrow` (+ optional `text` label) | connectors, mind-map edges | `FixedPointBinding`; elbow arrows allowed |
| `line` | lines, converted polygons | `polygon: true` for closed shapes |
| `freedraw` | pen, highlighter | Highlighter = `freedraw` with opacity 50 and a wide stroke (`customData.lobby.kind = 'highlight'`) |
| `image` | images, PDF pages, file cards | `fileId` matches `^ver_[0-9A-Za-z]{10,40}(\.p[1-9][0-9]{0,3})?$` on the wire |
| `frame` | frames, slides | no nesting |
| refused | `selection`, `magicframe`, `iframe`, `embeddable` | `iframe`'s `generationData.html` becomes a `srcdoc`: a script-injection route [DATA] |

### 3.2 Field groups (`groups.ts`)

The merge unit is the field group. Names were checked against `next` `element/src/types.d.ts` [plan-run]. The map is **per element kind**, because a bound label's position and size are derived layout, not user geometry.

| Group | Fields | Merge |
|---|---|---|
| `pos` | `x`, `y` (not for bound labels) | last writer wins |
| `shape` | `width`, `height` (not for bound labels or free text), `angle`, `points`, `pressures`, `simulatePressure`, `polygon`, `scale`, `crop`, `roundness`, `seed`, `elbowed`, `fixedSegments`, `startIsSpecial`, `endIsSpecial`, `baseHeight` | last writer wins |
| `text` (leased) | `originalText` | last writer wins, behind the lease |
| `layout` (leased) | wrapped `text`; for bound labels also `fontSize`, `x`, `y`, `width`, `height`; for free text `width`, `height` | from the lease holder only while leased; otherwise last writer wins |
| `textStyle` | `fontSize` (free text only), `baseFontSize`, `fontFamily`, `lineHeight`, `textAlign`, `verticalAlign`, `autoResize` | last writer wins |
| `style` | `strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `strokeStyle`, `strokeOptions`, `roughness`, `opacity`, `startArrowhead`, `endArrowhead` | last writer wins |
| `bind` | `startBinding`, `endBinding`, `containerId`, `labelPosition` | last writer wins, then invariants (§2.4.4) |
| `bound` | `boundElements` | set add/remove by id; server keeps it symmetric |
| `z` | `index` | server-validated |
| `membership` | `groupIds`, `frameId` | last writer wins (whole value), then invariants. Undo works id by id (§2.8). |
| `meta` | `link`, `locked`, `name` | last writer wins; lock rules |
| `file` | `fileId` | last writer wins; re-authorized through file-refs |
| `life` | `isDeleted` | Delete wins. Only an explicit `false` (undo or restore) revives. |
| `c:<key>` | `customData.lobby.<key>` | per key, by class (§3.3) |
| **local-only** | `status` (image) | never synced; server stores `'saved'` |
| **server-owned** | `id`, `type`, `version`, `versionNonce`, `updated`, `created`, `customData.lobbyServer` | never taken from clients |

A canvas-schema test **fails when any key of any element type is in no group, or in two**. Without it, an Excalidraw bump that adds a field would silently never sync it. Spike A's history module (`apps/web/src/canvas/history/fields.ts`) holds a copy of this map, because `groups.ts` did not exist yet; it classifies every key of rectangle, ellipse, diamond, stickynote, text, bound label, arrow, elbow arrow, line, freedraw, image and frame in this engine [spike-A A15]. The contracts step moves it here, and the history module imports it: one map, one coverage test.

**Container fit** (§2.9.4) is not a group. It is a conditional write form for a text container's `height`, `width`, `x` and `y`, which belong to `shape` and `pos`. Only the label's lease holder may use it, and the server applies it only when no ordinary `pos`/`shape` write came after its base. The coverage test is unaffected. **Derived writes**, meaning a fit and the server's bound-arrow re-snaps (rule 7), advance `gclock.fit` of the element they change, never `gclock.pos` or `gclock.shape`.

### 3.3 customData: five classes

Only two top-level keys are allowed: `lobby` and `lobbyServer`. Anything else is refused with `INVALID`. Every key has a spec in the `customData` key registry (`custom-data.ts`): class, value schema (today's contracts readers, which take `meta: unknown`), per-key size, and what `onDuplicate` does with it.

| Class | Keys | Server rule | On duplicate / paste |
|---|---|---|---|
| **1. Server-owned** (`customData.lobbyServer`) | `createdBy`, `createdAt`, `lastEditedBy`, `lastEditedAt`, **`privateNote` `{session, author?}`** | Only the server writes them; a client value is replaced by the stored one. `privateNote` is written only by the `place-notes` endpoint. | Server builds them fresh for the copy (`createdBy` = the paster; `privateNote` never copied) |
| **2. Create-only, identity-stamped** | `kind`; `ai` `{by, run?}`; `privateFrame` `{session, by}` | Accepted only in the op that creates the element; `by` must equal the writer's uid (stamped if absent). Later changes → `INVALID`. Removal allowed for the `by` user or an owner. | `ai` and `privateFrame` stripped; `kind` kept |
| **3. Identity-bound, per key** | `plusOne:<uid>` | Add or remove only where `<uid>` = the writer's uid. An addition while a dot vote is open → `VOTE_OPEN`. At most 200 keys (`PLUS_ONES_MAX`) [repo]. | Stripped |
| **4. Validated against the api** | `file` `{assetId, versionId, kind, name, mimeType, sizeBytes}`; `pdfPage` | `versionId` must equal the version in `fileId`; `assetId`, `kind`, `mimeType`, `sizeBytes` are **canonicalized** from the file-refs answer; `name` is client-writable (≤ 200 chars). `pdfPage` is derived from the `.p<n>` suffix. | Kept (same file) |
| **5. Free, schema-validated** | `alt` (≤ 500 chars); `tag:<tagId>` (≤ 10 per element, `MAX_TAGS_PER_SHAPE`; the tag must exist in `lb_doc`); `mindmap`, `mindmapEdge`; `present` `{index?, skip?}`; `prompt`, `slot`, `swatch` | zod per key | `mindmap` ids re-linked to the copies or stripped when the copy leaves the tree; `present.index` stripped; tags kept |

Why: `privateNote.author` (contracts `workshops.ts:598-601`) could otherwise be forged by any editor or guest; a forged `privateFrame` would let a facilitator's Cancel remove someone's frame; `plusOne:<uid>` could be written for another person; `file` metadata was not tied to `fileId` [REV].

`lobbyServer` shape:

```ts
{
  createdBy: { uid, name, guest } | null,
  createdAt: number,
  lastEditedBy: { uid, name, guest } | null,   // set on text changes of text elements
  lastEditedAt: number,
  privateNote?: { session: string, author?: string },
}
```

- `lastEditedBy` replaces `props.textLastEditedBy`.
- The ported attribution ledger restores the original author on the author's own undo (SEAM-01) [SYNC].
- An anonymous reveal writes `null`.

### 3.4 Board document (`lb_doc`)

Per-key last writer wins, under the same clock, validated per key:

| Key | Value | Today | Who writes |
|---|---|---|---|
| `startView` | `{x, y, w, h, frameId?}` | `document.meta.drStartView` (`pageId` dropped) | owners |
| `workshop` | `{hideNoteAuthors, hideCursors}` | `drWorkshop` | facilitators (owner/editor) |
| `tagDef:<id>` | `{name, color}` | `drTagList:<id>` (≤ 200, `MAX_TAGS_PER_BOARD`) | editors |
| `import` | `{from:'tldraw-5.4.2', converterVersion, at, legacyPages, legacyIds, lossy}` | new | the server only |

### 3.5 Server validation and limits

**Elements.** A strict zod schema per type (unknown keys refused), pinned to the `next` field set. Numbers finite, **`x`, `y`, `width` and `height` within ±1e6** (revision 3.1 allowed ±1e7, but Excalidraw logs `New element size or position is too large` above 1e6, E 16334-16343 [spike-A A16-static]; the converter reports `over-limit` and shifts a flattened board that would exceed it). `type` never changes. `index` must be a valid fractional key. **`fontFamily` ∈ {5, 6, 8}**, the families Lobby serves and measures (§2.12). Any other value is `INVALID`, including 9 (Liberation Sans, not served, whose fallback went to esm.sh) and 10 (not registered).

**Limits, reconciled with measured sizes.** The first draft's limits contradicted each other: a 64 KiB element cannot hold 8,000 freedraw points, 200 +1s do not fit in 8 KiB, and a 20,000-character text does not fit in 64 KiB [REV]. Measured on `next` with realistic strokes [rev-run `plan2/sizes.mjs`]:

| Measured | Bytes |
|---|---|
| freedraw, mouse, unrounded points | ≈ 40 B per point |
| freedraw, pen with pressures, unrounded | ≈ 58 B per point |
| freedraw, points and pressures rounded to 2 decimals | ≈ 16–21 B per point |
| one `plusOne:<24-char uid>` key | ≈ 44 B (200 keys ≈ 8.8 KB) |
| rectangle / 22-character label | ≈ 470 B / ≈ 730 B |

| Item | Limit | Why |
|---|---|---|
| Points precision | 2 decimals for `points` and `pressures` of `freedraw`, `line` **and `arrow`**. The client rounds when an element is finalized (its own new element, so no echo); the server rounds anything finer and returns `fix`. | Halves stroke size; 1,000 unrounded arrow points (39.6 KB) break the 32 KiB limit, rounded they are 15.5 KB [spike-A] |
| `freedraw` points | ≤ 2,500. A longer stroke is simplified (Ramer–Douglas–Peucker, 0.5 px) and, if still too long, split into consecutive strokes in one group. | ≈ 50 KB at 20 B per point |
| `line` / `arrow` points | ≤ 1,000 | |
| `originalText` | ≤ 20,000 characters (today's cap) | |
| `customData.lobby` without `plusOne:*` | ≤ 8 KiB | |
| `plusOne:*` keys | ≤ 200 keys, own budget ≤ **16 KiB**; a uid is at most 60 characters (checked in `auth-tickets` and here) | 12 KiB held 200 keys only for uids up to about 40 characters (12,001 of 12,288 B) [spike-A]; 200 × about 80 B for 60-character uids fits 16 KiB |
| Element JSON, per type | `text` ≤ 144 KiB (two copies of 20,000 characters at up to 3 bytes each, plus overhead); `freedraw` ≤ 64 KiB; every other type ≤ 32 KiB | Worst case per type, not one number for all |
| `groupIds` / `boundElements` | ≤ 32 / ≤ 1,000 | |
| **Board cap, in items** | ≤ 20,000 **items**, where a bound label does not count (a note + its label = 1 item), and ≤ 40,000 live elements in total | Today's cap is 20,000 shapes **per page** (`MAX_SHAPES_PER_PAGE`) [repo]; each note is now 2 elements |
| Archive import | `maxElements` = 40,000 (= the live element cap) | The first draft's 40,000 was above its own 20,000 live cap |

All limits live in `limits.ts` and are shared by the server, the client (it refuses before pushing), archive import and **the converter**. The converter checks every output element against them and simplifies, splits or reports with a lossy code (`stroke-simplified`, `over-limit`), so it never writes a board the server would reject. A flattened multi-page board over the item cap fails conversion with a report; the owner decides (for example, split it into boards).

**Links.** `link` must be `http(s)`, `mailto` or a Lobby-relative path, at most 2 KiB. Never `data:`, `javascript:` or a signed URL (`X-Amz-Signature`, `Signature=`).

**Files.** `fileId` must resolve through file-refs to the board's workspace (§2.10.2).

**Guests.** The optional `guest` ticket claim (A3). Guests get half the op rate, a per-session creation cap (500 items), Lobby-relative links only, and no lock or unlock.

**Rejections are per op.** A bad op is rejected and the socket stays open. Today a single `INVALID_RECORD` closes the session for good.

### 3.6 Ids, object refs and links

- **Element ids** are strings. Converted ids are the tldraw id without `shape:`. Extra elements made by the converter get suffixes: `<id>.t` (label), `<id>.o` (polygon outline), `<id>.g` (its group) [DATA]. Readers follow `containerId` and `boundElements`, never suffixes. New ids are Excalidraw's nanoids.
- **Api contracts keep `shape:<elementId>`** as the object-ref format: `CommentShapeRef`, `AI_SHAPE_ID_PATTERN`, `DeletedShapeId` [repo]. One helper in `refs.ts` maps between the two. Comment anchors, AI ids and vote targets stay valid with no Postgres migration.
- **Deep links (C2).** tldraw links are `?d=s<id>.<id>` (shapes), `p<pageId>` and `v<x>.<y>.<w>.<h>.<pageId>` (`copy-link.ts`, `content-search.ts:78`) [repo]. Since converted ids can contain `.`, new links use:
  - `?el=<id>,<id>` for elements (`,` never appears in an id);
  - `?view=<x>,<y>,<w>,<h>` for a viewport.

  The legacy `?d=` parser stays. It maps shape ids directly (a `.`-joined list is split against the set of live ids, longest match first) and maps page and viewport links through `lb_doc.import.legacyPages`.

### 3.7 Formats

- **Snapshot** (internal): `{format:'lobby-elements', schema, clock, elements, doc}`.
- **Board archive v2** (`.lobby.json`):

  ```ts
  { format: 'lobby-board', version: 2, engine: 'excalidraw', engineVersion: '0.18.0-1118751', schema, exportedAt,
    elements, doc, assets: ArchiveAssetRef[] /* unchanged */ }
  ```

  - Export strips `lobbyServer.privateNote.author`, `plusOne:*` and `lastEditedBy` (as today's export strips authors).
  - Import validates with the same schema and limits, gives every element a fresh id and remaps `containerId`, `boundElements`, bindings, `frameId`, `groupIds` and the refs inside `mindmap`/`mindmapEdge`; indices go above the target's top.
  - Import accepts v2 natively, and **v1** (`draftroom-board`) through `packages/tldraw-import`.
- **Checkpoint body v2**: `{format:'lobby-checkpoint', version:2, boardId, clock, schema, elements, doc}`. v1 bodies are converted **on read** (§5.5).
- **Backup manifest**: fields unchanged; `documentClock` carries `lb_meta.clock`; a new `format` field (absent = tldraw). The asset-ref collector reads `fileId` and `customData.lobby.file`.

---

## 4. Feature-by-feature plan

Legend: **Keep** (no canvas change, or config only), **Rewrite** (same behaviour on the new engine), **Drop** (removed, with the reason), **Defer** (after the cut-over). Sizes feed §7.

### 4.1 Canvas objects

| Feature | Verdict | Plan | Hard part |
|---|---|---|---|
| Sticky notes (N, palette, sizes, auto-fit) | Rewrite | `stickynote` (§2.11) | `created: null` on create and duplicate; label ink follows the note stroke colour |
| Type-to-edit, double-click, double-tap, click-to-edit, Enter re-edits, the RETRO-02 exception | Rewrite | Lease acquire, then a synthetic Enter and the buffered keys; every other editor-open path goes through the guard (§2.9.2) | **Hard**: no public "start editing" API, and seven internal paths. Spike A2, A16 and B3 L9. |
| Shapes: rectangle, ellipse, diamond | Rewrite | native types | |
| Shapes: triangle, star, cloud, hexagon and the other tldraw geos | Drop for new content | Converted boards keep them as a grouped `line` polygon plus a holder rectangle [DATA] | Arrows bind to the holder box |
| Text | Rewrite | Plain `text` | Rich-text formatting is lost (§5.2) |
| Connectors (L), labels, elbow arrows | Rewrite | `arrow` with `FixedPointBinding`, `elbowed` | L means arrow in Lobby, line in Excalidraw (Lobby-owned key) |
| Pen, highlighter, line | Rewrite | `freedraw` / `line`, rounded points (§3.5) | Highlighter is approximated |
| Frames, frame outline and reorder | Rewrite | `frame` + `frameId`; order in `customData.lobby.present` | No nested frames |
| Groups | Rewrite | `groupIds`; undo per id (§2.8) | |
| Lock / "Unlock all" | Rewrite | `locked`, enforced by the server, also through labels (§2.4.4) | Locked elements can't be selected by clicking; Lobby's locked hint covers this |
| Images: upload, paste, drop layout, placeholders | Rewrite | §2.10 | Derivatives by zoom via local file keys |
| File cards: PDF, video, Office, other | Rewrite | §2.10.4 | Face added when loaded; live facts from `meta-store` |
| Inline video playback | Rewrite | A player overlay on double-click or the play chip | Nothing plays inside the canvas |
| Animated GIF playback | Defer (inline) | First frame on the canvas; the viewer overlay plays it | UNVERIFIED that the canvas shows a static frame |
| PDF viewer, placing pages | Rewrite | `image` with `fileId` `ver_….p<n>` | |
| Legacy tldraw embeds and bookmarks | Drop (converted) | A "link card": rectangle + label + `link` | No live iframes |
| Pages | Drop | Flattened to the right of page 1 | |
| Laser (K), eraser (E) | Keep (built in) | Enabled if they fit the toolbar | |

### 4.2 Canvas UX (`features/canvas-ux`, 54 files)

| Feature | Verdict | Plan |
|---|---|---|
| Toolbar, style panel (Lobby's own) | Rewrite | Map to element properties through `CanvasPort`; `ui={false}` |
| Miro shortcuts, keyboard map, keyboard safety, Ctrl+U | Rewrite | The allowlist (§2.3.3); `keyboard-map.test.ts` rewritten against it |
| Context menu (+ Shift+F10) | Rewrite | Lobby menu |
| Minimap (M) | Rewrite | Lobby-drawn from element bounds, throttled, closed by default |
| Guides, snapping, grid | Keep | `objectsSnapModeEnabled`, `gridModeEnabled` |
| Zoom keys (Alt+1/2, Ctrl+0, fit) | Rewrite | **Fit is Lobby's own camera.** Excalidraw clamps every zoom to [0.1, 30] through `getNormalizedZoom` (F 642-644; `MIN_ZOOM`, C 1898), including its own fit (`zoomToFitBounds`, F 501) and the wheel. The heavy board needs 0.054 in a 1536 × 864 view, so Excalidraw's fit showed only 3,488 of 9,220 elements (38%) [spike-A A14]. `updateScene({ appState: { zoom, scrollX, scrollY } })` accepts less. So `CanvasPort.viewport.fit()` computes the zoom and scroll itself and installs them through `appState`; Follow, Present and the minimap use the same path. Below 0.1, Lobby's capture `wheel` listener handles wheel and pinch zoom, stepping from the current zoom, because Excalidraw's handler would snap to 0.1. The floor is the whole-board fit, or 0.1 if that is larger. Wave 3b, +0.5 pd. Other zoom keys use `api.setViewport`. |
| Board search, select by type, arrange as grid, copy link, start view, open on first frame, Frames panel | Rewrite | Over `CanvasPort.items()`; new link format + legacy parser (§3.6) |
| Paste as sticky notes | Rewrite | `onPaste` returns `false`, Lobby's prompt |
| Templates (7), insert as one undo step | Rewrite | `packages/templates` emit elements; one `transact` |
| Dark mode | Keep | `theme`; `next` maps colours with `applyDarkModeFilter` [API][rev-run: exported from `@excalidraw/common`] |
| Shape cap | Keep | Server cap in items (§3.5) |

### 4.3 Collaboration

| Feature | Verdict | Plan |
|---|---|---|
| Live edits, reconnect, offline | Rewrite | §2.4–2.5; per-tab offline queue |
| Saved indicator (all states) | Rewrite (exact) | §2.5.7 |
| Per-property undo | Rewrite | §2.8 |
| Text lease + "Alice is typing" | Rewrite | Explicit lease (§2.9); `EditingBadges.tsx` |
| Cursors, names, "(guest)", hide cursors | Rewrite | Overlay; the pointer is read by Lobby's own listener for every role (§2.7) |
| Remote drag preview | Rewrite, with a deviation | Render offsets; hit tests stay at the document position until the drop commits, and the old spot is guarded (§2.7) |
| Remote selection colours | Rewrite, with a deviation | Hashed colours, drawn by Excalidraw |
| People list, follow, "Bring to me", present to everyone | Rewrite | Roster + always-included peers + `setViewport` (§2.7) |
| Attribution ("last edited by", note authors) | Rewrite | `lobbyServer` (§3.3) |
| Comments: tool (C), pins that follow shapes, anchors, orphans | Rewrite | Custom tool + overlay; anchors unchanged (§3.6); point anchors on legacy pages shifted at read time (§5.8) |

### 4.4 Facilitation

| Feature | Verdict | Plan |
|---|---|---|
| Timer, raise hand, reactions bar | Keep | No canvas coupling |
| +1 on notes | Rewrite | `plusOne:<uid>` keys, identity-bound, refused while a vote is open (§3.3) |
| Voting (badges, ballots hidden until reveal, results) | Rewrite | Vote custom tool (no selection); server drops `sel` while a vote is open; eligibility from the `lobby-elements` snapshot |
| Private brainstorming (reveal) | Rewrite | `place-notes` builds `stickynote`s on the server with `lobbyServer.privateNote`, idempotent by draft id; legacy `pageId` mapped (C1) |
| Hide note authors | Rewrite | The overlay and attribution UI read `lb_doc.workshop` |

### 4.5 Present and export

| Feature | Verdict | Plan | Hard part |
|---|---|---|---|
| Frame-by-frame presentation | Rewrite | `setViewport` on the frame; overlay hidden | |
| PNG | Rewrite | `exportToBlob` with `exportingFrame`; PNG keeps one pHYs chunk | Files loaded before export |
| SVG | Rewrite | `exportToSvg` with an export-only `data:` files map and `skipInliningFonts: true`, plus Lobby's own `@font-face` embedding (§2.10.4) | e2e: opens offline; no `unsafe-eval` |
| PDF (raster pages + text layer) | Rewrite | `exportToBlob` per frame; text layer from text elements. pdf-lib becomes a lazy import, loaded on the first PDF export (§2.2) | Rotated text positions |
| CSV (colour names) | Rewrite | `board-ops/csv.ts` on items | |
| Export policy gate | Keep | Lobby's UI decides; every `canvasActions` flag off; Ctrl+Shift+S and Alt+Shift+C never reach Excalidraw (§2.3.3) | |
| Thumbnails | Rewrite | `exportToBlob({ maxWidthOrHeight })` of the start view | |

### 4.6 History and safety

| Feature | Verdict | Plan |
|---|---|---|
| Checkpoints, preview, restore as new, duplicate | Rewrite | Bodies v2, v1 converted on read. **Preview** renders with `exportToCanvas` plus Lobby's own pan and zoom, not a second `<Excalidraw>`: two instances share module-global state (`editorJotaiStore`, window flags, font caches) [REV]. **Confirmed by spike A11:** two instances are not viable (§2.3.2). `exportToCanvas` ignores any camera and always exports the scene bounds (X 15391-15437), so the preview (`apps/web/src/canvas/preview/CheckpointPreview.ts`) keeps its own camera: an anchor rectangle, an overview bitmap and a detail pass. Heavy-board overview in 271–274 ms; with 200 images, 939–950 ms; 0 ops and 0 drift on the live scene [spike-A]. |
| Recently deleted | Rewrite (server) | §2.4 internal routes |
| JSON export/import | Rewrite | Archive v2; v1 through `tldraw-import` |
| Backups, offsite copies, restore drill | Keep (readers change) | §5.6; every restore takes a new epoch (§2.6) |

### 4.7 AI, search, tags, mind maps

| Feature | Verdict | Plan | Hard part |
|---|---|---|---|
| AI actions | Rewrite | `ai/sources.ts` reads elements through `canvas-schema/items.ts`; results applied as one `transact`, created with `ai` stamped (§3.3) | |
| Search across boards | Keep (payload) | Same text endpoint shape; reindex after conversion | |
| Tags | Rewrite | `tag:<id>` keys, `lb_doc` `tagDef:<id>` | |
| Mind maps | Rewrite | `customData.lobby.mindmap`; layout inside the user's `transact` | **Collapse, decided in spike B:** store only `collapsed` on the parent's `mindmap` value. Hide the branch with a render override (opacity 0) through `canvas/overrides.ts`, plus a Lobby hit-test guard, plus filtering hidden ids out of selection, search, exports and copy. Ctrl+A is Lobby-owned and builds the selection without hidden ids; box and lasso selections are post-filtered (§2.3.3). Not "opacity 0 + locked", which collides with real locks and "Unlock all" and writes other people's elements [REV]. Render overrides do not change hit tests, selection or exports [rev-run `types.d.ts:1095-1110`], hence the guards. **From spike A10:** the opacity override names every hidden id, including bound labels and frame children (a container at 0 still draws its label); the guard stopped clicks, double-clicks, drags, context menus and box selection on hidden elements, 3/3. Its three gaps (the hover cursor, touch, and the dead zone where a visible element lies under a hidden one or under a moving one) get the rules in §2.7. A collapse that re-lays out the tree can move visible siblings over hidden items; the guard then selects the visible element (§2.7). B12 tests it, and wave 3d decides from B12 whether the layout should keep the collapsed branch's area free (+0.5 pd in 3d for the guard gaps). |

### 4.8 Mobile, accessibility, i18n

| Area | Verdict | Plan |
|---|---|---|
| Phone and tablet (phone sheet, overflow menu, touch guard, guest on phone) | Rewrite | Lobby chrome with `ui={false}`; `touch-guard.ts` rewritten. Excalidraw has phone-specific pointer paths (form-factor checks, long-press menu) [REV]. **Spike B** runs the phone flows (guest, sheet, timer, voting) under Playwright touch emulation at 390 px. **Before cut-over**, one real iPhone or iPad Safari session is an owner check (Appendix B). |
| Accessibility | Rewrite | Deliverables, each tested: (1) a live region announcing selection and focus ("Sticky note: <text>", "Frame: <name>"); (2) keyboard traversal between elements (F6 enters the canvas; Alt+Arrow moves to the next or previous element in reading order; Enter edits through the lease); (3) an accessible content list (notes, frames, text) in the search panel; (4) `a11y-2`, `a11y-polish` and `keyboard-safety` re-run, plus axe on the board page; (5) a contrast check of the 13-colour palette in light mode and through `applyDarkModeFilter` in dark mode (`palette.test.ts`). |
| i18n | Keep | `langCode 'en'` |

### 4.9 Outside the canvas

| Area | Files | Change |
|---|---|---|
| api | `features/ai/sources.ts`, `features/workshops/shapes.ts`, `features/search/indexer.ts`, `features/history/{snapshot-rows,files,board-ops,checkpoint-routes}.ts`, `files/gc-refs.ts`, `sync-internal.ts`; **new**: `file-refs` and `workshop-state` routes | §1 A1–A5 |
| packages | `board-ops` (16 files use tldraw), `templates` (17), `canvas-schema` (3), `auth-tickets` (`guest` claim) | Rewritten on elements; tldraw schema moves into `tldraw-import` |
| contracts | none structurally | `shape:` refs kept; `PrivateTarget.pageId` kept (C1); migration `0021` adds `engine-migration` |
| Unchanged | auth, sharing, dashboard, notifications, comments privacy, AI budgets, storage, worker, Office sidecar | none |

---

## 5. Data migration

### 5.1 Mapping (tldraw 5.4.2 → Excalidraw 0.18.0-1118751)

[DATA]'s prototype (`data/proto/convert.ts`) is pure and deterministic. It targets **0.18.1**; the port to `next` is spike B8's first job and part of wave 2D.

| tldraw | Excalidraw | Port to `next` |
|---|---|---|
| `note` | rectangle + bound text | → `stickynote` + label (`baseHeight`, `baseFontSize`, `created: null`) |
| `geo` rectangle/ellipse/diamond/oval/check-box/x-box | native, + label | same |
| `geo` other kinds | grouped `line` polygon + holder rectangle + label | outline with `polygon: true` |
| `text` (rich) | plain lines, lists as "• " and "1. "; first link → `link` | same |
| `frame` | `frame`; children get `frameId`; nested frames lifted | same |
| `group` | `groupIds` | same |
| `arrow` + bindings | `startBinding`/`endBinding` `{focus, gap}`; label as bound text | → `FixedPointBinding {elementId, fixedPoint, mode}`: `isPrecise` → `'inside'` at the anchor, else `'orbit'`. Checked visually in spike B8. |
| `draw`, `highlight` | `freedraw` (points via `b64Vecs`), highlight at opacity 50 | + `strokeOptions`; points rounded and capped (§3.5) |
| `line` | `line`; spline → `roundness {type: 2}` | + `polygon: false` |
| `image` (+ asset) | `image`, `fileId` = version id; crop and flips | same |
| `dr-file-card`, `video` | `embeddable` in [DATA] | → **`image` + `customData.lobby.file`** (D7) |
| `embed`, `bookmark` | `embeddable` in [DATA] | → link card |
| Pages 2..n | offset to the right (`page-flattened`) | same; offsets in `lb_doc.import.legacyPages`, **frozen at the first conversion**: every later conversion of this board's records (roll-forward, v1 checkpoints of this board) reuses them instead of recomputing them from page-1 bounds |
| Lobby meta | flat `dr*` keys in [DATA] | → `customData.lobby.<key>` by class (§3.3); `plusOnes[]` → `plusOne:<uid>`; `drPrivateNote` → `lobbyServer.privateNote`; `textLastEditedBy` → the label's `lobbyServer.lastEditedBy` |
| `document.meta` | board settings | → `lb_doc` (§3.4) |
| z-order | `generateNKeysBetween` in paint order | server re-validates; labels after containers. Used only for a whole-board first conversion; the local mode (below) never regenerates keys. |

**Building elements on `next`** [spike-A A1, A3, A17]. Spike A found three limits of Excalidraw's own builder, `convertToExcalidrawElements`:
- it regenerates every id, and overwrites `created` with a timestamp, unless called with `regenerateIds: false` (E 24527-24528): a skeleton id `note-1` came back random;
- it **cannot bind an arrow to a `stickynote`**: `bindLinearElementToElement` builds only rectangle, ellipse, diamond and text targets, so a note target hits `assertNever` and then throws `reading 'id'` (E 24382-24441);
- it stamps `created` on notes, which draws the date footer.

So the converter, `place-notes` and any server-made note build elements directly with the element package's constructors, with `created: null`, kept ids and hand-built `FixedPointBinding`s plus the target's `boundElements` entry. If the converter uses `convertToExcalidrawElements` for other element types, it always passes `regenerateIds: false`. A unit test asserts that ids and `created: null` survive for every type.

**Prototype evidence**, on [DATA]'s 8 fixtures (7 templates + a kitchen sink; 463 records → 606 elements): no duplicate ids, increasing indices, consistent labels, symmetric bindings, no `data:` or signed URLs, byte-identical output across runs and input orders. Through 0.18.1's `restoreElements(…, { repairBindings, refreshDimensions })` in Chrome: 0 elements dropped, 0 fields changed, 0 wrap mismatches in 311 texts, ≤ 2.2 px width drift [plan-run]. **Not yet run:** the `next` port and any real board file. There is no `.data` directory in `Draftroom-int3` [rev-run]. Spike B8 therefore converts every staging board from a read-only restore of the latest R2 offsite backups, plus board files generated with the current build (§8.3 B8).

**Deterministic, but not local.** The same input gives byte-identical output, but a change to one record changes other elements. The prototype regenerates every index across the whole board with `generateNKeysBetween(null, null, N)` (`data/proto/convert.ts:558`). It derives the offsets of pages 2..n from page-1 bounds and the pages before them (`convert.ts:183-204`) [r3-run]. One add or delete shifts the index of every later element. One edge move on page 1 moves every element on the flattened pages. The roll-forward merge therefore never compares two whole-board conversions (§5.9). The converter gets a **local mode** for it:
- it converts a given set of records;
- it takes page offsets from `lb_doc.import.legacyPages`;
- it resolves each record's absolute transform through its parent chain in the given snapshot;
- it assigns no index;
- a unit test checks that converting one record in local mode equals that record's elements in the whole-board conversion, apart from `index` (§6.1).

### 5.2 What is lost (lossy codes, reported per board)

| Code | Loss | Prototype count (8 fixtures) |
|---|---|---|
| `rich-text-formatting` | bold, italic, headings, code, more than one link | 22 (21 in the Lobby tour) |
| `serif-font` | serif becomes Nunito | 1 |
| `geo-polygon`, `geo-approximated` | polygon, or approximated | 3 |
| `nested-frame` | inner frame lifted to the top | 1 |
| `page-flattened` | page laid out to the right | 1 |
| `arrow-binding-dropped` | binding to a non-bindable target | 1 |
| `arrowhead-approximated`, `arrow-label-position` | square/inverted heads; label at the middle | 1 |
| `stroke-simplified`, `over-limit` | new: limits (§3.5) | not yet measured |
| `image-circle-crop`, `frame-rotation`, `missing-asset`, `unknown-shape`, `orphan` | as named | 0 |

**Owner action:** the Lobby tour sample board and the templates are **re-authored** for plain text in wave 2D, not just converted.

### 5.3 Boards: conversion inside the sync process

The first draft ran a separate `convert-all` command. That breaks the rule of one writer per board file, and on Render only the sync service mounts the board disk [REV]. Lazy conversion on the event loop would also stall every room.

- **Code.** The converter is in `packages/tldraw-import`. It reads the tldraw `documents(id, state, lastChangedClock)` and `metadata(documentClock, schema)` tables with `node:sqlite` directly [repo `backup/backup.ts:144-151`], migrates records to 5.4.2 with `@tldraw/tlschema` plus the old file-card migration, and converts.
- **Where it runs.** Always in the sync process, in a `worker_thread` (`apps/sync/src/room/migrate/`), one board at a time, so the event loop keeps serving health checks, internal routes and other rooms.
- **Worker limits (new).**
  - **One conversion at a time, process-wide.** `convert-all`, lazy conversions and roll-forward merges share one FIFO queue with concurrency 1. A board's joiners wait in the join queue while its job is queued or running.
  - **Memory.** Each job runs in a fresh `new Worker(…, { resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } })`. `maxOldGenerationSizeMb` is 256 during the maintenance window, when no room is open. At runtime it is the §2.13 cap: 1.5 × the peak measured in spike B8 for the largest board, at most 128 MB.
  - **Runtime gate.** A runtime job starts only when process RSS + the cap ≤ 440 MB, after flushing the snapshot cache (§2.13).
  - **Over the cap.** A worker that hits its cap is terminated by Node with `ERR_WORKER_OUT_OF_MEMORY`. The main thread sees an `error` event, marks the board failed, leaves it on its tldraw tables and reports it. That board then converts only in a maintenance run. The sync process and its other rooms are unaffected.
  - The worker's peak heap is reported per board in `/internal/migrate/status` and the report.
- **Two entry points:**
  - `POST /internal/migrate/convert-all` (internal secret), used during the cut-over's maintenance window, when sync refuses sockets. It reports progress at `GET /internal/migrate/status`.
  - **Lazy**, on room open, when `lb_meta` is missing and `metadata` exists: restored old backups, and boards created on R0 during a rollback (§5.9). The join queue holds sessions until the board is converted. `backupKey` is null for these boards (no final backup exists); `lb_source` is still written, so a later roll-forward has its base.
- **Per board:**
  1. **Disk check first:** free space ≥ 3.5 × the board file + 50 MB. Conversion adds `lb_*` at 1.3–1.9× the tldraw size [DATA], `lb_source` at about 1× (a copy of the `documents` rows), `lb_deleted`, WAL and the local backup. If not, stop and report; resizing the disk is an owner decision (paid).
  2. **Time budget:** 60 s per board; a board that exceeds it is marked failed, stays on tldraw tables, and is retried alone.
  3. In one `BEGIN IMMEDIATE`:
     - write `lb_elements`, `lb_doc` and `lb_meta` with a new epoch and clock 1;
     - copy the tldraw `documents` rows into **`lb_source`**, the roll-forward base (§5.9);
     - convert the `dr_deleted_*` rows into `lb_deleted` (§5.4);
     - write `lb_meta.converted_from = {documentClock, schemaHash, sourceSha256, converterVersion, backupKey, deletedSeq, lbClock: 1, cycle: 0}`. `sourceSha256` is the digest of `lb_source`, computed as the backup manifest's `recordsSha256` is (sha256 over `id` and `state`, ordered by id; `backup/backup.ts:148-167`). `backupKey` names the final pre-cut-over backup object in R2 (§5.6), read from the board's newest backup manifest, which R0's `run-all` wrote after maintenance was on (§7.5 step 4). `deletedSeq` is the last `dr_deleted_records.seq` copied;
     - write the `import` doc key, including the frozen `legacyPages`.
  4. **Leave the tldraw tables and `dr_deleted_*` untouched** until `drop-legacy`: no write, no trim, no schema change.
  5. Write a report to `<data>/migration/<board>.json`: counts in and out, lossy codes, ms, bytes before and after.
- **Verification per board (100% of boards), a semantic diff** — not just counts:

| Check | Pass |
|---|---|
| Every tldraw shape id maps to an element id or a lossy code | 100% |
| `sourceSha256` equals the final backup's `recordsSha256` for this board (boards converted at cut-over; lazily converted boards have no final backup) | equal |
| Every `dr_deleted_records` row maps to an `lb_deleted` row or a lossy code | 100% |
| Plain text of every text-bearing shape equals the element's `originalText` (after the documented list and bullet rules) | 100% |
| Set of referenced assets (version ids) equal | equal |
| Every comment anchor, vote target, private-note frame and search object id resolves | 100% |
| Frame membership kept (except `nested-frame`) | 100% |
| Bounds within 2 px (notes) / 1% (other shapes), except lossy codes | 100% |
| `restoreElements` fixed point in a headless browser: 0 changed fields | 0 |
| Headless render of every board, screenshot saved | all render |

The owner signs off on lossy counts from the rehearsal (§7.5).

### 5.4 Recently deleted

`dr_deleted_records` hold tldraw records, and R0 keeps using them. The new build **copies**, and never converts in place:
- In the conversion transaction (§5.3 step 3), every batch is read from `dr_deleted_*`, converted with the same converter in local mode, and written to **`lb_deleted`** with `origin = 'converted'` and the original `batch`, `deleted_by`, `deleted_by_name` and `deleted_at`. Partial sets are fine, since orphans go to the root [DATA].
- `dr_deleted_records` and `dr_deleted_schemas` are left byte-for-byte as they were. No `kind = 'element'` row is written, so the CHECK constraint (`store.ts:55`) never needs a table rebuild. No new-build trim ever runs on them; R0's own trims (`store.ts:224-225`) see only R0's rows.
- On a roll-forward, the rows R0 added during the rollback (`seq > converted_from.deletedSeq`) are converted and appended to `lb_deleted` the same way, and `deletedSeq` moves forward.
- Ids are kept, so restore still works. Restores write `version = max(existing) + 1` [DATA].
- `lb_deleted`'s own trim rules (same limits as today) apply only to `lb_deleted`.

### 5.5 Checkpoints (object store bodies)

- The api reads **v1 and v2**. A v1 body is converted **on read** (preview, restore, duplicate) through `tldraw-import`. Element ids are kept, so they match the live board [DATA]. Page offsets are taken from the board's frozen `lb_doc.import.legacyPages` when it has them, so a multi-page checkpoint lines up with the live board.
- **No batch rewrite** of stored bodies in this project. v1 bodies stay as they are, so a rollback never meets a rewritten body, and signed backups stay intact. A rewrite can be a later, separate decision; `tldraw-import` stays at least 6 months anyway (§5.7).
- One checkpoint per board with the new reason `engine-migration` is taken right after conversion, as a restore point. The reason ships first in the bridge release (§5.10).

### 5.6 Backups

- **At cut-over, after maintenance is on** and every socket is closed (§7.5 step 3), a final manual backup set of every board goes to R2 and is kept 90 days (owner decision, Appendix B). No edit can land between this backup and the conversion. Its object keys are recorded in each board's `converted_from.backupKey`. The conversion checks that `lb_source`'s digest equals the backup's `recordsSha256` (§5.3). The backup is the disaster copy: the roll-forward's base is `lb_source`, in the board file itself (§5.9), so the roll-forward needs no network.
- **Old local and offsite backups** contain only tldraw tables. Restoring one goes through the staged restore, then room open, then the lazy converter, then a new epoch.
- **The restore drill** learns the new format and compares element counts.
- **Retention** (newest 12 plus daily for 14 days) ages old backups out by itself.

### 5.7 Archives and the tldraw-import package

- `.lobby.json` v1 files keep importing through `tldraw-import`.
- The package keeps `@tldraw/tlschema`, `utils`, `store`, `state` and `validate` 5.4.2 (all MIT) and nothing else from tldraw.
- It is imported by apps/sync (conversion, roll-forward) and apps/api (checkpoint and archive v1).
- Its removal is reviewed after 6 months, and only once no v1 checkpoint needs reading.

### 5.8 Side effects outside the board file (all computed at read time)

| Item | Action |
|---|---|
| Comment point anchors on pages 2..n | **Not rewritten in Postgres.** The web client shifts a point anchor that carries a legacy `pageId` by that page's `dx/dy` from `lb_doc.import.legacyPages` when it draws the pin. New anchors carry no legacy page id. Shape anchors are unchanged (same ids). |
| `PrivateTarget.pageId` (C1) | Before maintenance, the runbook closes or freezes open private-brainstorm sessions. Any that remain are revealed correctly: `place-notes` maps a legacy `pageId` through `legacyPages`. |
| Deep links | Legacy `?d=` parser (§3.6) |
| Search index | Boards come back with a new epoch; the indexer re-indexes fully on an epoch change. |
| AI usage, votes, private drafts | Ids kept; nothing to do |
| Thumbnails | Kept, regenerated on the next edit |
| Asset GC | Stays in **report mode** until 30 days after cut-over |

### 5.9 Rollback and roll-forward (reversible)

**The problem with the first draft.** The lazy converter ran only when `lb_meta` was missing. After a rollback, people edit the tldraw tables; when the new build returns, `lb_meta` is still there, so the room would serve stale Excalidraw data and silently drop every edit made during the rollback. And the draft's rollback discarded every edit made after the cut-over [REV].

**The design.**

1. **Rollback target = the bridge release R0** (§5.10), never the pre-bridge build.
2. **Rolling back** (within the window):
   - maintenance on; every board's `lb_*` state is exported to R2 (`rollback-exports/<board>/<time>.json`) as a safety copy;
   - deploy R0's api, sync and web. R0's sync serves the tldraw tables and **never writes or trims any `lb_*` table** (`lb_elements`, `lb_doc`, `lb_meta`, `lb_deleted`, `lb_source`, `lb_prev_*`). The one thing it reads is whether `lb_meta.converted_from` exists, to refuse boards born on the new canvas (step 4). They stay in the file untouched, and R0's gate tests this (§5.10).
   - Edits made on Excalidraw after the cut-over are **not visible** during the rollback, but they are **not lost**.
3. **Rolling forward** (redeploying the Excalidraw build). On room open, the tldraw side was edited during a rollback if either:
   - the tldraw `documentClock` is higher than `converted_from.documentClock`, or
   - `dr_deleted_records` has rows past `converted_from.deletedSeq`.

   In that case the room does **not** serve `lb_*`. It queues a roll-forward job, one at a time, in the capped worker (§5.3).

   **Why not diff two whole-board conversions.** The converter is deterministic but not local: indices and page offsets are recomputed across the board (§5.1). If "theirs" were a fresh conversion of the whole board, one add or delete made during the rollback would re-key every later element, and one edge move on page 1 would move every flattened page. "Theirs wins" would then revert Excalidraw-era z-order and positions across the whole board. The merge therefore works at the **tldraw record level**, and converts only what the rollback touched:

   The three inputs:
   - **base** = `lb_source`: the tldraw `documents` rows as of the last conversion or roll-forward, stored in the board file. Its digest must equal `converted_from.sourceSha256`; if not, the board stays closed and the owner is alerted.
   - **theirs** = the current tldraw `documents` rows (the edits made during the rollback);
   - **ours** = the current `lb_elements` (Excalidraw edits since the cut-over or the last roll-forward).

   The steps:

   a. **Record diff, base → theirs.** Records are sorted into *created* (in theirs only), *deleted* (in base only) and *changed* (`state` differs). Deletions come from the set difference, not from tldraw tombstones, which R0 prunes.

   b. **Local conversion of touched records only.** Each changed record is converted twice in local mode (§5.1): once within the base snapshot and once within theirs. Created records are converted within theirs. Both runs use the frozen `lb_doc.import.legacyPages` offsets. A page created during the rollback gets one new offset to the right of the board's current bounds, appended to `legacyPages`. No other record is converted, and no index is generated. The roll-forward requires the recorded `converterVersion`; the runbook pins the converter during the window.

   c. **Field-group merge per element.**
      - For each element a changed record produces, the groups where the base conversion and the theirs conversion differ are the groups **theirs changed**.
      - **Ours changed** a group when its write clock is above the clock of the last conversion or roll-forward (`gclock[g]` > `converted_from.lbClock`). This uses no re-conversion. `customData.lobby` is compared per key (`gclock['c:<key>']`).
      - Theirs changed, ours did not: theirs is taken.
      - Both changed: theirs wins (it is newer). Ours' value is kept in `lb_prev_<cycle>_*` and listed.
      - Every group theirs did not change keeps ours' value as it is.

   d. **Parent moves compose.** When a frame or group record moved in theirs, its children's absolute positions change although their own records did not. For each such descendant, the translation (theirs conversion − base conversion) is **added** to ours' position. A tldraw-side frame move and an Excalidraw-side move of a child therefore both survive.

   e. **Creations and deletions.** Records created in theirs are inserted with their kept ids. Records deleted in theirs mark their elements deleted in ours (delete wins). Excalidraw-era creations and deletions are kept.

   f. **z-order by relative position.** Ours' order is never regenerated.
      - A created element gets a key between its nearest preceding and following neighbours in theirs' paint order that exist in ours.
      - A record whose tldraw `index` changed in theirs is moved the same way, unless ours re-ordered it after the cut-over (`gclock.z` above `lbClock`). Then ours keeps it and the conflict is listed.
      - Labels stay after their containers.

   g. **Validate the merged result.** Text containers whose layout inputs changed on either side are re-fitted by the server in Node (§2.11), because fit is derived and is not merged as a group; the arrows bound to them are re-snapped as in §2.9.4 rule 7. The §2.4.4 invariants then run with their server repairs, followed by index uniqueness and the limits (§3.5). If a violation cannot be repaired, the board stays closed with a report and the owner decides. Nothing is half-written.

   h. **Write, in one transaction.**
      - Copy the pre-merge `lb_*` rows to `lb_prev_<cycle>_*`, kept until `drop-legacy`.
      - Write the merged `lb_elements`.
      - Append R0's new `dr_deleted` rows to `lb_deleted` (§5.4).
      - Take a new epoch, with a clock above both sides.
      - **Replace `lb_source` with theirs**: it becomes the new base.
      - Update `converted_from`: `documentClock`, `sourceSha256`, `deletedSeq`, `lbClock` and `cycle + 1`.

      A second rollback cycle therefore merges against the state it actually started from, never against the original cut-over base.

   i. **Report** in `<data>/migration/<board>.rollforward.json`: conflicts by element id and group name (never content), and counts.

   Elements that neither side touched come out **byte-identical** to their pre-merge rows. Nothing in the merge depends on two whole-board conversions giving the same output.

4. **Boards born after the cut-over.** New boards, duplicates, restores-as-new, imports and template boards have only `lb_*` tables, and no `converted_from`.
   - **R0 refuses them without touching the file.** R0's sync checks the file before opening a room. If `lb_meta` exists without `converted_from`, it does not start a `TLSocketRoom`, which would create empty tldraw tables. It closes the socket with the terminal reason `NEW_CANVAS_BOARD`, and R0's web shows "This board was made on the new canvas. It opens again after the switch." R0's internal snapshot, text and asset-refs routes answer `409 new-canvas`, so checkpoints, AI, search and duplicate skip such a board with the same message. R0's backups still copy the file whole.
   - **Roll-forward serves them unchanged.** R0 never wrote them, so there is nothing to merge.
   - **Boards created on R0 during the rollback** have only tldraw tables. They are converted lazily the first time they open after the roll-forward (§5.3), and that conversion writes their `lb_source`.
5. **Nothing irreversible before the window closes:**

| Job | When | Why it is safe |
|---|---|---|
| Checkpoint body rewrite | Not in this project (§5.5) | v1 bodies untouched |
| Comment anchor shifts | Never stored (§5.8) | computed at read time |
| `dr_deleted_records`, `dr_deleted_schemas` | Never written, trimmed or rebuilt by the new build (§5.4) | R0 finds them exactly as it left them; the new engine uses its own `lb_deleted` |
| `lb_source`, `lb_prev_*`, the tldraw tables | Kept until `drop-legacy` | the base and the history of every cycle stay available |
| Boards born after the cut-over | R0 refuses them without opening a room (step 4) | the file is never modified by R0 |
| Migration `0021` | In R0, before the cut-over | additive; R0 understands it |
| `drop-legacy` (remove the tldraw tables, `dr_deleted_*`, `lb_source` and `lb_prev_*`; then `VACUUM`) | Day 7 after cut-over, owner OK | after the window |
| Asset GC out of report mode | Day 30 | after the window |

6. **Rehearsed** (§7.5, and spike B8 on a real staging board). The drill runs: cut-over → edit on Excalidraw → rollback to R0 → edit on tldraw → roll-forward → a second rollback and roll-forward.
   - Edits on the tldraw side include an add, a delete, a z-order change, an edit on a flattened page 2, a frame move while the Excalidraw side moved one of its children, and a same-group conflict.
   - A board created on Excalidraw after the cut-over is opened on R0 during the drill.
   - **Pass:**
     - 0 edits lost on either side, except same-group conflicts, which are listed and kept in `lb_prev_*`;
     - untouched elements byte-identical;
     - Excalidraw-era z-order unchanged except where tldraw re-ordered;
     - the second cycle merges against the refreshed base;
     - the born-after board refused by R0 and byte-identical afterwards;
     - `dr_deleted_*` byte-identical to the pre-cut-over file, apart from R0's own rows.

**Go/no-go** at 24 h; the rollback window closes at 48 h.

**If the rollback becomes permanent** (Excalidraw abandoned), the Excalidraw-era edits stay in each board file's `lb_*` tables and in the R2 exports. A reverse converter is not planned; the owner would decide on manual recovery from the exports.

### 5.10 Bridge release R0 (tldraw, before cut-over)

A normal tldraw release, deployed at least 3 days before the cut-over, so that a rollback lands on a build that degrades gracefully:

| Part | R0 behaviour |
|---|---|
| api | Lists v2 checkpoints and shows "Made on the new canvas — preview and restore after the switch"; refuses v2 restore with that message. Accepts the `engine-migration` reason (migration `0021`, additive). Refuses v2 archive import with a clear message. Shows boards born on the new canvas with a "new canvas" badge, and refuses to duplicate or export them with the same message. Has the `file-refs` and `workshop-state` routes (unused by tldraw sync; reviewed versions of the spike's code, §8.1). |
| sync | Serves the tldraw tables. **Never writes or trims any `lb_*` table** (it reads only whether `lb_meta.converted_from` exists), and keeps managing its own `dr_deleted_*` as today. Refuses boards with `lb_meta` and no `converted_from` without opening a room (§5.9 step 4). Its backups copy the whole file, `lb_*` included. **Maintenance mode (new):** `POST /internal/maintenance {on}` lets pending pushes commit, closes every socket with 4099 `MAINTENANCE`, and refuses new ones; internal routes keep working. **`POST /internal/backups/run-all` (new)** writes a fresh local and offsite backup of every board and returns each object key and `recordsSha256` for the cut-over runbook (§7.5). |
| web | Unchanged apart from R0 api messages, the maintenance notice and the "new canvas" message. |
| Tests | R0's gate runs a board file that contains every `lb_*` table and checks that each of them is byte-identical after R0 served, backed up and trimmed the board. A born-after board is refused, with no tldraw table created. A v2 checkpoint row. Maintenance on closes and refuses sockets. `run-all` returns digests equal to the files'. |

Cost: 4.5 pd (§7.2).

---

## 6. Test strategy

**The gate does not change: lint, typecheck, unit, full e2e.** The full e2e runs **twice in a row** before any merge to the engine branch, and **three times** before the cut-over. Today's baseline is 3,103 unit tests and 315/315 browser tests [repo PROGRESS].

### 6.1 Unit tests (vitest)

- **canvas-schema:** a valid and an invalid sample per element type; every limit (§3.5), including the per-type byte limits with worst-case samples; link and `fileId` rules; each `customData` class (§3.3); doc keys; the field-group **coverage test** (every key in exactly one group, local-only or server-owned); migrations up and down.
- **Sync engine core** (pure): dirty-group tracking and rebase; the vanishing-id rule per removal path; the index pre-pass (E2, E3); local-only fields ignored (E1, E9); hold-back list; offline queue per tab (lock adoption, cap blocks editing, purge rules); Saved states; seeded random edit sequences between simulated clients that must end identical to the server.
- **Undo (field-level):** every case in §2.8, including the probe2 cases.
- **Server merge and invariants:** every case in [SYNC]'s prototype (8 checks); index collisions and label order; lease denial with partial accept, and lease inheritance through `containerId`; lock through labels; each `customData` class; each cross-element invariant (§2.4.4) as a **property test** over random element graphs; attribution stamping; `STALE` rules.
- **Converter:** [DATA]'s invariants; golden files for the 8 fixtures and the spike's real boards; determinism across input orders; **local mode equals the whole-board conversion per record, apart from `index`**, with frozen page offsets; the semantic diff tool (§5.3) against planted faults; `dr_deleted_*` → `lb_deleted` with the source rows byte-identical afterwards.
- **Roll-forward merge (§5.9):** planted conflicts; a **property test** of random tldraw-side edits (add, delete, move, re-order, page-2 edit, frame move) against random Excalidraw-side edits: no edit is lost except listed same-group conflicts, untouched elements are byte-identical, and Excalidraw-era order is kept; a second cycle against the refreshed base; a born-after board is left alone.
- **board-ops and templates:** ported tests, plus "every template renders through `restoreElements` without changes" (browser probe, §6.5).
- **Licence check** (§2.12) and the **foreign-host check** of the built bundle, scoped to the engine's dependency tree (the host-rewrite plugin's own tests: 8 in spike A).
- **Keys:** `keymap.test.ts` pins the editor's chord allowlist, including AltGr and Option text input per common layout and Ctrl+Alt+S / Cmd+Alt+S (§2.3.3).
- **Server layout:** A3's 208-label corpus in Node against the stored browser layouts, with kerning (0 differences expected), and determinism of server-made labels (`created: null`).

### 6.2 Protocol tests (`apps/sync/test/protocol`, real server process)

The harness moves from `TLSyncClient` (`test/harness/sync-client.ts`, `tldraw-runtime.ts`, `records.ts`; 19 of the 54 sync test files import `@tldraw` today [REV]) to a **headless client built on the pure engine core**, so protocol tests run the same client code the browser runs. The server-process harness, fake api and tickets stay.

Each of today's 17 protocol files is ported:

| Test | What it covers |
|---|---|
| `baseline` | ack, then `changes` to every session (one serialization) |
| `auth` | Unchanged semantics |
| `access` | Revoke → `FORBIDDEN` and offline-queue purge signal; downgrade → 4000, then a read-only reconnect |
| `validation` | Per-op `INVALID`; a malformed message → 4099; abuse close counts only `INVALID`/`TOO_LARGE`/`TYPE_CHANGE` |
| `readonly` | `READ_ONLY` for every op kind and `lease.acquire` (denied); nothing stored; socket open; presence flows |
| `conflicts` | Same group: last write wins. Different groups: both kept. Edit vs delete: delete wins in either order. Per-key `customData`. |
| `reconnect` | Per-group merge; `STALE` rules for replays |
| `durability` | SIGKILL with 0 acked-but-missing (3 rounds, during 64-push batches); SIGINT; **injected COMMIT failure** → `UNAVAILABLE`, room reload, nothing lost |
| `text-lease` | Acquire/grant/deny; renew by presence; expiry; release ordered after the last push, **including a push parked in stage 0 on a delayed file-refs lookup** (open item 5); an acquire for a just-created id is denied when another session holds a live lease on it (open item 7); partial accept keeps a move; lease inherited through `containerId`; re-layout on expiry by the server |
| `attribution` | Stamping from the ticket; forged `lobbyServer` ignored |
| `presence` | Identity cannot be sent; roster uncapped; cursor cap with always-included peers; `sel` dropped during a vote; drag ids sent once and then only deltas, active drags in `welcome`, a read-only session's `drag` dropped |
| `schema` | N−1 client served; N+1 → `SERVER_TOO_OLD` |
| `join-order` | Snapshot cache + catch-up keeps the prefix invariant during a join storm |
| `room-lifecycle` | 20 concurrent first connects → one room, one file; evict and reopen keep clock, rows and tombstones |
| `tags-merge` | Per-key tags |
| `internal` | snapshot, seed (409), place-notes (legacy `pageId`), text, asset-refs, deleted, workshop-state |
| `user-records` | Deleted, replaced by "no identity is ever read from the client" |

**New suites:**
- **Prefix invariant**, as a property (random interleavings, group commits, disconnects).
- **Convergence property**: N headless clients, random ops (create, move, recolour, text through the lease, group, bind, delete, undo), random disconnects and one SIGKILL; at the end every client's element map hashes equal to the server snapshot and the invariant checker finds nothing.
- **Echo**: a receiving-only client pushes nothing across every op type, including concurrent creates at the same end of the order.
- **Negative security suite**: one test per server rule — every row of §2.4.4, every `customData` class, links, `fileId` (foreign, missing, api down → `UNAVAILABLE`), types, limits (including `fontFamily` outside {5, 6, 8} and coordinates beyond ±1e6), guest caps, `VOTE_OPEN`, a tldraw `connect` → `CLIENT_TOO_OLD`.
- **Epochs**: horizon reset; a stale client reconnecting after a restore gets a reset.
- **Conversion**: convert-all in a worker thread with the room closed; disk-check refusal; time budget; lazy conversion holds joins; rollback → roll-forward merge; **one job at a time** (a second lazy open queues); **a planted board over the heap cap terminates only its worker** (`ERR_WORKER_OUT_OF_MEMORY`), and the process and other rooms keep serving; the runtime RSS gate delays a job.
- **Text lease, container fit**: a stale `fit` is dropped after another session's `pos`/`shape` write; a non-holder's `fit` is dropped; a holder's re-fit after `fitDropped` is accepted; fit writes do not advance `gclock.pos`/`gclock.shape`. **Bound arrows (§2.9.4 rule 7):** an applied fit re-snaps the bound endpoints of a straight and an elbow arrow in the same clock and `changes` frame, and a dropped fit re-snaps nothing; another session's concurrent midpoint or free-end write survives (cases a–c); an arrow write based on geometry older than its target's fit is re-snapped; re-snaps advance `gclock.fit` only, so they never make a later write `STALE`; a locked arrow is re-snapped; an arrow push from the holder for a fit-derived change is never sent (checked on the headless client).

The `http/*` (10 files plus helpers), `lease/*` (3), `backup/*` and `deleted/*` tests are ported with their payloads.

### 6.3 e2e (Playwright)

- **Test facade.** `window.lobbyCanvas`, behind the same dev-auth guard as `window.editor` today. It exposes Lobby concepts: `items()`, `get(id)`, `create(kind, props)`, `update`, `delete`, `select`, `selection()`, `tool()`, `setTool`, `sceneToScreen(point)`, `bounds(id)`, `zoomToFit()`, `editingId()`, `leaseHolder(id)`, `collaborators()`, `saveState()`. **Every write goes through `CanvasPort.transact` and then the sync engine**, never straight into `updateScene`, so specs test the real path.
- **Forged writes** do not use the facade: specs open a raw WebSocket with the page's own ticket and send frames, so the server's refusal is tested without client code in the way.
- **Why the port is large.** 62 of the 80 files in `e2e/tests` use `window.editor`, `.tl-*` classes or `shape:` ids, and specs call 81 distinct `ed.*` methods through 16 support files [repo][REV]. Clicks on tldraw DOM shapes become clicks at `sceneToScreen` coordinates. Overlays get `data-lobby-*` test ids. Each facade verb is checked once against real pointer and keyboard input, so a facade bug cannot hide a UI bug.
- **Order of work.** Support helpers first (wave 2E). Each feature owner ports its own specs (wave 3). Screenshot baselines are regenerated and reviewed by eye.
- **New specs:**
  - `engine-safety.spec.ts`: no request outside Lobby's origins and Clerk's; no `data:`/`blob:` in stored elements; undo after a remote edit; note footer hidden; a failing image load pushes nothing.
  - `keys-by-role.spec.ts`: the allowlist per role (§2.3.3), counting File System Access picker calls as downloads.
  - `lease.spec.ts`: two typists, resize while typing, lease loss, **every editor-open path P1–P8** (§2.9.2) on a note leased by someone else and on a free one (§8 B3), and a second editor opened while a request is pending (B3 L12).
  - `presence-roles.spec.ts`: a viewer's, a commenter's and a limited guest's cursors reach an editor with no tool selected.
  - `phone.spec.ts`: guest, sheet, timer and voting under touch emulation at 390 px.
  - `svg-export.spec.ts`: the exported SVG renders with the network off.
  - `migration.spec.ts`: a tldraw board file opens converted; a v1 archive imports; a v1 checkpoint previews.

### 6.4 Performance and load

- **e2e/perf** (browser): the heavy-board seed (20 frames, 4,500 notes, 200 images) is ported. Budgets are re-baselined against today's numbers **measured with the same method** as the Excalidraw runs. The review's numbers [repo REVIEW §2] (typical open 1.82 s; heavy open 3.36 s; pan at fit 26–32 fps) came from branded Chrome and e2e/perf's gentle 60 px pan, and do not reproduce in the method spike A used: the headless Chromium shell with GPU flags, a 600 px sweep, 1536 × 864 at DPR 1.25 (`e2e/spike/fixtures/perf-kit.ts`). There today's tldraw measures **open 3.7–3.9 s** through the real stack, **16.4–18.8 fps at fit** (zoom 0.05), 53–55 at 0.25 and 59 at 1 [spike-A A14]. e2e/perf's own budget notes that its 600 px sweep at fit measured 16–21 fps. Edit visibility: p95 283 ms against the 250 ms gate. New measures: welcome bytes and time, ack round trip, edit visibility at fit and at 100%, image memory on the mood board.
- **e2e/load** (new, Node): the load generator from spike B, running headless engine-core clients against a sync container limited to `--cpus=0.5 --memory=512m` on the NAS. Profiles L1 and L2 (§2.13). Run in spike B, in wave 4 and in the rehearsal.

### 6.5 Engine probe suite (upgrade safety)

[API]'s probes (`probe.mjs`, `dbg3`, `dbg4`, `dbgnext`, `dbgframe`, `perf20k`), the review's `probe1`/`probe2`, and this revision's `sizes.mjs` move to `apps/web/test/engine-probe/`. They run in Playwright and Node against the pinned build and assert:
- `NEVER` keeps remote edits off the stack;
- `registerAction` replaces `undo`;
- `addFiles` keeps the first entry for an id;
- `updateImageCache` still marks failures with `status: "error"` (so E1's rule stays necessary and sufficient);
- `syncInvalidIndices` behaviour on collisions (E2);
- fonts loading changes no version (E5);
- `duplicateElement` sets `created`, and `onDuplicate` can override it;
- the `interaction` config shape and its keyboard/clipboard behaviour;
- the embeddable z-order; the sticky-note footer hidden when `created` is null;
- `getStickyNoteLayout` runs in Node;
- the bundle has exactly 7 `startTextEditing` call sites and 2 `handleTextWysiwyg` call sites (the editor-open table, §2.9.2);
- `savePointer`'s early return under the `interaction` config (why presence has its own listener, §2.7);
- `updateScene` runs no sticky-note re-layout (E7), and the open text editor follows scene updates (§2.5.4);
- `restoreElements` leaves templates untouched;
- element sizes stay within the limits' assumptions;
- (new from spike A) every font face's fallback source is same-origin after the host rewrite; zoom is clamped at 0.1 by `getNormalizedZoom` (so Lobby's own fit stays needed); `setActiveTool` refuses non-custom tools under `interaction`; `convertToExcalidrawElements` still regenerates ids without `regenerateIds: false` and still cannot bind to a `stickynote`; `validateIndicesThrottled` stays off in the npm builds (E3); `Scene` still needs `window` in Node; A3's layout corpus still gives 0/208 with the kerning table.

**Status after spike A.** The Node half exists: `apps/web/test/engine-probe/` (A3's calibration and run, A8, `editor-open-paths.test.ts`, `node-probes.test.ts`; 23 probes, 3/3). The browser half is covered piecemeal by the spike A specs (A1, A4, A7, A9, A16, A17), and four probes do not exist yet: `NEVER` keeping remote edits off Excalidraw's own stack, `addFiles` keeping the first entry, embeddable z-order, and `restoreElements` on templates [spike-A report §5]. Wave 1 writes them and assembles one standing upgrade suite.

They run on every Excalidraw bump and nightly in CI.

---

## 7. Phases, ownership, estimates, cut-over

### 7.1 Rules

- **Branch.** Work happens on `engine/excalidraw`, from `integration/wave3`. `main` keeps tldraw and takes hotfixes, merged into the engine branch daily. R0 is cut from `main`.
- **Before any parallel wave** (the end of wave 1), these are merged and frozen:
  - `packages/canvas-schema` (elements, groups, protocol, limits, `customData` key registry, invariants): changes after the freeze go through the contracts owner as change requests;
  - `canvas/port.ts`, `canvas/registries.ts`, `canvas/test-facade.ts` types, `e2e/tests/support/canvas.ts` types;
  - **lockfile PR #1**: adds the five pinned `@excalidraw/*` packages and `packages/tldraw-import`'s five MIT tldraw packages, plus any other dependency waves 2–3 need. No other PR touches `pnpm-workspace.yaml`, the catalog or `pnpm-lock.yaml` until wave 4.
- **Extension points instead of shared files.** Features add keys through the key registry, overlays through the overlay registry, menu entries through the selection-bar registry, and `customData` keys through the key registry. `keyboard-map.test.ts` reads the registry. Nobody edits `BoardPage.tsx`, the capture handler or the overlay root outside wave 2C.
- **Lockfile PR #2** (wave 4) removes `tldraw`, `@tldraw/editor`, `sync`, `sync-core` and `assets`. It cannot come first: every importer must be ported before removal, or the gate cannot run.
- **Each owner** owns the files listed for it and ports its own e2e specs. Permission-heavy workstreams (2A, 2B, 2F, 3f, 3h) get a verifier, as in waves 3 and 4.

### 7.2 Waves and estimates

Person-days (pd) are human-engineer equivalents, used for sizing. **Every row, the spikes included, is in this one unit.** The calendar (§7.3) converts pd into working days at about 7 pd per owner-day. The spread is ±30% until spike B reports.

| Wave | Owner | Owns | pd |
|---|---|---|---|
| **0A Spike A** (§8) | 3 owners + lead | `spike/excalidraw` branch: engine checks (summed per check in §8.2). **Done** (5203e41), plus the A6/A16 fix round | 14 |
| **0B Spike B** (§8) | 5 owners + lead | `spike/excalidraw`: contracts step, minimal room and engine core, lease client on the real protocol, facade and browser harness, load harness and NAS containers, conversion port on the restored staging boards, roll-forward drill with the R0 stand-in, routes A1–A3, the minimal features the checks need, three independent verifiers (§8.1 has the breakdown, §8.6 the owners) | 56 |
| **1 Contracts + freeze** | contracts (+1) | `packages/canvas-schema/src/**` (new files, §3; spike B's contract drafts reviewed and frozen); `docs/EXCALIDRAW-CONTRACTS.md`; `canvas/port.ts`, `canvas/registries.ts`; facade types; lockfile PR #1; probes into `docs/research/excalidraw/`, including the four missing browser probes (§6.5) | 7 |
| **R0 Bridge release** | bridge | api: v2 checkpoint listing and messages, migration `0021`, routes A1/A2 (reviewed from the spike branch), "new canvas" board badge; sync: maintenance mode, `backups/run-all`, refusal of boards born on the new canvas, byte-identity tests for every `lb_*` table; staging deploy (owner OK) | 4.5 |
| **2 Engine core** | 2A sync-room | `apps/sync/src/room/**` (not `migrate/`), `rooms.ts`, `app.ts`, `presence.ts` (drag relay with ids once), lease with the conditional container fit and the server's bound-arrow re-snap, attribution ledger, outbound budgets; `user-records.ts` deleted | 16 |
| | 2B sync-edges | `apps/sync/src/{http,backup,deleted}/**` (`lb_deleted` store), `snapshot.ts`, `room/migrate/**` (capped conversion worker and queue, `lb_source`, record-level roll-forward merge), `file-refs.ts`, `workshop-state.ts`, `/internal/metrics` | 9.5 |
| | 2C web-engine | `apps/web/src/canvas/**` (engine, sync adapter with fit classification, history with `lastLocal` and fix folding, overrides, input framework with the editor-open guard and its invariant, the editor's chord allowlist, the double-tap detector and Ctrl+A, the presence pointer listener, image loader core, facade), `board/BoardPage.tsx`, `board/presence.ts`, `board/touch-guard.ts`, `sync-quality/**` | 20 |
| | 2D formats | `packages/tldraw-import/**` (converter on `next` with its local mode and frozen page offsets, limits, semantic diff), `board-ops/**`, `templates/**` (tour and templates re-authored), `dashboard/template-catalog.ts` | 12.5 |
| | 2E harness | `apps/sync/test/harness/**`, `test/protocol/**`, `e2e/tests/support/**`, `e2e/perf/seed.ts`, `e2e/load/**` (from the spike), the negative security suite | 9 |
| | 2F api | routes A1/A2 final, readers A5, `auth-tickets` guest claim (A3, from the spike), checkpoint v1/v2 read | 4 |
| **3 Features** | 3a canvas tools | `features/canvas-ux`: Toolbar, StylePanel, key entries, ContextMenu, defaults, dblclick-note, type-to-edit, locked-hint, export-gate, `onDuplicate` specs | 11 |
| | 3b navigation | NavigationPanel (minimap), SearchPanel, FramesPanel, start-view, arrange-grid, select-by-type, bulk-paste, template-insert, copy-link (new format + legacy parser), `content-search` links; **Lobby's own fit camera and wheel below zoom 0.1 (+0.5); the level-of-detail pass for zoomed-out views (+3, §8.5, now applies)** | 12.5 |
| | 3c comments + people | `features/comments/**`, `features/people/**` (roster), present-live | 10 |
| | 3d mind maps + tags | `features/mindmap/**` (collapse as decided in spike B, with the hit guard's cursor, touch and dead-zone rules, +0.5), `features/tags/**` | 8.5 |
| | 3e present + export | `features/present-export/**` (SVG files map; Lobby's own `@font-face` embedding with `skipInliningFonts`; pdf-lib as a lazy import, +0.5), `features/thumbnails/**` | 10.5 |
| | 3f workshops | `features/workshops/**` (vote tool, +1, private notes web) | 8 |
| | 3g media | `apps/web/src/file-card/**`, `assets/**`, `board/ExternalContent.tsx`, derivative swap | 10 |
| | 3h history, AI | `features/history/**` (preview via `exportToCanvas`), `features/ai/**` | 8 |
| | 3i a11y + mobile | live region, traversal, content list, palette contrast, phone flows | 6 |
| **4 Integration** | integration | cross-cutting fixes; lockfile PR #2; licence check; host-rewrite plugin (built in spike A12; reviewed and carried forward) and its scoped CI rule; CSP in `render.yaml` with the theme script as a file and `z.config({ jitless: true })`; the static host's 404 under `/excalidraw-assets/`; mermaid stub; the asset plugin's dev-auth condition; `VITE_TLDRAW_LICENSE_KEY` removal; `DEPLOY.md`; `AGENTS.md` and `docs/research/excalidraw/SYNTHESIS.md` drafts (§10); full gate ×2; perf; NAS load re-run | 10 |
| **5 Review** | 4 personas + security seam review + fix owners | as in the 27–28 Sep rounds; the seam review targets forged elements, `customData` classes, references, links, cross-board files, guests and the lease | 10 |
| **6 Rehearsal + cut-over** | migration | runbook; rehearsal on the NAS including the rollback → roll-forward drill; cut-over; 48 h watch | 9 |
| | | **Total** | **≈266** |

**What grew from the first draft to revision 2 (+63 pd):** spike A+B (+14), explicit lease (+2), field-level undo (+2), cross-element invariants (+3), `customData` classes and file-refs (+3), push coalescing and drag previews (+3), offline queue per tab and `STALE` (+2), capacity work and the load harness (+4), bridge release and roll-forward (+7), in-process conversion and semantic diff (+4), CSP and host rewrite (+1), accessibility and mobile deliverables (+6), SVG export (+1), presence roster (+2), harness on the engine core and negative suite (+4), api work (+5).

**Revision 3 (+38 pd, 223 → 261).**
- **Spike A, 6 → 14 pd (+8).** It had the same unit problem: 3 owners × 2 days. It is now summed per check in §8.2, including the new checks A16 and A17.
- **Spike B, 16 → 56 pd (+40).** Revision 2 sized it as 4 owners × 4 days at about 1 pd per owner-day. The waves assume about 7 pd per owner-day, so 16 pd was not credible for a spike that builds a minimal room, a web engine, a multi-browser harness, a load harness, the converter port and a roll-forward drill. The 56 pd is summed slice by slice in §8.1, in the same unit as the waves.
- **Revision 3 design additions (+10.5).**
  - R0: maintenance mode, `run-all` backups, born-after refusal (+1).
  - 2A: conditional container fit (+0.5).
  - 2B: record-level merge with `lb_source` and the second cycle (+2); `lb_deleted` (+1); worker limits and queue (+0.5).
  - 2C: editor-open guard, double-tap detector and text tool (+1.5); fit classification and re-fit (+1); presence listener (+0.5); undo recording (+0.5); Ctrl+A (+0.5).
  - 2D: converter local mode (+1.5).
- **Carried forward from the spike (−20.5).** Parts of the spike become the reviewed starting point of a wave instead of being written twice:
  - the converter port (2D −4);
  - the conversion worker and merge (2B −4);
  - the load generator and browser harness (2E −4);
  - routes A1–A3 (R0 −0.5, 2F −1).

  The room and the engine are rebuilt against the frozen contracts, with the spike as reference (2A −3, 2C −4). The rest of the spike stays unmerged.

**Revision 3.2 (+5 pd, 261 → 266), from spike A's results.**
- **Spike B stays at 56 pd (56.25).** Spike A already built parts of the web-engine slice, with tests: `ExcalidrawHost`, the key allowlist and Ctrl+A, the editor-open guard, the double-tap detector, the custom N and T tools, the presence listener, the overrides, the image loader and the undo core. The slice drops from 12 to 8.5 (−3 for that code, −0.5 moved to the contracts step). New items: the server's bound-arrow re-snap (room +0.5), R0's born-after check in the drill's stand-in (roll-forward +0.5), the hit guard's gaps for B12 (features +0.5), and the A14 laptop half (lead +0.25). **Three independent verifiers are budgeted explicitly** (+1.5, 0.5 each, §8.6.8). Spike A's verifier was not in its 14 pd, and it found the two bugs that mattered most. The contracts step becomes explicit: 1.5 pd (1 from the room slice, 0.5 from the web slice). The net is 56.25, rounded to 56 (§8.1).
- **Waves (+5).** The level-of-detail pass now applies (3b +3, §8.5); fit as Lobby's own camera below zoom 0.1 (3b +0.5); the bound-arrow re-snap (2A +0.5); the hit guard's cursor, touch and dead-zone rules (3d +0.5); SVG export with Lobby's own font embedding, and lazy pdf-lib (3e +0.5). Wave 4 is unchanged: the host-rewrite plugin already exists (−1), and the CSP fixes, the mermaid stub, the scoped CI rule and the asset plugin's condition take that time back (+1).
- **No carried-forward credit is taken yet for spike A's code in the waves** (2C, wave 4). Revision 3 already took 2C −4 for "the spike as reference". Which spike code survives review is known only after spike B, so any further credit is decided then, once, to avoid counting it twice.

### 7.3 Critical path and calendar

The critical path is serial; parallel owners shorten only the waves in the middle.

```
Spike A (d1–2) ─┐
                ├─► report + owner go/no-go (d7) ─► W1 freeze + lockfile #1 (d8)
Spike B (d2–6) ─┘                                        │
                          ┌──────────────────────────────┼──────────────────────────────┐
                          ▼                              ▼                              ▼
                 R0 bridge (d8–9) → R0 on staging   W2A room, W2C engine,          W2D formats → W2B migrate
                 (by d10, ≥ 3 days before cut-over) W2E harness, W2F api (d9–11)
                          │                              └────────────► W3 a–i (d12–13) ◄──┘
                          │                                                  ▼
                          │                              W4 integration: gate ×2, tldraw removal, CSP, load (d14–15)
                          │                                                  ▼
                          │                              W5 review + fixes (d16–17)
                          │                                                  ▼
                          └──────────────────────────────► W6 rehearsal + rollback drill + sign-off (d18–19)
                                                                             ▼
                                                               cut-over (d20) → go/no-go (d21) → window closes (d22)
```

This assumes about 7 pd per owner-day for **every** wave and for the spikes, slightly below the 26–28 Sep waves (a wave of 5–7 owners finished 40–60 pd in about a day), and 20+ minutes per full gate run.

**Spike B in these units.** 56 pd over 5 owners, a lead and three verifiers is 8.5–11.5 pd per owner (§8.6.3), or about 1.6 owner-days of building, so the build fits in spike B's first two days (d2–3). The next three days are set by the dependency chain and serial run time, not by pd:
- every browser check needs the room and the engine first;
- every check runs 3 times;
- the NAS load test is 6 runs of 10 minutes plus setup and cleanup;
- the conversion of every staging board and the rollback drill on a real board run after the converter port;
- the fixes the runs find, then a final 3-run pass, the verifiers and the report (d4–6).

**What spike A's actual effort implies.** Spike A, sized at 14 pd, took about **4 hours of agent wall time** for the build and the 3-run evidence of all 17 checks, with 3 owners and a lead. That is about 4.7 pd per owner in half a working day, or roughly 9 pd per owner-day against the 7 assumed here: about 1.3 times the planned rate. It does **not** justify cutting pd or the calendar yet:
- **It is one sample, of the least coupled work in the project.** One browser, no server, no multi-process runs, 17 independent checks. Spike B couples a real server, 2–3 browser processes, a load generator and a NAS.
- **Spike A was not done at 4 hours.** The verifier found two guard bugs that the owners' own evidence had called closed (A6, A16), and a fix round plus a re-verification follows. The time to a *verified* result is 4 hours plus that round. Spike B budgets verifier rounds explicitly (§8.6.8).
- **pd are a sizing unit, not agent time.** Agent speed changes only the pd-to-days conversion. The serial parts of the calendar (3-run passes, NAS runs, review, rehearsal, the 48 h watch) do not shrink with it.

So the pd figures stay, the ±30% spread stays, and the rate stays at 7 pd per owner-day until spike B reports hours per slice (§8.6.9), which gives a second sample on coupled work. If spike B also runs at 9 pd per owner-day or more, the first thing to shorten is waves 2–3, the phases with the most pd per owner, possibly by a day each. Spike B itself keeps its five-day ceiling (d2–6): if its build finishes in one day instead of two, the go/no-go moves to d6.

| Working day | Work | Gate to pass |
|---|---|---|
| 1–2 | Spike A (**done on d1**: about 4 h of build and runs, then the A6/A16 fix round); spike B's contracts step starts (d2) | A checks (§8.2); fix round re-verified 3/3 |
| 3 | Spike B builds (the R2 restore of the staging backups is already done: 4 boards, §8.6.7) | minimal room, engine and harness run end to end (milestone M1, §8.6.4) |
| 4–6 | Spike B checks, fixes, final pass, verifiers, report | B checks, 3 runs each; verifiers' verdicts |
| 7 | Spike report, re-estimate, owner go/no-go | §8.5 |
| 8 | Wave 1; R0 starts | freeze merged |
| 9–11 | Wave 2 (6 owners); R0 on staging by day 10 | protocol suite, convergence property and negative suite green; two browsers edit through the facade |
| 12–13 | Wave 3 (9 owners) with spec ports | each owner's specs green |
| 14–15 | Wave 4 | full gate ×2; perf budgets; NAS load targets |
| 16–17 | Wave 5 | no open major finding |
| 18–19 | Wave 6 rehearsal | semantic diff 100%; drill passes; full gate ×3; owner sign-off |
| 20 | Cut-over | smoke |
| 21–22 | Watch; go/no-go at 24 h; window closes at 48 h | |

**About 20 working days to cut-over, or 26 with a 30% buffer.** That is one day more than revision 2, all of it in spike B. Wave 2 keeps its three days: its largest workstream (2C, 20 pd) sets its length. Wave 3 needs 9 owners at once, more than the 5–7 of past waves; with 7, it takes one more day. Wave 3b grows to 12.5 pd with the level-of-detail pass, which still fits its two days at 7 pd per owner-day. Spike A was built and run in about 4 hours; its laptop measurement (A14) moves to spike B's lead, and the Clerk capture of A12 moves to the rehearsal. Real staging data is proven in the spike, at about 70 pd spent, not first at the rehearsal.

**No cut-over date is committed before the spike go/no-go.** Spike B reports hours per slice against a naive estimate; §7.2 is rescaled from that.

### 7.4 Deadlines

- **Staging tldraw key.** A trial key lasts 100 days with no grace period, after which the canvas blanks (`DEPLOY.md:262`) [repo]. If staging's key was issued at the first staging deploy on 2026-09-27, it expires about **2027-01-05**. The owner records the exact date (Appendix B). Cut-over day + 7 (drop-legacy) must land at least two weeks before it; otherwise the owner renews the key first.
- **R0 on staging** at least 3 days before the cut-over.

### 7.5 Cut-over order (runbook in `DEPLOY.md`)

0. **Preconditions:** R0 live ≥ 3 days; rehearsal passed and signed off; staging sync disk free space ≥ 3.5 × total board bytes + the local backups (§5.3; else stop: a disk resize is an owner decision); Clerk origins for the CSP final, recorded at the rehearsal (§2.12); a request for a missing file under `/excalidraw-assets/` on the static host gets a 404, not `index.html` (§2.12).
1. **Rehearsal (NAS; owner OK needed):**
   - stand up the engine-branch images next to a copy of staging's boards, restored from the offsite backups with the existing drill tooling (read-only R2 use), plus a Postgres dump;
   - run `convert-all` inside the sync container; semantic diff on 100% of boards (§5.3);
   - run DEMO.md end to end and the full e2e ×3 **with the CSP header enforced**, including a real Clerk sign-in whose network log gives the exact Clerk origins;
   - the owner compares 10 boards side by side with staging and signs off on lossy counts;
   - **drill** (§5.9 step 6): cut-over → edit → rollback to R0 → edit → roll-forward → a second cycle; 0 edits lost on either side; a board born after the cut-over refused by R0 and unchanged;
   - time every step, to size the window.
2. **Announce** a 30-minute window. Close or freeze open private-brainstorm sessions.
3. **Maintenance on** (R0, `POST /internal/maintenance {on:true}`). Pending pushes commit, and every open socket is closed with 4099 `MAINTENANCE`. New sockets are refused; the web shows a notice. Internal routes keep working. From here on, no edit can reach a board file.
4. **Final backup, after maintenance is on.** `POST /internal/backups/run-all` writes the final backup set (R2, kept 90 days) and returns each board's object key and `recordsSha256`; the runbook stores them. Then take a manual checkpoint of every board (the api reads the snapshot route, which works in maintenance).
5. **Deploy the api** (v1/v2 readers; A1/A2 already shipped in R0).
6. **Deploy sync** (Excalidraw build), still in maintenance. `POST /internal/migrate/convert-all`, one board at a time (§5.3). Poll `GET /internal/migrate/status` until: 0 failures, disk OK, every board's `lb_source` digest equal to its final backup's `recordsSha256`, semantic diff 100%, lossy counts as rehearsed.
7. **Deploy the web** with the CSP header and the host-rewritten bundle. The server always goes before the client. Old tabs get `CLIENT_TOO_OLD` and show "Reload". A new tab that meets a tldraw-protocol reply shows "Reload — Lobby is updating". The leave guard (edits still pending when leaving the board) is kept.
8. **Smoke:** DEMO.md flows, two users, a phone guest, a restore drill, backups written to R2, no CSP violations in the console.
9. **Maintenance off.** Watch `/internal/metrics` and logs for 48 h. Go/no-go at 24 h (§5.9).
10. **Clean up:** day 7, `drop-legacy` with the owner's OK (removes the tldraw tables, `dr_deleted_*`, `lb_source` and `lb_prev_*`) — the tldraw key is then no longer needed; day 30, the asset GC may leave report mode.

**Rollback** (within 48 h): §5.9 step 2. **Roll-forward**: redeploy the Excalidraw build; rooms merge on open (§5.9 step 3). Boards born after the cut-over follow §5.9 step 4.

---

## 8. The spike (first step, about 6 working days)

### 8.1 Goal

Prove the risky parts before any wave starts. The spike uses real browsers, real sockets, a real server process, real files in R2, **real staging board files** and a Render-sized container. The first draft's spike mostly checked single-client API behaviour. This one checks convergence, undo between people, the lease, durability, server enforcement, files, conversion, rollback and capacity.

The spike lives on branch `spike/excalidraw`, behind `DRAFTROOM_ENGINE=excalidraw` (sync) and `VITE_LOBBY_ENGINE=excalidraw` (web). It is **not merged as a whole**; its code is a reference for waves 1–2. Parts are carried forward as reviewed PRs (§7.2): the converter port, the conversion worker and merge, the load generator, the browser harness, and routes A1–A3.

- **Spike A (3 owners + lead, 14 pd): done.** Engine checks in one browser and in Node, on `spike/excalidraw` 5203e41: 14 PASS, 2 PARTIAL, 1 FAIL as written (§8.2; `docs/research/excalidraw/SPIKE-A-REPORT.md`). A fix round for the A6/A16 guard bugs is running and is re-verified before spike B fans out.
- **Spike B (5 days at most, 5 owners + lead + 3 verifiers, 56 pd):** a minimal ElementRoom and engine core with the protocol of §2.4. It runs through **two and three real browsers** and 200 simulated clients on the NAS, and it converts **every staging board** and runs a rollback drill on a real one. Its execution plan (owners, files, contracts, order, ports, NAS and privacy rules, verification, report) is §8.6.

**Scope of the minimal build.** Everything below is needed by at least one check.
- **Sync:**
  - the `hello`/`welcome`/`push`/`ack`/`changes`/`presence`/`roster`/`lease.*` messages and field-group patches;
  - the accept algorithm of §2.4.3: stage 0 with the per-session FIFO for pushes and lease messages, the cross-element invariants, the `customData` classes, the conditional container fit with the bound-arrow re-snap, group commit and COMMIT-failure handling;
  - the drag relay with ids once per drag;
  - the `lb_*` tables, including `lb_deleted` and `lb_source`;
  - conversion in the capped worker, and the record-level roll-forward merge.
- **Spike api** (in the spike branch, so B never waits for R0):
  - A1 `file-refs`;
  - A2 `workshop-state`, both the sync pull and the api push;
  - the A3 `guest` ticket claim;
  - the existing comments, votes, +1 and tags routes, unchanged.
- **Web:**
  - Excalidraw in Lobby's board page, with real sign-in (dev provider) and real tickets; `ui={false}`;
  - Lobby's top bar and Saved indicator;
  - the key allowlist with Lobby's Ctrl+A (from spike A, with the fix round);
  - the editor-open guard, the double-tap detector, and N and T as custom tools (from spike A, with the fix round);
  - the presence pointer listener, the overrides and the image loader (from spike A); the field-level undo wired to the engine; the lease client on the real protocol; the lease UI; the facade;
  - the hit guard's cursor, touch and dead-zone rules (§2.7), for B12;
  - the **minimal features the checks use:**
    - tags, as `tag:<id>` keys and `tagDef` doc keys written through the facade, with a tag chip in the overlay (B1.2, U2);
    - +1 (U1, B1.2, F13);
    - the comment tool placing a pin on the overlay (R2);
    - the vote custom tool with A2 (R2, F13, B12);
    - the phone sheet, the timer and guest join at 390 px (B12);
    - the mind-map collapse prototype (B12).

**Out of scope:** comment threads and the comments panel; the tag manager UI; templates UI; AI; search; minimap; present mode; PDF export; history and checkpoint UI (spike A11 covers preview); the full toolbar and style panel.

**Real staging data (mandatory).** Spike B8 converts every staging board. The source is a read-only restore of the latest offsite backups in R2. The owner has already authorized R2 read access for Lobby. **Done on 2026-09-28** (about 21:50Z), with the owner's answer to Appendix B 13: every staging board restored with signatures verified. There are **4 boards, of 4 to 64 records each**, so "the largest staging board" of the drill is small, and the heavy and multi-page boards (below) carry the size. The copies are read-only inputs held under the rules of §8.6.7.
- **Tool:** the existing drill, `pnpm --filter @draftroom/sync backup:restore-drill --from=store --keep` [repo `apps/sync/src/backup/restore-drill.ts`, `drill.ts`]. It runs with `DRAFTROOM_BACKUP_STORE=r2` and the R2 values from the gitignored `.env.deploy.local`, which are never printed or logged. It is read-only on the store. It checks each download's size and `sha256` against the offsite manifest, restores the newest backup of every board into a clean scratch data dir, and opens each one through the real room code. `--keep` leaves the restored copies for B8. Signatures are checked with the staging key only if the owner supplies it; otherwise the drill runs with `--allow-unsigned`, its sha256 checks still run, and the report says so.
- **Where:** the scratch dir is on the workstation's local disk, never `V:\` or another share (SQLite over SMB is unsafe). Conversion runs on **copies** inside the spike's sync process.
- **Privacy:** these files hold real DBC content. The full rules are in §8.6.7. In short:
  - they are never committed, uploaded, printed or pasted anywhere;
  - reports carry ids, counts, lossy codes and timings only, and logs never print text;
  - screenshots go only to the owner;
  - the copies are deleted at the end of the spike (the owner's answer, Appendix B 13).
- **Not in the spike:** the staging Postgres dump. That needs a separate owner OK and is used at the rehearsal (§7.5). Comment anchors and vote targets of staging boards are therefore checked structurally in the spike: every tldraw shape id maps to an element id, so every anchor that named a live shape still resolves. They are checked against the real rows at the rehearsal.

**Effort, in the waves' unit (pd, §7.2), re-estimated in revision 3.2:**

| Slice | Owner (§8.6.3) | Contents | Rev. 3.1 | Rev. 3.2 |
|---|---|---|---|---|
| Contracts step | lead | the frozen shared contracts of §8.6.2 (protocol, groups, `customData` registry, limits, element schemas, `lb_*` DDL, engine-core, facade and harness types, the bound-point wrapper, the sync dispatch hooks, the one lockfile change) | (inside Room and Web engine) | 1.5 |
| Room | O1 | minimal ElementRoom: protocol, stage 0 with the FIFO for lease messages, drain and group commit, invariants, `customData` classes, lease and conditional fit **with the bound-arrow re-snap**, the drag relay, `lb_*` store, COMMIT-failure path, metrics | 11 | 10.5 |
| Web engine | O2 | engine core and adapter, the lease client on the real protocol, fit classification into ops (fit-derived arrows local-only), Saved indicator, undo wiring, drag-relay client, the spike board page. **Already built in spike A:** `ExcalidrawHost`, key allowlist and Ctrl+A, editor-open guard, double-tap detector, custom N/T tools, presence listener, overrides, image loader, undo core | 12 | 8.5 |
| Browser harness | O3 | separate browser processes with barriers, facade, raw-socket forging, convergence hash and invariant checker wiring, the spike-B stack launcher | 5 | 5 |
| Load harness | O3 | headless engine-core clients, fake api, NAS containers, L1/L2 profiles, drag-relay and presence byte split | 5 | 5 |
| Conversion | O4 | converter port to `next` with the local mode, hand-built note bindings, capped worker and queue, semantic diff, the conversion of the restored staging boards, reports | 7 | 7 |
| Roll-forward | O4 | record-level merge with `lb_source`, drill with the R0 stand-in **including R0's born-after pre-open check and the `lb_*` byte-identity check**, second-cycle cases | 4 | 4.5 |
| Routes | O5 | A1, A2, A3 in the spike branch | 2 | 2 |
| Minimal features | O5 | tags, +1, comment pin, vote tool, phone sheet, timer, guest at 390 px, mind-map collapse, **the hit guard's cursor, touch and dead-zone rules** | 5 | 5.5 |
| Files | O5 | R2 image, file card, loader batching and URLs, SVG export offline | 2 | 2 |
| Runs and report | lead | integration, every check × 3 on the merged tree, A14's laptop half (+0.25), the effort re-estimate, the owner report | 3 | 3.25 |
| Verification | V1, V2, V3 | three independent verifiers: room, lease and undo; security; conversion and rollback (§8.6.8) | — | 1.5 |
| **Total** | | | **56** | **56.25 ≈ 56** |

The calendar reasoning, in the same unit as the waves, is in §7.3.

**"Real browsers"** means separate browser processes, not contexts of one browser: two Chromium processes plus, for three-browser checks, one Firefox process if Playwright's Firefox is installed (else a third Chromium process; whether it is installed is UNVERIFIED). Each signs in as a different dev user. Actions that must be simultaneous are released by a barrier (a shared promise the test resolves), so they start within 20 ms of each other.

**Every check runs 3 times in a row and must pass all 3.** After every check, the test compares the element maps of all browsers and the internal snapshot by hash (convergence), and runs the invariant checker (§2.4.4) on the snapshot.

### 8.2 Spike A: engine checks (done)

Run on `spike/excalidraw` (scaffold b9252d9, then the merges of `spike/a-node` 4581fd8, `spike/a-host` 11a5d6d and `spike/a-render` 1a489c2; the report is 5203e41), Windows 11 workstation, Node 24, Playwright 1.63.0 headless Chromium shell 153, engine `0.18.0-1118751`. Every result was measured again on the merged branch, 3 runs in a row; the gates passed 3/3: lint (1,119 files), typecheck (14 packages), 1,389/1,389 unit tests, the whole spike Playwright suite (50 passed, 2 opt-in skipped), and 0 engine markers in the normal build [spike-A]. The verifier re-ran most checks on its own worktree and tried to break the security claims [verify-A]. Revision 3.2 corrects the pass criteria of A6, A13, A14 and A16 (marked **corrected**).

| # | Check | Pass | Result [spike-A] | Verifier |
|---|---|---|---|---|
| A1 | A note built with `created: null` renders without the date footer; Ctrl+D and Alt-drag copies get `created: null` through `onDuplicate` | no footer in pixel probes, 3 cases | **PASS.** Footer ink 0 (control 171) for the note, the Ctrl+D copy and the Alt-drag copy | CONFIRMED |
| A2 | After a lease grant, a synthetic Enter opens the editor on a note's label, and creates the label when there is none; buffered keys replay in order | 20/20; no lost or reordered key | **PASS.** 217 keys per run, 165–167 buffered and replayed; grants 135–409 ms; labels created 10/10. Desktop keydown only (open items, minor) | CONFIRMED |
| A3 | `getStickyNoteLayout` and `newTextElement` run in the sync process (Node 24) with the metrics provider; a server-made note matches the browser's layout | line breaks differ in ≤ 3 of 208 labels | **PASS with kerning:** 0/208 (6/208 with the revision-3 per-character table); Node 62 ms, browser 129 ms | CONFIRMED (0/208) |
| A4 | The `interaction` config for read-only roles: pan, zoom, links and custom tools work; keys, clipboard and drop do nothing. **Lobby's pointer listener reports the cursor with no tool selected, while `onPointerUpdate` stays silent** (§2.7) | per role, scripted | **PASS.** Presence 11–12 samples (15–16 Hz), `onPointerUpdate` 0; keys, clipboard and drop 0. The selection tool is set through `appState` (§2.3.4) | CONFIRMED |
| A5 | `ui={false}` hides Excalidraw's UI; Lobby's toolbar drives tools | visual pin test | **PASS.** 33 selectors, 6 states, 0 visible; 9 tools driven by Lobby's toolbar | CONFIRMED |
| A6 | The key allowlist (§2.3.3) in edit mode: every "Everything else" key does nothing. With the text editor focused, **every Ctrl/Cmd/Alt chord outside the editor's allowlist does nothing, Ctrl+Alt+S and Cmd+Alt+S included**, and AltGr and Option text input still types (**corrected**; open item 1) | 0 downloads, 0 dialogs, 0 element changes; **a download includes any File System Access picker call** (**corrected**) | **PASS as written in 3.1:** 140 presses, 0 acted, 0 pickers (control: 89/140 acted, 54 keys) | **WEAKER-THAN-CLAIMED:** Ctrl+Alt+S in the editor called the save picker 20/20. **Being fixed** |
| A7 | An image whose URL fails: reproduce `status: "error"`; with Lobby's loader and local-only `status`, the engine pushes nothing | 0 ops | **PASS.** Engine path 1 op, never retried; Lobby's loader 0 ops; 30 images, ≤ 6 in flight, visible first | CONFIRMED |
| A8 | Index pre-pass: a local new element colliding with a confirmed one is re-keyed; no confirmed element changes version | Lobby's `assertConfirmedUntouched` silent (Excalidraw's own check never runs in the npm builds, E3) | **PASS.** Without the pre-pass a confirmed element went v3→v4; with it 0 | CONFIRMED |
| A9 | Loading every font changes no element version | 0 | **PASS.** 17 elements, 27 font files: 0 ops, 0 foreign requests | CONFIRMED |
| A10 | Render overrides: drag offsets move a note and its label together; opacity 0 hides a branch; the hit-test guard stops clicks on hidden elements | pixel probes | **PASS.** Opacity must name labels and frame children; gaps recorded: hover cursor, touch, dead zone (§2.7) | CONFIRMED |
| A11 | Checkpoint preview through `exportToCanvas` with Lobby's pan/zoom; and, for the record, two `<Excalidraw>` instances on one page | preview works; two-instance result recorded | **PASS.** Overview 271–274 ms; two instances share state (A missed 10/20 repaints) | CONFIRMED |
| A12 | The host-rewrite plugin: the built app loads and works; the bundle greps clean; with the CSP header on a static server, the sign-in and board flows log no violation. Record the exact Clerk origins | 0 foreign requests, 0 violations | **PARTIAL.** 0 foreign requests; 0 violations only with the theme-script fix and zod `jitless` (emulated); the whole-dist grep cannot pass while tldraw is built; Clerk origins UNVERIFIED (§2.12) | not re-run |
| A13 | Bundle size of the board route | reported against **today's same-method number, 1086.2 KiB gzip** (**corrected**: the ≈881 KiB baseline does not reproduce) | **Reported.** Excalidraw engine route 1306.9 KiB (1307.4 at run time); projected ≈1066 KiB after cut-over (§2.2) | not re-measured |
| A14 | Render: the heavy perf board (20 frames, 4,500 notes = 9,000+ elements, 200 images) on the workstation **and** an agreed laptop: open time; pan fps at fit, 0.25 and 1 | reported (gate in §8.5), **against a same-method tldraw baseline** (**corrected**) | **PARTIAL** (laptop half unrun). Median fps, fit / 0.25 / 1: Excalidraw 17.7 at its own fit (clamped at zoom 0.1) and **13.9 at the true fit** (0.054) / 53.7 / 60; tldraw **18.2** at fit (0.05) / 56 / 59. Open 0.67–0.70 s (static JSON, no sync server) against 3.7–3.9 s (real stack): not comparable. Drag preview 60 fps; echo 0 | not re-run |
| A15 | Lobby's undo applier in Node: every §2.8 case including probe2's, the `lastLocal` recording and `fix` folding | all pass | **PASS.** 31/31; CAS unit refined (§2.8) | CONFIRMED |
| A16 | **Editor-open paths** (§2.9.2): the probe counts 7 `startTextEditing` and 2 `handleTextWysiwyg` call sites in the pinned bundle (dev and prod). **P1, P2, P3 off the label, P4 and Lobby's T tool open only after the grant. P3 on the label and P5 are caught by the guard: read-only from the first frame, no key lands before the grant, nothing is pushed. P6–P8 are unreachable. A second editor opened while a Lobby request is pending, and input with no keydown, are guard-caught too.** Forwarded: a line double-click and Ctrl/Cmd+double-click on an arrow open the linear editor, a group double-click enters the group; a plain arrow double-click edits its label through the lease; every swallowed second touchstart is `preventDefault`ed (**corrected**; open item 2) | 20/20 per path; **0 ops pushed before a grant** (not "0 local changes": opening re-measures the label) | **FAIL as written, corrected criteria pass 3/3.** 7/2 call sites; P1–P6 20/20 each; deny 40/40; forwards 20/20 | **WRONG** on the guard: a second editor opened during a pending request was writable with no lease (20/20). **Being fixed** |
| A17 | While the editor is open, a remote container move and resize arrive through `updateScene`. The textarea stays open, and the caret and text are kept. The editor follows the container, and the holder re-fits with `fit`, not `pos`/`shape`. Ctrl+Z inside the textarea undoes typing natively and never reaches Lobby's stack. | 20/20 | **PASS.** Textarea moved exactly (120, 40); re-fit to 652 px as `fit`; bound arrows rewritten from the holder's copy (open item 3, §2.9.4 rule 7) | CONFIRMED; 7 more remote changes kept the editor open |

**Effort (14 pd):** A1 0.5, A2 1.5, A3 1, A4 0.5, A5 0.5, A6 1, A7 0.5, A8 0.5, A9 0.25, A10 1, A11 1, A12 1.5, A13 0.25, A14 1, A15 1.5, A16 1, A17 0.5 (each includes its three runs). Actual: about 4 hours of agent wall time for the build and the 3-run evidence, plus the fix round (§7.3).

**Not run in spike A, and where it goes:** A14's laptop half (spike B lead, if the owner names a laptop; Appendix B 16); A12's Clerk origins (the rehearsal, §7.5); non-Chromium browsers and real touch devices (B's third browser, Appendix B 11); the real lease server (B3); the §8.4 client numbers and a typical 2k-object board's open time (B).

### 8.3 Spike B: acceptance checks with two and three browsers

#### B1. Concurrent edits to different fields of the same note both survive

| Case | Browsers | Action (released by a barrier) | Pass (20 repetitions × 3 runs) |
|---|---|---|---|
| B1.1 | A, B | A recolours note N while B drags N | N has A's colour and B's position in both browsers and the snapshot |
| B1.2 | A, B, C | A tags N `#x`, B adds a +1, C moves N | all three kept |
| B1.3 | A, B, C | A changes N's font size, B changes its fill, C groups N with M | all three kept |
| B1.4 | A, B | A deletes N while B moves N | N deleted everywhere (delete wins, either order) |

#### B2. Per-user undo never reverts the other user

| Case | Browsers | Steps | Pass |
|---|---|---|---|
| U1 | A, B | A +1s N; B +1s N; A presses Ctrl+Z | B's +1 stays; A's is gone |
| U2 | A, B | A tags N `#x`; B tags N `#y`; A undoes | `#y` stays |
| U3 | A, B | A groups {N, M}; B groups that group with P; A undoes | B's outer group stays on N, M, P; A's inner group gone |
| U4 | A, B | A moves N; B recolours N; A undoes | N back where A found it; B's colour stays |
| U5 | A, B | A recolours N red; B recolours it blue; A undoes | N stays blue; A sees "1 change kept" |
| U6 | A, B | A creates N; B deletes N; A undoes, then redoes | N stays deleted throughout (no resurrection) |
| U7 | A, B, C | A drags a frame with 6 children; B recolours child 1; C moves child 2; A undoes | children go back except child 2 (C moved it since); child 1 keeps B's colour |
| U8 | A, B | A selects and deselects 10 times, then Ctrl+Z | undoes A's last real change, not a selection |
| U9 | A, B | With 300 ms of injected latency, A recolours N and then moves it before the first ack; A presses Ctrl+Z once, then again | the first Ctrl+Z undoes only the move, the second only the colour (recording against `lastLocal`) |
| U10 | A, B | A draws a stroke (points rounded by the server, `fix`), creates a label that the server re-keys (`fix`), and binds an arrow to a note B deletes (binding nulled); A undoes each | each undo applies with **no** "change kept" toast; no fix or repair created an undo step (the stack length is **at most** A's real actions: an entry that a fix empties is dropped, §2.8) |
| U11 | A, B, C | A deletes X by an undo; B restores X; C deletes X again; A redoes | X stays deleted (the life-version check, §2.8) |

#### B3. The text lease blocks and releases visibly

| Case | Browsers | Steps | Pass |
|---|---|---|---|
| L1 | A, B, C | A opens the editor on N | B and C show "A is typing" within 300 ms (p95 over 20) |
| L2 | A, B | On N, which A holds, B tries **every editor-open path**: Enter; a double-click on N's body; a **double-click on N's label** (P3b, guard-caught); a printable key; a **second click on N's label** with N selected; a **touch double-tap** (B under touch emulation); a **text-tool click** on N; and on an arrow whose label A holds, a **plain double-click on the arrow** | no editor stays open on B, and no key lands in one; toast "A is typing in this note"; B pushes 0 ops (8 paths × 20) |
| L3 | A, B | A types, pauses **30 s** (longer than the old 5 s TTL), types again, closes | nothing lost: N's text on B and in the snapshot equals A's buffer |
| L4 | A, B, C | A closes the editor | badge gone on B and C within 1 s; B can now edit N |
| L5 | A, B, C | A and B press Enter on the same **unlabelled** note at once | exactly one editor opens; exactly one label exists; C sees one badge (20/20) |
| L6 | A, B, C | B resizes N (a sticky note) while A types, with A's text long enough that N auto-grows; repeated with N rotated 15° and B moving it. N has **a straight arrow and an elbow arrow bound to it**, and in a third repetition C drags the straight arrow's free end while A types (open item 3) | A's text intact; the stored N has **B's** `width`/`baseHeight`/position and a `height` that fits A's text for B's size; the label is re-wrapped for B's width while A still types (no wait for close); the server log shows fit writes only from A's session, and any fit computed before B's change `fitDropped`. **Bound arrows:** in every browser and the snapshot, both arrows end on N's final edge (within 0.5 px of the endpoint computed from their `FixedPointBinding`); every arrow geometry write in A's editor window is a server re-snap (logged as derived, `gclock.fit`), and A pushes 0 arrow ops; C's free-end move survives. C pushes 0 ops in the first two repetitions and only its drag in the third |
| L7 | A, B | A goes offline for 15 s while typing; B then opens N and types | B gets the lease after expiry; A sees "Not saved — B is editing" with Copy my text; A's text never overwrites B's |
| L8 | A, B | While A holds N's lease, B's raw socket sends a label-text patch, a new text with `containerId: N`, a delete of N, and a `fit` for N | `LEASED` for each of the first three; the `fit` is dropped (`fitDropped`); nothing stored |
| L9 | A, B | On a **free** note, A uses each path of L2 in turn | each opens the editor only after a grant (P3b and P5 through the guard, read-only until then); keys typed during the pending grant are replayed in order at the caret of §2.9.2; **0 ops pushed** before the grant, including the open-time re-measure of the label (20/20 per path) |
| L10 | A, B, C | A types in a **rectangle's** label until the rectangle grows; B resizes the rectangle meanwhile; an arrow is bound to the rectangle | B's size is kept (A's stale fit is dropped); the rectangle then grows only if A's text needs it; the arrow ends on the rectangle's final edge through server re-snaps only; C pushes 0 ops |
| L11 | A (phone), B | On a 390 px phone under touch emulation, A double-taps a note that B holds, then a free one | first: toast, no editor; second: the editor opens after the grant |
| L12 | A, B | **Guard regression (the verifier's A16 probes).** (1) A presses Enter on note N1 (request pending, grant delayed 300 ms or held manually), then at once double-clicks N2's label, then uses P5 on N2; (2) in each state, text arrives with no keydown (`insertText`, as an IME or dictation would); (3) with the editor open on N1 under a grant, A double-clicks N2's label; (4) the same with B holding N2 | Never a writable editor without a granted lease for its element: every unrequested editor is read-only from its first frame; `insertText` changes nothing before a grant; Lobby's state and Excalidraw's `editingTextElement` agree after every step; N1's lease is released only after N1's final push; with B holding N2, B's toast appears and N2's text is unchanged; 0 ops pushed for an element without a grant (20/20 per case) |
| L13 | A | **Editor chords (the verifier's A6 probe).** In a granted editor, A presses Ctrl+S, Ctrl+Alt+S, Ctrl+Shift+S, Cmd+S and Cmd+Alt+S (macOS emulation), Ctrl+O and Ctrl+P, then types `@` with AltGr (a German layout) and `ß` with Option (macOS emulation) | 0 downloads, 0 pickers, 0 dialogs, the editor stays open; the AltGr and Option characters land in the text (20/20) |

#### B4. Reload and sync-kill durability, with exact Saved semantics

| Case | Browsers | Steps | Pass |
|---|---|---|---|
| D1 | A, B | A edits, waits for "Saved", reloads | content kept; "Saved" never appeared before the last ack (the test logs the ack time and the indicator change) |
| D2 | A, B | A and B edit at 5 edits/s each; the test SIGKILLs sync at a random moment, restarts it after 3 s; 3 rounds | every edit that was covered by a displayed "Saved" is present after restart in both browsers and the snapshot (**0 missing**); edits made while down showed "Saving…" or "Offline", never "Saved", and appear after reconnect, then "Saved" |
| D3 | protocol | 3 SIGKILLs during 64-push group commits | 0 acked-but-missing |
| D4 | A | Injected COMMIT failure | pushes answered `UNAVAILABLE`; client retries; nothing lost; "Saved" only after success |
| D5 | A, B | A goes offline, edits for 60 s, reloads while offline, reconnects | A's edits survive the reload (IndexedDB) and land; B sees them |
| D6 | A (two tabs) | Tab 1 edits offline and is closed; tab 2 opens the board | tab 2 adopts and replays tab 1's queue once |

#### B5. Read-only enforced on the server (forged frames refused)

| Case | Setup | Pass |
|---|---|---|
| R1 | A viewer browser opens a raw WebSocket with its own ticket and sends a create, a patch, a delete, a `doc` write, a `lease.acquire` and a presence message with a `drag` of 5 live ids | `READ_ONLY` per op and a lease deny; the socket stays open; the snapshot is unchanged; the editor browser sees no element change and **no drag preview** (the read-only `drag` is dropped, §2.7). **Presence flows for every read-only role:** the viewer's, a commenter's and a limited guest's cursors, moved with no tool selected, appear on the editor's screen within 200 ms p95 |
| R2 | A commenter places a comment pin and casts a vote through the custom tools; then forges a patch | pin and vote work; the patch gets `READ_ONLY` |
| R3 | Each role (editor, commenter, viewer, limited guest) presses Ctrl+S, Ctrl+Alt+S, Ctrl+Shift+S, Ctrl+O, Ctrl+P, Alt+Shift+C, Ctrl+Shift+E, Ctrl+/, Ctrl+Backspace, Tab then Shift+Tab on a selected shape, Q, Shift+X, Ctrl+Arrow, and G, S, I, digits; then drops a file on the canvas | no download, **no File System Access picker call** (counted with `instrumentFilePickers`), no file chooser, no dialog, no browser save or print, no element change, no push; the drop is prevented for every role; limited viewers cannot copy |
| R4 | An editor is downgraded to viewer while connected | 4000, read-only reconnect; its offline queue turns into `READ_ONLY` rejections with a clear message |

#### B6. Forged customData, references and links refused

One editor browser plus raw frames:

| # | Forged write | Pass |
|---|---|---|
| F1 | `plusOne:<another uid>` | `INVALID` |
| F2 | `lobbyServer.createdBy` naming someone else | replaced by the stored value |
| F3 | `lobbyServer.privateNote` on a create | stripped |
| F4 | `privateFrame` added to an existing frame | `INVALID` |
| F5 | A second label for a container | `INVALID` |
| F6 | A text with `containerId` pointing at a note leased by another user / at a locked note | `LEASED` / `LOCKED` |
| F7 | An arrow bound to a missing id | binding set to null (`fix`) |
| F8 | `frameId` pointing at a rectangle | `INVALID` |
| F9 | `fileId` of a version in another workspace; then with the api stopped | `INVALID`; then `UNAVAILABLE` (fail closed) |
| F10 | `link` = `javascript:…`, `data:…`, a signed R2 URL | `INVALID` |
| F11 | `type: 'embeddable'`, `type: 'iframe'`; a type change | `INVALID`; `TYPE_CHANGE` |
| F12 | A label whose index sorts before its container | label re-keyed (`fix`) |
| F13 | A +1 while a dot vote is open | `VOTE_OPEN` |
| F14 | 60 `INVALID` ops in a minute; then 60 `RATE` rejects | the first closes with 4099 `INVALID_MESSAGE`; the second does not close |
| F15 | A text with `fontFamily` 9, then 10, then 1 | `INVALID` each (§3.5) |
| F16 | A rectangle at `x` = 2e6 | `INVALID` |
| F17 | A presence `drag` with 501 ids; a second active drag in the same session | the message's `drag` is dropped; no preview reaches the editor browser |

#### B7. An R2 image and a file card, with no base64 stored

| Case | Pass |
|---|---|
| Upload an image and a PDF through `/api` to **R2** (`E2E_BLOB_STORE=r2`, the existing opt-in, random `test/` prefix, deleted afterwards). Both browsers render them (pixel probe). | rendered in A and B |
| The internal snapshot | no `data:`, no `blob:`, no signed URL; every `fileId` matches `^ver_`; `status` is `'saved'` |
| The file card | an `image` face with chips; double-click opens the PDF viewer; `customData.lobby.file` equals the api's record |
| Network | only same-origin `GET /files/…` for bytes; no request to a foreign host |
| Failure injection: B's derivative returns 404 | B shows Lobby's placeholder, retries, and pushes 0 ops |
| Exports | PNG contains the image; the SVG export renders with the network off |
| Mood board: 200 images | fetches never exceed 6 at once; memory and derivative upgrades reported |

#### B8. Conversion of real tldraw boards, with a lossless checklist

**Every staging board is converted. This is mandatory, not optional.** The corpus:
- **every staging board**, from the read-only restore of the latest R2 offsite backups (§8.1, "Real staging data"): already restored, 4 boards of 4–64 records, on the workstation's local disk (§8.6.7). B8 converts copies of those files;
- the **Lobby tour** board, created from `packages/templates` through the running current api and sync (the sample-board flow), with comment anchors seeded on it;
- the **heavy perf board**, created by `e2e/perf/seed.ts` `HEAVY` against the current build;
- a **multi-page board** made with the current build (pages 2 and 3 with content), for `page-flattened` and the frozen offsets;
- [DATA]'s 8 fixtures.

Conversion runs **inside the spike's sync process**, in the capped worker, one board at a time, on copies of these files.

| Lossless check | Pass |
|---|---|
| Every tldraw shape id → an element id or a lossy code | 100% |
| Every `dr_deleted_records` row → an `lb_deleted` row or a lossy code; `dr_deleted_*` byte-identical afterwards | 100%; identical |
| `lb_source` digest equals the restored backup's `recordsSha256` | equal |
| Plain text of every text-bearing shape equals `originalText` (after list rules) | 100% |
| Referenced asset set | equal |
| Comment anchors (seeded on the tour board) and vote targets resolve; on staging boards, structurally (every anchored shape id maps; §8.1) | 100% |
| Frame membership kept (except `nested-frame`) | 100% |
| Bounds within tolerance (§5.3) | 100% |
| Limits: every element passes the server schema | 100% |
| Local mode: each record converted alone equals its elements in the whole-board conversion, apart from `index` | 100% |
| `restoreElements` fixed point in the browser | 0 changed fields |
| Invariant checker | 0 violations |
| Opening the converted board in two browsers | both converge; 0 pushes from either |
| Worker | peak heap per board reported; the runtime cap (§2.13) is set from the largest staging board and the heavy board |
| Report | records in → elements out, lossy codes, ms, bytes before/after, disk check result, peak heap; screenshots for the owner only (no content in the report) |

**Rollback drill**, on the tour board, on the multi-page board and on **the largest staging board copy** (64 records; the tour and multi-page boards carry the harder cases):
1. Convert.
2. Edit on Excalidraw (A).
3. Run the R0 stand-in (below) on the same file, and edit (B). B's edits include an add, a delete, a z-order change, an edit on page 2, a frame move while A had moved one of its children, and one planted same-group conflict.
4. Roll forward.
5. Repeat steps 2–4 once (the second cycle).

**The R0 stand-in (open item 4, closed).** Revision 3.1 used "the current tldraw sync" unchanged, which has no born-after check, so the born-after case could not pass. The stand-in is now the spike branch's own `apps/sync` started **without** `DRAFTROOM_ENGINE` (the current tldraw sync), plus R0's born-after check, ported so that the drill tests the code R0 will ship:
- **Where.** `apps/sync/src/r0/born-after.ts`, a spike file owned by O4 (§8.6.3). It is called through a pre-open hook that the contracts step adds (§8.6.2) in the tldraw room-open path of `rooms.ts` and in the internal snapshot, text and asset-refs routes. O4 never edits `rooms.ts`.
- **What it does, before any writable handle exists.** It opens the board file with `new DatabaseSync(path, { readOnly: true })`, looks in `sqlite_master` for `lb_meta` and, if it exists, reads `converted_from`. If `lb_meta` exists without `converted_from`, it closes the read-only handle and refuses: the socket gets 4099 `NEW_CANVAS_BOARD`, the internal routes answer `409 new-canvas`, and no `TLSocketRoom` or `SQLiteSyncStorage` is created, since either would create `documents` and `metadata` tables. A file with `converted_from` is served by the tldraw room as R0 serves it.
- **Never writing `lb_*`.** The stand-in has no code that names `lb_*` except this read-only check. The born-after file is left out of the stand-in's backup pass during the drill, because today's backup code throws on a file with only `lb_*` tables (open item 9, which R0 fixes).
- **Carried forward.** `born-after.ts` and these checks become R0's reviewed code and gate tests (§5.10).

**Pass:**
- A's and B's edits are all present;
- the conflict is listed in the roll-forward report and kept in `lb_prev_*`;
- untouched elements are byte-identical to their pre-merge rows;
- A-era z-order is unchanged except where B re-ordered;
- the second cycle merges against the refreshed `lb_source`;
- **R0 never writes `lb_*`:** for each converted board the stand-in served, every `lb_*` table (`lb_meta`, `lb_elements`, `lb_doc`, `lb_deleted`, `lb_source`, `lb_prev_*`) has the same schema SQL and the same content digest (sha256 over its rows in primary-key order, as `recordsSha256` is computed) before the stand-in opened the file and after it served, backed up and trimmed it; `dr_deleted_*` changed only by the stand-in's own rows;
- **born-after:** a board created on the spike's Excalidraw build is opened by the stand-in through a socket and through each internal route. Each attempt is refused as above; `sqlite_master` lists the same tables afterwards (no `documents`, `metadata` or `dr_deleted_*` appear); the main file's sha256 is unchanged, and no WAL frames were written (a `-shm` index that the read-only open may need is not board data).

#### B9. Capacity: simulated clients on a 0.5 CPU / 512 MB container on the NAS

**Setup** (under the standing NAS approval for `draftroom-*` containers; LAN only; nothing else on the NAS touched; the full rules are §8.6.6):

```sh
# on the NAS, over SSH; the data directory is on the NAS's own volume (never over SMB)
docker network create --internal draftroom-spike-net
docker run -d --name draftroom-spike-sync --network draftroom-spike-net \
  --cpus=0.5 --memory=512m --memory-swap=512m \
  -v /volume3/Apps/draftroom-spike/data:/var/data -e DRAFTROOM_DATA_DIR=/var/data \
  draftroom-spike-sync:<sha>
docker run -d --name draftroom-spike-load --network draftroom-spike-net \
  --cpus=4 --memory=2g draftroom-spike-load:<sha>     # load generator + fake api
# afterwards, always:
docker rm -f draftroom-spike-sync draftroom-spike-load
docker network rm draftroom-spike-net
docker image rm draftroom-spike-sync:<sha> draftroom-spike-load:<sha>
rm -rf /volume3/Apps/draftroom-spike
```

- `--memory-swap=512m` disables swap, as on Render. No port is published.
- The cleanup lists `docker ps -a --filter name=draftroom-spike-` first and removes only those names.
- The load generator runs **headless clients built on the real engine core**, over real WebSockets with signed test tickets, and plays the api (access, file-refs, workshop-state).
- The NAS CPU and disk differ from Render's. The numbers are a proxy; fsync especially (§2.13).

**Runs:** L1 (all-hands workshop) and L2 (heavy board) from §2.13, 10 minutes each, 3 runs, plus one presence-mode comparison (one shared frame vs per-view frames). L1's editors drag as the §2.13 drag row assumes, and one editor drags a 100-note frame every 30 s, so the drag relay's cost is measured, not estimated (open item 6). **Plus one conversion-under-load run:**
- L1 runs while, at minute 5, a joiner opens an unconverted copy of the heavy board (a lazy conversion) and a second joiner opens another unconverted board. The second job must queue behind the first.
- A planted board larger than the runtime heap cap is opened too. Its worker must be terminated with `ERR_WORKER_OUT_OF_MEMORY` while the process and every room keep serving.
- **Pass:** no OOM of the container; RSS stays under the §2.13 gate; L1's targets hold; the planted board is reported as failed and stays on its tldraw tables.

**Numbers the spike must report:**

| Area | Numbers |
|---|---|
| Latency | ack p50/p95/p99; A→B edit visibility p50/p95 through the server (Node clients) and in two browsers at 100% and at fit, while L2 runs |
| Event loop | delay p50/p99/max (`monitorEventLoopDelay`) |
| CPU | % of quota, 10 s windows (`docker stats`), per phase: join storm, steady state, reconnect storm |
| Memory | RSS over time; peak; per open room; snapshot cache; outbound buffers |
| Disk | fsync p50/p99 on the NAS volume; commits/s; pushes per commit; bytes per board before/after conversion |
| Network | bytes/s out in total, per session, split into presence (cursors) / **drag relay (id lists and deltas separately)** / changes / welcome; welcome bytes and gzip ms |
| Drag relay | drag starts/s, drags in progress, ids per start (p50/max), CPU ms/s attributable to drag entries, in both presence modes |
| Protocol | pushes/s, ops/s, rejects by code, backpressure closes, `RESYNC`s |
| Restart | after the SIGKILL at minute 8: time until all sessions are back; acked-but-missing (must be 0) |
| Conversion | worker peak heap, queue wait, RSS during the conversion-under-load run |

**Pass:** the targets in §2.13.

#### B10. Echo

Across B1–B9, every receiving-only browser and simulated client pushes **0 ops**. Plus: A and B each create 50 notes at the top of the order at the same time; C only watches → C pushes 0 ops, all keys are unique, all three converge.

#### B11. Convergence under random load

Three browsers plus 50 headless engine-core clients run random ops for 10 minutes (create, move, recolour, text through the lease, group, bind, delete, undo), with random disconnects and one SIGKILL. **Pass:** at the end every element map hashes equal to the snapshot; 0 invariant violations; 0 acked-but-missing.

#### B12. Phone flows and the mind-map collapse decision

- Guest, sheet, timer and voting under Playwright touch emulation at 390 px: pass as in today's phone specs.
- Mind-map collapse prototype (§4.7): the collapsed branch is hidden (labels and frame children named in the opacity override), cannot be clicked, and is left out of an export. **Ctrl+A (Lobby-owned) selects everything else but none of the hidden items, and a box or lasso selection over the branch is post-filtered to exclude them.** Records the decision for wave 3d.
- **The hit guard's gaps (§2.7):**
  - the cursor over a hidden element and over one under a remote preview is `default`, not `move`;
  - under touch emulation, a tap, a double-tap and a long-press on a hidden element do nothing: no selection, no editor, no acquire, no context menu;
  - a click on a remote-dragged note's old spot, where a visible element lies underneath, selects that element and shows "Bob is moving this";
  - after a collapse whose re-layout moves a visible sibling over the hidden branch, a click on the sibling selects the sibling.
- Phone editing: a guest on the phone double-taps a note to edit it through the lease (B3 L11).

### 8.4 Other numbers the spike must report

| Area | Numbers |
|---|---|
| Effort | Hours of agent wall time per slice and per owner (§8.6.3), against the slice's pd, used to rescale §7.2 (spike A: 14 pd in about 4 h plus the fix round); LOC per slice; how many verifier findings each slice needed |
| Client | `updateScene` ms at 5k/20k elements; `onChange` diff ms at 20k; the index pre-pass on the apply path (skipped when nothing is unacknowledged); override updates per second during a 100-note drag preview (spike A: about 60 at 60 fps) |
| Render | heavy board **open through the real stack** (ticket, socket, `welcome`, snapshot, apply, first paint), which spike A could not measure (it opened from static JSON in 0.67–0.70 s); pan fps at 0.25 and 1 with sync running; a typical 2k-object board open time. Same method as spike A14 and the same-method tldraw baseline (open 3.7–3.9 s; 16.4–18.8 / 53–55 / 59 fps). **A14's laptop half** if the owner names a laptop (Appendix B 16) |
| Bundle | gzip JS+CSS of the spike board route, with the method of A13 |
| Conversion | per board: records in → elements out, lossy codes, ms, bytes; the owner's visual verdict |

### 8.5 Go / no-go

| Outcome | Condition | Action |
|---|---|---|
| **Go** | Every A and B check passes 3 runs (A6 and A16 on the fix commit, with the verifier's probes); echo 0; convergence 0 differences; **every staging board converts with the semantic diff at 100%, and the rollback drill passes on the largest staging board** (B8); capacity targets met on the NAS, including the conversion-under-load run; edit visibility p95 ≤ 250 ms at 100% zoom with L2 running; heavy board ≥ 30 fps at 0.25 and 1 (spike A: 53.7 and 60 without sync), and its open through the real stack no slower than today's tldraw with the same method (median 3.8 s on the workstation, revised from "≤ 3.4 s", a branded-Chrome number); the three verifiers' verdicts (§8.6.8) have no open WRONG | Proceed with §7; rescale the estimate |
| **Conditional: fit fps — applies** (spike A14) | Revision 3.1: "the heavy board is below 24 fps at fit". Spike A14 measured that, with the same method for both engines: Excalidraw **13.9 fps at the true fit** (zoom 0.054), tldraw 18.2 (zoom 0.05). Both are below 24; Excalidraw is about 24% slower for the same picture. Excalidraw's own fit clamps at zoom 0.1 and shows 38% of the board. "Today's median is 29" came from branded Chrome and a gentler pan and does not reproduce. | **Taken:** a zoomed-out level-of-detail pass in wave 3b (+3 pd): below zoom 0.2, draw a cached bitmap per frame, invalidated by that frame's changes. Fit is Lobby's own camera (§4.2, +0.5 pd). The prototype must reach **24 fps at Lobby's whole-board fit** on the workstation with the same method before wave 4, and must not change edit visibility; if it cannot, the owner decides whether to accept the fit regression against today's 18 fps. |
| **Conditional: capacity** | Targets missed | Apply the §2.13 ladder in order (commit interval, storage worker +4 pd, `synchronous=NORMAL` with owner acceptance). If still missed, a larger sync plan is an owner cost decision. |
| **Conditional: a staging board** | A staging board fails conversion, the diff, or the limits (for example over the item cap) | The owner sees the report and decides per board (split it, accept a listed loss, or fix the converter in wave 2D) before the go |
| **Fallback** | A `next`-only blocker (A1, A2, A3, A10) cannot be fixed in 1 day | Switch to 0.18.1 (§2.2), re-run A16 on its editor paths, and re-estimate (+5.5 pd) |
| **Stop and re-plan** | The sync design fails: convergence, echo, durability, the lease (including an editor-open path the guard cannot hold) or undo cannot pass; or the roll-forward drill loses an edit | Re-plan before any wave. (Spike A's A6 and A16 findings do not meet this row: both are bugs in Lobby's guard code on paths the engine lets Lobby hold, not engine paths that cannot be held [verify-A].) |

### 8.6 Spike B execution

How spike B runs with parallel owners, built on the code spike A actually left on `spike/excalidraw`. There are five owners (O1–O5), a lead who also integrates, and three independent verifiers (V1–V3). One serial contracts step comes first. Every owner has an exact, disjoint set of files. The effort per owner adds up to §8.1's 56 pd and to row 0B of §7.2.

#### 8.6.1 Starting point

**Base commit B0.** B0 is `spike/excalidraw` after the A6/A16 fix round is committed and re-verified: A6 and A16 pass 3/3, the verifier's `repeat.probe.ts` and `break.probe.ts` pass 20/20 per case, the rules of open items 1 and 2 hold, and the whole spike A suite and gates pass. The lead records B0's hash in `docs/research/excalidraw/spike-b/CONTRACTS.md`.

The contracts step (§8.6.2) may start before B0: it touches no file the fix round edits (`apps/web/src/canvas/input/**`, `canvas/lease/editorLease.ts`, their unit tests, `e2e/spike/tests/host-a6.spec.ts`, `host-a16.spec.ts`). Owners fan out only from the contracts commit **C0**, rebased on B0.

**What spike A left, and who takes it over.** Spike A's pages and specs stay as they are and become spike B's regression suite: `apps/web/src/canvas/spike/{SpikeRoute.tsx, harness.ts, pages/**}`, `e2e/spike/**`, `apps/web/build/**` (the asset and host-rewrite plugins) and `apps/web/src/canvas/preview/**` are **frozen**. Nobody edits them in spike B; the lead runs the spike A suite in every integration pass. Other spike B code may import them.

| Spike A path | What it is | Taken over by | Built on in spike B |
|---|---|---|---|
| `apps/web/src/canvas/engine/` (`ExcalidrawHost.tsx`, `engineGlobals.ts`, `interaction.ts`) | the host with fixed props, the `wiring` prop, the `onDuplicate` stamp | O2 | the host of the spike board page; `initialData` with the `appState` defaults (§2.3.2) |
| `canvas/input/` (`CanvasInput.ts`, `keymap.ts`, `dblclick.ts`, `doubleTap.ts`, `selectAll.ts`) | allowlist, double-click classifier, tap-twice detector, Ctrl+A | O2 (after B0) | as fixed at B0; the hit-guard hooks go through `registries.ts` |
| `canvas/lease/` (`client.ts`, `editorLease.ts`, `fit.ts`, `protocol.ts`, `replay.ts`, `fakeServer.ts`) | lease client against an in-page fake server, the write classifier | O2 | `client.ts` gets a real `LeaseTransport`, and `fakeServer.ts` implements the same interface so the spike A pages keep working. `fit.ts` produces `fit` ops and marks bound-arrow writes as fit-derived. `protocol.ts` re-exports `canvas-schema/protocol.ts` |
| `canvas/history/` (`apply.ts`, `diff.ts`, `fields.ts`, `stack.ts`) | the undo core, 31 tests | O2 | wired to the engine (`markPushed`, `onAck`, `absorb`); `fields.ts` imports `canvas-schema/groups.ts`; the life-version check |
| `canvas/sync/index-keys.ts` | the index pre-pass | O2 | moves into the engine core |
| `canvas/presence/pointer.ts` | the pointer listener for every role | O2 | plus the drag relay client and the cursor overlay layer |
| `canvas/tools/` (`customTools.ts`, `notes.ts`, `tools.ts`) | custom N and T tools, `setTool` refusals, notes with `created: null` | O2 | read-only `setTool` through `appState` (already done in spike A) |
| `canvas/overrides.ts` | `RenderOverrides` and `installHitGuard` | O5 | the hit guard's cursor, touch and dead-zone rules; the collapse prototype. O2 calls its existing drag-offset API and does not edit the file |
| `canvas/files/loader.ts` | the loader: 6 in flight, visible first, per-frame batching | O5 | `resolveUrl` with asset, derivative and board ids; the 100 ms window; the SVG rule |
| `packages/canvas-schema/src/engine/` (`bindability`, `fractional`, `layout`, `raw`, `text-metrics` with its table, `types`) | the server-side engine wrappers | O1 | plus `binding.ts` (bound endpoints, elbow routing probe); O4 uses them read-only |
| `apps/web/test/engine-probe/` | A3, A8 and the Node probes | frozen | O4 reuses A3's layout path for server-made labels |
| `e2e/spike/support/watch.ts` (`instrumentFilePickers`), `support/page.ts` | picker counting, request blocking | frozen (imported) | O2's R3 and L13 specs, O3's harness |

#### 8.6.2 The contracts step (serial, the lead, 1.5 pd)

The lead writes these files before anyone fans out, starting from 5203e41 if B0 is not ready yet and rebasing onto B0 when it lands. After C0 they are **frozen**. A change is a change request to the lead: the lead applies it on `spike/excalidraw`, bumps `CONTRACTS_REV` in `protocol.ts`, and every owner merges it. A change to `protocol.ts`, `groups.ts` or `room/schema.ts` also needs the OK of both ends (O1 and O2, or O1 and O4).

| File | Freezes | Source |
|---|---|---|
| `packages/canvas-schema/src/protocol.ts` | every message of §2.4.2 as zod plus TS types (`proto: 1`): `Op` with `fit`, `drag` with ids once, reject codes, close codes, `CONTRACTS_REV` | spike A's `canvas/lease/protocol.ts` for the lease messages; §2.4.2 |
| `packages/canvas-schema/src/groups.ts` | the §3.2 map per element kind, the derived-write rule (`gclock.fit`), and the coverage test | moved from spike A's `canvas/history/fields.ts` |
| `packages/canvas-schema/src/custom-data.ts` | the key registry (class, zod value, per-key size, duplicate rule) for the keys the checks use: `tag:*`, `plusOne:*`, `file`, `pdfPage`, `kind`, `ai`, `privateFrame`, `mindmap`, `mindmapEdge`, `alt`, `present`; the `lobbyServer` shape | §3.3 |
| `packages/canvas-schema/src/limits.ts`, `elements.ts`, `doc.ts`, `refs.ts` | §3.5 (fonts {5, 6, 8}, ±1e6, +1 budget 16 KiB, uid ≤ 60), strict per-type element schemas, `lb_doc` keys, `shape:` ref mapping | spike A's `engine/types.ts`; §3.4–3.6 |
| `packages/canvas-schema/src/hash.ts` | **the convergence hash**: sha256 over the live and deleted elements in `(id)` order, each as canonical JSON with sorted keys, without `status` and with the local derivative suffix stripped from `fileId`. Every browser (through the facade), headless client and the snapshot route use this one function | new |
| `packages/canvas-schema/src/invariants.ts` | the signature `checkInvariants(elements) → Violation[]` and the violation codes (a stub the lead writes; O1 implements it; the harness calls it) | §2.4.4 |
| `packages/canvas-schema/src/engine/binding.ts` | the signature of the bound-endpoint helper for §2.9.4 rule 7 (a stub; O1 implements it) | new |
| `packages/canvas-schema/package.json`, `src/index.ts` | exports `.`, `./engine` and the new subpaths (spike A's lead action) | spike A report §4 |
| `apps/sync/src/room/schema.ts` | the DDL of `lb_meta`, `lb_elements`, `lb_doc`, `lb_deleted`, `lb_source`, the `lb_prev_<cycle>_*` naming, and the `gclock` JSON shape. O1's store and O4's conversion both use it | §2.6 |
| `apps/sync/src/engine-switch.ts`, plus one-time edits of `rooms.ts`, `app.ts` and the internal-route mounting | `DRAFTROOM_ENGINE` dispatch; `registerElementRoom(factory)` for O1; `registerPreOpenCheck(fn)` on the tldraw open path and the internal snapshot, text and asset-refs routes for O4's born-after check; mount points for the room's internal routes and `/internal/metrics` | new |
| `apps/web/src/canvas/sync/types.ts` | **the engine-core interface.** `EngineCore` is pure, with no DOM: it takes server messages and local scene snapshots and emits pushes, lease messages and Saved state. `SceneAdapter` is what the core needs from a scene: read elements and `appState` gesture flags, apply with `NEVER`. `Transport` is a WebSocket or a test pipe. `LeaseTransport` is implemented by the real core and by spike A's `fakeServer.ts` | §2.5 |
| `apps/web/src/canvas/port.ts`, `registries.ts`, `test-facade.types.ts` | `CanvasPort` (§2.3.1); the registries for keys, overlay layers, pointer tools, `customData` specs, and the **hit-guard predicate** `isBlocked(scenePoint)`, which O5's guard provides and O2's double-tap detector and double-click classifier consult (so neither edits the other's file); the facade verbs (§6.3) plus `hash()`, `pushedOps()`, `leaseState()` and `saveState()` | §2.3.1, §6.3 |
| `e2e/spike-b/playwright.config.ts`, `e2e/spike-b/support/types.ts`, `support/ports.ts` | the harness types (`BrowserProcess`, `Barrier`, `ForgeSocket`, `Snapshot`, `InvariantReport`) and the port table of §8.6.5 | §8.1 |
| `packages/auth-tickets/src/index.ts` | the optional `guest` claim (A3) and the uid length check | §1 A3 |
| `packages/tldraw-import/package.json` | the new package with its dependencies, all already in the catalog | §5.7 |
| `pnpm-workspace.yaml`, catalog, `pnpm-lock.yaml`, `vitest.config.ts` | **the only lockfile change in spike B** (the new package), and the test projects for the new folders | AGENTS.md: serialize lockfile changes |
| `apps/web/src/App.tsx` | one route, `/b/:boardId`, to the spike board page, only with `VITE_LOBBY_ENGINE=excalidraw` and the dev-auth guard (inlined, as spike A found it must be) | spike A scaffold |

**Gate for C0:** lint, typecheck, unit (the existing 1,389 plus the contract tests: a zod round trip for every message, the group coverage test over spike A's element samples, the limit samples), the whole spike A suite, pushed. The lead writes `docs/research/excalidraw/spike-b/CONTRACTS.md`: what is frozen, the change-request rule, B0 and C0.

#### 8.6.3 Owners and their files (no overlap)

Each owner works in its own worktree on `spike/b-<name>`, branched from C0, and never edits another owner's files; it may import them. The lead merges the owner branches into `spike/excalidraw` at the milestones (§8.6.4) with `--no-ff`, and owners then merge `spike/excalidraw` back. Files no one owns are frozen; an owner who needs one changed asks the lead.

| Owner | Owns (exactly) | Checks and evidence it writes | pd |
|---|---|---|---|
| **Lead** (integration) | The contracts files of §8.6.2, except the three it hands over after C0 (`canvas-schema/src/invariants.ts` and `canvas-schema/src/engine/binding.ts` to O1, `packages/tldraw-import/package.json` to O4); `apps/sync/src/{rooms.ts, app.ts, engine-switch.ts}`; `apps/web/src/App.tsx`; `packages/auth-tickets/**`; `pnpm-workspace.yaml`, the catalog, `pnpm-lock.yaml`, `vitest.config.ts`, `biome.json`, root `package.json`, `.gitignore`; `docs/research/excalidraw/SPIKE-B-REPORT.md`, `spike-b/CONTRACTS.md`, `spike-b/scripts/integration-*`; `docs/PROGRESS.md` | the integration runs, A14's laptop half, the report | 4.75 |
| **O1 room** (sync server) | `apps/sync/src/room/**` except `room/schema.ts` and `room/migrate/**`: `element-room.ts`, `store.ts`, `merge.ts`, `custom-data.ts` (server rules), `lease.ts`, `fit.ts` (fit and the bound-arrow re-snap), `index-keys.ts`, `outbound.ts`, `presence.ts` (roster, cursors, drag relay), `metrics.ts`, `http.ts`, `index.ts`; `apps/sync/src/{file-refs.ts, workshop-state.ts}`; `packages/canvas-schema/src/invariants.ts` (after the stub); `packages/canvas-schema/src/engine/**` (after the stubs); `apps/sync/test/element-room/**` | protocol suites (§6.2, spike subset); B3 L8; B4 D3, D4; B5 R1, R4; B6 F1–F17; the server half of L6 and L10. Specs in `e2e/spike-b/tests/`: `b3-l8-*`, `b4-server-*`, `b5-r1-*`, `b5-r4-*`, `b6-*` | 10.5 |
| **O2 web engine** | `apps/web/src/canvas/sync/**` except `sync/types.ts`: `core/**` (pure), `adapter/**` (Excalidraw), `headless/**` (a Map-backed scene and a WebSocket client for Node: the client of O1's protocol tests and of O3's load generator); `canvas/{lease, history, input, engine, presence, tools, overlay}/**`; `canvas/port-impl.ts`; `canvas/spike/board/**` (the spike board page: top bar, Saved indicator, ticket, socket, "X is typing") | B2 (U1–U11); B3 L1–L5, L7, L9, L11, L12, L13; B4 D1, D2, D5, D6; B5 R3. Specs in `e2e/spike-b/tests/`: `b2-*`, `b3-*` (except `b3-l8-*`), `b4-client-*`, `b5-r3-*` | 8.5 |
| **O3 harness** (browser and load) | `apps/web/src/canvas/test-facade.ts`; `e2e/spike-b/support/**` except `types.ts` and `ports.ts` (stack launcher reusing `e2e/tests/support/stack.ts` by import, separate browser processes, barrier, raw-socket forging, hash and invariant helpers); `e2e/load/**` (headless load clients on O2's `headless/`, fake api, per-run test ticket secret, L1/L2 profiles, reports); `docker/spike/**` (the sync and load images); `docs/research/excalidraw/spike-b/scripts/nas-*` | B1; B9 (runs the NAS); B10; B11. Specs in `e2e/spike-b/tests/`: `b1-*`, `b10-*`, `b11-*` | 10 |
| **O4 conversion and roll-forward** | `packages/tldraw-import/**` (after the lead creates `package.json`); `apps/sync/src/room/migrate/**`; `apps/sync/src/r0/**` (the stand-in's born-after check); `apps/sync/test/migrate/**`; `e2e/spike-b/b8/**` (drill scripts; the tldraw-side edits use the existing `apps/sync/test/harness/sync-client.ts` by import) | B8, including the drill and the stand-in. Specs in `e2e/spike-b/tests/`: `b8-*` | 11.5 |
| **O5 features, routes, files** | `apps/api/src/**` changes (the A1 `file-refs` and A2 `workshop-state` routes and their registration; A3 issuance in `routes/tickets.ts`); `apps/web/src/canvas/overrides.ts`; `canvas/files/**`; `canvas/export/**` (SVG with the export-only files map and Lobby's `@font-face`); `canvas/spike/features/**` (tags chip, +1, comment pin tool, vote tool, phone sheet, timer, guest at 390 px, mind-map collapse), registered through `registries.ts` | B5 R2; B7 (R2 uploads under a random `test/` prefix, deleted afterwards, as the existing opt-in does); B12. Specs in `e2e/spike-b/tests/`: `b5-r2-*`, `b7-*`, `b12-*` | 9.5 |
| **V1, V2, V3** (verifiers) | nothing in the repo; their probes live in their own worktrees and are handed to the lead, who may add them as regression specs | §8.6.8 | 1.5 |
| **Total** | | | **56.25 ≈ 56** |

Each check's evidence file `docs/research/excalidraw/spike-b/<check>.md` belongs to the owner that writes the check, and so do that owner's run scripts `spike-b/scripts/<owner>-*`.

#### 8.6.4 Order and dependencies

```
B0 (fix round re-verified) ─► C0 contracts (lead, serial)
                                   │
   ┌───────────────┬───────────────┼────────────────┬─────────────────────┐
   ▼               ▼               ▼                ▼                     ▼
 O1 room        O2 engine core   O3 browser       O4 converter port     O5 api routes A1–A3,
 skeleton       + headless       harness,         + local mode          loader, SVG export,
 (elbow probe   client first     stack launcher   (pure; needs only     hit-guard gaps on
  in Node d1)                    (against spike   canvas-schema)        spike A pages
   │               │              A pages)          │                     │
   └──────┬────────┘               │                ▼                     │
          ▼                        │              worker + queue on       │
   M1 walking skeleton ◄───────────┘              room/schema.ts          │
   (O1+O2, lead integrates)                         │                     │
          │                                         ▼                     │
          ├─► O3 facade on port-impl; load generator on headless/         │
          ├─► O5 features on the board page ◄─────────────────────────────┘
          ▼
   M2 full protocol (lease + fit + re-snap, FIFO, presence + drag relay,
      invariants, customData classes, COMMIT failure, offline queue)
          │                                        │
          ▼                                        ▼
   M3 every check written and passed once    O4 drill: needs O1's store to serve
          │                                  converted boards and C0's pre-open hook
          ▼
   owners' 3-run passes ─► verifiers per slice ─► fixes ─► lead's final 3-run pass ─► report
   (B9 NAS runs by O3 and B8 conversions by O4 run in parallel with the browser checks)
```

- **Day 1 of spike B (calendar d2), after C0.** O1 builds `hello`/`welcome`/`push`/`ack`/`changes` on the `lb_*` store, and probes first whether the element package's elbow routing runs in Node without `Scene` (§2.9.4 rule 7). O2 builds the pure core and the headless client first, tested against a protocol fake generated from `protocol.ts`, so O1's protocol tests and O3's load generator can start early. O3 builds the browser-process harness against the spike A pages. O4 ports the converter and its local mode (pure). O5 builds the api routes, the loader changes, the SVG export and the hit-guard gaps.
- **M1, walking skeleton** (target: end of day 1; O1 and O2, integrated by the lead). Two separate browser processes sign in as different dev users, open the same board at `/b/:id`, and create and move a note both through the facade and by pointer. Both hashes equal the snapshot's, and a third, receiving-only client pushes 0 ops. **Every browser check depends on M1.**
- **M2, full protocol** (target: middle of day 2): the lease with fit and the re-snap, the stage-0 FIFO, presence and the drag relay, the invariants, the `customData` classes, the COMMIT-failure path and the offline queue. The headless client passes O1's protocol suites.
- **M3, every check written** (target: end of day 2) and passed at least once on the integrated tree.
- **In parallel:** O4's conversions of the staging, tour, multi-page and heavy boards need only the converter and the worker. Only the "open in two browsers" row and the drill need M1 or M2. O3's B9 needs O1's room and O2's headless client, from M2; it runs on the NAS, so it does not compete with browser runs for the workstation.
- **Days 3–5 (calendar d4–6):** the owners' 3-run passes; the verifiers start on each slice as soon as its 3-run pass is in, not at the end; fixes and re-verification; the lead's final 3-run pass on the merged tree; the report.

#### 8.6.5 Ports

Spike B uses **7850–7999** only. Everything else stays free:
- today's e2e defaults (sync 5881, api 5882, web 4191) and bases used before, such as `E2E_PORT_BASE=6500`;
- spike A's ranges, including its fix round and re-verification: 7700–7849.

Each stack uses `E2E_PORT_BASE` = base: sync on base, api on base + 1, web on base + 2, with the build folder `apps/web/dist/spike-b-<web port>` and the output folder `e2e/test-results/spike-b-<web port>`. Separate browser processes need no port. Tests that bind port 0 (the sync protocol harness, api route tests) stay on port 0.

| Who | Range | Stacks |
|---|---|---|
| Lead | 7850–7859 | integration 7850; the final pass's second stack 7855 |
| O1 room | 7860–7869 | dev stack 7860 |
| O2 web engine | 7870–7879 | 7870 |
| O3 harness | 7880–7899 | browser harness 7880; local load dry run 7890 (the NAS runs publish no port) |
| O4 conversion | 7900–7909 | the R0 stand-in (tldraw sync and api) 7900; the Excalidraw stack 7905 |
| O5 features | 7910–7919 | 7910 |
| V1, V2, V3 | 7920–7929, 7930–7939, 7940–7949 | one stack each at the range's base |
| Spare | 7950–7999 | assigned by the lead on request |

Each owner lists the listeners in its range before starting and after finishing, and leaves nothing listening or running: no server, no headless browser, no watcher.

#### 8.6.6 NAS rules for B9

B9 runs under the standing NAS approval for `draftroom-*` containers (Appendix B 3). O3 runs it, and the lead reviews the listings.
- **Access.** SSH with the existing key in batch mode as the `docker`-group user; Docker without `sudo`. Nothing is exposed: the NAS stays LAN-only.
- **Names.** Every container, network, image and folder is named `draftroom-spike-*`: containers `draftroom-spike-sync` and `draftroom-spike-load`, the network `draftroom-spike-net`, images `draftroom-spike-sync:<sha>` and `draftroom-spike-load:<sha>`, and the data folder `/volume3/Apps/draftroom-spike/`.
- **LAN-only, no ports.** The runtime network is `--internal`; no `-p` or `--publish`; the containers cannot reach the internet. The images are built with their dependencies inside. The build context comes from `git archive` of the spike commit, so it never contains `.env*`, `.data`, `node_modules` or the restored staging boards.
- **Limits.** Sync: `--cpus=0.5 --memory=512m --memory-swap=512m` (no swap, as on Render). Load generator: `--cpus=4 --memory=2g`. The NAS has 12 threads and about 8 GB of RAM, and the owner's other containers use about 3.6 GB. So before starting, O3 checks free memory and does not start with less than 3 GB available; it reports that instead.
- **SQLite on the NAS's own volume, never over SMB.** The data folder is created over SSH and bind-mounted into the sync container. The workstation never opens, writes or copies a database file under `V:\draftroom-spike`. Only JSON reports come back, over SSH.
- **No real data on the NAS.** B9 uses generated boards (L1, L2, the heavy seed, synthetic unconverted boards). The restored staging copies never leave the workstation (§8.6.7).
- **Secrets.** A test ticket secret generated per run. No value from `.env.deploy.local` goes to the NAS.
- **List by name before removing.** Before any removal, O3 lists `docker ps -a --filter name=^draftroom-spike- --format '{{.Names}}'`, `docker network ls --filter name=^draftroom-spike-` and `docker images 'draftroom-spike-*'`, and then removes **only** names from those lists that start with `draftroom-spike-`, one by one. Never `docker system prune`, `docker rm $(docker ps -aq)`, `docker compose down`, a Docker restart, or any command without an explicit `draftroom-spike-` name.
- **Never touch anything else.** No other container, image, network or volume. Nothing of the `theaitre` compose project or `V:\theaitre-bot`: never stopped, rebuilt, read or listed beyond what `docker ps` shows.
- **Removed afterwards.** After each run session and at the end: the containers, the network, the images and `/volume3/Apps/draftroom-spike/` are removed. The before and after listings go into `docs/research/excalidraw/spike-b/B9.md`.

#### 8.6.7 Privacy rules for B8's restored staging boards

Four staging boards (4–64 records each) were restored from the R2 offsite store on 2026-09-28 with verified signatures, on the owner's instruction: restore, verify, and delete when the spike ends (Appendix B 13). They are under the session scratchpad at `…/scratchpad/spike-b8/` (the copies are in its `tmp/dr-restore-drill-*` folder) on the workstation's local disk. They hold real DBC content.
- **Read-only inputs.** Never modified in place. O4 copies a file into a per-run work folder inside `spike-b8/` and converts only the copy. Nothing goes into the repo, `.data`, `V:\`, the NAS, R2 or any other machine.
- **Who reads them.** O4 and the V3 verifier only. No other owner, and no automated job outside B8.
- **Never committed, uploaded, printed or pasted.** No board text, frame name, comment content, file name or user name appears in logs, reports, test output, commit messages, PR text or chat. Reports carry board ids, counts, lossy codes, timings, bytes and hashes only. The converter and the drill log ids and counts only.
- **Checked before every commit.** A local script reads the restored boards' text fields and searches the B8 evidence files, the drill reports and the Playwright output folders for any of those strings. It prints only the number of matches, which must be 0. Nothing from `e2e/test-results` or the scratchpad is ever staged.
- **Screenshots** of converted staging boards go to the owner directly, never into the repo or a report, and are deleted with the folder.
- **Deleted at the end.** After the report is written and the owner has the screenshots, O4 deletes the whole `spike-b8/` folder: the copies, the work folders and any Playwright output that shows a staging board. The lead confirms the deletion in the report. The re-run script used for the restore is not kept.

#### 8.6.8 Verification rounds

- **Owners.** Every check runs **3 times in a row**, with a fresh build each run, and must pass all 3. The evidence file gives the commit, the commands, the ports, the numbers per run and any deviation from the check as written.
- **Lead.** After M3 and after the fixes, the lead reruns every check 3 times on the merged tree, plus the spike A suite and the gates: lint, typecheck, unit, and the normal build with 0 engine markers and 0 `@excalidraw` sources in its source maps.
- **Independent verifiers.** One per high-risk slice. A verifier is not an owner and not the lead. It works in its own worktree at the lead's integration commit, on its own ports (§8.6.5). It re-runs the checks and **writes its own break probes**, as spike A's verifier did, 20 repetitions per probe. It returns CONFIRMED, WEAKER-THAN-CLAIMED, WRONG or NOT-CHECKED per check, with a reason.
  - **V1 room, lease and undo:** B2, B3 (including L12 and L13), B4, B10, B11, and the code in `apps/sync/src/room/**` (merge, lease, fit, re-snap, FIFO), `canvas/lease/**`, `canvas/history/**` and `canvas/sync/core/**`. It must at least try: a release overtaking a push parked on file-refs; a fit after a concurrent resize; an arrow edit during a fit; a second editor during a pending request; input with no keydown; AltGr text in the editor; a SIGKILL inside a group commit; an undo after a server fix.
  - **V2 security:** B5 and B6, B7's "no `data:`, `blob:` or signed URL" and cross-workspace `fileId`, and the code of stage 0, the invariants, the `customData` classes, roles, the fail-closed file-refs, the read-only drag drop, the key allowlist and picker counting. It must try forged frames beyond the F list, for example a `fit` from a non-holder aimed at a label, a `boundElements` injection, a `lobbyServer` key in a create, a `containerId` switch to a leased note, a guest `doc` write, and a drag with 501 ids.
  - **V3 conversion and rollback:** every B8 row, the drill, the born-after refusal, `lb_*` byte identity, local mode, and the privacy rules of §8.6.7 (it runs the content-leak search itself). It is the only verifier that reads the restored boards.
- **Findings.** A WRONG or WEAKER-THAN-CLAIMED on a security, durability or data-loss claim **blocks the report**: the owner fixes it, re-runs 3/3, and the same verifier re-checks. Other findings go into the report as open items with an owner and a wave.
- **B9** is numbers against targets: O3's three runs, with the raw JSON re-read by the lead. A target missed is reported, not argued away.

#### 8.6.9 What the lead reports

`docs/research/excalidraw/SPIKE-B-REPORT.md`, in the shape of spike A's report:
1. **The result line** (PASS, PARTIAL and FAIL counts) and a recommendation for each §8.5 row: go, conditional, fallback, or stop and re-plan.
2. **Per check:** status, runs, key numbers, finding, evidence file, the verifier's verdict.
3. **The numbers:** §8.4, B9's table (latency, event loop, CPU, memory, disk, network with the drag-relay split, protocol, restart, conversion under load), the heavy board's open through the real stack, and bytes per hour for the owner's bandwidth check (Appendix B 10).
4. **B8 per board:** board id, records in → elements out, lossy codes, ms, bytes before and after, peak worker heap, semantic diff; the drill's results (both cycles, the conflict list by id and group, `lb_*` byte identity, born-after). No content.
5. **Engine behaviour** that contradicts or refines the plan, with dist file:line.
6. **Plan corrections**, grouped by section; where the lead disagrees with an owner, say so and why.
7. **Effort:** agent wall time per slice and per owner against its pd; LOC per slice; verifier findings per slice; a rescaled §7.2 with the reasoning (the second sample, §7.3).
8. **Not run or not verified**, each marked UNVERIFIED.
9. **Cleanup evidence:** the NAS listings before and after; the `spike-b8/` folder deleted; B7's R2 `test/` prefix empty; ports 7850–7999 free; no process left.
10. **How to re-run** each check.

Also a `docs/PROGRESS.md` entry. For the owner, a short summary: the go/no-go, the fit decision and the level-of-detail plan, capacity against the 0.5 CPU / 512 MB plan, bandwidth per hour, the staging boards' lossy counts (Appendix B 2), with the screenshots handed over directly.

---

## 9. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **Performance with thousands of elements.** Every note is now 2 elements. At fit, [API] measured 58 ms per frame at 6k elements and 177 ms at 20k on `next`, on an RTX 5090 host. The heavy board becomes 9,000+ elements. Spike A14: 13.9 fps at the true fit against tldraw's 18.2 with the same method; above 30 at 0.25 and 1 for both. | High / High | `EXCALIDRAW_THROTTLE_RENDER`; roughness 0 and solid fills; `thumb` derivatives by default; minimap closed; `updateFrameRendering({ clip: false })` when zoomed out; **the level-of-detail pass (applies, wave 3b)** and Lobby's own fit camera; `addFiles` batching; the item cap; measured on an agreed laptop |
| **Sync capacity on 0.5 CPU / 512 MB**, especially fsync blocking the event loop | Medium / High | Patches, one serialization per batch, gesture coalescing, drag previews, budgets (§2.13); the NAS load test; the mitigation ladder; a bigger plan is an owner decision |
| **Hosting bandwidth** for 200-person sessions (≈23 GB per hour estimated, drag relay included) | Medium / Medium | Cursor caps and integer coordinates; drag ids once per drag; "hide cursors"; spike numbers for the owner's cost check |
| **Echo loops** from engine behaviour not yet found | Medium / High | Nine named sources with rules (§2.5.5); the dev-mode `echo_suspect` assertion; receiving-only checks in every spike check and in the protocol and e2e suites |
| **Undo semantics** (Lobby's own applier) | Medium / High | Same contract as today's tested `perPropUndo.ts`; unit cases incl. probe2; spike B2 in 2–3 browsers |
| **Text editing:** lease loss while offline, IME, resize while typing, editor-open paths that bypass the lease | Medium / Medium | Explicit lease with presence renewal; every editor-open path intercepted or guarded, pinned by a probe that counts the call sites (§2.9.2); the holder is the only writer of the label layout and the container fit, which is conditional (§2.9.4); the server re-snaps bound arrows; server re-layout on expiry; "Copy my text"; spike A16, A17 and B3 |
| **Guard code that looks right but is not.** Spike A's owners reported open items 1 and 2 closed; an independent verifier broke both in minutes (Ctrl+Alt+S; a second editor during a pending request) [verify-A] | Medium / High | Invariants instead of lists: the editor's chord allowlist and "no writable editor without a granted lease" (§2.3.3, §2.9.2), reconciled on every change; an independent verifier per high-risk slice in spike B and the waves (§8.6.8), who writes their own break probes; the verifier's probes kept as regression checks (B3 L12, L13) |
| **Cross-element state** broken by partial rejections or concurrent edits | Medium / High | Server invariants with repairs (§2.4.4); property tests; the invariant checker after every spike check |
| **Fractional indices** | Medium / High | Server-assigned keys; own-only client re-keys; label-after-container rule; E2 tests |
| **Excalidraw upgrades.** A nightly pin; the API moved within 2 weeks; `ui` is WIP; `interaction` is new | High / Medium | Exact pins of all five packages; one adapter directory; the field-group coverage test; the probe suite (§6.5); bumps only as their own PR, with a data migration when fields change; move to the next stable release when it includes sticky notes |
| **Host-rewrite plugin** misses a new host or breaks code after a bump | Low / Medium | The plugin covers the engine's whole 266-package tree and fails the build on any host left (spike A12); the font fallback is same-origin; CSP as a second layer; e2e network assertion |
| **CSP breaks sign-in** (Clerk origins) | Medium / Medium | Clerk origins derived from code in spike A12, **UNVERIFIED**; recorded from a real sign-in at the rehearsal, which runs everything with the header enforced; the theme script as a file and zod `jitless` remove the two app-code violations |
| **Server layout differs from the viewer's** (A3's table reproduces Windows Chromium; macOS/iOS CJK and emoji fall back to other fonts) | Medium / Low | Pair kerning and per-class widths (0/208 on Windows Chromium); the holder's re-fit corrects a label on its next edit; re-calibration on every bump |
| **Rollback / roll-forward** complexity | Medium / High | Record-level merge that converts only touched records in a local mode with frozen page offsets; in-file base (`lb_source`) refreshed every cycle and cross-checked with the final backup, which is taken after maintenance is on; a rule for boards born after the cut-over; property tests; drill on a real staging board in spike B8 and in the rehearsal; nothing irreversible inside the window (`dr_deleted_*` untouched) |
| **Conversion** fails, runs out of disk or memory | Low / High | Worker thread with `resourceLimits`, one job at a time, an RSS gate at runtime, time budget, disk check first, per-board retry, semantic diff on 100% of boards; every staging board converted in spike B8 |
| **Mobile and tablet** | Medium / High | Lobby chrome; touch-emulation flows in spike B12; a real iPhone/iPad check before cut-over |
| **Accessibility:** the canvas is not DOM | Medium / Medium | Live region, keyboard traversal, content list, axe, a11y specs in the gate (§4.8) |
| **Bundle size** (`next` eager ≈719 KiB gzip; the spike's route 1307 KiB with tldraw still in the shell) | Medium / Low | Board route only; projected ≈1066 KiB after cut-over against 1086 today (spike A13); pdf-lib lazy; mermaid stubbed (≈120 KiB); katex and locales lazy |
| **Fonts and look** (Nunito instead of tldraw sans, no serif) | Medium / Low | Self-host without Liberation; owner sees the look in the spike |
| **Sticky-note internals** (`created: null`, ink rule, 18 days old) | Medium / Medium | Probe checks; server stores null; fallback to rectangle + label |
| **Cross-board asset leak** through clipboard `files` | Medium / High | file-refs check in the server; paste handler strips foreign images first |
| **Rich-text loss** on existing boards | Certain / Low | Plain text with list bullets; tour and templates re-authored; lossy report per board |
| **Live-ness change**: resizes, rotations and strokes appear to others at gesture end | Certain / Low | Drags preview live; typing at 2 Hz; owner accepts (Appendix B) |
| **Per-zoom image sharpness** | Low / Low | `thumb` → `display` upgrade on zoom (§2.10.3) |
| **Staging tldraw key expires** before cut-over + 7 days | Low / High | Hard deadline (§7.4) |
| **Parallelism**: wave 3 needs 9 owners | Medium / Medium | Frozen contracts and registries; one extra day with 7 owners |

---

## 10. Changes to AGENTS.md

The change is made on the engine branch in wave 1, **with the owner's approval** (repository rules are the owner's), and merges to `main` with the cut-over. At the same time, a new verified synthesis, `docs/research/excalidraw/SYNTHESIS.md`, is written from the spike and the probe suite; finishing it is part of the cut-over gate. `docs/research/SYNTHESIS.md` stays as history for the tldraw era.

**Intro paragraph.** Replace:

> Verified engine facts live in `docs/research/` and `docs/FEASIBILITY.md`.

with:

> Verified engine facts live in `docs/research/excalidraw/` (current canvas engine and sync) and `docs/FEASIBILITY.md`; `docs/research/SYNTHESIS.md` is history for the tldraw era.

**Working rules.** Replace:

> Inspect current library docs and installed exports (`node_modules/**/*.d.ts`) before relying on an API name — tldraw 5.x is newer than most model training data.

with:

> Inspect installed exports (`node_modules/@excalidraw/**/*.d.ts` and `dist/dev`) before relying on an API name — Lobby pins an Excalidraw nightly (`0.18.0-1118751`) that is newer than most model training data. Pin all five `@excalidraw/*` packages to the same exact version; bump them only in a dedicated PR that runs the engine probe suite (`apps/web/test/engine-probe`) and the full gate.

**Architecture invariants.** Replace the first four bullets with:

- Canvas state has one authority: Lobby's element sync server (`apps/sync` `ElementRoom`). Exactly one room owner per board, one SQLite database per board, and only the sync process writes a board file (including conversion). Acks are sent only after COMMIT.
- Until `drop-legacy`, the new build never writes, trims or alters the tldraw tables or `dr_deleted_*` in a board file; it copies from them (`lb_source`, `lb_deleted`). The bridge release never writes `lb_*`.
- Do not add a second sync or merge layer: no Yjs, Liveblocks, Excalidraw collab/Firebase, and no `reconcileElements` as a merge rule. Do not add a whole-board overwrite save loop or debounce board JSON into a last-writer-wins endpoint.
- Apply every server or remote change to the editor with `CaptureUpdateAction.NEVER`, only through the sync adapter. A client that only receives changes must push nothing: clients re-key only their own unacknowledged elements, image `status` is local-only, and every new echo source gets a rule and a test.
- Never put base64, `data:`, `blob:` or signed/expiring URLs in elements, `customData`, `link` or board settings. Elements store stable Lobby ids (`fileId` = a version id). The editor's files map is runtime-only, filled by Lobby's loader.
- Element schemas, field groups, `customData` key classes, cross-element invariants, limits, the wire protocol and migrations live in `packages/canvas-schema` and are used by client, server, converter and archive import. Every element write is validated server-side, per op, including references between elements and identity-bearing `customData`. A test fails when an element field belongs to no field group. Test reconnects, process restarts, stale clients and concurrent modifications when those paths change.
- Undo is Lobby's field-level stack: entries are recorded against the previous local state, server fixes fold into their entry and never create a step, it changes only fields, `customData` keys and group ids whose current value is still what the entry left, and it never revives an element someone else deleted.
- Text in an element is edited only under a server-granted lease; only the holder writes its words, its layout and its container's fit, and the server re-snaps arrows bound to a fitted container. No text editor is ever writable unless its element is that of a lease this tab holds, whatever state Lobby's lease client is in. Every path that opens Excalidraw's text editor is intercepted or caught by the guard in `apps/web/src/canvas/input/`; a new path found after a bump must be added before the bump merges.
- Only `apps/web/src/canvas/**` and `packages/canvas-schema/src/engine/**` may import `@excalidraw/*`. Features use `CanvasPort` and the registries.
- Keys reach Excalidraw only through the allowlist in `apps/web/src/canvas/input/`; inside the text editor, Ctrl/Cmd/Alt chords are an allowlist too, and AltGr/Option text input still types. Every `canvasActions` flag stays off; read-only roles use the `interaction` config, and their tool is set through `appState`. A File System Access picker call counts as a download in every test.
- Embeddables and iframes stay disabled (`validateEmbeddable` returns false; the server refuses those types) unless a reviewed change adds a Lobby-only allowlist.
- No request leaves Lobby's own origins and the auth provider's: self-host Excalidraw's fonts without Liberation Sans, with a same-origin font fallback and a 404 (not `index.html`) for missing files under `/excalidraw-assets/`; keep the build-time host rewrite over the engine's whole dependency tree and the CSP header without `unsafe-eval`; and keep the e2e network assertion.
- The sync server uses only pure functions from `@excalidraw/element` (never `Scene`), installs the text-metrics provider at start-up, and builds server-made elements with `created: null` and kept ids.
- No production dependency may need a paid licence or carry a copyleft licence (CI licence check). The only tldraw code allowed is `@tldraw/tlschema`, `utils`, `store`, `state` and `validate` (MIT), inside `packages/tldraw-import`.

**Keep unchanged:** presence is ephemeral; file processing stays outside the sync loop; permissions are server-side and authorship comes from the session; the "Saved" and "natively editable" honesty rules; secrets and logging.

**Local environment.** Add:

> Load tests may run on the NAS in throwaway containers named `draftroom-spike-*` (or `draftroom-load-*`), LAN-only with no published port, with SQLite on the NAS's own volume inside the container, never over SMB, and never with real board data. List them by that name before removing them, remove them after each run, and never touch other containers.

---

## Appendix A: evidence and sources

**Repo (read-only, `C:/Users/Chase/Documents/GitHub/Draftroom-int3`, `integration/wave3` 715b0fb):**
- Docs: `AGENTS.md`, `docs/PROGRESS.md`, `docs/research/SYNTHESIS.md`, `docs/REVIEW-2026-09-27.md` §2, `docs/DEPLOY.md:262`.
- Contracts and packages: `packages/contracts/src/workshops.ts:262-300` (`PLUS_ONES_MAX` 200), `:492-503` (`PrivateTarget.pageId`), `:598-601` (`drPrivateNote` author); `tags.ts:31-32` (10 per shape, 200 per board); `ai.ts:190-232` (`drAi`, team notes); `comments.ts` (`usr_` ids); `packages/auth-tickets/src/index.ts:9-18` (`TicketClaims`, no guest); `packages/canvas-schema/src/file-card.ts`; `packages/board-ops/src/archive.ts:52`.
- Sync: `apps/sync/src/touch.ts:23-26` (GET because of the api's CSRF hook), `access.ts:24-29`, `session-end.ts`, `backup/backup.ts:144-151`.
- api: `apps/api/src/files/plugin.ts:19-24` (`FILE_ROUTES`), `sync-internal.ts`, `routes/tickets.ts:38`.
- Web: `apps/web/src/sync-quality/perPropUndo.ts:1-60` (today's undo contract); `features/workshops/PlusOnes.tsx:55-57` (+1 hidden while voting, client-side); `features/canvas-ux/defaults.ts:7` (`MAX_SHAPES_PER_PAGE` 20,000 per page); `features/canvas-ux/copy-link.ts:1-14`; `dashboard/search/content-search.ts:78`; `assets/meta-store.ts:50` (6 concurrent); `features/workshops/private-notes/canvas.ts:79-81`.
- Deploy: `render.yaml:55-106` (web headers, no CSP), `:191-207` (sync 0.5c-512mb, 1 GB disk).
- e2e: `e2e/perf/seed.ts:28` (`HEAVY`).
- There is no `.data` directory in `Draftroom-int3`.
- Measured with grep (first draft): about 160 files in `apps/web/src` import tldraw; 102 files use 137 distinct `editor.*` members; 62 of the 80 files in `e2e/tests` use `window.editor`, `.tl-*` or `shape:`.

**Checks run for this revision [rev-run]** (Node 24.19.0, packages under `scratchpad/excalidraw/critic/next`, all `0.18.0-1118751`):
- `critic/next/probe1.mjs` re-run: after `syncInvalidIndices`, A stays `a1` v1, B becomes `a1V` v2.
- `critic/next/probe2.mjs` re-run: after undo, `customData` = `{"lobby":{"tag:x":true}}` (Bob's +1 gone); `groupIds` = `[]`.
- `plan2/sizes.mjs` (new): freedraw 44.7/39.6 B per point (mouse, 100/1,000 points, unrounded), 58.1–58.9 B (pen, unrounded), 15.5–21.4 B (rounded to 2 dp); rectangle 473 B; 22-character bound label 726 B; 200 `plusOne` keys 8,801 B; position patch 75 B.
- `excalidraw/dist/types/excalidraw/types.d.ts`: `InteractionConfig` 549-633 (`tools` inside `enabled`); `interaction` 750-765; `ui` (WIP) 766-790; `onDuplicate` 741-745; `ElementRenderOverride` 655-667; `setElementRenderOverrides` docs 1095-1110; `ImageOptions` 896; `CanvasActions`/`UIOptions` 900-927; AppState gesture fields 236-433.
- `element/dist/types/element/src`: `mutateElement.d.ts:3` (`created` excluded from updates); `newElement.d.ts:3` (`created` optional); `duplicate.d.ts:8-18` (`OnDuplicateData`); `linearElementEditor.d.ts:41` (`isEditing`); `store.d.ts` and `delta.d.ts` (`StoreDelta.squash/inverse/applyTo/applyLatestChanges`, `ElementsDelta`).
- `element/dist/dev/index.js`: `isBindableElement` and `isTextBindableContainer` 3659-3670 (include `stickynote`); `validateFractionalIndices` bound-text rule 12648-12659; `syncInvalidIndices` 12728; `newElement` `created` 16371; `duplicateElement` 17933-17939 (`created = updated`); sticky-note footer 6860-6880.
- `excalidraw/dist/dev/index.js`: `updateImageCache` → `status: "error"` via `newElementWith`, captured `NEVER` (47089-47111); `saveFileToDisk` `viewMode: true`, no predicate, Ctrl+Shift+S (11608-11651); `loadScene` predicate (11667-11672); Tab converts element type (43960-43977); touch freedraw under 10 points removed from the scene (45638-45657).
- `excalidraw/dist/dev/chunk-FN755BR4.js`: `Fonts.onLoaded` clears caches only (3026-3052); `exportToSvg` writes `fileData.dataURL` into `<image href>` (4276).
- `excalidraw/dist/prod` grep: the hosts listed in §2.12.
- `common/dist/types/common/src/colors.d.ts:1`: `applyDarkModeFilter` exported.

**Checks run for revision 3 [r3-run]** (same packages under `critic/next`, and the repo read-only):
- `excalidraw/dist/dev/index.js`, editor-open paths: `startTextEditing` call sites at 27824 (sticky-note tool drop), 44176 (Enter), 44864 (`handleCanvasDoubleClick`), 46350 and 46374 (`handleTextOnPointerDown`), 51313 (sticky-note tool pointer-up) and 51681 (second click on a selected text or label, not touch; with `getSelectedTextEditingContainerAtPosition` 49945-49965); `handleTextWysiwyg` calls at 44685 and 51250 (a new text). Touch double-tap: `onTouchStart` 43477-43517 → `handleCanvasDoubleClick`, attached to the interactive canvas at 47143-47148; `shouldHandleBrowserCanvasDoubleClick` 44710; `autoshape` in the double-click tool check 44733.
- `excalidraw/dist/dev/index.js`, container writes while typing: `handleTextWysiwyg`'s `updateElement` replaces a sticky note with `getStickyNoteLayout`'s container output (49806-49848); `textWysiwyg` grows and shrinks a non-sticky container's `height` (25125-25147); the editor subscribes to `scene.onUpdate` (25600); `relayoutStickyNotes` is called only by paste-styles (11819).
- `element/dist/dev/index.js`: `getStickyNoteLayout` (6964-7040) returns container `x`, `y`, `width`, `height`, `baseHeight`; `updateStickyNoteLayout` (7067-7086); `STICKY_NOTE_LAYOUT_INPUTS` (7088-7098); `getPositionAfterHeightChange` top-anchor shift (16091-16108); `redrawTextBoundingBox` widens a container (6320-6326).
- `excalidraw/dist/dev/index.js`: `savePointer` returns early when interaction is disabled and the tool is unsupported (47780-47786); the key handler returns early inside a writable element (44005-44011); undo/redo `keyTest` (22832, 22870).
- `common/dist/dev/index.js`: `TAP_TWICE_TIMEOUT` = 300 (1892), `DOUBLE_TAP_POSITION_THRESHOLD` = 35 (2069).
- `excalidraw/dist/types/excalidraw/types.d.ts:1095-1110`: render overrides leave hit tests, selection and editing at document values.
- `data/proto/convert.ts:558` (board-wide `generateNKeysBetween`) and `:183-204` (page offsets from page-1 bounds).
- Repo: `apps/sync/src/deleted/store.ts:44-70` (`dr_deleted_*` DDL, `kind` CHECK) and `:214-235` (trims by batch); `apps/sync/src/backup/backup.ts:140-170` (`recordsSha256` over `documents` ordered by id); `apps/sync/src/backup/restore-drill.ts` and `drill.ts` (`--from=store`, `--keep`, `--allow-unsigned`, read-only on the store); no maintenance mode in `apps/sync/src` today.

**Spike A [spike-A]** (`spike/excalidraw` at 5203e41; merges 576df0f, c733cd2, 7eccb51 of `spike/a-node` 4581fd8, `spike/a-host` 11a5d6d, `spike/a-render` 1a489c2; scaffold b9252d9):
- Report: `docs/research/excalidraw/SPIKE-A-REPORT.md` (results, gates, engine behaviour §3, plan corrections §4, not run §5, re-run commands §6).
- Per check: `docs/research/excalidraw/spike-a/{A1…A17, A16-static, SCAFFOLD}.md`; run scripts in `spike-a/scripts/`.
- Code: `apps/web/src/canvas/{engine, input, lease, history, sync, presence, tools, files, preview, spike}/**`, `canvas/overrides.ts`; `apps/web/build/{excalidraw-assets.ts, excalidraw-host-rewrite.ts}`; `apps/web/test/engine-probe/**`; `packages/canvas-schema/src/engine/**` (with `text-metrics-table.json`); `e2e/spike/**` (specs, support, fixtures, CSP harness and dist report).
- Dist lines cited in revision 3.2 (X, F, E, C as defined at the top), all checked by the owners in the installed `0.18.0-1118751` files and spot-checked by the integration (X 44727, 51679-51686, 44741-44746, 47091, 44343-44350; E 18947-18952; C 2944-2946; F 642-644): fonts F 1225-1249, 1277, 3072-3082, 3155, 3207; zoom F 501, 642-644, C 1898; editor paths X 25212, 25247, 25388-25391, 25545-25561, 25600-25607, 25613-25614, 25633, 43481-43483, 43506-43516, 44005-44011, 44727, 44741-44746, 44838-44864, 49918, 51679-51686; auto-fit and bound arrows X 25133, 25147, 49806-49838, 49822-49824, 49845, 49864-49868, E 9055-9123; keys X 11606, 23095-23106, 43673-43695, 43927, 43960-43977; read-only X 42465-42479, 44343-44350, 47780-47801, 49327, 48682; images X 43789-43821, 47091-47118, E 13559-13572, 22637-22646; index and E3 E 12713, 12728, 18947-18958, 19079-19085, C 34, 2945; Node E 5731-5735, 5754-5758, 5772-5796, 6085, 6113, 16334-16343, 16371, 18949; duplicates E 17932-17939, 18139-18163, X 3737, 28491, 28547; converter E 24382-24441, 24527-24528; two instances X 43955-43980, 52656, F 3786-3790, C 2662-2680; export X 15391-15437; readiness X 49154, 49441.
- Repo, app code found by spike A: `apps/api/src/files/serve.ts:58-63` (`?board=` required); `node_modules/zod/v4/core/util.js:218-230` (eval probe); `apps/web/index.html` inline theme script; `apps/web/src/features/canvas-ux/palette.ts:45-50` (Butter `#f8e48f`).

**Spike A verification [verify-A]:** the independent verifier's result in the session scratchpad (`excalidraw/spike-a-findings.md`, section "verify"), with its probes `e2e/spike/verify/{verify.config.ts, break.probe.ts, repeat.probe.ts}` in the worktree `Draftroom-spike-verify` (not committed).

**Spike B8 corpus:** 4 staging boards restored from the R2 offsite store on 2026-09-28 with verified signatures, under the session scratchpad's `spike-b8/` folder; never in the repo (§8.6.7).

**Research scratch** (temporary; wave 1 copies what matters into `docs/research/excalidraw/`). Base: `C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/excalidraw/`
- `api/`: [API]'s installs (`stable/` 0.18.1, `next/`) and probes (`probe.mjs`, `dbg3`–`dbg5`, `dbgnext`, `dbgframe`, `perf20k`, `licenses`, `woff2name`, `eager`, `probe-{stable,next}.txt`).
- `sync/proto.mjs`: [SYNC]'s persistence and merge prototype.
- `data/proto/`: [DATA]'s converter, fixtures (`tl-*.json`, `ex-*.json`), `metrics.json`, browser harness.
- `features/spike/`: [FEAT]'s runtime probes.
- `plan/`: the first draft's `node-layout.mjs` and `rewrap.mjs`.
- `critic/`: the review's installs (`next`, `latest`) and `probe1.mjs`, `probe2.mjs`.
- `plan2/sizes.mjs`: this revision's size probe.

**npm registry (queried 2026-09-28):** `npm view @excalidraw/excalidraw dist-tags|time|peerDependencies`.

**URLs cited by [API]:** https://api.github.com/repos/excalidraw/excalidraw/pulls/12064; the Excalidraw fonts tree and licence headers; https://raw.githubusercontent.com/liberationfonts/liberation-fonts/main/LICENSE; https://raw.githubusercontent.com/microsoft/cascadia-code/main/LICENSE.

## Appendix B: owner decisions needed

1. **Go/no-go after the spikes** (§8.5), including accepting Excalidraw's look (Nunito and Excalifont, no serif, hashed remote-selection colours).
2. **Accepting the losses:** rich-text formatting, pages, extra geo shapes as polygons, inline video and GIF playback, live embeds, the live-ness change (resizes, rotations and strokes appear to others at the end of the gesture), and the remote-drag hit-test gap: during someone else's drag, a note is clickable only after the drop commits, and a click on its old spot selects what is visible there instead (§2.7). Also: the fit is about 24% slower than tldraw's for the whole heavy board until the level-of-detail pass lands (§8.5), and double-clicking a label selects its text (open items, minor).
3. **NAS use:** the spike's throwaway containers (`draftroom-spike-*`, LAN-only, removed afterwards) and the rehearsal stack with a copy of staging's boards and Postgres. **Answered for spike B:** the throwaway containers fall under the standing NAS approval, with the rules of §8.6.6. The rehearsal needs a staging database dump (not yet authorized). **R2 read access for the spike's restore of the staging backups is already authorized** (read-only; §8.1).
4. **Deploying R0** (the tldraw bridge release) to staging at least 3 days before the cut-over.
5. **The cut-over window**, and the rollback semantics: during a rollback, edits made on the new canvas are hidden but kept, and merge back on roll-forward (same-field conflicts: the rollback side wins, the other value is kept and listed); boards created on the new canvas cannot be opened during a rollback and come back unchanged; if a rollback becomes permanent, Excalidraw-era edits are recoverable only by hand from the exports.
6. **Keeping the final pre-cut-over backup set for 90 days** (R2 storage).
7. **The staging tldraw key's exact expiry date**, and renewing it if cut-over + 7 days falls within two weeks of it.
8. **Capacity fallbacks** if spike B misses the targets: accept `synchronous=NORMAL` (an OS crash could lose the last commits), or pay for a larger sync plan.
9. **Optional:** a one-off fsync measurement on the staging sync service through Render's shell (no deploy).
10. **Bandwidth cost** check from spike B's bytes per hour.
11. **One real iPhone or iPad Safari session** before cut-over.
12. **Approving the AGENTS.md rewrite** (§10).
13. **For spike B8:** whether the drill may verify backup signatures with the staging signing key (supplied by the owner, never printed), or runs `--allow-unsigned` with its sha256 checks only; and whether the restored staging copies are deleted at the end of the spike (the default) or kept.
    **Answered 2026-09-28:** restore the staging boards to the workstation, and delete the copies when the spike ends. Verify signatures with the staging signing key, read from the Render sync service env through the Render API; it is never printed or saved to a file.
14. **A disk resize** if the pre-cut-over free-space check fails (paid).
15. Whether sticky notes should ever show Excalidraw's creation-date footer. The plan hides it.
16. **A laptop for A14's second half** (new in 3.2): which laptop counts as "agreed" for the render numbers. Spike B's lead measures it if one is named; otherwise it moves to wave 4's perf run.
17. **For information, no decision needed** (new in 3.2): SVG export will embed whole font files for the characters used rather than Excalidraw's subset fonts, because subsetting needs `unsafe-eval` in the CSP (§2.10.4). Exported SVGs are larger. The default note colour stays Butter (`#f8e48f`). Coordinates are limited to ±1e6.

## Appendix C: how each review item was applied

Spike A's findings and corrections (revision 3.2) are mapped in the table "What changed in revision 3.2" at the top, and the open items' closure in "Open items".

| Priority | Review item | Where | What changed in the design |
|---|---|---|---|
| must | Rollback and the lazy converter | §5.3, §5.9 | `converted_from` records the source clock, hash and backup; a room refuses stale `lb_*` and runs a 3-way roll-forward merge; `lb_prev_*` kept; exports to R2 before rollback; drill in spike B8 and the rehearsal |
| must | Irreversible jobs inside the window | §5.5, §5.8, §5.9, §5.10 | No checkpoint rewrite; anchor shifts at read time; `0021` ships in the bridge release R0 |
| must | Echo 1: image `status` | §2.5.5 E1, §2.10.3 | `status` local-only; Lobby's loader hands `blob:` URLs only after success; test |
| must | Echo 2: index re-keying | §2.5.5 E2–E3, §2.4.3 | Own-only pre-pass; server keeps labels after containers; dev assertion; concurrent-create test |
| must | Undo reverts others' `customData`/`groupIds` | §2.8 | Field-level stack with 3-way compare-and-set per field, key and group id; side-effect geometry pushed separately; leased labels untouched |
| must | `customData` authority | §3.3 | Five classes; `privateNote` server-owned; `plusOne:<uid>` identity-bound; `file` canonicalized; `onDuplicate` rules |
| must | Element cross-references | §2.4.4 | Server invariants with rejections and repairs; lease and lock inherited through `containerId`; property and negative tests |
| must | File authorization | §2.10.2, §1 A1 | `GET /internal/boards/:bid/file-refs`, stage-0 pre-validation, LRU, fail closed |
| must | Keys, read-only, export policy | §2.3.3 | Allowlist; every `canvasActions` flag off; `interaction` config for read-only roles (shape corrected: `tools` inside `enabled`); per-role e2e |
| must | Text lease | §2.9 | Explicit acquire/release; editor after grant; presence renewal; buffer kept on loss; `text` vs `layout` groups; one layout writer |
| must | Rates and pushing | §2.5.3, §2.4.2, §2.4.5 | Gesture coalescing, drag previews, patches; `RATE` retryable and not counted toward the abuse close |
| must | Limits vs data | §3.5 | Measured sizes; rounded points; per-type byte limits; +1s outside the customData budget; cap in items; converter checks the same limits |
| must | `convert-all` / lazy conversion | §5.3 | In the sync process, worker thread, one board at a time, time budget, disk check, runbook |
| must | Non-goals, multi-page, contracts | §1, §3.6, §5.8 | api and contract changes listed; `pageId` mapping; legacy `d=` parser; new link separator; `guest` claim |
| must | Capacity at 200+ users | §2.13, §8 B9 | Budget, global outbound memory budget, one serialization per batch, NAS load test with targets |
| must | Spike acceptance | §8 | Split into A and B; every risky path proven in 2–3 real browsers, a load test, conversions and a rollback drill |
| should | Hold-back list | §2.5.4 | Gesture fields added; container and label held together |
| should | Vanishing ids | §2.5.2 | Rule defined; test per removal path |
| should | Offline queue | §2.5.6, §2.4.3 | Per tab under Web Locks; `STALE` from per-group clocks; no guest persistence; purge on revocation; horizon 14 days; cap blocks editing |
| should | Group commit failure | §2.4.3 | Memory updated only after COMMIT; `UNAVAILABLE`; room reload; injected-failure test |
| should | Presence cap vs features | §2.7 | Uncapped roster; always-included peers; vote tool; `sel` dropped during votes |
| should | `created` | §2.11 | Server stores null for notes; client builds with null; `onDuplicate` resets it |
| should | Mind-map collapse | §4.7, §8 B12 | Decided in spike B: `collapsed` flag, render override, hit-test guard, filtered selection and exports |
| should | SVG export | §2.10.4 | Export-only `data:` files map; offline e2e |
| should | Image loading and memory | §2.10.3 | Lobby loader, 6 concurrent, retries, `thumb` default, local derivative keys |
| should | Test harness | §6.2, §6.3 | Harness on the engine core; facade writes through `transact`; convergence property; negative suite; touch flows; conversion corpus |
| should | Parallel waves and ownership | §7.1 | Lockfile PR #1 and freezes before any parallel wave; registries as extension points |
| should | Effort | §7.2, §7.3 | ≈223 pd in revision 2 (≈261 pd in revision 3); dependency graph and critical path; re-estimate after spike B; no date before go/no-go |
| should | Accessibility | §4.8 | Five testable deliverables |
| should | Mobile | §4.8, §8 B12 | Touch-emulation flows in the spike; a real device before cut-over |
| should | Restores and epochs | §2.6 | Every restore takes a new epoch and a higher clock; test |
| should | CSP | §2.12 | Shipped at cut-over, rehearsed enforced |
| should | Verification | §5.3 | Semantic diff on 100% of boards; headless render of every board; owner sign-off on lossy counts |
| should | Cut-over deploy order | §7.5 | Maintenance window; sync, convert, web; "Reload" on a tldraw reply; leave guard kept |
| should | Repo rules | §10 | AGENTS.md text spelled out; new synthesis in the cut-over gate |
| should | Checkpoint preview | §4.6, §8 A11 | `exportToCanvas` preview; two instances tried in the spike |
| could | D13 licences | D13, §2.12 | Five MIT packages listed; licence CI asserts `tldraw-import`'s tree |
| could | Fan-out | D14, §2.4.2 | One serialization per batch to everyone; acks carry only server changes |
| could | Cross-workspace paste | §2.10.4 | Cheap version: foreign images removed before creation with a clear toast; the copy route is a backlog item |
| could | 0.18.1 fallback | §2.2 | `peerDependencyRules` and a React 19 runtime check (+0.5 pd); undo no longer needs `next` |
| could | Lint rule | §2.3.1 | Server imports only through `canvas-schema/src/engine/` typed wrappers |
| could | Durability fallback | §2.13, Appendix B | fsync measured; `synchronous=NORMAL` pre-agreed as a rung needing owner acceptance |
| could | Staging key | §7.4 | Hard deadline in the plan |

### Recheck items (revision 3)

| Recheck | Item | Where | What changed in the design |
|---|---|---|---|
| must (not resolved) | Text lease: editor-open paths | §2.9.2, §2.3.3, §2.3.4, §6.5, §8 A16, B3 L2/L9/L11 | All 7 `startTextEditing` and 2 `handleTextWysiwyg` call sites listed. N and T are custom tools, and `autoshape` is never activated. A capture double-tap detector handles touch. An unrequested-open guard sets the editor read-only, buffers keys and pushes nothing until the grant. A probe counts the call sites. |
| must (not resolved) | Text lease: sticky-note auto-fit writes container geometry | §2.9.4, §2.4.2, §2.4.3, §2.5.4, §2.5.5 E7, §3.2, §8 A17, B3 L6/L8/L10 | The container's fit is sent only by the holder, as a conditional `fit` that is dropped after anyone else's `pos`/`shape` write. The holder does not hold its container back and re-fits on the newer geometry. Watchers never re-lay out. |
| must (not resolved) | Irreversible change inside the window: `dr_deleted_*` | §2.4.1, §2.4.6, §2.6, §5.3, §5.4, §5.9, §5.10 | A new `lb_deleted` table. `dr_deleted_*` is never written, trimmed or rebuilt by the new build and is copied at conversion. R0 never writes `lb_*`, and its gate checks byte identity. |
| must (not resolved) | Spike scope, real data, routes, estimate | §8.1, §8.3 B8, §7.2, §7.3, Appendix B 3 and 13 | Every staging board is converted from a read-only R2 restore through the existing drill tool, with privacy rules. The drill runs on the largest staging board. The scope matches B1.2, U2, R2 and B12. Routes A1–A3 are in the spike branch. Spike B is 56 pd and spike A 14 pd, summed per slice in the waves' unit. The calendar is 20 days (26 with buffer). |
| new | Roll-forward assumes stable conversion output | §5.1, §5.9, §6.1 | Record-level diff against an in-file base (`lb_source`). Only touched records are converted, in a local mode with frozen page offsets. Ours changed is detected from `gclock`. Parent moves compose. z-order is merged by relative position. Invariants and index uniqueness run on the result, and untouched elements are byte-identical. |
| new | Final backup before maintenance; stale base on a second cycle | §5.6, §5.9 step 3h, §7.5 steps 3–4, §5.10 | R0 gets a maintenance mode and `backups/run-all`. The backup is taken after maintenance is on and cross-checked against `lb_source`. The base is replaced on every roll-forward. |
| new | Boards born after the cut-over | §5.9 step 4, §5.10, §5.3 | R0 refuses them before opening a room, with a message and without creating tldraw tables. Roll-forward serves them unchanged. Boards born on R0 are converted lazily. |
| new | `dr_deleted_*` shared-table conversion | as the must above | as the must above |
| new | Viewer presence silent under `interaction` | §2.3.2, §2.7, §6.3, §8 A4, B5 R1 | Lobby's own capture pointer listener, for every role |
| new | Undo recorded against `confirmed`; fixes not folded in; Ctrl+Z in the editor | §2.8, §2.3.3, §8 A15, A17, B2 U9/U10 | `lastLocal` snapshot per step. Ack `fix` values fold into `after`. Fixes and repairs never create a step. Ctrl+Z/Y stay native inside the textarea. |
| new | Lease bypass paths and container writes | as the two lease musts above | as above |
| new | Ctrl+A delegated despite the mind-map rule | §2.3.3, §4.7, §8 B12 | Ctrl+A is Lobby-owned; box and lasso selections are post-filtered |
| new | Remote-drag hit test not stated | §2.7, §4.3, Appendix B 2 | Stated deviation, with a pointerdown guard on the old spot |
| new | Conversion worker without limits or a concurrency cap | §5.3, §2.13, §6.2, §8 B9 | `resourceLimits`, one job process-wide, a runtime RSS gate, and termination of the worker on OOM without the process |
| new | Estimate units inconsistent; real data first at the rehearsal | §7.2, §7.3, §8.1, §8.2 | One unit throughout; the spikes are re-estimated; real staging data is converted in spike B |
