# Spike B contracts (C0)

The serial contracts step of spike B (docs/EXCALIDRAW-MIGRATION.md §8.6.2, revision 3.5). Everything listed
under "What is frozen" is frozen from C0 on. Five owners fan out from here (§8.6.3); none of them edits
another owner's file or invents a shape another owner also implements.

| | |
|---|---|
| Branch | `spike/excalidraw` |
| B0 (candidate) | `45574c6` (spike A plus the A6/A16 fix round). Its re-verification was still running when C0 was written; the final B0 hash is confirmed later. C0 touches none of the fix round's files. |
| Plan | revision 3.5 plus the lead's confirmation `00a3724`, merged into `spike/excalidraw` as `d344f69` (docs only; the `docs/PROGRESS.md` conflict kept both sides) |
| C0 | **`975b531`** (the contracts commit). Owners branch `spike/b-<name>` from the `spike/excalidraw` commit that records this hash (docs only on top of C0), rebased on B0 once B0 is confirmed. |
| Engine | `@excalidraw/*` `0.18.0-1118751`, pinned by the catalog |
| Gate | see "The C0 gate" at the end |

`CONTRACTS_REV` in `packages/canvas-schema/src/protocol.ts` is **1** at C0 (**3** after the M1 integration, **4**
after the M3 integration; see "Change log").

## The change-request rule

After C0 every file of the table below is frozen. A change is a **change request to the lead**:

1. The owner who needs it writes to the lead what, why, and which owners it touches.
2. A change to `protocol.ts`, `groups.ts`, `apps/sync/src/room/schema.ts` or
   `packages/contracts/src/sync-internal.ts` also needs the OK of **both ends**: O1 and O2 (protocol, groups),
   O1 and O4 (room schema), O1 and O5 or O3 (sync-internal).
3. The lead applies it on `spike/excalidraw`, bumps `CONTRACTS_REV` in `protocol.ts`, adds a line to "Change
   log" below, and every owner merges `spike/excalidraw` back.
4. The lockfile (`pnpm-lock.yaml`), `pnpm-workspace.yaml` and the catalog change only this way. Every
   dependency edge spike B needs was added at C0 (see "Lockfile"), so none is expected.
5. The arrow acceptance tests (`apps/sync/test/room/arrows/**`) are frozen like the contracts: O1 may not
   weaken a test. A test that is wrong is a change request with the evidence.
6. Files no one owns are frozen; an owner who needs one changed asks the lead (§8.6.3).

## What is frozen, file by file

"Owner after C0" is who edits the file from C0 on; everyone may import it.

### `packages/canvas-schema` (subpath exports; the package root `.` stays the tldraw schema so the normal build carries no engine code)

| File (export) | Freezes | Owner after C0 |
|---|---|---|
| `src/protocol.ts` (`./protocol`) | every message of §2.4.2 as zod plus TS types, discriminated by `type`: client `hello`, `push`, `lease.acquire`, `lease.release`, `presence` (with `drag`: ids once, then deltas), `ping`; server `welcome` (reset with the binary `SnapshotFrame`, or `catchUp`), `changes`, `ack` (per-op `fix`, `fitDropped`, `denied`; `derived` rows), `lease.grant`/`lease.deny`/`lease`, `roster`, `presence`, `workshop`, `notice`, `pong`. `Op` = create or patch (`g` groups, `c` customData keys, `b` boundElements, `fit`, `off`); a `path` patch is whole (`pathUnitProblem`); `fit` on a container or a leased free text's own `x`, `y`. `ClientEnvelope` for per-op rejection. Reject codes with retry/abuse/UI rules, close codes and reasons (`NEW_CANVAS_BOARD` included), notices, `WIRE_LIMITS`. The group vocabulary (`GROUP_NAMES`, `GROUP_FIELDS`, the path field lists, `DERIVED_CLOCK`). The test snapshot (with `horizon`), `LeaseHookRequest`, `FailCommitRequest`, `TEST_HOOK_PATHS`. `encodeSnapshotFrame`/`decodeSnapshotFrame` (gzip JSON, isomorphic). `PROTO` 1, `ELEMENT_SCHEMA_VERSION` 1, `CONTRACTS_REV` | lead |
| `src/groups.ts` (`./groups`) | the §3.2 map per element kind (`FIELD_GROUPS`; `path` = the whole geometry of arrows and lines, `angle` in `shape` for every other kind; a bound label's `x`, `y`, `width`, `height`, `fontSize` in `layout`; a free text's box in `layout`), `classifyField`, `fieldGroupOf`, the coverage check `coverageProblems`/`unclassifiedKeys`; the derived-write rule (`DERIVED_WRITE_CLOCK` = `fit`, `RESNAP_TRIGGER_FIELDS`); `pathUnitOf`; `userSetGeometry` (scene coordinates from `getPointAtIndexGlobalCoordinates`; fixed segments by order, orientation and cross-axis position, never by index; self-loop midpoints relative to the start); `sameUserSetGeometry` / `userSetGeometryDelta` (THE compare, within `GEOMETRY_TOLERANCE_PX`); `compareArrowChange` / `isDerivedArrowChange` (the structural derived test O2's core calls unchanged); `overlayPatch` (the mechanical overlay of a patch, `path` applied whole); `ENGINE_ARTIFACT_FIELDS` / `stripEngineArtifacts` (new at C0, see findings) | lead |
| `src/custom-data.ts` (`./custom-data`) | the `customData.lobby` key registry for `tag:*`, `plusOne:*`, `file`, `pdfPage`, `kind`, `ai`, `privateFrame`, `mindmap`, `mindmapEdge`, `alt`, `present`: class, value schema, per-key size, duplicate rule; `checkLobbyData` (budgets: 8 KiB, 200 `plusOne:*` within 16 KiB, 10 tags); the `lobbyServer` shape; `CustomData` (only `lobby` and `lobbyServer`) | lead |
| `src/limits.ts` (`./limits`) | §3.5: ids, `fileId`, fonts {5, 6, 8}, ±1e6, `GEOMETRY_TOLERANCE_PX = 0.5`, the rounding rule `roundGeometry` (points, pressures and fixed segments to 2 decimals; `x`, `y` of an UNROTATED line or arrow only), per-type byte limits, point caps, customData budgets, uid ≤ 60, links (`isAllowedLink`), board, guest, tombstone, wire and rate limits | lead |
| `src/elements.ts` (`./elements`) | strict per-type schemas pinned to the engine's field set (unknown keys refused), `WireElement`, `checkElement` (schema, byte limit, customData) | lead |
| `src/doc.ts` (`./doc`) | `lb_doc` keys (`startView`, `workshop`, `tagDef:<key>`, `import` server-only), value schemas, who writes | lead |
| `src/refs.ts` (`./refs`) | `toShapeRef` / `fromShapeRef` | lead |
| `src/hash.ts` (`./hash`) | the convergence hash: the test snapshot's element list, live and tombstones, `(id)` order, canonical JSON with sorted keys, without `status`, `fileId` suffix stripped; WebCrypto, no imports. `hash-sample.ts` is its pinned sample | lead |
| `src/invariants.ts` (`./invariants`) | `checkInvariants(elements) → Violation[]` and `VIOLATION_CODES` (a STUB) | **O1** (handed over) |
| `src/engine/binding.ts` (`./engine`) | the rule-7 helpers' signatures and contract: `resnapArrow`, `resnapLinearArrow`, `routeElbowArrow`, `arrowLabelLayout` (STUBS; whole `path` unit; rebase is `movePoints`; router's whole output; rounding; caller bumps the arrow's version before the label helper) | **O1** (handed over) |
| `src/engine/linear.ts` | `pointAtIndexGlobal` (the one engine read `groups.ts` needs) | O1, like all of `engine/**` |
| `package.json`, `src/index.ts` | the exports above; `.` unchanged | lead |

### `packages/contracts`

| File | Freezes | Owner after C0 |
|---|---|---|
| `src/sync-internal.ts` (re-exported by `.`) | A1 `GET <api>/internal/boards/:bid/file-refs?ids=` (1–100 BARE version ids) → `FileRefsResponse` `{ok, foreign, missing}`; A2 `GET <api>/…/workshop-state` and `POST <sync>/…/workshop-state` → `WorkshopStateBody`; the error body and codes (401 `bad-secret`, 400 `bad-request`, 404 `board-not-found`, 503 `unavailable`); the 3 s timeout (fail closed); the cache constants; `LobbyElementsSnapshot` (sync's snapshot route in the excalidraw engine) | lead |

### `apps/sync`

| File | Freezes | Owner after C0 |
|---|---|---|
| `src/engine-switch.ts` | `DRAFTROOM_ENGINE` (`parseEngine`, `loadEngine`), `registerElementRoom(factory)`, the `ElementRoomService` interface (`connect(session, socket) → handle`, `routes()`, `metrics()`, `closeAll()`, and the `SessionDirectory` the access monitor and session-end reporter use), `ElementRoomDeps`, `InternalRoute`, `registerPreOpenCheck(fn)` / `runPreOpenChecks` / `BoardOpenRefused` | lead |
| `src/rooms.ts` (one-time edit) | `runPreOpenChecks` inside `RoomRegistry.open()`, before the writable `new DatabaseSync(path)` | lead |
| `src/app.ts` (one-time edit) | with `engine: 'excalidraw'`: sockets go to `ElementRoomService.connect` after the unchanged Origin and ticket checks (same replaced-socket guard, message token bucket, join queue, access admission); the tldraw board routes are not mounted; the room's routes, `GET /internal/metrics` and (with the flag) the test routes are. With tldraw: a pre-open refusal closes with 4099 `NEW_CANVAS_BOARD` | lead |
| `src/http/router.ts` (one-time edit) | `engineRoutes`, `tldrawBoardRoutes`, `BoardOpenRefused` → 409 `new-canvas` | lead |
| `src/access.ts` (type only) | the monitor takes a `SessionDirectory` | lead |
| `src/server.ts` (one line) | `await loadEngine(config.engine)` before `createSyncServer` | lead |
| `src/test-hooks.ts`, the flag in `src/config.ts` | `DRAFTROOM_TEST_HOOKS=1` (refused with `NODE_ENV=production`), `registerTestHooks({snapshot, leaseHook, failCommit})`, the three routes (404 without the flag or without registered hooks) | lead |
| `src/config.ts` | `engine` (`DRAFTROOM_ENGINE`) and `testHooks` in `SyncConfig` | lead |
| `src/room/schema.ts` | the §2.6 DDL (`LB_DDL`, `ensureLbSchema`, `LB_PRAGMAS`), `lb_meta` keys and `ConvertedFrom`, the `gclock` JSON shape (`parseGclock`/`serializeGclock`), `lbPrevTable(cycle, table)` = `lb_prev_<cycle>_<suffix>` | lead (O1 and O4 OK needed) |
| `src/room/index.ts` | a STUB: `createElementRoomService` throws "not implemented (O1)"; importing it registers the factory | **O1** |
| `src/r0/index.ts` | EMPTY: `loadEngine('tldraw')` imports it; O4 registers its born-after check here | **O4** |
| `tsconfig.node-safe.json` | the Node-safety check (below) | lead |
| `test/room/arrows/**` | the arrow acceptance tests (below) | lead, frozen |
| `test/contracts/**` | the seam's own tests | lead |
| `package.json` | the dependency edges (below) | lead |

### `apps/web/src/canvas`

| File | Freezes | Owner after C0 |
|---|---|---|
| `sync/types.ts` | `EngineCore` (pure: server messages and scene snapshots in; pushes, lease messages and Saved state out; the derived-arrow marking with its pending-cause rule), `SceneAdapter`, `SceneSnapshot`/`GestureState`, `Transport` (inbound = parsed `ServerMessage` or the decoded `SnapshotFrame`), `LeaseTransport`/`LeaseConnect` (spike A's `LeaseClient` shape, implemented by the core and by `fakeServer.ts`), `SaveStatus`, `PushRecord`, `OfflineQueueStore`, `HeadlessClient` (for O1's protocol tests and O3's load generator) | lead |
| `sync/core/index.ts`, `sync/headless/index.ts` | STUBS (`createEngineCore`, `createHeadlessClient` throw "not implemented (O2)") | **O2** |
| `port.ts` | `CanvasPort` (§2.3.1): items, get, bounds, selection, viewport (Lobby's own fit), scene/screen, `transact`, `setTool`/`tool`, events, and the session reads the facade needs (`editingId`, `leaseHolder`, `collaborators`, `saveStatus`, `engine`) | lead |
| `registries.ts` | `createRegistries()`: key handlers, overlay layers, pointer tools, customData handlers; `hitGuard.isBlocked(scenePoint)` (O5 provides, O2 consults); `hidden.isHidden(id)` (O5 provides, O2's `selectAll.ts` and the box/lasso post-filter consult); `dragger.draggerOf(id)` (O2 provides, O5 reads); UI slots `toolbar`, `sheet`, `timer`; `registerInstaller` / `runInstallers` | lead |
| `test-facade.types.ts` | `window.lobbyCanvas`: the §6.3 verbs plus `hash()`, `pushedOps()`, `leaseState()`, `saveState()` | lead |
| `test-facade.ts` | EMPTY STUB `install(port, registries)` | **O3** (handed over) |
| `spike/features/index.ts` | EMPTY STUB `install(port, registries)` | **O5** (handed over) |
| `spike/installers.ts` | `installAll(port, registries)`: registers the facade's and the features' installers | lead |
| `spike/board/SpikeBoardPage.tsx` | a STUB page (App.tsx lazy-loads its default export) | **O2** |
| `history/fields.ts`, `history/apply.ts` | rewired at C0 to `groups.ts` (one map; `path` coupled in undo) | O2 (after B0) |
| `../App.tsx` | `/b/:boardId` → `SpikeBoardPage` only with `VITE_LOBBY_ENGINE=excalidraw` AND the inlined dev-auth guard | lead |

### `e2e/spike-b`

| File | Freezes | Owner after C0 |
|---|---|---|
| `support/types.ts` | `SpikeBStack`, `StackOptions`, `DevUser`, `BrowserProcess`, `Barrier`, `ForgeSocket`, `Snapshot`, `InvariantReport`, `ConvergenceReport`, `TestHooks` (`leaseGrant`, `failNextCommits`, `withLatency`, `cutSocket`, `restoreSocket`), the B10 recorder (`RecordPushes`, `PushLog`: `count()`, `ops()`, `byElement(id)`), and `SpikeBHarness`, the entry points every spec imports from `./harness.ts` | lead |
| `support/ports.ts` | the §8.6.5 table, `stackPorts(base)`, `SPIKE_B_PORT_BASE` | lead |
| `support/harness.ts` | a STUB `harness: SpikeBHarness` (every method throws "not implemented (O3)") | **O3** |
| `playwright.config.ts` | the build and serve of the spike board per stack (`dist/spike-b-<web port>`, output `e2e/test-results/spike-b-<web port>`); projects `chromium` and `b8-staging` (only with `SPIKE_B8_DIR`: output inside it, trace, video and screenshot off; specs `b8-staging-*.spec.ts`) | lead |
| `contracts/**` | the browser half of the hash check (no stack, no port bound) | lead |

### Other packages and root files

| File | Freezes | Owner after C0 |
|---|---|---|
| `packages/auth-tickets/src/index.ts` | A3: optional `guest?: true` claim (`signTicket({guest})`, `verifyTicket` refuses anything but `true`); uid ≤ 60 (`MAX_TICKET_UID_CHARS`) when signing and verifying | lead |
| `packages/tldraw-import/package.json` | the package with its six dependencies (below) | **O4** (handed over; a dependency change is still the lead's, the lockfile is) |
| `packages/tldraw-import/src/**`, `tsconfig.json` | an empty module | O4 |
| `pnpm-workspace.yaml`, catalog, `pnpm-lock.yaml`, `vitest.config.ts`, `vitest.arrows.config.ts`, `biome.json`, root `package.json`, `e2e/package.json` | below | lead |

## Lockfile

The only lockfile change of spike B, made at C0. No package was added to the store (`pnpm install
--offline`); the lockfile diff is importer edges and two catalog entries:

- catalog: `@tldraw/state` and `@tldraw/store` `5.4.2` (the plan's five MIT packages of `tldraw-import`,
  D13; three were in the catalog already);
- `packages/tldraw-import`: `@tldraw/tlschema`, `utils`, `store`, `state`, `validate` (catalog) and
  `@draftroom/canvas-schema` (workspace);
- `packages/canvas-schema`: `zod` (catalog; protocol.ts) and `@draftroom/contracts` (workspace; the tag and
  mind-map readers `custom-data.ts` reuses);
- `apps/sync`: `@draftroom/contracts` (O1's `file-refs.ts`/`workshop-state.ts` on `sync-internal.ts`),
  `@draftroom/tldraw-import` (O4's worker in `room/migrate/**`), `zod`; dev: `@excalidraw/element` (the
  acceptance tests' client copies only; Biome allows it in `apps/sync/test/room/arrows/**`).

## Node-safety rules

O1's sync tests and O3's load image import these web files across apps (spike only; wave 1 decides whether
they move into a package): `apps/web/src/canvas/sync/types.ts`, `sync/core/**`, `sync/headless/**`,
`canvas/history/**`, `canvas/lease/client.ts`. Their rules:

1. explicit `.ts` import extensions (as `apps/sync` uses with `nodenext`);
2. no DOM: no `window`, `document`, `navigator` or DOM lib types (no `lib: dom` at all);
3. no `import.meta.env`, no Vite-only imports (`?url`, `?raw`, `import.meta.glob`);
4. no `@excalidraw/excalidraw` (the React package); element helpers only through
   `@draftroom/canvas-schema/engine` (and `groups.ts`);
5. timers and time are injectable (`setTimer`, `now`) where tests need them.

Check: `pnpm exec tsc -p apps/sync/tsconfig.node-safe.json --noEmit` (`module`/`moduleResolution` `nodenext`,
`lib` `es2023`, `types` `["node"]`, tests excluded). It is part of every gate. Note: under `nodenext` the
engine's own `.d.ts` re-exports do not resolve, so server-side code types engine helpers itself (as
`engine/raw.ts` and `engine/linear.ts` do).

## The arrow acceptance tests (`apps/sync/test/room/arrows/`)

The recheck's probes (`scratchpad/critic-r34/lib.mjs`, `s1-*` to `s7-*`; `critic-r33/freeend-rel.mjs`,
`label-node.mjs`; `lead-r34/elbow-fixed2.mjs`; `lead-r35/drift-rot2.mjs`, `s3-elbow-undo.mjs`) ported to
vitest against **Lobby's real room**, with the recheck's pass conditions and every geometry within
`GEOMETRY_TOLERANCE_PX`:

- the server side is O1's room, in-process on a temp data dir, reached only through the frozen seam
  (`registerElementRoom`, `ElementRoomService.connect`, `registerTestHooks().snapshot`);
- the client side is a minimal protocol client (`support/room.ts` `TestClient`: hello, the gzip snapshot,
  `changes`, `ack`, the lease) that validates every server message with the frozen schemas and applies
  server patches with `overlayPatch`; its local copies are made and edited with Excalidraw's own helpers
  (`support/excalidraw.ts`); the derived test is `isDerivedArrowChange` from `groups.ts`; nothing of O2's is
  used;
- "on the target's edge" is `followError`: Excalidraw's own follow re-run on a copy of the STORED arrow and
  targets moves its bound ends by at most the tolerance.

| File | Scenario (pass) |
|---|---|
| `s1-freeend.test.ts` | a start-bound free end at C's drop (605, 400) in both orders, plain and rotated 0.6; start on X's new edge; the resizer's follow derived; B's and C's undos apply; C's map hashes equal to the snapshot. Client side: the literal rebase formula moves the rotated free end > 14 px (negative control) |
| `s1-sweep.test.ts` | 2,000 resizes, half rotated: no follow misclassified (roughness 0, and roughness 1 with fixed seeds, raw and rounded points); against the room, 2,000 races with C's 60 px drag first: no drag lost |
| `s2-midpoint.test.ts` | a curved midpoint kept against a move of X or Y in both orders, both undos; a self-loop's midpoints kept relative to its start; its repeated re-snaps settle within 4 writes (writes 5 and 6 change nothing) |
| `s3-elbow.test.ts` | an elbow segment kept across its axis in both orders against a move, a resize and rotations of 60° and 90°, on an orthogonal route; the rotator's follow derived; C's unit on top of a flipped flag, live and as an offline replay (`off` 11 min, not STALE); C's undo after the flip by order; B's undo of the rotation keeps C's segment |
| `s3-elbow-sweep.test.ts` | 1,500 random moves, resizes and rotations: 0 misclassified (client side) |
| `s4-frame.test.ts` | a frame drag (Excalidraw's `dragSelectedElements`) with a start- or end-bound arrow: not derived; free end and bend translated in both orders of the drag and the holder's fit (the stale fit `fitDropped`, re-fit applied) and both op orders; bound end on N's grown edge; A's undo |
| `s5-freetext.test.ts` | an arrow bound to a left- and a centre-aligned free text: the typist's follow derived; typing (with the centred text's own `x` as a fit) re-snaps the arrow; C's free end survives in both orders |
| `s6-twotargets.test.ts` | two targets moved at once, straight, curved, elbow, elbow with a fixed segment: both follows derived; both orders store the same arrow; each undo equals a fresh board with only the other move |
| `s7-angle-mix.test.ts` | a rotation racing a free-end drag: the later writer's whole version, both orders |
| `r33-freeend-rel.test.ts` | (605, 400); a points-only `path` patch is `INVALID` |
| `r33-label-node.test.ts` | the helper's (120, 37.5) then (220, 137.5) in Node; against the room, a re-snapped labelled arrow's label is where the helper puts it |
| `r34-elbow-fixed.test.ts` | the engine follow keeps x 400 (ends 50.01 → 150.01); against the room, the stored segment stays at x 400 |
| `r35-drift.test.ts` | 1,000 re-snaps at angles 0, 0.6 and 2.2: no free end creeps past the tolerance |

**How to run:** `pnpm test:arrows` (= `vitest run -c vitest.arrows.config.ts`, project
`sync-arrows-acceptance`), or one file: `pnpm exec vitest run -c vitest.arrows.config.ts
apps/sync/test/room/arrows/s1-freeend.test.ts`. They are **not** in the default `pnpm test` until M1; from
M1 on the lead moves the project into `vitest.config.ts` and they are part of every gate.

**At C0:** 85 tests in 13 files: **56 fail** (every room test, "not implemented (O1): apps/sync/src/room/index.ts createElementRoomService") and **29 pass** (the client-side tests). Every room test fails with "not implemented (O1)"; no test is skipped or marked
`todo`. The client-side tests (they need only `groups.ts`, `limits.ts` and the engine) pass. O1's room must
pass all of them before M1 (§8.6.4).

**Validated at C0 against a throwaway model of the recheck's own rules** (lead-r35 `lib35.mjs` behind the
frozen seam, never committed; a copy is in the lead's scratchpad `c0/model-room.ts.txt`): all 85 pass, 3 runs.
So the tests are passable by a correct room; they do not prescribe O1's design.

## Ports (§8.6.5)

Spike B uses **7850–7999** only; today's e2e defaults (5881, 5882, 4191), `E2E_PORT_BASE=6500` and spike A's
7700–7849 stay free. A stack uses sync = base, api = base + 1, web = base + 2 (`e2e/spike-b/support/ports.ts`).

| Who | Range | Stacks (base) |
|---|---|---|
| Lead | 7850–7859 | integration 7850 (also `SPIKE_WEB_PORT` of the spike A suite; its files server 7851; A8 probe 7853); the final pass's second stack 7855 |
| O1 room | 7860–7869 | dev stack 7860 |
| O2 web engine | 7870–7879 | 7870 |
| O3 harness | 7880–7899 | browser harness 7880; §8.4 measurements 7885; local load dry run 7890; B9's workstation half 7895 |
| O4 conversion | 7900–7909 | R0 stand-in 7900; Excalidraw stack 7905 (data, TEMP/TMP and output under `spike-b8/` when they touch staging copies) |
| O5 features | 7910–7919 | 7910 |
| V1, V2, V3 | 7920–7929, 7930–7939, 7940–7949 | one stack each at the range's base |
| Spare | 7950–7999 | assigned by the lead |

Each owner lists the listeners in its range before starting and after finishing, and leaves nothing
listening or running.

**Quiet windows (§8.6.4):** none scheduled yet; the lead posts each window here before any timing-gated run.

## Handover after C0 (§8.6.3)

The five files the plan hands over, plus the stubs C0 had to create in owners' folders so that the frozen
seams have something to import:

| File | To | Why it exists at C0 |
|---|---|---|
| `packages/canvas-schema/src/invariants.ts` | O1 | §8.6.2 (stub) |
| `packages/canvas-schema/src/engine/binding.ts` | O1 | §8.6.2 (stubs) |
| `packages/tldraw-import/package.json` | O4 | §8.6.2 |
| `apps/web/src/canvas/test-facade.ts` | O3 | §8.6.2 (empty installer) |
| `apps/web/src/canvas/spike/features/index.ts` | O5 | §8.6.2 (empty installer) |
| `apps/sync/src/room/index.ts` | O1 | the factory registration `loadEngine` and the acceptance tests import |
| `packages/canvas-schema/src/engine/linear.ts` | O1 | the engine read `groups.ts` needs (O1 owns `engine/**`) |
| `apps/sync/src/r0/index.ts` | O4 | `loadEngine('tldraw')` imports it |
| `packages/tldraw-import/src/index.ts`, `tsconfig.json` | O4 | so the package typechecks |
| `apps/web/src/canvas/sync/core/index.ts`, `sync/headless/index.ts` | O2 | import targets for O1's and O3's code |
| `apps/web/src/canvas/spike/board/SpikeBoardPage.tsx` | O2 | App.tsx's route target |
| `e2e/spike-b/support/harness.ts` | O3 | the import every spec uses |

Everything else listed above stays the lead's. `docs/PROGRESS.md` and `apps/web/build/**` stay untouched
until B0 is confirmed (§8.6.1).

## Decisions taken at C0 (the plan was silent or ambiguous)

1. **`vn` in server patch ops.** §2.4.2 lists `v`, `pv`, `updated` and `lobbyServer`. The convergence hash
   includes `versionNonce`, which the server owns, so a client could never hash equal to the snapshot. Server
   `p` ops carry `vn`, and receivers set it. (Found by running the acceptance tests on the model.)
2. **Per-op rejection.** `Push` validates ops fully; `ClientEnvelope` validates a push with its ops
   unchecked, so the server can answer a bad op `INVALID` in its place (§3.5 "Rejections are per op") and
   treat only an envelope failure as a malformed message. A rejected result's `id` is the op's id as sent
   (`''` when none).
3. **`plusOne:<uid>` = `true`.** §3.5 sizes the +1 budget as 200 keys of 60-character uids at "about 80 B",
   which only a short value fits (an epoch-ms value makes 85 B, 17 KB > 16 KiB). The order of +1s is not
   stored; readers order by uid.
4. **file-refs take bare version ids** (`ver_…`); sync strips `.p<n>` and checks the page against
   `pageCount`.
5. **The sync snapshot envelope** (`LobbyElementsSnapshot`) is frozen in `sync-internal.ts` though §8.6.2
   names only A1 and A2: the api's vote eligibility (R2) reads it, so O1 and O5 would both invent it.
6. **Welcome** carries either `catchUp` (full-element `c` ops since `since`) or a reset with the binary
   snapshot as the next frame; `drags` (active drags with ids) and `limits` are in it.
7. **Element ids** use the `CommentShapeRef` character set (`[A-Za-z0-9_.:-]{1,120}`), so every id can be an
   api object ref with no migration.
8. **The package root** of `canvas-schema` stays the tldraw schema; the contracts are subpaths, so the normal
   build carries no engine code.
9. **Catalog:** `@tldraw/store` and `@tldraw/state` were added (the instruction said the dependencies were
   already in the catalog; three of the plan's five were). Same versions as the lockfile already held.
10. **Test hooks and pre-open checks** are module-level registrations (`registerTestHooks`,
    `registerPreOpenCheck`), as the plan names them; the room unregisters on `closeAll`.
11. **In excalidraw mode** the tldraw board routes (snapshot, seed, deleted, asset-refs, place-notes,
    text) are not mounted: they would open tldraw storage on an element board file. `access-changed` and
    `backups/status` stay.
12. **Installer stubs are empty, not throwing** (§8.6.2 "empty stubs"), so O2's board page works before O3
    and O5 fill them.
13. **The arrow acceptance tests use Lobby's roughness 0** (the probes used Excalidraw's default 1; see
    findings) and pin the roughness-1 sweep with fixed seeds; the self-loop move test checks relative
    midpoints only (see findings); `s3` adds a resize of X (the row names "a move, a resize and rotations").

## Findings at C0 the owners must know (not in the plan)

1. **`moveMidPointsWithElement` is written onto arrows by the engine.** `LinearElementEditor.movePoints`
   spreads its `otherUpdates` into the element (E 11536-11540) and Excalidraw's own `updateBoundElements`
   passes `{moveMidPointsWithElement}` there (E 9114-9116). Every straight or curved arrow that followed a
   target carries this key in a browser, and a server re-snap with `movePoints` adds it too. The strict
   element schema refuses it. `groups.ts` classifies it (`engine-artifact`, in no group) and
   `stripEngineArtifacts` removes it: **O2's adapter strips it before diffing and pushing; O1 strips it
   before storing** (or hashes and schemas will not match).
2. **At roughness 1 the tolerance does not always hold for rotated arrows.** A rotated arrow's follow
   residual depends on the rough-shape seed (the curve's bounds, hence the rotation centre, jitter): in
   4 runs of the 2,000-case sweep with random seeds, one rotated follow was 0.53 px (> 0.5), so it would be
   classified as the resizer's own write and pushed from a stale copy. At roughness 0 (Lobby's
   `currentItemRoughness`) the residual is exactly 0. Revision 3.5's "0 of 2,000" was one random run.
   Pasted or converted arrows with roughness ≥ 1 are exposed; the owners decide (wave 3) whether Lobby
   forces roughness 0 on linear elements or widens the compare for them. Measured with the probes' own
   model (`scratchpad/c0/sweep-rough.mjs`).
3. **A self-loop is far from settled after its target moves.** On the recheck's own model, after X moves,
   repeated re-snaps shift the loop's start by 21.8, 1.53, 0.1 and 0.01 px before it settles
   (`scratchpad/c0/selfloop2.mjs`); §2.9.4's "a fraction of a pixel" holds only for an unchanged loop.
   Cosmetic, but a stored self-loop's ends are not on their binding points after one re-snap; O1 may re-snap
   self-loops to their fixed point (at most 4 iterations).
4. **Excalidraw's constructors default to roughness 1**, so every test element must set roughness 0 to
   match Lobby (the acceptance tests' helpers do).

## Lead decisions at the M1/M2 integration (no frozen file changed)

Recorded with the integration in `spike-b/M1-M2.md`:

1. **O1's op and byte budgets** park a push inside one burst before answering RATE (O1-room.md deviation 1):
   accepted for the spike, because the frozen arrow tests burst far above §2.4.5's budget. The frozen tests
   stay as they are.
2. **A port patch's `customData`** (port.ts `CanvasTx.update`/`create`) has the element field's shape,
   `{lobby: {key: value | null}}` (null removes a key); flat keys under `customData` are not read.
3. **`BrowserOptions.guest`** means a guest signed in by the harness, which is not available yet (the
   harness throws "not available"; R1's guest part stays NOT RUN on it). A spec that runs the A3 guest flow
   itself launches a dev-user browser.
4. **Not accepted now (not blocking)**: O3's `EngineCore.pendingLeases()` (O2 implements it; the facade
   reads it structurally, and a required member would break O3's facade test), O2/O3's additions to
   `support/types.ts` (`restoreSocket` options, `newTab`, `relayStats`), O4's `lb_source` schema text in
   `room/schema.ts` (wave 2D).

## Lead decisions at the M3 integration (recorded in `spike-b/M3.md`)

1. **Decision 3 above is superseded.** O3's harness now signs a name-only guest in through the product's
   invite page (`BrowserOptions.guest`; O3's `O3BrowserOptions.guestRole`: `viewer`, the default, is the
   limited guest; `commenter`, `editor`). A spec may use `guest: true`; specs that run the A3 flow themselves
   (O5's `b12-phone`, O2's `b5-r3-keys`) keep working and may switch.
2. **O1's CR `b5689e0` is accepted** (rev 4, change log below).
3. **Still deferred:** `EngineCore.pendingLeases()`, the `support/types.ts` additions, O4's `lb_source` schema
   text; O2's proposal of an idempotent offline-queue entry (a push id the room deduplicates, or the confirmed
   version per entry) touches `protocol.ts` or the queue format and needs O1's and O2's OK as a CR.

## Change log

| Rev | Date | Change | By |
|---|---|---|---|
| 1 | 2026-09-29 | C0 | lead |
| 2 | 2026-09-29 | `custom-data.ts`: `prompt`, `slot`, `swatch` (class 5 "free", `MarkerValue` = boolean or a 1-64 character string, 72 B, duplicate `keep`), which §3.3 lists and C0 left out; `limits.test.ts` name list. Additive: O1 validates them through the registry with no code change; O2/O5 clients may write them; O4's converter carries the template markers instead of `meta-dropped`. Accepted at M1 (CR `1370281` on `spike/b-convert`, applied as `bf11de0`) | O4 (CR), lead |
| 3 | 2026-09-29 | `apps/web/src/canvas/sync/types.ts`: `EngineCore.doc()` and `EngineCore.setDoc(set)` for `lb_doc` keys (O5's tags write `tagDef:<key>` before an element's `tag:<key>`, §3.3). Additive; O2's core implements both (`sync/core/engine.ts`), and a `setDoc` is sent no later than the element push after it. Accepted at M1 (CR `35f0ae2` on `spike/b-features`, applied as `ac9a358`) | O5 (CR), O2, lead |
| 4 | 2026-09-29 | `protocol.ts`: notice `PREPARING` (a joiner held while the room converts or rolls forward a tldraw board on open, §2.13 "Preparing this board…") and the terminal close reason `CONVERSION_FAILED` (4099; a failed lazy conversion or roll-forward, so joiners do not re-queue the job; the board stays on its tldraw tables, §5.3); a `PREPARING` round trip in `protocol.test.ts`. Additive. Accepted at M3 (CR `b5689e0` on `spike/b-room`, merged with `166850c`). Two ends: O1 (the CR); O2's end needs no code change (its core ignores a notice code it does not handle, `engine.ts` `case 'notice'`, and its page shows the closed state with `data-reason` for every 4099, `session.ts`); O2's explicit OK was not given in this round (O2 finished before the CR existed) and is asked for in the next one, with the page's "Preparing this board…" state. If O2 declines, reverting the CR needs no room change (the room reads both lists at run time: no notice, `MAINTENANCE`), but O1's `conversion.test.ts` would need its expectations changed | O1 (CR), lead |

## The C0 gate

Run on the working tree that became C0, Windows 11 workstation, Node 24.19.0, pnpm 10.34.5, Playwright
1.63.0; `bash docs/research/excalidraw/spike-b/scripts/integration-c0.sh` (logs in the lead's scratchpad
`c0/gate/`). The machine was shared with the fix round's re-verification (32 node processes, CPU at 62%).

| Gate (§8.6.2) | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,187 files, 0 errors, 0 warnings |
| typecheck (`pnpm -r typecheck`, 15 packages) + engine-probe tsc | PASS |
| `tsc -p apps/sync/tsconfig.node-safe.json --noEmit` | PASS |
| unit, every project (`vitest run`) | PASS: 3,466 passed, 33 skipped (baseline before C0: 3,382 passed, 33 skipped) |
| of which spike A's subset (web, canvas-schema, engine-probe) | PASS: 1,478 (spike A: 1,389) |
| the contract tests in it | zod round trips of every client and server message, the snapshot frame, the test-hook bodies and every `sync-internal` request, response and error body; the group coverage test over spike A's engine-built samples; the limit samples; `hash.ts` pinned digest in Node; the seam tests (`apps/sync/test/contracts/`) |
| `hash.ts` in Chromium (`pnpm --filter @draftroom/e2e spike-b:contracts`) | PASS: the same digest as Node for the sample map with 2 tombstones |
| asset/host-rewrite plugin unit tests | PASS 9/9 |
| arrow acceptance tests (`pnpm test:arrows`) | as expected at C0: 56 fail, 29 pass, 0 skipped |
| the whole spike A suite (`SPIKE_WEB_PORT=7850 pnpm --filter @draftroom/e2e spike`) | 68 passed, 2 skipped (opt-in), **1 failed**: `host-a16-pending.spec.ts` "type-to-edit on B, then grant", 16/20. See below |
| A8 browser probe | PASS |
| normal web build | PASS, **0 engine markers** (16 markers, incl. `@excalidraw/`, `Excalifont`, `spike-board-stub`, `lobbyCanvas`); no `excalidraw-assets/` |
| engine flag without the dev-auth guard | PASS, 0 marker files, no `excalidraw-assets/` |

**The one spike A failure.** `host-a16-pending.spec.ts` (the fix round's regression spec) failed one of its
"then grant" cases: IME text reached A's editor because A's grant arrived before the test's IME step. The
spike A pages import nothing C0 changed (`host-lab.tsx` imports the engine host, input, lease, presence and
tools modules, all untouched). Re-running that spec file alone on C0, 3 times: 1 case failed once
("p5 on B, then grant", 19/20), then 15/15 and 15/15. The same spec file on the B0 candidate
`45574c6` (a temporary worktree, SPIKE_WEB_PORT=7855), right after: 15/15 three times; then on C0 again
under the same conditions: 15/15 three times (CPU at 23% at the end). The failing cases are the "then grant"
variants, whose grant is a fixed timer (`GRANT_MS`: 300 ms, 1,500 ms for P5) racing the spec's own steps:
under load the grant lands before the IME step. The "manual-grant" variants never failed. So this is a
timing weakness of the fix round's spec under CPU load, not a C0 regression; reported to the fix round's
verification, and the lead runs timing-sensitive specs in the quiet windows.
