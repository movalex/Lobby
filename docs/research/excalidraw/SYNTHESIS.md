# Excalidraw era: verified engine facts (implementation reference)

Date: 2026-09-30, on `engine/w4-prep` (from `engine/excalidraw` 1a85d5c). Engine: **`@excalidraw/excalidraw`,
`element`, `common`, `math` and `fractional-indexing` 0.18.0-1118751** (the npm `next` snapshot, pinned in
the pnpm catalog), with Lobby's own element sync (`apps/sync` ElementRoom) on Node 24.19.0.

This file collects what spike A, spike B, waves 2-3 (and the wave-5 owners' reports) and the engine probe
suite established about the engine and Lobby's sync, with the evidence for each fact. It replaces
`docs/research/SYNTHESIS.md` as the reference once the cut-over lands (plan §10); that file stays as the
tldraw era's history. Finishing this file is part of the cut-over gate (plan §10); the open items in §19
are what is left.

**Statuses** (as the evidence gives them, never upgraded):
- **VERIFIED n/n**: measured or asserted by a run, with the number of runs where the evidence states it
  ("3/3" = three runs back to back, each passing). **VERIFIED (probe)**: asserted by the standing engine
  probe suite (`apps/web/test/engine-probe/`, part of `pnpm test`).
- **PARTIAL**, **FAIL**: as the check's own file says.
- **OPEN**: a known defect or a decision not yet made.
- **UNVERIFIED**: read in code, derived, estimated or not run. **UNVERIFIED (code)** = a dist line read,
  no run.

**Where the numbers come from.** Every measurement in spike A and spike B ran on one shared Windows 11
workstation (Threadripper, 64 threads, RTX 5090; headless Chromium shell 153; Node 24.19.0), never in a
quiet window (`spike-b/CONTRACTS.md:216`, `spike-b/M3-part3.md:29`). **Nothing ran on the NAS or on
Render**: B9's NAS half (0.5 CPU / 512 MB) was never run (`spike-b/B9.md:4`). Treat every timing as
informational for staging.

**Dist line shorthand** (all `0.18.0-1118751`, `dist/dev`; `SPIKE-A-REPORT.md:324-326`): **X** =
`@excalidraw/excalidraw/dist/dev/index.js`, **F** = `…/excalidraw/dist/dev/chunk-FN755BR4.js`, **E** =
`@excalidraw/element/dist/dev/index.js`, **C** = `@excalidraw/common/dist/dev/index.js`. Paths below are
relative to `docs/research/excalidraw/` unless they start with `apps/`, `packages/`, `docs/` or `e2e/`.

---

## 1. Engine, packages and pins

| # | Fact | Status | Evidence |
|---|---|---|---|
| ENG-1 | All five `@excalidraw/*` packages are pinned to 0.18.0-1118751 through the catalog, and a probe fails on any other installed version | VERIFIED (probe) | `pnpm-workspace.yaml` catalog; `apps/web/test/engine-probe/editor-open-paths.test.ts:23-26` |
| ENG-2 | The bundle's own version string is `0.18.0`, not the nightly, so the font fallback URL names `@excalidraw/excalidraw@0.18.0` | VERIFIED (request seen) | `spike-a/SCAFFOLD.md` finding 1; F 1277 |
| ENG-3 | `index.css` is exported only under the `development` and `production` conditions; `package.json` is not exported; `dist/dev/fonts` and `dist/prod/fonts` are byte-identical | VERIFIED (`diff -rq`) | `spike-a/SCAFFOLD.md` finding 7 |
| ENG-4 | The `ui` prop is marked WIP in the types; every host prop Lobby passes was checked by name against `types.d.ts` | VERIFIED (smoke 3/3); the list is code-read | `spike-a/SCAFFOLD.md:21-37`, `spike-a/A5.md:82-84` |
| ENG-5 | Two `<Excalidraw>` instances on one page share state (the jotai store X 398/52656/43965, one `throttleRAF` F 3786-3790 that `destroy()` cancels for both; instance A missed 10 of 20 repaints), so two instances are not viable | VERIFIED 3/3 (recorded); shared i18n UNVERIFIED (code) | `spike-a/A11.md:56-84` |
| ENG-6 | `onExcalidrawAPI` fires before the editor is initialised (X 49154); `onInitialize` after the first scene (X 49441) | UNVERIFIED (code), used in smoke 3/3 | `spike-a/SCAFFOLD.md:134-142` |
| ENG-7 | Only `apps/web/src/canvas/**`, the probe suite and `packages/canvas-schema/src/engine/**` (and listed tests) may import `@excalidraw/*`; ported feature code may import neither engine | enforced by Biome `noRestrictedImports` | `biome.json` |

## 2. `@excalidraw/element` on the server (Node)

| # | Fact | Status | Evidence |
|---|---|---|---|
| NODE-1 | The element package's default build runs `newStickyNoteElement`, `newTextElement` and `getStickyNoteLayout` in plain Node once Lobby's text-metrics provider is installed | VERIFIED 3/3 (A3), 23/23 ×3 (A16-static), probe | `spike-a/A3.md:12-16`, `spike-a/A16-static.md:52`, `node-probes.test.ts:60-70` |
| NODE-2 | Without a metrics provider, `newTextElement` throws `ReferenceError: document is not defined` (E 5731-5735); the sync server must install the provider at start-up | VERIFIED (probe) | `spike-a/A3.md:101-103`, `node-probes.test.ts:60` |
| NODE-3 | `Scene` cannot run on the server: it throws `window is not defined` in plain Node (E 18949), and its lodash throttle keeps the process alive 60 s. Use pure functions only | VERIFIED (probe) | `spike-a/A8.md:73-78`, `node-probes.test.ts:255-257` |
| NODE-4 | Server layout matches Windows Chromium only with measured pair kerning: 0/208 labels differ in line breaks (criterion ≤ 3), 0 px note-height difference, 7.21 px max label-width difference; a plain per-character table gives 6/208 | VERIFIED 3/3 | `spike-a/A3.md:52-75` |
| NODE-5 | The metrics table (`packages/canvas-schema/src/engine/text-metrics-table.json`, 95 KB) covers families 5 (Excalifont), 6 (Nunito) and 8 (Comic Shanns); one table at 100 px suffices (linear within 1.4e-6) | VERIFIED (calibrated) | `spike-a/A3.md:77-97`; `apps/web/test/engine-probe/browser/calibrate.ts:55-59` |
| NODE-6 | The table reproduces Windows Chromium only; macOS/iOS fallback fonts for CJK and emoji were not measured, and it must be re-calibrated on every engine or font bump | UNVERIFIED for other platforms | `spike-a/A3.md:123-129` |
| NODE-7 | Browser and Node layout agree within 0.1 px on every template | VERIFIED 3/3 | `wave2/2D.md` §1.1, §3 |
| NODE-8 | The element constructor logs "New element size or position is too large" above ±1e6 (E 16334-16343), while the wire allows ±1e7; templates keep within ±900,000 | VERIFIED (probe) | `node-probes.test.ts:198-205`; `wave2/2D.md` §1.1 |

## 3. Text: the editor, its open paths and the lease

| # | Fact | Status | Evidence |
|---|---|---|---|
| TXT-1 | The bundle has exactly 7 `startTextEditing` call sites (X 27824, 44176, 44864, 46350, 46374, 51313, 51681) and 2 `handleTextWysiwyg` call sites (X 44685, 51250), in both dev and prod; the probe fails on any other count | VERIFIED (probe) | `editor-open-paths.test.ts:43-78`; `spike-a/A16-static.md:25-46` |
| TXT-2 | A double-click on a note's label opens the editor on the second pointer-up (X 51679-51686) before `dblclick` fires, with all text selected (X 25613-25614), so only the guard can catch it | VERIFIED 20/20, 3 runs | `spike-a/A16.md:263-272` |
| TXT-3 | A plain double-click on a simple arrow edits its label (a lease path); only a line, or Ctrl/Cmd+double-click on an arrow, toggles the linear editor (X 44741-44744); elbow arrows go to segment editing (X 44746) | VERIFIED 20/20; elbow UNVERIFIED (code) | `spike-a/A16.md:273-278` |
| TXT-4 | A touch double-tap is always a text path (`onTouchStart` deselects first, X 43506-43516); Excalidraw calls `preventDefault` on iOS only | VERIFIED (touch emulation) | `spike-a/A16.md:405-418` |
| TXT-5 | The editor's value is copied once from the label (X 25247) and never refreshed; this was the root of spike A's high-severity lease breaks L1/L2 | VERIFIED (verifier) | `SPIKE-A-REPORT.md:41,434-435`; `spike-b/OPEN-FROM-SPIKE-A.md:7-31` |
| TXT-6 | Spike A's lease breaks L1-L4 are fixed: all 9 cases failed 0/3 before `7ea91e2`; after the fix (and a re-fix of L2 p5) 9 × 20/20 | VERIFIED 3/3 | `spike-b/L12-verifier-l.md:17-21,41-43` |
| TXT-7 | The lease: L2, L3, L4 (max 36-38 ms), L7, L9 (160/160), L11, L12, L13 pass; L1 ("A is typing" within 300 ms p95, measured 22-80 ms) and L5 are smoke only | VERIFIED 3/3; L1, L5 PARTIAL | `spike-b/B3.md:77-91`; `spike-b/M3.md:106,110` |
| TXT-8 | L6/L10 (the races) reached 580/580 rows ×3 in part 3, after raising the runner's heap to 16 GB; still awaiting a quiet window | PARTIAL | `spike-b/B3.md:93-99`; `spike-b/O2-part3.md:210,218-226` |
| TXT-9 | Forged writes to a leased note are refused (LEASED ×3 plus `fitDropped`, 20/20); a lease escape through the bind group (verifier V2, high) is fixed in `486a08e` | VERIFIED 3/3 | `spike-b/B3-L8.md:10,19-23`; `spike-b/M3-fixes.md:52` |
| TXT-10 | The lease TTL is 10 s (`LEASE_TTL_MS`); a session holds at most 4 live leases | VERIFIED (L7: expired 9.9 s after the cut) | `spike-b/O1-room.md:313`; `spike-b/B3.md:134`; `spike-b/M3-fixes.md:59` |
| TXT-11 | An open editor survives `updateScene(NEVER)`: after a remote move the textarea moved exactly (120, 40) px and kept caret and text; the editor follows `scene.onUpdate` (dev line 25600) | VERIFIED 3/3, 20/20; probe | `spike-a/A17.md:66,110-112`; `node-probes.test.ts:218` |
| TXT-12 | Ctrl+Z/Ctrl+Y inside the textarea are the browser's native undo; Lobby's undo ran 0 times (X 44005-44011) | VERIFIED 3/3 | `spike-a/A17.md:113-116` |
| TXT-13 | Opening the editor writes the label (`updateElement`, X 49918); on a cold open `x` and `width` were rewritten with a version bump, cause unknown | write VERIFIED; cause UNVERIFIED | `spike-a/A16.md:247-254,279-290` |
| TXT-14 | Excalidraw's own paste writes the textarea by script (X 25303-25320), so `readOnly` does not stop it; its container prevents every drop (X 43022, 49404-49416) | VERIFIED (control) | `spike-a/A16.md:241` |
| TXT-15 | A synthetic Enter must follow a `flushSync` of the selection: `updateScene({appState})` only schedules a React update (X 43825-43851); 217 keys per run typed, 164-165 buffered and replayed in order | VERIFIED 3/3, 20/20 | `spike-a/A2.md:57-77` |
| TXT-16 | Keys with `keyCode` 229 (Android soft keyboards, IME "Process") cannot be buffered; "no key lost" covers desktop keydown only | UNVERIFIED on a real device | plan "Open items" (minor), from spike A's verifier [verify-A] |

## 4. Keys and the read-only `interaction` config

| # | Fact | Status | Evidence |
|---|---|---|---|
| KEY-1 | Inside the editor, the textarea's keydown runs zoom, font size, save (Ctrl/Cmd+S through `executeAction`, which skips predicates, X 23095-23106; the key test ignores Alt, X 11606), indent and submit; a 658-chord sweep flagged 637 presses per platform on the old code | VERIFIED | `spike-a/A6.md:119-156` |
| KEY-2 | Outside the editor, with no allowlist, 54 of 70 probed keys act; Tab sets a hidden jotai atom (X 43960-43977) and the next Shift+Tab converts the shape in place | VERIFIED 3/3 | `spike-a/A6.md:310-347` |
| KEY-3 | Spike A's key breaks K1-K5 (a page keyup re-binding arrows, numpad Ctrl+Insert, BÉPO/KOY Ctrl+Z, key/code mismatches) are fixed: K1 60/60, K2-K4 20/20, K5 60/60 | VERIFIED 3/3; keyboard layouts emulated, real layouts UNVERIFIED | `spike-b/L13-verifier-k.md:42-49` |
| KEY-4 | Excalidraw's `mutateElement` treats object values as always changed, so every arrow keyup bumped the arrow's version (why K1 mattered) | VERIFIED 3/3 (verifier) | `spike-b/OPEN-FROM-SPIKE-A.md:37-39` |
| KEY-5 | Read-only roles get `interaction = { enabled: { navigation: true, links: true, tools: { custom: true } } }`; pan, zoom, links and custom tools work | VERIFIED 3/3 | `spike-a/A4.md:72-76` |
| KEY-6 | Under `interaction`, `setActiveTool` refuses every tool but laser and custom, the selection tool included (X 44343-44350), so Lobby sets the tool through `appState.activeTool` | VERIFIED 3/3 | `spike-a/A4.md:85-93` |
| KEY-7 | `onPointerUpdate` stays silent for read-only roles with no tool (`savePointer` X 47780-47801): 0 calls against 11; Lobby's own listener got 15-16 Hz | VERIFIED 3/3; probe | `spike-a/A4.md:80-84`; `node-probes.test.ts:222` |
| KEY-8 | `ui={false}` hides every engine control (33 selectors in 6 states, 0 visible); an empty `SVGLayer` and the layer-UI wrapper stay mounted | VERIFIED 3/3 | `spike-a/A5.md:65-78` |
| KEY-9 | Read-only editors get no Excalidraw clipboard and no drop guard (`addEventListeners` returns at X 49327) | VERIFIED 3/3 | `spike-a/A4.md:98-106` |
| KEY-10 | Excalidraw's file I/O uses browser-fs-access, which picks the File System Access API, so Playwright's download events stay at 0: tests count `showSaveFilePicker` calls | VERIFIED (harness self-test) | `spike-a/SCAFFOLD.md` finding 8 |
| KEY-11 | R3 (keys, pickers, print, drop, copy for 4 roles): 12/12; it found editors could not copy or paste with the keyboard (fixed `c48e35c`) | VERIFIED 3/3 | `spike-b/B5-R3.md:21-35` |
| KEY-12 | PgUp/PgDn have no Lobby handler and are blocked for read-only roles | OPEN | `spike-a/A4.md:110-112` |

## 5. Undo and `captureUpdate`

| # | Fact | Status | Evidence |
|---|---|---|---|
| UNDO-1 | `CaptureUpdateAction` has `IMMEDIATELY`, `NEVER` and `EVENTUALLY` | VERIFIED (probe) | `node-probes.test.ts:97-103` |
| UNDO-2 | Excalidraw's own `ElementsDelta` loses another user's +1 and outer group on undo (probe2); Lobby's field-level undo passes every §2.8 case, `record()` 5.1-5.3 ms at 20,000 elements | VERIFIED 3/3 (31/31) | `spike-a/A15.md:19-29` |
| UNDO-3 | Spike B's undo: U1-U11 11/11, U12 (recolour during a drag) 12/12; Excalidraw mutates scene elements in place, so the adapter hands the scene clones only (`041f6f3`) | VERIFIED 3/3 | `spike-b/B2.md:7,19-23,54-56`; `spike-b/O2-part3.md:202-203` |
| UNDO-4 | Verifier V1's three undo defects are fixed (fixer 20/20 ×3); V1's own re-check is pending | VERIFIED by the fixer; re-check pending | `spike-b/M3-fixes.md:39,42,46,133` |
| UNDO-5 | Redo of Ctrl+G in a long sequence, and redo reviving an element someone else deleted | OPEN | `spike-b/M3-fixes.md:135`; `spike-a/A15.md:71-95` |
| UNDO-6 | No probe shows that `NEVER` keeps remote edits off Excalidraw's own stack, or that `registerAction` replaces undo | UNVERIFIED (missing probes) | `SPIKE-A-REPORT.md:633-637`; plan §6.5 status |

## 6. Fractional indices and echo

| # | Fact | Status | Evidence |
|---|---|---|---|
| IDX-1 | `updateScene` re-keys the later of two colliding elements in place and bumps its version (`syncInvalidIndices`, E 12728): Bob's confirmed `c2` went a1 → a1V, v3 → v4, an echo | VERIFIED 3/3 (Node and browser) | `spike-a/A8.md:24-41` |
| IDX-2 | Label-after-container order is not enforced in the npm builds: the check runs only in dev/test or with `window.DEBUG_FRACTIONAL_INDICES` (E 18947-18958), and even then logs instead of throwing | VERIFIED (probe) | `spike-a/A8.md:62-72`; `node-probes.test.ts:231-267` |
| IDX-3 | Lobby's pre-pass re-keys only its own unacknowledged elements (600 random scenes; 50 + 50 concurrent creates gave 101 unique keys; 14.7-15.2 ms at 20,020 elements) | VERIFIED 3/3 (13/13); single browser run on the branch | `spike-a/A8.md:24-60,87-89`; `WAVE-2.md` §3 |
| IDX-4 | B10: two browsers each create 50 notes at the same top key, a third pushes 0; 101 unique keys | spec VERIFIED 3/3; aggregate PARTIAL | `spike-b/B10.md:3-6,42-56` |
| IDX-5 | Receive-only clients push nothing: B1's receive-only browsers wrote 120 push logs and 0 ops | VERIFIED | `spike-b/B1.md:122-124` |

## 7. Sticky notes, `created` and duplicates

| # | Fact | Status | Evidence |
|---|---|---|---|
| NOTE-1 | `created: null` hides the note's date footer (`getStickyNoteDateLabel`, E 6855-6857); the footer is also absent under 75 px wide | VERIFIED 3/3; probe | `spike-a/A1.md:59-66`; `node-probes.test.ts:80-88` |
| NOTE-2 | `duplicateElement` sets `created = updated` on every copy, even from null (E 17932-17939); `onDuplicate`'s result is merged and bumps the version, so Lobby's stamp gives copies `created: null` | VERIFIED 3/3; probe | `spike-a/A1.md:67-74`; `node-probes.test.ts:72-78` |
| NOTE-3 | `created` is excluded from `ElementUpdate` by type only; `newElementWith` still writes it at runtime | VERIFIED (probe) | `node-probes.test.ts:90-95` |
| NOTE-4 | `newTextElement` stamps `created` from the clock (E 16371), so server-made labels pass `created: null` | VERIFIED | `spike-a/A3.md:110-113` |
| NOTE-5 | `convertToExcalidrawElements` regenerates ids and `created` unless `regenerateIds: false` (E 24527-24528), and cannot bind an arrow to a `stickynote` (it throws "reading 'id'") | VERIFIED (throw seen); the line range is cited two ways (E 24382-24441 and 24302-24380) | `spike-a/A17.md:117-121`, `spike-a/A10.md:74-79`, `spike-a/A1.md:75-79` |
| NOTE-6 | Auto-fit while typing replaces the container with `getStickyNoteLayout`'s output (X 49806-49838); `updateScene` runs no re-layout (`relayoutStickyNotes` has one caller, paste styles) | VERIFIED 3/3, 20/20; probe | `spike-a/A17.md:66,75-84`; `node-probes.test.ts:212-216` |
| NOTE-7 | Element sizes: rectangle 350-600 B, a 22-character label < 900 B, note + label < 1,600 B; freedraw with 2,500 rounded points fits 64 KiB, unrounded does not; 1,000 rounded points fit 32 KiB for a line or arrow; 200 `plusOne` keys fit 12 KiB | VERIFIED (probe) | `node-probes.test.ts:121-196`; `spike-a/A16-static.md:63-75` |

## 8. Images and files

| # | Fact | Status | Evidence |
|---|---|---|---|
| IMG-1 | `updateImageCache` writes `status: "error"` as a new element version under `NEVER` (X 47091-47111), so a sync adapter would push it: image `status` must stay local | VERIFIED 3/3 | `spike-a/A7.md:46-48,61-66` |
| IMG-2 | A failed image is never retried in the session (the error stays cached, E 22637-22641; cached ids skipped, X 47113-47118): never hand the engine a file that has not loaded | VERIFIED 3/3 | `spike-a/A7.md:67-74` |
| IMG-3 | Lobby's loader (local-only status, ≤ 6 in flight, visible first) pushes nothing: one image 404 for 7 s then 200, 0 ops | VERIFIED 3/3 | `spike-a/A7.md:44-57` |
| IMG-4 | Every `addFiles` call repaints the whole scene (X 43789-43796); batching per animation frame cut the visible-image delay from 4.9-6.5 s to 0.8-1.8 s | numbers VERIFIED; cause UNVERIFIED | `spike-a/A14.md:106-110` |
| IMG-5 | `addFiles` never replaces an existing id; a revoked blob URL was seen once | observed in wave 3G, not a standing probe; the revoked URL "not explained" | `wave3/3G.md` 2C-3G-1 |
| IMG-6 | B7: the snapshot holds no `data:`, `blob:` or signed URL and every `fileId` is `ver_…`; 200 mood-board images load at fit in 34.0 s, ≤ 6 in flight, 0 foreign requests | PASS 7/7 ×3 after O2's fix (B7.md's own status line still reads FAIL 2/3) | `spike-b/B7.md:159-170`; `spike-b/O2-part3.md:214-215`; `spike-b/M3-part3.md:105` |
| IMG-7 | Lobby's files route requires `?board=<id>` (400 without it); blob URLs are revoked only on `dispose()`, because `exportToCanvas` reloads files | VERIFIED | `spike-a/A7.md:99-105`; `apps/api/src/files/serve.ts:58-63` |
| IMG-8 | SVG cannot be handed over as a `blob:` URL (`addMissingFiles` parses a `data:` URL, X 43806-43818); derivatives by zoom are built but off | UNVERIFIED (code); derivatives OPEN | `spike-a/A7.md:80-82`; `spike-b/B7.md:124-138` |

## 9. Arrows and bindings

| # | Fact | Status | Evidence |
|---|---|---|---|
| ARR-1 | Every keystroke that changes a container's geometry rewrites bound arrows from the holder's copy (`updateBoundElements`, X 49845, 49864-49868; E 9055-9123), for notes and other containers | VERIFIED | `spike-a/A17.md:86-94` |
| ARR-2 | `updateScene` never calls `updateBoundElements`, so bound arrows follow a remote change only when the server's re-snap arrives | UNVERIFIED (code, X 43825-43845) | plan "What changed in revision 3.5" |
| ARR-3 | The server's arrow acceptance tests (from the critics' probes) pass 85/85 from M1 on; the room suites 149/149 ×3 | VERIFIED 3/3 | `spike-b/CONTRACTS.md:189`; `spike-b/B3-L6-L10-server.md:3`; `spike-b/O1-room.md:133-134` |
| ARR-4 | A rotated rough arrow (roughness 1) can exceed the 0.5 px tolerance (0.53 px once in 2,000); self-loops settle within 4 re-snaps | VERIFIED; the tolerance decision OPEN (wave 3) | `spike-b/CONTRACTS.md:285-296` |
| ARR-5 | 0.18's fixed-point binding draws connectors centre to centre (fixed by 3a with outline bindings); arrowheads are about twice tldraw's size and bound connectors stop 4-6 px short | fix VERIFIED; look OPEN (CR-W5-3A-2) | `REVIEW-W5-EARLY.md` W5-11; `WAVE-3.md` §4.1 |
| ARR-6 | Bound connectors follow a remote drag only when it ends | OPEN (fix on `engine/w5-2c` 594cc4d, not merged) | `REVIEW-W5-EARLY.md` W5-08 |

## 10. Sync: convergence, durability, Saved, server enforcement

| # | Fact | Status | Evidence |
|---|---|---|---|
| SYNC-1 | B1 (concurrent edits to different fields of one note): 4 cases 20/20 each | smoke 3/3; PARTIAL (timing-gated, no quiet window) | `spike-b/B1.md:3-7,116-124` |
| SYNC-2 | B11 (3 browsers + 50 headless clients, 10 min, socket cuts, a SIGKILL): all 53 maps hash equal, 0 invariant violations, 0 acked-but-missing | VERIFIED 3/3 at `eb0970b` | `spike-b/B11.md:3,102-117` |
| SYNC-3 | B11's first pass and the lead's M1/M2 run were void (every headless op threw); fixed in `03df2c1` | recorded | `spike-b/B11.md:5-7,72-83` |
| SYNC-4 | At `017f76d` one B11 run had browser A showing Saved with one note differing from the server (index, version, versionNonce); not reproduced, not explained | OPEN | `spike-b/B11.md:85-100` |
| SYNC-5 | Hash convergence cannot detect an edit lost before it was pushed | limitation | `spike-b/B11.md:119-121` |
| SYNC-6 | D1 "Saved" exactly: the last "saved" 1-2 ms after the last ack | VERIFIED 3/3 | `spike-b/B4-client.md:95-96` |
| SYNC-7 | D2 (SIGKILL during edits, about 3.5 s down) and D3 (9 SIGKILLs during 64-push group commits): 0 missing; acked = stored (e.g. 774/774). D3 shows "acked ⇒ on disk" only; acks go after COMMIT with `synchronous=FULL` | VERIFIED 3/3 | `spike-b/B4-client.md:97`; `spike-b/B4-D3.md:21-44` |
| SYNC-8 | D4 (an injected COMMIT failure): pushes answered UNAVAILABLE, sessions closed 4000 RECONNECT, "saved" only after the store | VERIFIED 3/3 | `spike-b/B4-D4.md:9,17-31` |
| SYNC-9 | D5 (60 s offline, 128 edits replayed once each), D6 (8 queued edits adopted by another tab), D7 (reload) | VERIFIED 3/3 | `spike-b/B4-client.md:98-99`; `spike-b/O2-part3.md:212` |
| SYNC-10 | M3's data-loss blocker (a local edit overtaken by a server frame, lost while Saved) is fixed (`syncLive`): 0 of 400 creates and 0 of 40 edits lost | VERIFIED 3/3 | `spike-b/O2-part3.md:14,215-216` |
| SYNC-11 | V1's high findings N3 (a lost-ack replay overwrote another user or revived a delete) and N17 (STALE never fired after 10 min) are fixed | VERIFIED 20/20 ×3 | `spike-b/M3-fixes.md:36-37` |
| SYNC-12 | Read-only enforced on the server: a viewer's forged ops get READ_ONLY, its socket stays open, the snapshot is unchanged; a downgrade reconnects read-only; revocation closes 4099 FORBIDDEN | VERIFIED 3/3 (R1 functional, R4); R1's 200 ms presence gate never asserted (PARTIAL) | `spike-b/B5-R1.md:13,27-34`; `spike-b/B5-R4.md:9,20-33` |
| SYNC-13 | B6's forged writes F1-F17 (15 tests) are refused; the op budget applies about 2,000 ops, then RATE | VERIFIED 3/3 | `spike-b/B6.md:9,17-21,55-59` |
| SYNC-14 | V2's hello flood is fixed: acks went from 8-9 s during the flood to p50 3-6 ms; more than 5 hellos in 10 s closes 4099 RATE_LIMITED | VERIFIED | `spike-b/M3-fixes.md:54-61` |
| SYNC-15 | The room caches its reset snapshot 5 s, so a join within 5 s of a board-document write gets the old `lb_doc` | VERIFIED; the stale `lb_doc` OPEN (DEF-3F-1) | `spike-b/O1-room.md:330-331`; `WAVE-3.md` §8.4 |
| SYNC-16 | Room parameters: drain ≤ 64 pushes or about 8 ms; a 64 MiB outbound budget; ≤ 40 cursors per recipient; drags ≤ 500 ids; a STALE ledger of 200,000 clocks | design values, as built | `spike-b/O1-room.md:254-262,328-329` |
| SYNC-17 | Every role, guests included, receives the full text and authors of deleted notes | OPEN, a cut-over blocker (fix on `engine/w5-2a` c96cc5f) | `REVIEW-W5-EARLY.md` W5-02 |
| SYNC-18 | Close codes: `PREPARING` (rev 4), 4099 `CONVERSION_FAILED`, 4099 `NEW_CANVAS_BOARD`, `MAINTENANCE`, 4000 RECONNECT, 4099 FORBIDDEN / RATE_LIMITED / INVALID_MESSAGE; `CONTRACTS_REV` 6 | as built | `spike-b/CONTRACTS.md:44,369-378` |

## 11. Conversion, rollback and roll-forward

| # | Fact | Status | Evidence |
|---|---|---|---|
| CONV-1 | Corpus: 11 generated boards (tour, multi-page, heavy 4,922 records, 8 fixtures) and 4 staging copies restored from R2 (41, 64, 4 and 33 records); heavy 4,922 records → 9,220 elements | VERIFIED 3/3 | `spike-b/B8.md:284-289,317-320,359-370` |
| CONV-2 | The semantic diff (shape map, plain text, assets, anchors, frames, bounds: notes 2 px, others 1%, limits, local mode): 0 failed on every board | VERIFIED 3/3 (phases 1, 2) | `spike-b/B8.md:291-300,502-512` |
| CONV-3 | `lb_source`'s digest equals the input's `recordsSha256`, and for staging the restored backup object's; tldraw tables and `dr_deleted_*` stay byte-identical | VERIFIED 3/3 | `spike-b/B8.md:302-313,504` |
| CONV-4 | The invariant checker finds 0 violations on all 15 boards | VERIFIED 3/3 (phase 2; not run in phase 1) | `spike-b/B8.md:513,542-546` |
| CONV-5 | `restoreElements` fixed point: 10,024 generated elements, 0 dropped or added, max change 0.0931 px; staging 158 elements, max 0.0003 px | VERIFIED 3/3 "with the deviation" (label widths re-measured by Chromium) | `spike-b/B8.md:329-337,436-445` |
| CONV-6 | Lossy codes seen: tour rich-text-formatting 21 and serif-font 1; multi-page page-flattened 2; the kitchen sink 8 kinds; one staging board geo-polygon 1, the others none | VERIFIED | `spike-b/B8.md:284-289,317-320,540-541` |
| CONV-7 | Conversion time per board: staging 268-314 ms (separate process, with local-mode verification) and 27-59 ms on room open; heavy 2.0-2.4 s and 1.2-1.3 s | VERIFIED (workstation) | `spike-b/B8.md:116-145,284-289,317-320` |
| CONV-8 | Peak worker heap: heavy board 62.7-67.1 MB total (49.7-51.9 MB used), others about 41-45 MB; the runtime cap is 98 MB, and 1.5 × the heavy peak (100.7 MB) is above it ("at its edge"); the heavy board converts with 40 MB of old generation and fails at 32 MB | VERIFIED (workstation); the cap's margin OPEN | `spike-b/B8.md:286,339-346,385-387,396,426-428` |
| CONV-9 | A worker over its cap (4 MB in the test) fails the board (`CONVERSION_FAILED`, status out-of-memory), the file stays byte-identical with no WAL, and the process keeps serving | VERIFIED in each 3-run set | `spike-b/O1-room.md:210-219` |
| CONV-10 | Converted files are 1.76-4.59 × the tldraw file (the doc says 2.3-4.6 ×; heavy 3.0 → 13.9 MB); the 3.5 × + 50 MB disk check can be too small, and B8 recommends 5 × + 50 MB | VERIFIED (byte tables); the check's factor OPEN | `spike-b/B8.md:304,327,419-420,521-524` |
| CONV-11 | The drill through two browsers: 11/11 generated boards (66-69 checks each) and the largest staging copy 69/69; born-after checks 28/28 per drill. Pass items: A's and B's edits both kept (frame-child move +60 with frame move +120), the planted conflict listed with A's value in `lb_prev_<cycle>_elements`, R0 never wrote `lb_*`, cycle 2 merged against the refreshed base, the born-after board refused (4099 `NEW_CANVAS_BOARD`, 7 routes 409 `new-canvas`) and byte-identical | VERIFIED 3/3 (phases 3, 4) | `spike-b/B8.md:150-197,166-181,499` |
| CONV-12 | Roll-forward time: 26-719 ms by report, 1.6-4.6 s wall; the first heavy open after conversion took 35.4 s | VERIFIED (workstation) | `spike-b/B8.md:154-191` |
| CONV-13 | The drill found that a roll-forward could give a shape a tombstone's z-order key (an echo on every open); fixed in `3390b0c` | VERIFIED (V3: high, fixed) | `spike-b/B8.md:27-29,552-560`; `spike-b/M3-fixes.md:68` |
| CONV-14 | The leak check (restored staging text searched in every output) found 0 matches in every phase | VERIFIED | `spike-b/B8.md:49-51`; `spike-b/M3-fixes.md:71` |
| CONV-15 | V3's confirmation of B8's phase 4 is contradictory in the docs ("V3 confirms" against "still to come" / "pending") | UNVERIFIED | `spike-b/B8.md:17,41`; `spike-b/M3-fixes.md:72,133` |
| CONV-16 | If R0 migrated the schema and no stored schema matches its hash, the board stays closed (`base-schema-unknown`); storing the schema text with `lb_source` is deferred to wave 2D | OPEN | `spike-b/B8.md:536-539`; `spike-b/CONTRACTS.md:316,325` |
| CONV-17 | `convertAll()` converts every tldraw board and rolls forward every `rollforward-needed` board, one at a time, with a 256 MB cap; a file is classified read-only first (`missing`, `tldraw`, `converted`, `rollforward-needed`, `element`, `unknown`) | as built | `apps/sync/src/room/migrate/service.ts:1-75,157-166` |
| CONV-18 | `backupOf` is wired nowhere, so a cut-over conversion records no `backupKey` and reports `sourceMatchesBackup: null` | OPEN (runbook G4) | `apps/sync/src/room/migrate/service.ts:112-121`; `docs/EXCALIDRAW-CUTOVER.md` §1 |
| CONV-19 | Rollback exports, `drop-legacy` and a boot-in-maintenance flag are not implemented; maintenance starts off on every start | OPEN (runbook G1, G7, G8) | `apps/sync/src/app.ts:140-144`; `docs/EXCALIDRAW-CUTOVER.md` §1 |
| CONV-20 | A board born on the new canvas cannot be backed up or restored by the spike's room yet (wave 2B) | OPEN | `spike-b/O1-room.md:71-83` |

## 12. Capacity and load

| # | Fact | Status | Evidence |
|---|---|---|---|
| CAP-1 | B9's NAS half (L1, L2, conversion under load, presence modes, fsync, RSS, CPU on 0.5 CPU / 512 MB) was never run; a dry run only printed its 189 commands | NOT RUN | `spike-b/B9.md:4,88-101,170-173` |
| CAP-2 | Workstation half: A→B visibility on the heavy board at 100% p50 1.1-1.5 s and p95 1.5-1.9 s against the 250 ms gate; 1 of 8 to 8 of 30 local edits lost in the diagnostic runs (0 lost in the lead's part-3 run, still p95 1,509 ms) | FAIL | `spike-b/B9.md:5-13,187-192`; `spike-b/M3-part3.md:111` |
| CAP-3 | The server side in the same runs: receive → ack p50 ≤ 5 ms, p95 ≤ 50 ms; group commit ≤ 2 ms p50; headless A→B p50 27 ms, p95 92 ms; event-loop p99 23.8 ms | VERIFIED (workstation, 4 diagnostic runs) | `spike-b/B9.md:13,244-247,297-299` |
| CAP-4 | The client-side cause: `CanvasPort.bounds` scans all 9,220 elements once per image (about 170 ms per change); `updateScene` runs about 18 times a second | VERIFIED (profile); fix OPEN (CR 3b-7, 3b-8) | `spike-b/B9.md:229-285`; `wave3/3B-2.md` §4 |
| CAP-5 | fsync on the workstation's NVMe only: raw 4 KiB p50 0.8 / p99 1.1 ms; SQLite commit (WAL, FULL) p50 0.9 / p99 1.3 ms. Render's and the NAS's disks were not measured | VERIFIED (workstation, "for comparison only"); Render UNVERIFIED | `spike-b/B9.md:167`; plan §2.13 |
| CAP-6 | Bytes per second, RSS, CPU and SIGKILL recovery under the Render-sized limits: never measured; no capacity target of plan §2.13 has passed | NOT RUN | `spike-b/B9.md` |

## 13. Rendering and performance

| # | Fact | Status | Evidence |
|---|---|---|---|
| PERF-1 | Zoom is clamped to [0.1, 30] (`getNormalizedZoom` F 642-644; Excalidraw's own fit F 501), so the heavy board's own fit shows 38% of it; `updateScene` accepts lower zooms | VERIFIED 3/3 | `spike-a/A14.md:83-90` |
| PERF-2 | Same-method fps on the heavy board (fit / 0.25 / 1): Excalidraw true fit 13.9-14.5, 50-54, 60; tldraw fit 17.6-18.2, 54-56, 59; rendering is the bottleneck | VERIFIED 3/3 (workstation); the laptop half UNRUN | `spike-a/A14.md:47-72`; `SPIKE-A-REPORT.md:245,253-261` |
| PERF-3 | The level-of-detail pass (frames as bitmaps below zoom 0.2): fit at 28.2 fps against 9.8 off; zoom 0.25 is "at its edge" (27-32 fps against ≥ 30) | 3 runs, not a quiet window | `wave3/3B-2.md` §3 |
| PERF-4 | Opacity 0 does not skip rendering (7.7 fps at fit against 34 with culling); render offsets cull | VERIFIED (one profiled pan each) | `wave3/3B-2.md` §1, §3 |
| PERF-5 | Spike B's perf status is "NOT MEASURED" (smoke only): heavy open median 991 ms, heavy pan 4-7 fps against ≥ 30 ("cannot pass" until `bounds` is fixed), a 9,000-note board 60 fps | smoke only | `spike-b/PERF.md:3-8,31,55-76` |
| PERF-6 | `updateScene` p50/p95: 3.7/5.7 ms at 5k elements, 21.0/30.8 ms at 20k; remote edit to paint p95 35 / 105 / 123 ms | smoke | `spike-b/PERF.md:61-65` |
| PERF-7 | Render overrides change no document, history or `onChange`; a drag offset moves a note with its label; hit tests stay at document positions | VERIFIED 3/3 | `spike-a/A10.md:40-73` |
| PERF-8 | Excalidraw rebuilds each element's cache on every zoom change unless `shouldCacheIgnoreZoom` is set; Lobby never sets it | UNVERIFIED (code; CR 3b-9) | `wave3/3B-2.md` §4 |
| PERF-9 | A touch pinch still stops at zoom 0.1 (Lobby's keys, fit, Ctrl+wheel and trackpad go below) | PARTIAL (CR 3b-10) | `WAVE-3.md` §4.2 |

## 14. Fonts, the host rewrite and the CSP

| # | Fact | Status | Evidence |
|---|---|---|---|
| FONT-1 | Every font source ends with an esm.sh fallback (F 1225-1249, 1277), so any local miss goes to a third party | VERIFIED (a real GET seen before blocking) | `spike-a/SCAFFOLD.md:110-123,188-193` |
| FONT-2 | All ~230 font faces are registered at the first render, whatever the scene; only the faces drawn text needs are fetched (27 files) | VERIFIED | `spike-a/A9.md:50-53` |
| FONT-3 | Chrome checks CSP for every FontFace source when the FontFace is constructed: with the host only rewritten, 230 `font-src` violations per board load; with the fallback same-origin, 0 | VERIFIED (probe page and trial runs) | `spike-a/A12.md:133-135,146-153` |
| FONT-4 | Font loading bumps no element version (17 elements, 0 ops); labels are not re-measured after a late font load | VERIFIED 3/3 | `spike-a/A9.md:29-49` |
| FONT-5 | `fontFamily` 10 has no registered faces and 9 (Liberation) is not self-hosted; the server accepts 5, 6 and 8 (and 7, Lilita One, once 2A's allowlist lands) | VERIFIED (console errors); 7 OPEN | `spike-a/A9.md:54-59`; `REVIEW-W5-EARLY.md` W5-16; `wave5/2D.md` §1 |
| FONT-6 | `document.fonts.ready` waits only for faces already requested: `document.fonts.load(sceneFontLoads())` must run before a scene is built | VERIFIED; the request to 3b OPEN | `wave5/2D.md` §3 |
| FONT-7 | The host-rewrite plugin (`apps/web/build/excalidraw-host-rewrite.ts`) covers the engine's whole dependency tree (266 packages), touches only literals, and fails the build on any foreign host left: 2,402 modules, 29 URL hosts rewritten, 0 left; the engine route went from 68 foreign hosts to 41, none from the engine's tree | VERIFIED (build report; 8 node tests ×3) | `spike-a/A12.md:27-93` |
| FONT-8 | A whole-dist host grep cannot pass while tldraw is built (it names 9 of the listed hosts) and would still fail after the cut-over on pdf-lib's `github.com`, react.dev and json-schema.org; the rule is the plugin's check plus per-package attribution | VERIFIED 3/3 | `spike-a/A12.md:58-93` |
| FONT-9 | The CSP, local form, with the inline theme script's hash and zod jitless emulated: **0 violations** in the sign-in and board flows; without them 1-2 per page (the inline script, zod's `new Function` probe in `zod/v4/core/util.js:218-230`) | VERIFIED 3/3 (zod fix emulated, not committed) | `spike-a/A12.md:105-131` |
| FONT-10 | Excalidraw's SVG font inlining needs `unsafe-eval` (Emscripten glue in the subset chunk); with `skipInliningFonts: true`, 0 violations. `'wasm-unsafe-eval'` does not help | VERIFIED | `spike-a/A12.md:154-163` |
| FONT-11 | Today's tldraw board under the same CSP logs 2 `connect-src data:` violations per load (and the inline script and zod), so the CSP ships only with the cut-over and is removed in a rollback | VERIFIED 3/3 (informational) | `spike-a/A12.md:119-123,169-170` |
| FONT-12 | `apps/web/index.html` still has its inline theme script (lines 19-39), and `z.config({ jitless: true })` appears in no code | OPEN (runbook G3) | `apps/web/index.html:19-39` |
| FONT-13 | Clerk's origins: the frontend-API host is inside the publishable key; staging's (from its public `/api/auth/config`, decoded 2026-09-30) is `splendid-flamingo-3744.clerk.accounts.dev`, a development instance. `img.clerk.com` and `clerk-telemetry.com` come from code (Lobby does not pass `telemetry={false}`); `challenges.cloudflare.com` from Clerk's docs. No sign-in has run under the CSP | host decoded; the set UNVERIFIED | `spike-a/A12.md:188-199`; `render.cutover.yaml.patch` |
| FONT-14 | The asset plugin emits `dist/excalidraw-assets/fonts/` (233 files, 14 MB, without Liberation) and its dev and preview servers answer 404 for misses, but only when `VITE_LOBBY_ENGINE=excalidraw` **and** dev auth are on; the production build ships no engine yet | as built; OPEN (runbook G2) | `apps/web/build/excalidraw-assets.ts:51-53,85-106`; `spike-a/SCAFFOLD.md:98-106` |
| FONT-15 | How Render's static site answers a rewrite of `/excalidraw-assets/*` to a missing path (it must be 404) | UNVERIFIED (runbook P6) | plan §2.12 |
| FONT-16 | The normal (tldraw) build carries none of 64 engine markers and no `excalidraw-assets/`; an engine-flag build without the dev-auth guard carries none either | VERIFIED (each gate) | `WAVE-3.md` §8.3; `spike-b/CONTRACTS.md:97,399-400` |

## 15. Bundle

| # | Fact | Status | Evidence |
|---|---|---|---|
| BUN-1 | Gzip JS + CSS: today's tldraw board route 1,086.2 KiB; spike A's engine route 1,306.9 KiB (with tldraw still in the shell); spike B's 1,387.8-1,390.5 KiB | VERIFIED 3/3 (reported, no gate) | `spike-a/A13.md:31-41`; `spike-b/PERF.md:54` |
| BUN-2 | Today's app shell is 652.3 KiB, of which 471.7 KiB is tldraw; the projected engine route after the cut-over is about 1,065 KiB | shell VERIFIED; projection UNVERIFIED | `spike-a/A13.md:58-79` |
| BUN-3 | Rolldown hoists mermaid, d3 and marked (about 120 KiB gzip) into the engine route's eager chunks; the largest packages are `@excalidraw/excalidraw` 290.7, mermaid 98.7, `@excalidraw/element` 85.8 KiB | VERIFIED | `spike-a/A13.md:51-75` |

## 16. Export

| # | Fact | Status | Evidence |
|---|---|---|---|
| EXP-1 | `exportToCanvas` ignores the camera and exports the root elements' bounds (F 4592-4668); the heavy board's overview takes 269-274 ms, capped at 16.7 Mpx | VERIFIED 3/3 | `spike-a/A11.md:28-54` |
| EXP-2 | Exports use `exportToSvg`/`exportToCanvas` with Lobby's own `@font-face` and `skipInliningFonts`; the heavy board's largest frame: SVG 378,561 B in 40 ms, PNG 2× 5.6 MB in 263 ms | VERIFIED (one run) | `wave3/3E.md` "Measurement" |
| EXP-3 | Frame names add height above frames in a whole-board PNG; notes in PNG, PDF and copy keep the engine's hard shadow (SVG fixed) | OPEN (CR 3E-6, 3E-7) | `wave3/3E.md`; `REVIEW-W5-EARLY.md` W5-37 |

## 17. Theme and look

| # | Fact | Status | Evidence |
|---|---|---|---|
| LOOK-1 | Dark mode is an invert + hue-rotate filter on the canvas (Ember `#f1ac4b` paints `#874c00`; a red note's ink 3.55:1); frame names `#9f9f9f` are 2.65:1 | VERIFIED (pixels); OPEN (2C; 5 `a11y-contrast` tests are `test.fail`) | `REVIEW-W5-EARLY.md` W5-10, W5-15 |
| LOOK-2 | Excalidraw text has no weight and only Nunito 400 loads: no bold. Decision D3: no new fonts; headings in Lilita One (fontFamily 7) | decided | `REVIEW-W5-EARLY.md` W5-16, §9 |
| LOOK-3 | New rectangles get large rounded corners by default (`currentItemRoundness`); a "Straight" connector pick stays curved | OPEN (W5-52, CR-W5-3A-1) | `REVIEW-W5-EARLY.md` W5-52; `WAVE-3.md` §6 |

## 18. Licences

| # | Fact | Status | Evidence |
|---|---|---|---|
| LIC-1 | `scripts/licence-check.mjs` reads pnpm 10.34.5's own listing (`pnpm licenses list --prod --json`, once per workspace package, because the listing does not follow workspace links) for the production trees of api, sync, web and worker: 97, 22, 430 and 20 packages | VERIFIED (run 2026-09-30) | `scripts/licence-check.mjs` |
| LIC-2 | Strict mode fails on 12 findings, all tldraw: 7 packages outside the five MIT ones (`tldraw`, `@tldraw/editor`, `sync`, `sync-core`, `assets`, `driver`, all "SEE LICENSE IN LICENSE.md", plus the MIT `@tldraw/state-react`), and the five MIT ones reached from `board-ops`, `canvas-schema`, `sync`, `templates` and `web` instead of only `packages/tldraw-import` (D13). With `--before-cutover` they are "removed at cut-over" and the check passes | VERIFIED (run 2026-09-30) | `scripts/licence-check.mjs` |
| LIC-3 | No other copyleft or paid licence in the four trees. Two allowlisted: `khroma` 2.1.0 (no licence field; its licence file is MIT, pinned by hash; via mermaid ← Excalidraw) and sharp's libvips binaries (LGPL-3.0-or-later; worker only, unmodified and dynamically linked, never conveyed); `dompurify` passes under its `(MPL-2.0 OR Apache-2.0)` dual licence; `@excalidraw/fractional-indexing` is CC0-1.0 | VERIFIED (run 2026-09-30, Windows; CI checks the Linux binaries) | `scripts/licence-check.mjs` |

## 19. What is still open or unverified (the synthesis is finished when these are closed or accepted)

- **Capacity:** B9's NAS half never ran (CAP-1, CAP-6); B9's visibility FAILS (CAP-2); fsync on Render
  is unknown (CAP-5). Plan §2.13's targets have no measurement.
- **Correctness:** B11's one divergence (SYNC-4); redo defects (UNDO-5); deleted notes' text to every
  role (SYNC-17); the stale `lb_doc` on a join (SYNC-15); V1's undo re-check and V3's B8 confirmation
  pending (UNDO-4, CONV-15).
- **Partial checks without a quiet window:** B1, L1, L5, L6/L10, R1's presence gate, B10's aggregate.
- **Missing probes (plan §6.5):** `NEVER` keeping remote edits off Excalidraw's stack, `registerAction`
  replacing undo, `addFiles` keeping the first entry, embeddable z-order (UNDO-6, IMG-5).
- **Platforms:** macOS/iOS text metrics (NODE-6); real keyboard layouts (KEY-3); a real iPhone/iPad;
  Android soft keyboards (TXT-16); the laptop half of A14 (PERF-2).
- **The cut-over's own items:** `docs/EXCALIDRAW-CUTOVER.md` §1 (G1-G11): boot maintenance, the
  production engine build, the inline script and zod jitless, the final-backup digest, the
  `engine_migration` checkpoint, R0's row contracts, the rollback export, drop-legacy, lockfile PR #2;
  Render's 404 rule (FONT-15); Clerk's origins (FONT-13).
- **Conversion margins:** the heavy board's heap against the runtime cap (CONV-8); the disk factor
  (CONV-10); the schema text with `lb_source` (CONV-16); element-board backups (CONV-20).

## 20. The engine probe suite (`apps/web/test/engine-probe/`)

- **Wiring.** The vitest project `engine-probe` (`vitest.config.ts:54-61`) runs `**/*.test.ts` there, so
  `pnpm test` and CI's test step run the Node half. The browser runners (`a3/run.ts`, `a8/run-browser.ts`)
  and the calibration (`a3/calibrate-table.ts`) are in no script and no CI step. `engine-probe/tsconfig.json`
  is not in `pnpm -r typecheck` (run by hand at each gate). CI has never run (`.github/workflows/ci.yml`).
- **`editor-open-paths.test.ts`** (5 tests): the five packages at the pinned version; the mismatch
  detector works; 7 `startTextEditing` and 2 `handleTextWysiwyg` calls in dev and prod at the pinned lines.
- **`node-probes.test.ts`** (18 tests): no metrics provider → `ReferenceError`; `duplicateElement`'s
  `created`; the note footer; `newElementWith` writes `created`; `CaptureUpdateAction`'s three values;
  element sizes against the limits; the ±1e6 log; `relayoutStickyNotes` has one caller; the editor follows
  `scene.onUpdate`; `savePointer`'s early return; `isDevEnv` false in the npm builds and the index check's
  gate; `Scene` needs `window`; label-before-container is accepted silently.
- **`a3/`**: the 208-label layout corpus, Node against headless Chromium (≤ 3 differing line breaks, 0
  foreign requests), 3 runs by default. **`a8/`**: the index-collision echo with and without Lobby's
  pre-pass. **`browser/`**: the probe page and its server (127.0.0.1 only).
- **Bump rule:** the five `@excalidraw/*` packages move together, in a dedicated PR that runs this suite,
  the browser runners and the full gate (AGENTS.md after the cut-over; staged as
  `docs/research/excalidraw/AGENTS.next.md`).
