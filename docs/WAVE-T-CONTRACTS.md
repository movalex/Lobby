# Wave T contracts: Storyboards and planning walls

Wave T puts production planning on the canvas: **storyboards** (panels in order with durations, fields and a picture;
script to boards; WS2), the **animatic player and storyboard exports** (PDF sheet, image sequence with timings CSV and
EDL, audio; WS3), **work cards, Kanban and the card table** (WS4) and the **timeline** (WS5), with WS1 owning the room's
rules and the stale-client proofs. The foundation (branch `wave-t/foundation`) lands the shared contracts: the planning
key classes in `packages/canvas-schema`, `CONTRACTS_REV` 14 with its frozen fixture and reader rules, the
`DRAFTROOM_PLANNING` kill switch, the api's `assignee-refs` route, the pending `storyboard` AI action, and the web's
switches, gate, read model, export-overlay registry and Export kind slot. Nothing changes for a user until the
workstreams land:

- every web switch is off (`apps/web/src/features/planning/flags.ts` `PLANNING_FLAGS`), and every planning write needs
  a room that says 14 (`planningOffered`); the six wave T features are registered empty;
- the sync refuses every planning key write: UNAVAILABLE while `DRAFTROOM_PLANNING` is off (render.yaml: off; unset is
  off), INVALID while it is on (`planningPending`, until WS1's rules); seeded content carries no planning key;
- the api answers the `storyboard` AI action 400 BAD_REQUEST with nothing read, reserved or sent (`PENDING_AI_ACTIONS`);
- the wave T palette ids are pending (`PENDING_PALETTE_COMMAND_IDS`).

What does not change: `ELEMENT_SCHEMA_VERSION` (1: no element field is added; `link` and `kind` already exist),
`LOBBY_CLIENT_REV` (3: no bell kind), the message types, codes and the welcome, Postgres (no migration: 0038 stays
free), the worker. Design: the wave T design scout (`scratchpad/wave-t/design.md`), followed except where §8 says why
not.

## 1. Workstreams and file ownership

| Workstream | Owns | Reads (does not edit) |
|---|---|---|
| **WS1 Room and compat** (sync, api internal) | `apps/sync/src/room/custom-data.ts` (the planning rules: replaces `planningPending`), `merge.ts` (the assignee lookup wiring, the audio ref check), `element-room.ts` (only if its frame rule changes), `caches.ts`; `apps/sync/src/assignee-refs.ts` (new: the client of §5, its 60 s per-room cache); `apps/sync/src/room-internal/{seed.ts, restore-elements.ts}` (the seed and restore rules of §3.3); `apps/api/src/features/history/archive-v2.ts`, `apps/api/src/canvas/lobby-elements.ts` (§3.3); `docs/DEPLOY.md` (the rollback, §3.4); the `DRAFTROOM_PLANNING` line of `e2e/tests/support/stack.ts` (on, with render.yaml, when the rules land); tests: `apps/sync/test/negative/planning-keys.test.ts` (new; and it removes what it supersedes from `planning-foundation.test.ts`), `apps/sync/test/element-room/stale-reader-rev13.test.ts`, `rollback-rev13.test.ts` (the real ba1704c after strip-keys), `e2e/excalidraw/t-compat-rev13.spec.ts` (the real 6769e07 web) | canvas-schema, contracts, the fixture |
| **WS2 Storyboard** | `apps/web/src/features/storyboard/**` (strip, chips, insert/delete/reorder, layout and Arrange, create and "Make storyboard from frames", the script parser and dialog, "Break down with AI", "Put panels in review" through `features/review/client.ts`), its export layer `storyboard` (§6.3); `packages/templates/src/pieces/storyboard.ts`, `templates/storyboard.ts`; api `apps/api/src/features/ai/storyboard*.ts` and its lines in `features/ai/index.ts` (removes `storyboard` from `PENDING_AI_ACTIONS`) and `prompt.ts`; `e2e/excalidraw/t1-*.spec.ts` | `features/planning/**`, canvas-schema `planning` |
| **WS3 Animatic and exports** | `apps/web/src/features/storyboard-play/**`, `present-export/storyboard-sheet/**`, `present-export/sequence/**` (store-only ZIP, timings CSV, EDL through `review-viewer/export/exports.ts`), the `slides` source seam in `present-export/ported/presenter.ts`, its Export sections `storyboard-sheet` and `storyboard-sequence` (§6.4); `apps/api/src/files/{mime.ts, upload.ts}` (audio byte checks, `INLINE_MIMES.other`); `e2e/excalidraw/t2-*.spec.ts` | `features/planning/**`, WS2's storyboard model |
| **WS4 Cards, Kanban, table** | `apps/web/src/features/cards/**` (make/unmake, chips, the popover registered through `registerCardPopover`, the assignee picker over `listMembers`), `features/kanban/**`, `features/card-table/**` (panel, CSV out and in, Export section `card-table-csv`), export layers `cards` and `kanban`; `packages/templates/src/templates/kanban.ts`; `e2e/excalidraw/t3-*.spec.ts`, `t4-*.spec.ts` | `features/planning/**` |
| **WS5 Timeline** | `apps/web/src/features/timeline/**`, export layer `timeline`; `packages/templates/src/templates/launch-timeline.ts`; `e2e/excalidraw/t5-*.spec.ts` | `features/planning/**`; opens cards through `openCardPopover` |

**Lead-only** (serialise through the lead): `packages/canvas-schema/**` (`planning-keys.ts`, `planning.ts`,
`custom-data.ts`, `protocol.ts`, the fixtures: never edited), `packages/contracts/src/**` (`sync-internal.ts`, `ai.ts`,
`usage.ts`), `apps/web/src/features/planning/**`, `features/canvas-registry.ts`,
`present-export/ported/{badges.ts, export-sections.ts, ExportDialog.tsx}` (a new layer or section id is one line in
their id union), `apps/api/src/routes/engine-internal.ts` (the assignee route), `apps/sync/src/config.ts`,
`render.yaml`, `pnpm-lock.yaml`, `AGENTS.md`, `docs/PROGRESS.md`. Each workstream turns its own switch on in
`flags.ts` (one line) and removes its own palette ids from `PENDING_PALETTE_COMMAND_IDS` (contracts `usage.ts`, through
the lead) in the change that makes its feature live. **WS1 lands first in integration**: until its rules are in, every
planning write of WS2-WS5 is refused (their unit tests use the canvas fakes; their e2e specs need WS1's sync).

## 2. The canvas keys (CONTRACTS_REV 14; `packages/canvas-schema/src/planning-keys.ts`)

| Key | On | Value | Duplicate | Class |
|---|---|---|---|---|
| `card:status` | rectangle, sticky note | `todo` \| `doing` \| `review` \| `blocked` \| `done` (`CARD_STATUSES`, labels `CARD_STATUS_LABELS`) | keep | free |
| `card:who` | (a card) | a uid (1-60): an **account** with a role on the board (§5) | keep | api-validated |
| `card:start`, `card:due` | (a card) | `YYYY-MM-DD`, a real date 2000-01-01..2100-12-31 | keep | free |
| `sb:of` | frame (a panel) | the head's element id (a soft ref) | **relink-keep** | free |
| `sb:pos` | (a panel) | a base-62 fractional order key, ≤ 64 chars (`isOrderKey`, pinned against `engine/fractional.ts`) | keep | free |
| `sb:dur` | (a panel) | ms, an integer 100..600,000 | keep | free |
| `sb:head` | free text (no container) | `{aspect: '16:9'\|'9:16'\|'1:1'\|'4:5'\|'2.39:1', fps?: 24\|25\|30, defaultMs?, perRow?: 1-12, audio?: element id, audioOffsetMs?: ±60,000}` | **relink-keep** | free |
| `kanban` | frame | `{labels?: {status: 1-40 chars}, hidden?: statuses (unique, one at least visible), wip?: {status: 1-99}}` | keep | free |
| `timeline` | frame | `{start, end (≤ 2 years), scale: day\|week\|month, lanes: none\|status\|assignee\|tag, tag?: tag key}` | keep | free |

- **Element rules** (`planningElementProblem`, run by `checkElement` for every writer: the room's merge, the seed and
  every import): card keys only on rectangles and sticky notes and never without `card:status` (removing the status
  unmakes the card: the same op removes the other card keys, or INVALID); `start <= due`; panel keys only on frames
  and a panel holds `sb:of` and `sb:pos` together; `kanban` and `timeline` only on frames, never both; `sb:head` only
  on a free text. A shape conversion that changes a card's type must drop its card keys first (WS4).
- **Duplicate** (`relink-keep`, `relinkKeep`): a copied head with its panels makes a second storyboard (the copies'
  `sb:of` point at the copied head); a panel copied without its head joins the same storyboard; a head copied with its
  audio card points at the copied card, else keeps the original. Every other key keeps (a copied card is a card).
- **No lock exemption**: a locked card or panel takes no planning write. **Undo**: field-level per key, as every
  `customData.lobby` key. Nothing derived is stored: shot numbers, a card's column and the timeline's bars are what
  readers compute (`planning.ts`), so two clients with the same converged keys agree.
- **Budget**: the keys count toward the 8 KiB `customData.lobby` budget (a card with every field and 10 tags fits:
  `planning.test.ts`).
- **The read model** (`@draftroom/canvas-schema/planning`, pure): `cardOf`, `isOverdue`, `addDays`, `storyboardsOf`,
  `panelsInOrder` (by `sb:pos`, ties by id), `shotNumbers`, `panelDurationMs`, `storyboardTimings`, `panelPosBetween`,
  `needsRebalance` (past 48 chars) and `rebalancedPositions`, `parseDuration` ("2.5", "2.5 s", "0:03", "1:02.5",
  "36f") and `formatDuration`/`formatRunningTime`, `kanbanOf`/`kanbanColumns`/`kanbanBands`/`bandAt`,
  `timelineOf`/`snapDate`/`dateToX`/`xToDate`/`timelineTicks`.

## 3. The room (WS1; `apps/sync`)

### 3.1 What the foundation ships

- `DRAFTROOM_PLANNING` (`config.ts parsePlanning`): `on`; `off`, empty or unset = off (fail-closed); anything else
  refuses to start. Logged at boot (`[planning] on` / `off (DRAFTROOM_PLANNING is not on)`).
- The `contracts` frame names the newest revision whose switches are all on (`element-room.ts contractsRevOf`):
  reactions off 12, planning off 13, both on 14. The reader and writer rules key on each socket's own revision.
- `custom-data.ts checkKey`: a planning key write is UNAVAILABLE with the switch off (nothing written; the switch
  answers before the element rules), and INVALID with it on (`planningPending`). An undelete's own keys come back
  with it (`checkCreateLobby`). Rev-13 writers: the generic writer rules (§0b rules 6-8 of EXCALIDRAW-CONTRACTS.md).
- `seed.ts prepareSeedContent` strips the four classes from any content; `strip-keys` takes the four prefixes.

### 3.2 What WS1 builds (replacing `planningPending`)

- **Roles**: viewers and commenters READ_ONLY (as every element write). Name-only guests who may edit (workshop links)
  may write status and dates and reorder panels, but a `card:who` write from a guest is INVALID (clearing one is
  allowed). Lock: no exemption.
- **Assignee** (`card:who`): resolved before merge through §5, once per push batch for the uids the room's 60 s cache
  (`ASSIGNEE_REFS_CACHE_MS`) does not hold, with the file-refs pattern (`withTimeout`, fail closed): not an account
  with access → INVALID (detail `ASSIGNEE`); lookup failed or the api answered 404 → UNAVAILABLE. Removing an
  assignee needs no lookup. A person who later loses access stays named (the web shows "No longer on this board").
- **Audio**: `sb:head.audio` must name a live element carrying a `file` key at the write (soft afterwards).
- **Echo**: no rule of the room writes a planning key on its own (no server re-layout or renumbering).

### 3.3 Seeds, archives, restore (WS1)

- `prepareSeedContent` (templates, duplicate board, restore as new, import): keeps `sb:*`, `kanban`, `timeline`,
  `card:status|start|due`; keeps `card:who` only when assignee-refs for the TARGET board names it, else strips it.
  With `DRAFTROOM_PLANNING` off it strips all four classes (templates degrade to plain frames and notes).
- `.lobby` v2 import (`archive-v2.ts importCustomData`) and workspace templates drop `card:who`; `lobby-elements.ts
  exportableElements` keeps every planning key.
- `restore-elements` (checkpoint restore) keeps the keys as stored; with the switch off it re-creates elements without
  them (as reactions do).

### 3.4 Rollback below 14

`DRAFTROOM_PLANNING=off` and a restart (the frame says 13; rev-14 tabs stop offering planning), a named checkpoint of
each board with planning keys, `POST /internal/maintenance/strip-keys` once per prefix (`card:`, `sb:`, `kanban`,
`timeline`), then the older sync (`ba1704c`). A rollback **removes** card fields, storyboard order and durations
(restorable from those checkpoints after re-upgrading); the elements stay. Without the strip, ba1704c refuses every
edit of an element holding one INVALID (`reader-rule-rev14.test.ts`: its `checkElement` refuses them).

### 3.5 Deploy order

api (assignee-refs; it is live in the foundation and harmless), then sync with `DRAFTROOM_PLANNING=off`, then web,
then the switch on (a restart). The api must precede the web too: the deployed api refuses a usage batch naming a
wave T event (`ai.open:storyboard`, the `palette.run:<id>` of a wave T command) with a 400 and the web drops the whole
batch (no user-visible effect, lost counts).

### 3.6 The stale proofs (WS1; EXCALIDRAW-CONTRACTS.md §0b rule 5)

- `packages/canvas-schema/src/reader-rule-rev14.test.ts` (foundation): what the rev-13, rev-12 and rev-11 parses
  ACCEPT and DROP for every frame kind naming each class, and that `frameForReader` makes all of it accepted with
  nothing lost; the writer helpers for rev 13.
- `apps/sync/test/element-room/stale-reader-rev13.test.ts`: a socket parsing every frame with `rev13-6769e07`, and
  6769e07's own headless core (`DRAFTROOM_OLD_WEB_SRC`), while a rev-14 tab edits cards and panels.
- `rollback-rev13.test.ts`: this build's board files under the real ba1704c (`DRAFTROOM_OLD_SYNC_SRC`) before and
  after the strip.
- `e2e/excalidraw/t-compat-rev13.spec.ts` with the real 6769e07 web (`E2E_OLD_WEB_DIST`, `REV13_SCHEMAS` and the build
  steps in `e2e/excalidraw/l-compat-kit.ts`; the run's sync with `DRAFTROOM_PLANNING=on` through `syncEnv`): it keeps
  parsing every frame while a rev-14 user edits cards and panels, its moves keep the keys, its copy of a card is a
  plain note with a fix, its undo of a delete keeps them, it pushes nothing while it only receives.
- Pair (b): the new web and api against the DEPLOYED sync (`E2E_SYNC_ENTRY` = ba1704c's `apps/sync/src/server.ts`):
  no planning offered (the room says 13), nothing else broken.

## 4. The `storyboard` AI action (WS2; contracts `ai.ts`)

`POST /api/boards/:bid/ai/run` `{action: 'storyboard', script (trimmed, 1..20,000), aspect (the five), maxPanels
(1..60), acknowledged?, at?}` → `{action: 'storyboard', panels: AiStoryboardPanel[] (≤ 60), truncated, budget, runId}`;
`AiStoryboardPanel` = `{camera ≤ 80, action ≤ 500, dialogue ≤ 500, sfx ≤ 200, durationMs: 100..600,000 | null}`.
Guards as every action (account, edit on an active board, AI on, the export policy, budgets, the notice); the ledger
name `storyboard` (0028's pattern, no migration); the script never in logs. Pending until WS2:
`apps/api/src/features/ai/index.ts PENDING_AI_ACTIONS` (400 BAD_REQUEST, nothing read, reserved or sent;
`apps/api/test/features/ai/wave-t-pending.test.ts`). The web's labels exist (`ACTION_LABELS`, `BUSY_LABELS`, the
notice words); the usage kind `ai.open:storyboard` is in `USAGE_AI_OPEN_KINDS`.

## 5. `POST <api>/internal/boards/:bid/assignee-refs` (live in the foundation; contracts `sync-internal.ts`)

sync → api, behind the internal secret (the contract's error shape: `ENGINE_INTERNAL_ROUTES`), exempt from the
web-origin check by its route pattern (`INTERNAL_SYNC_POSTS`). Body `AssigneeRefsRequest` `{uids: 1..50 strings of
1..60}` → 200 `AssigneeRefsAnswer` `{accounts}`: the asked uids that are accounts (`users.kind = 'account'`) with a
role on the board now (`connectionRole` over `loadBoardAccessMany`: an archived board gives viewers), each once, in the
request's order; every other uid is left out, the same for all (no existence oracle). A trashed or unknown board is
404 `board-not-found`, a database failure 503 `unavailable`, a bad body 400 `bad-request`. Two queries whatever the
number of uids. Test: `apps/api/test/assignee-refs.test.ts` (PGlite).

## 6. The web (`apps/web/src/features/planning/**`, lead-owned, read-only to WS2-WS5)

### 6.1 Switches and the gate (`flags.ts`)

`PLANNING_FLAGS` (`storyboard`, `storyboardAi`, `animatic`, `storyboardExports`, `cards`, `kanban`, `table`,
`timeline`), all off; a dev-auth page may set `PLANNING_FLAG_KEYS[name]` = `'1'`/`'0'` in localStorage.
`planningOffered(flag, canvas)`: the switch, a room of `PLANNING_REV` or later (`room.contractsRev()`, asked when the
offer is drawn) and not read-only; `planningShown(flag)`: the switch only (showing what a board holds).

### 6.2 The read model (`model.ts`)

Over `canvas.index` only (`withLobbyKey`, `byFrame`), never a walk of the scene: `cardsOn`, `cardsIn(frameId)`,
`storyboardsOn` (heads and panels, panels in order), `storyboardOfSelection`, `kanbansOn`, `timelinesOn`. Nothing
writes; every write is its workstream's, through `canvas.transact` (one undo step), and only the actor's tab ever
writes a layout, a renumbering, a rebalance, a Kanban stacking or a status that follows a move (each such path gets a
"a receiving client pushes nothing" test).

### 6.3 The export-overlay registry (`present-export/ported/badges.ts`)

`registerExportOverlay({id, order, active(canvas), svg(input)})`, ids `votes` (100, built in: the vote badges),
`storyboard`, `cards`, `kanban`, `timeline` (wave T's, 10-40). An export with any active layer draws every active
layer's markup over the engine's export: PNG and the clipboard (`drawOverlays`), SVG (`svgWithOverlays`) and vector
PDF pages (their SVG). `svg(input)` gets the exported ids, the export's top-left in scene coordinates (`origin`: a
scene point p draws at p - origin) and its viewBox; literal colours (no CSS variables), text as `<text>` (searchable
in the vector PDF), no external reference, no author name.

### 6.4 The Export dialog's kind slot (`present-export/ported/export-sections.ts`)

`registerExportSection({id, order, offered(canvas), Section})`, ids `storyboard-sheet`, `storyboard-sequence` (WS3),
`card-table-csv` (WS4). A section renders after the CSV section with `{canvas, boardTitle, selectedIds, disabled,
run}`; `run(task)` runs its export through the dialog's busy state, status line and Cancel (`task` gets the abort
signal). Files go through `../download.ts`; the dialog only opens under the board's export policy.

### 6.5 Features, entries, the card popover

- Registered empty in `canvas-registry.ts` (before `elements`, still the last): `storyboard`, `storyboard-play`,
  `cards`, `kanban`, `card-table`, `timeline` (`{ id }` each).
- `PLANNING_ENTRIES`: every offer (`id` = a palette command of contracts `WAVE_T_PALETTE_COMMAND_IDS`: `storyboard.new`,
  `storyboard.from-frames`, `storyboard.from-script`, `storyboard.play`, `storyboard.present`, `cards.make`,
  `kanban.new`, `card-table.open`, `timeline.new`), its owner, switch, places (Elements panel, palette, context menu,
  selection bar, main menu) and whether it writes. All nine ids are pending until their owner registers them.
- The card popover seam (`index.ts`): WS4 calls `registerCardPopover(open)` on mount; WS4's table and WS5's timeline
  call `openCardPopover(ctx, {id, anchor?, focus?})`, false until WS4 lands.

## 7. Checks of the foundation

See the foundation's report for the counts. Pinned by: `packages/canvas-schema/src/{planning.test.ts,
reader-rule-rev14.test.ts, fixtures.test.ts, limits.test.ts}`, `packages/contracts/src/wave-t.test.ts`,
`apps/api/test/{assignee-refs.test.ts, features/ai/wave-t-pending.test.ts}`,
`apps/sync/test/negative/planning-foundation.test.ts` (and `config.test.ts`, `seed.test.ts`, `strip-keys.test.ts`),
`apps/web/src/features/wave-t-stubs.test.ts`, `apps/web/src/canvas/board/tx.test.ts`,
`packages/board-ops/src/elements/elements.test.ts`, `scripts/smoke/render-yaml.test.mjs`.

## 8. Where the foundation differs from the design, and why

1. **`sb:head` duplicates with `relink-keep` too** (the design: keep), so a head copied with its audio card points at
   the copied card; without the card the ref is kept as before.
2. **The element rules are canvas-schema's, in `checkElement`** (the design put the type and cross-key rules in the
   room): every writer, the seed and the imports hold them, and the room has one place for its class rules.
3. **`sb:pos`'s order-key rule is restated in `planning-keys.ts`** (not the engine's `validateOrderKey`): only
   `packages/canvas-schema/src/engine/**` may import `@excalidraw/*`, and a freeze copies `planning-keys.ts` as it is.
   `planning.test.ts` pins it against `engine/fractional.ts isValidIndexKey`.
4. **The foundation bumps `CONTRACTS_REV` to 14 itself** (wave N's foundation kept 12): with the kill switch the
   foundation sync says 13 unless the switch is on, and the reader rules must serve rev-13 sockets from the start
   (the room's `Math.min(reader, CONTRACTS_REV)` shortcut would otherwise treat a rev-14 tab as 13). With the switch on,
   the foundation's room still takes no planning write (`planningPending`).
5. **With the switch off, the switch answers first** (UNAVAILABLE even for a planning key on the wrong element type):
   nothing planned is written while planning is off.
6. **assignee-refs is live, not pending**: it is small, read-only and only the sync calls it.
7. **The wave T palette ids** (nine, pending) are new: they give `PLANNING_ENTRIES` stable ids across the Elements
   panel, the palette and the menus.
