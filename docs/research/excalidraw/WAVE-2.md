# Excalidraw migration, wave 2: integration

The wave-2 integration of `docs/EXCALIDRAW-MIGRATION.md` §7.2 (row "2 Engine core"). It covers the change
requests, the four merges, spike B's latest state, the fixes the merges needed, the gate, what wave 3 can
build on, and the open problems. The owners' own reports are the evidence for their slices:
2C in `docs/PROGRESS.md` (wave 2C), 2D in `docs/research/excalidraw/wave2/2D.md`, and 2E and 2F in their
workflow results, which are quoted here. The lead's runs here are **single runs**, not the 3-run evidence,
on a machine shared with other agents' runs.

| | |
|---|---|
| Branch | `engine/excalidraw` |
| Base | `0f17569` (the wave-1 freeze; every owner branched from it) |
| Merged (`--no-ff`, in this order) | `engine/w2-2c` `66ffe88` (`12243dc`), `engine/w2-2d` `0d8953c` (`d7fb58b`, one `docs/PROGRESS.md` conflict: both entries kept), `engine/w2-2e` `6f2e563` (`2428d84`), `engine/w2-2f` `bb45af1` (`b2e4377`). No code conflict. |
| Spike B | `origin/spike/excalidraw` merged again: **already up to date** (`92b1098`, the M3 report; spike B has pushed no fix to it since the wave-1 freeze). Spike B is still running: the O2 lost-edit fix is not on any pushed branch yet. `spike/b-convert` has 3 commits (B8 phase 3 evidence, the roll-forward z-order fix) that the spike lead has not merged; they reach this branch when the lead merges them into `spike/excalidraw`. |
| Change requests | 5 CR commits reviewed, all **accepted**, plus one decision on a spike B C0 file (`App.tsx`); recorded in `docs/EXCALIDRAW-CONTRACTS.md` §12 as W1-2 to W1-9 |
| Integration fixes | `f7fef27`, `c2b4fe1` (e2e only, below) |
| Lockfile, `pnpm-workspace.yaml`, catalog | unchanged by every owner and by the integration |
| Spike-owned folders | unchanged by every owner and by the integration (`apps/sync/src/room/**`, `room/migrate/**`, `apps/web/src/canvas/{sync,lease,history,input,engine,presence,tools,overlay}/**`, `packages/tldraw-import/**`, `e2e/spike-b/**`) |
| Machine | Windows 11 workstation, 64 logical CPUs, Node 24, pnpm 10.34.5, Playwright headless Chromium. Other agents' runs shared the machine; the default suite, the spike A suite and the Excalidraw specs ran side by side, so every duration is informational. |
| Ports | 6700-6702 (default suite), 6720-6722 (Excalidraw specs), 6740-6742 (spike A suite), 6743 (A8 probe). Nothing listened in 6700-6749 before or after. |
| Logs | the integrator's scratchpad `w2/` (`static1/`, `unit1.log`, `arrows1.log`, `lc*/`, `default1/`, `spikeA1/`, `builds1/`); never committed |

## 1. Change requests

| Rev (§12) | CR, commit | File(s) | Decision |
|---|---|---|---|
| W1-2 | 2C, `e010263` | `canvas/api/impl.ts` `LOBBY_CANVAS_MEMBERS`, `contracts.test.ts`, the generator, §2.2 | **Accepted.** `MemberStatus` gains `board`: 2C's 49 stubs become 10 composed members and 39 board-page members (real with the page's `board` handles, a stub naming 2C on a bare port). The member list, owners and signatures are unchanged; the regenerated §2.2 table matches the doc. |
| W1-3 | 2E, `080d536` | `e2e/excalidraw/playwright.config.ts` | **Accepted.** It fixes a real bug: a spec's own `test.use({syncEnv})` replaced the config's `syncEnv` and ran sync on the tldraw engine against the Excalidraw build. The config now sets `engine: 'excalidraw'`, and 2E's launcher puts `EXCALIDRAW_SYNC_ENV` under any spec `syncEnv`. The default suite's stacks are unchanged. |
| W1-4 | 2E, `c729546` | `e2e/tests/support/canvas.ts` (bodies only) | **Accepted.** Focus before Enter in `startTextEditingWithKeyboard`; `readOnly` and `text` derived until the page has those verbs. |
| W1-5 | 2F, `8a7e7af` | `apps/sync/src/engine-switch.ts`, `app.ts` (spike B lead's C0 seam files) | **Accepted on `engine/excalidraw`** (additive; the C0 seam tests pass). A room extension mount point: `registerRoomExtension` and `extendElementRoom`; `loadEngine('excalidraw')` imports `room-internal/`. The spike B lead is asked to adopt it in spike B's `CONTRACTS.md`. Two review notes: the wrapper forwards the service's members by name, so a new optional `ElementRoomService` member would be dropped silently; and the seam now type-imports `BoardStore` from `room/store.ts`. |
| W1-6 | 2F, `8a7e7af` | `engine-switch.ts` (`ElementRoomService`) | **Accepted as an optional interface.** `prepareBoard?` and `serverWrite?` are for O1 to implement. O1 may amend them through a CR, with 2F's OK. |
| W1-7 | 2F, `e19c6da` | `packages/contracts/src/history.ts` | **Accepted.** `CheckpointContent` gains optional `format`, `elements` and `doc` for v2 checkpoints. It is compatible with R0's edits of the same file on `r0/bridge`, which change other declarations. |
| W1-8 | 2C (not a CR commit) | `apps/web/src/App.tsx` (spike B lead's C0 file) | **Accepted.** In the guarded engine build, `/b/:boardId` loads `canvas/board/route.tsx`: Lobby's board page, or spike B's page at `?page=spike` or with `VITE_LOBBY_BOARD_PAGE=spike`. The guard is still inlined, and the builds show 0 markers. Spike B's suite on this branch now needs `VITE_LOBBY_BOARD_PAGE: 'spike'` in its config, a request to spike B. §7.1 was regenerated too: 167 files, since 2D removed the catalog's tldraw import. |
| W1-9 | requests, not commits | — | **Recorded, not applied:** CR-2D-1, CR-2D-2, the two importer edges, `LobbyHistory.mergeTop()`, and the `ai.by` wording (§6). |

## 2. Integration fixes

The four branches merged cleanly, but 2E's specs had been written against spike B's board page. With 2C
merged, `/b/:id` in the engine build is Lobby's board page, so the first run of every Excalidraw spec
(`lc1`, at `f7fef27`) had 5 failures. All 5 were in 2E's specs, and each came from how the new page
differs from the spike page:

| Commit | Spec | Cause | Fix |
|---|---|---|---|
| `f7fef27` | collab-lifecycle, collab-network-interruption, sync-durability, conflicts' toasts | The spike page's `save-state` and `toast` test ids. The board page uses the tldraw page's `save-status` (data-state is a `DisplayState`) and NoticeRegion notices (`.dr-notice`: `lease-toast`, `undo-notice`, `save-rejected-toast`). | `saveIndicator(page)` and `toastTexts` in `e2e/tests/support/excalidraw.ts` read either page. The durability recorder re-reads the indicator on every mutation. |
| `c2b4fe1` | permissions-canvas (2 tests) | The app's no-access screen has no full stop ("You don't have access to this board"). The spike page's text had one. | The spec matches both. |
| `c2b4fe1` | sync-durability "Saving… then Saved", "an injected COMMIT failure" | The board page's indicator uses the tldraw page's hold and settle rules (`useEngineSaveStatus`). It keeps "Saving…" on screen briefly after the engine is saved, and the spec read the DOM log at the engine's Saved. | The spec reads the log once the indicator shows Saved. |
| `c2b4fe1` | sync-durability "10 edits … survive a reload" | **A real defect.** It lost `offline-9`, the 10th offline edit. The engine writes the offline queue 100 ms after a change (`sync/core/engine.ts` `schedulePersist`), while the indicator already reads "Offline — 10 changes on this device". The spec reloaded inside that window. | The spec now reloads once IndexedDB holds all 10 edits. **The window itself is an open problem for O2** (§6). 2C's own reload spec already waited 500 ms for the same reason. |

After the fixes, the two specs passed 8/8 (`lc2`). Then the whole folder was run once more on the final
tree (§3).

## 3. Gate

Code under test: `c2b4fe1` for the Excalidraw specs and the final static checks. The other checks ran on `b2e4377`/`f7fef27` (the merges, and the first fix). `c2b4fe1` changes only two `e2e/excalidraw` specs, which none of those checks runs or builds. The commit after it adds docs only.

| Check | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,599 files (re-run on the final tree, with the docs) |
| `pnpm -r typecheck` (15 projects) + engine-probe tsc + e2e tsc | PASS (merged tree and final tree) |
| Node-safety tsc (`apps/sync/tsconfig.node-safe.json`) | PASS (merged tree and final tree) |
| `pnpm test` | PASS: **4,573 passed, 36 skipped** (408 files, 9 skipped). That is wave 1's 4,242 plus exactly the owners' new tests: 2C 25, 2D 203, 2E 61, 2F 42 |
| `pnpm test:arrows` | PASS 85/85 |
| asset and host-rewrite plugin tests; `hash.ts` in Chromium; A8 browser probe (port 6743) | PASS 9/9; PASS 1/1; PASS |
| **every ported Excalidraw-path spec** (`e2e/excalidraw`, `E2E_PORT_BASE=6720`), once on the final tree | **52 passed, 1 failed** of 53 (3.6 min). The failure was sync-durability "a SIGKILL in the middle of a burst of 60 creates loses none of them": `burst-11`, created while online among the first 30, was never stored, and the tab showed Saved. This is consistent with O2's open lost-create race (§6), not confirmed with a trace. The same test passed in the two earlier runs today and then **10/10** with `--repeat-each=10` (12 of 13 runs today). The 52 passes include the 4 expected failures below. The earlier runs were `lc1` (48/53, the 5 integration failures of §2) and `lc2` (8/8 after the fixes). |
| **the default (tldraw) e2e suite**, whole, once (`E2E_PORT_BASE=6700`) | **PASS: 341/341** (26.0 min; 340 chromium + 1 branded Chrome), with fixtures generated by `pnpm fixtures` |
| **spike A suite** (`SPIKE_WEB_PORT=6740`), once | **PASS: 99 passed, 2 skipped** (opt-in), 19.8 min, fresh build |
| normal web build, engine markers | PASS: **0** hits for 39 markers: spike A's and spike B's, wave 1's, and wave 2's (`data-lobby-board-canvas`, `__lobbyProbe`, `installProbe`, `lobby-typing-badge`, `setContentSink`, `LobbyBoardPage`, `VITE_LOBBY_BOARD_PAGE`, "Preparing this board", `instantiateSceneTemplate`, `layoutBoundText`, `buildStickyNote`, `lobby-offline`). No `excalidraw-assets/`, 0 source maps. |
| engine flag without the dev-auth guard | PASS: 0 marker files for 21 markers. Positive control: the guarded engine build contains 19 of the 21 markers (`spike-board-stub` and `LobbyEngineCore` are absent even there, so they prove nothing either way). |

The Excalidraw run counts four **expected failures**: known defects marked `test.fail`. Playwright
counts them as passing only while they still fail, so each mark must be removed when its fix lands.

| Expected failure | Defect | Owner |
|---|---|---|
| templates-scenes "keeps the labels of its locked image slots (CR-2D-1)" | the room refuses a label created with its new locked container | O1 |
| collab-conflicts "bob recolours while alice is still dragging" | **data loss**: Alice's pointer-up push carries her old colour, and Bob's recolour is lost on every tab while all of them show Saved | O2 (`canvas/sync/core`) |
| collab-conflicts "typing into an empty note is one undo step" | after typing into a note created empty, one undo leaves 'o' and later undos do nothing | spike B's history and lease |
| collab-conflicts "… group and delete undo and redo step by step" | redoing Ctrl+G in a long sequence does nothing | spike B's history |

Not run: the spike B suite, and the owners' 3-run repetitions. The spike B suite's ports are 7850-7999,
and on this branch it would need `VITE_LOBBY_BOARD_PAGE=spike` (W1-8). Each owner ran 3 runs on its own
branch, as reported.

## 4. What integrates

- **2C: Lobby's board page on Excalidraw** (`apps/web/src/canvas/board/**`).
  - In the guarded engine build, `/b/:boardId` opens a real Lobby page: the tldraw page's load, access and error screens, sign-in, tickets, the shared top bar (`board/TopBarFrame.tsx`), the dock (`features/FeatureHostCore.tsx`), notices, the Share dialog, the role and blocked-edit hints, the leave guard and the skip link.
  - Inside the canvas: the overlay root (scene and screen layers, focus mode, cursors filtered by `cursorVisible`, typing badges), the host slots, the outer capture-phase input layer that dispatches `registries.keys`, paste and drop routed to `contentHandlers`, and `trackUpload`.
  - The Saved indicator on the engine's status. `CANVAS_FEATURES` are installed after the first welcome with the frozen `CanvasFeatureContext`.
  - Every one of 2C's 49 `LobbyCanvas` members is real on the page.
  - The default build still renders `board/BoardPage.tsx`, which is unchanged.
- **2D: formats and templates.**
  - One engine-neutral template source with two emitters. The tldraw output is byte-identical to before; `@draftroom/templates/scene` emits Excalidraw scenes that equal the converter's output field by field.
  - `@draftroom/templates/plan` feeds the dashboard gallery, which no longer imports tldraw.
  - `@draftroom/board-ops/elements` covers text, search, CSV, frames, presentation order, remap, pasted notes, file refs and archive v2. `/elements/v1` reads v1 archives through an injected converter.
- **2E: the harness and the ported cross-cutting specs.**
  - The element protocol harness (`apps/sync/test/harness/element-*.ts`) and the 56-test negative security suite against the real server process.
  - The engine-aware stack launcher: `engine`, `EXCALIDRAW_SYNC_ENV`.
  - The Excalidraw helpers (`e2e/tests/support/excalidraw.ts`: server snapshot, relay, forge, keys).
  - Seven ported specs: lifecycle, network interruption, conflicts, permissions, durability, the browser half of the negative suite, and the perf seed. Plus `seedHeavyExcalidrawBoard`.
- **2F: the api on the new engine.**
  - Sync internal routes outside the room (`apps/sync/src/room-internal/`): seed, place-notes, text, asset-refs, deleted.
  - The api's element reader (`apps/api/src/canvas/lobby-elements.ts`).
  - Checkpoint bodies v1 and v2 (read, preview, restore-as-new, duplicate), archive v2 export and import, and the AI source, file GC and workshop readers on elements.

## 5. What wave 3 can now build on

Every wave-3 owner now has a real page to run in. Ported code in `…/ported/**`, imported through
`canvas/api/index.ts`, is installed by the board page and can be seen and tested in a browser at
`/b/:id` in the guarded engine build (`pnpm --filter @draftroom/e2e excalidraw`).

- **Available to everyone:**
  - the 26 C0 members, 17 composed members and 39 board-page members of `LobbyCanvas`;
  - every registry: commands, keys, tools, menus, selection bar, dock panels, top bar, overlays, host slots, content handlers and the cursor filter;
  - the change stream (local, remote, history), `transact` with `joinPrevious`, `text.edit`, `text.replace` and the lease;
  - the Saved indicator and `trackUpload`;
  - the harness and helpers for ported specs (`canvas.ts`, `excalidraw.ts`, the server test snapshot, the relay and forge sockets).
- **The remaining stubs**, which are each owner's own part (`canvas/api/parts/*.ts`): 3a `styles.of` and `styles.apply`; 3b `viewport.zoomTo`, `centerOn`, `ensureVisible`, `zoomStep` and `limits`; 3c `follow.*` and `on:followChanged`; 3e `export.*`; 3g `files.urlOf` and `files.insert`.

| Owner | Can start on | Blocked or limited by |
|---|---|---|
| 3a canvas tools | the toolbar, style panel, context and main menu, shortcuts dialog and selection-bar host slots; key specs; `styles.next`/`setNext`; the keyboard-map test on `collectKeyClaims(CANVAS_FEATURES)` | nothing new |
| 3b navigation | the frames, search and navigation panels (the search reads `@draftroom/board-ops/elements` `searchElements`); start view; select-by-type; copy-link | **CR-2D-2**: the template insert and paste-as-notes need `LobbyTx.insert(elements)`, because `tx.create('note')` rebuilds the note. CR-2D-1 limits templates with locked image slots (lock them in a second push, as 2D's spec does). The scenes must be built after `document.fonts.ready`. |
| 3c comments + people | the people item. Register the top-bar item with id `people` and the page's fallback list steps aside. Present-live; comments overlays | nothing new (follow is 3c's own part) |
| 3d mind maps + tags | `joinPrevious` for the re-layout (confirmed feasible); `hidden` and `hitGuard`; tags over `doc.set` (`tagDef:*`) | the history join works through the controller's live undo list until `mergeTop()` lands (spike B) |
| 3e present + export | `frameOutlineOf` and `presentationOrderOf` (board-ops/elements); focus mode; `export.*` is its own part | nothing new |
| 3f workshops | overlays, pointer tools, keys, and the api's workshop readers on elements (2F: file cards count as `dr-file-card` for votes) | the **private brainstorm reveal**: place-notes answers 503 on a board whose room is open until O1 implements `serverWrite` (CR 2F-2), which is the normal case |
| 3g media | `contentHandlers` for paste and drop; `trackUpload(registries, promise)` keeps Saved truthful | `files.insert` and `files.urlOf` are its own part |
| 3h history, AI | v2 checkpoint content (`format`, `elements`, `doc`; CR 2F-3) for the preview; the api's AI sources on elements | **Recently deleted restore** answers 503 on an open board until `serverWrite`. A v1 checkpoint previews as tldraw records until the api has the `tldraw-import` edge. |
| 3i a11y + mobile | the `phoneSheet` and `liveRegion` host slots; the page's skip link and named canvas | no phone spec covers the new page yet |

## 6. Open problems

**Data loss or truthfulness (blocking the cut-over; spike B O2 unless noted)**
- **Remote edit overwritten during a local drag** (2E, reproduced on every run, including this one). Bob's change to an element Alice is dragging is held back until her gesture ends. Her pointer-up push then carries her stale `strokeColor` with the move, and the server stores it. Bob's edit is gone on every tab, and all of them show Saved. This is not the known O2 race.
- **The O2 lost-edit race** (spike B M3; still open). A local edit that a server frame overtakes before Excalidraw reports it is lost while the tab shows Saved. 2C reproduced it on the new page, and this integration's final run lost `burst-11` in 2E's burst test (1 of 13 runs of that test today, §3). 2C's specs wait for Saved between seeding writes (`board-kit` `settled`), and 2E's 100-step test does the same. Remove those waits once the fix lands.
- **The offline queue's 100 ms window** (found here). "Offline — N changes on this device" counts a change before it is in IndexedDB, and nothing writes the queue on `pagehide`. A reload or close within about 100 ms of an offline edit loses it. Either flush the queue on `pagehide`/`visibilitychange`, or count only persisted entries as being "on this device".
- **Undo defects** (2E; spike B's history and lease): after typing into an empty note, undo leaves 'o' and never removes the note. Redoing Ctrl+G inside a long sequence does nothing.
- **Core event order** (2C): the engine core emits `message` events before it applies them (roster, lease table, doc), and the page defers its reads by a microtask. Either emit after applying, or document the order. The offline count is per element, so a note and its label count as two.

**Server and api**
- **O1:** CR-2D-1 (apply the lock rule only to containers that were live before the push). CR 2F-2: implement `prepareBoard` and `serverWrite`. Until then, restore and place-notes answer 503 on an open board, and a read of an unconverted board builds and discards one snapshot. The header of `room/http.ts` still lists the 2F routes as not built.
- **2F follow-ups:** place-notes does not push down what sits below a frame it grows. A tldraw (rollback) sync refuses a lobby seed with 400, which the api reports as 503; R0's messaging should say "made on the new canvas". The seed does not check file-refs (the api has already decided `board_asset_links`).
- **O4:** export `colorOf`/`PALETTE` and the note label font and size from `tldraw-import`. Place-notes keeps a pinned copy of the 13 note fills.

**Contracts and dependencies**
- **CR-2D-2**, `LobbyTx.insert(elements: readonly WireElement[]): string[]` (contracts owner and 2C): this blocks 3b's template insert and paste-as-notes. It needs an engine-side write path. Neither the C0 `CanvasTx` nor spike B's port has one; the board handles could provide it.
- **Lockfile owner:** `apps/api` → `@draftroom/tldraw-import` (for v1 checkpoint and archive reads on the api) and `apps/sync` → `@draftroom/board-ops` (for the search text of 2B). Both are importer edges only.
- **Spike B:** add `VITE_LOBBY_BOARD_PAGE: 'spike'` to `e2e/spike-b/playwright.config.ts`, or have `openBoard` append `?page=spike`. Add `LobbyHistory.mergeTop()` for `joinPrevious`. Adopt W1-5 in spike B's `CONTRACTS.md`.
- **The wave-1 facade verbs** are still not on the page. `canvas/test-facade.ts` is spike B's O3 file, and 2E implements the verbs after spike B closes. Meanwhile `canvasCall` derives `readOnly` and `text`, and 2C's specs use the dev-only `window.__lobbyBoard.canvas`. Each facade write verb should also be one undo step: today two writes in one frame become one step.
- **Plan versus schema:** plan §3.3 says `ai.by` is stamped if absent, but canvas-schema's `AiValue` requires it (the negative suite pins the schema's behaviour). This is the contracts owner's call.
- **Carry-forward when spike B closes:** move `e2e/spike-b/support/{relay,forge,png}.ts` and `e2e/load/{boards,seed}.ts` into `e2e/tests/support` (2E). Review `canvas-schema` (wave-1 §10 item 2).
- **Not covered yet:** a phone spec for the new page; the board item cap, the 200 `plusOne` cap and the 8 KiB `customData.lobby` budget in the negative suite; and the four engine probes of plan §6.5. The e2e spec covers the "`restoreElements` on templates" probe.
- **AGENTS.md (plan §10)** is unchanged. It needs the owner's own approval.
