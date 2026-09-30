# Excalidraw migration, wave 1: the feature-facing canvas contracts

The wave-1 document of `docs/EXCALIDRAW-MIGRATION.md` (§7.1 "Before any parallel wave", §7.2 row 1). It freezes the API that the nine wave-3 owners port `apps/web/src/features/**` onto, so they can work in parallel without tldraw and without editing each other's files. Spike B's C0 contracts (`docs/research/excalidraw/spike-b/CONTRACTS.md`: canvas-schema, the wire protocol, `CanvasPort`, the C0 registries, the C0 facade) stay as they are; this document adds to them.

| | |
|---|---|
| Branch | `engine/excalidraw` (from `origin/spike/excalidraw` 92b1098, with `origin/main` 79f0125 merged as 6210fc5) |
| Freeze commit | the commit that adds this file (see `git log -- docs/EXCALIDRAW-CONTRACTS.md`) |
| Plan | revision 3.5 (`docs/EXCALIDRAW-MIGRATION.md`); spike B `CONTRACTS_REV` 4 |
| Engine | `@excalidraw/*` `0.18.0-1118751` (catalog, unchanged) |
| Lockfile | unchanged: every dependency waves 2–3 need is already in it (spike B's C0 added the engine and `tldraw-import` edges). "Lockfile PR #1" (§7.1) is therefore empty. |
| Gate | §11 |

## 0. What is frozen, and how to change it

After this commit the files below change only through a **change request to the contracts owner**: write what, why, and which owners it touches; the contracts owner applies it on `engine/excalidraw`, adds a line to §12 (change log) and every owner merges `engine/excalidraw`. Additive changes (a new optional field, a new registry entry type) are the normal case; a breaking change needs the OK of every owner that uses the member.

| File | Freezes | Owner after the freeze |
|---|---|---|
| `apps/web/src/canvas/api/lobby-canvas.ts` | `LobbyCanvas` (the C0 `CanvasPort` plus the members features need), `LobbyTx`, the namespaces, the event map, the value types | contracts |
| `apps/web/src/canvas/api/registries.ts` | `FeatureRegistries` (the C0 registries plus commands, keys, tools, menus, selection bar, panels, top bar, overlays, host slots, content handlers, cursor filter, menu state), `HOST_SLOTS` and their owners, `MENU_GROUPS` | contracts |
| `apps/web/src/canvas/api/feature.ts` | `CanvasFeature`, `CanvasFeatureContext`, `installCanvasFeatures`, `collectKeyClaims` / `keyConflicts`, `useCanvasFeatureContext` | contracts |
| `apps/web/src/canvas/api/{keys,geometry,items}.ts`, `apps/web/src/lib/signals.ts` | chords; plain geometry; element readers; the signals library | contracts |
| `apps/web/src/canvas/api/owners.ts` | the owner ids, `NotImplementedError`, `notImplemented` | contracts |
| `apps/web/src/canvas/api/tldraw-map.ts` | the map of every tldraw use (§6) and the file owners (§7) | contracts |
| `apps/web/src/canvas/api/facade.types.ts` | the wave-1 facade verbs (§9.2) | contracts (2E implements them) |
| `apps/web/src/canvas/api/index.ts` | the one import path of ported code | contracts |
| `apps/web/src/canvas/api/impl.ts` | only its **member table** `LOBBY_CANVAS_MEMBERS`; the body and `LobbyCanvasDeps` are 2C's | 2C |
| `apps/web/src/canvas/api/parts/*.ts` | the part signatures (`PartDeps`, each `create…Part`); the bodies are their owners' | 3a, 3b, 3c, 3e, 3g |
| `apps/web/src/features/canvas-registry.ts` | `CANVAS_FEATURES` (15 entries, one file per owner) | contracts |
| `e2e/tests/support/canvas.ts` | the helper signatures and types (§9.1) | 2E (bodies) |
| `e2e/excalidraw/playwright.config.ts` | how ported specs run (§9.3) | 2E |
| `biome.json` (the `**/ported/**` override) | ported code imports no tldraw, no engine, and only `canvas/api/index.ts` from the canvas | contracts |

**While spike B runs** (it is fixing the O2 lost-edit race in `canvas/sync/core`), spike B's owners still own `apps/sync/src/room/**`, `apps/sync/src/room/migrate/**`, `apps/web/src/canvas/{sync,lease,history,input,engine,presence,tools,overlay}/**`, `packages/tldraw-import/**` and `e2e/spike-b/**`; the lead merges their later fixes into `engine/excalidraw`. Nothing in this freeze edits those folders: the new API wraps the C0 port (`canvas/port.ts`, unchanged) instead of changing it.

## 1. Rules for porting a feature (wave 3)

1. **Both engines keep working until wave 4.** The default build (no `VITE_LOBBY_ENGINE`) is today's tldraw app and keeps passing its e2e suite. So a feature is ported **beside** its tldraw code, not over it:
   - ported code lives in `…/<feature>/ported/**` (the folders of §7.2, created at wave 1 with an empty `CanvasFeature`);
   - the tldraw files stay as they are. A shared pure module (a model, an api client, a formatter) may be edited by its feature's owner only if both builds and both suites still pass; a type-only tldraw import in it (`TLShapeId`) may become `string`;
   - wave 4 deletes the tldraw files and moves `ported/**` up.
2. **Imports.** Ported code reaches the canvas only through `apps/web/src/canvas/api/index.ts` and uses `lib/signals.ts` for reactive state. It never imports `tldraw`, `@tldraw/*` or `@excalidraw/*`, and never another `canvas/**` module. Biome enforces it (`biome.json`, override `apps/web/src/**/ported/**`), and so does `canvas/api/contracts.test.ts`.
3. **`ctx.editor` becomes `ctx.canvas`.** A feature exports a `CanvasFeature` (§4) from its `ported/index.tsx`; `features/canvas-registry.ts` already imports it. tldraw's `overrides`, `components`, `options` and `Overlay` become registry declarations (§3).
4. **Writes** go through `ctx.canvas.transact(label, fn)`: one undo step, pushed by the sync engine. A `transact` whose callback throws applies nothing (tldraw's `bailToMark`). Board settings go through `canvas.doc.set` (lb_doc). Nothing else writes the canvas.
5. **Reads are reactive.** Every `LobbyCanvas` read called inside `useValue`, `computed` or `react` re-runs when it may have changed (the implementation tracks a signal source per concern). Port `useValue('x', () => editor.getSelectedShapeIds(), [editor])` to `useValue('x', () => canvas.selection, [canvas])`.
6. **One page, scene coordinates, element ids.** tldraw pages, parent spaces and `shape:` ids are gone from canvas code: every element's `x`, `y` are scene coordinates; frames hold children through `frameId`; groups through `groupIds`; a note's text is its bound label. api object refs stay `shape:<id>` (canvas-schema `refs.ts`); `SINGLE_PAGE_ID` fills a contract that still carries a page id.
7. **Plain text through the lease.** `canvas.text.edit` opens the editor only after the server grants the lease; programmatic words go through `canvas.text.replace` (existing elements) or `create` props `text` (new ones). No rich text.
8. **Keys, menus, tools** are declared (commands with `kbd`, `FeatureKeySpec`, `FeatureToolSpec`, menu entries); the keyboard-map test (3a) reads `collectKeyClaims(CANVAS_FEATURES)` and fails on `keyConflicts`. Only the key allowlist (2C, `canvas/input/`) dispatches keys.
9. **Identity and permissions stay server-side.** `readOnly()` and role checks are UI hints; the server refuses writes. Identity-bearing `customData` keys (`plusOne:<uid>`, `ai`, `privateFrame`) are stamped or checked by the server (canvas-schema `custom-data.ts`). A new `customData.lobby` key or `lb_doc` key is a change request to canvas-schema.
10. **Stubs throw.** A member whose owner has not landed it throws `NotImplementedError(owner, member)`. Call it anyway where the feature needs it (the feature is then done when the owner lands the member), or ask the owner for an early version; never work around a stub by reaching into the engine.
11. **Specs** are ported to `e2e/excalidraw/<feature>-<topic>.spec.ts` with the helpers of §9; the tldraw specs stay until wave 4. Overlays carry `data-lobby-*` or `data-testid` attributes.

## 2. `LobbyCanvas` (`canvas/api/lobby-canvas.ts`)

### 2.1 What it adds to the C0 port

`LobbyCanvas extends CanvasPort` (C0): the C0 members keep their meaning (`items`, `get`, `bounds`, `selection`, `select`, `viewport.get/set/fit`, `sceneToScreen`, `screenToScene`, `transact`, `setTool`, `tool`, `on`, `editingId`, `leaseHolder`, `collaborators`, `saveStatus`, `engine`). Added:

- **Mode, DOM, keyboard:** `readOnly`, `container`, `focus`, `hasKeyboard`, `setCursor`, `theme`.
- **Pointer and hit testing:** `pointer` (scene and screen point, modifiers, over-canvas, button down), `gesture` (`idle`, `dragging`, `editing-text`, …), `hitTest(point, {margin, hitInside, selectedFirst, skipLocked, filter})`, `hovered`.
- **Reads:** `boundsOf(ids?)`, `visibleBounds(id)` (clipped by its frame), `isLocked`, `isHidden`, `hide(owner, ids)` (the render side of a mind-map collapse), `sceneToOverlay` / `overlayToScene` (overlay-root pixels).
- **`viewport`** (widened): `zoomTo`, `centerOn`, `ensureVisible`, `zoomStep`, `stop`, `moving`, `limits`, `screenRect`, `remeasure`; `set` and `fit` take `{animate, force}`.
- **`transact(label, fn, {joinPrevious})`** with **`LobbyTx`**: `createMany`, `reorder`, `setFrame`, `group`, `ungroup`, `bind`, `duplicate` besides C0's `create`, `update`, `delete`.
- **Namespaces:** `text` (`of`, `canEdit`, `edit`, `stop`, `editorElement`, `measure`, `replace`), `styles` (`next`, `setNext`, `of`, `apply`; values in the engine's field names), `presence` (`peers`, `peer`), `follow` (`current`, `start`, `stop`), `history` (`undo`, `redo`, `canUndo`, `canRedo`), `doc` (`get`, `entries`, `set`), `export` (`svg`, `png`, `canvas`, `copy`), `files` (`urlOf`, `status`, `insert`), `settings` (`get`, `set`).
- **Events** (`on`): `change` (created/updated/deleted with source `local`, `history` or `remote`), `input` (capture-phase pointer/wheel/key events with `handled()`), `toolChanged`, `editingChanged`, `resize`, `docChanged`, `followChanged`, besides C0's `changed`, `selectionChanged`, `viewportChanged`, `pointer`.

### 2.2 Who implements what

The board page (2C) builds the canvas with `createLobbyCanvas({port, registries, board})` (`canvas/api/impl.ts`; `board` is the page's engine handles, `canvas/board/handles.ts`). The C0 members delegate to the port, the reads are reactive (a signal source per concern), and 22 members are composed from port members alone (wave 1's seven, 2C's `text.of`, `visibleBounds`, `sceneToOverlay`, `overlayToScene` and the six structural `tx` writes of `canvas/board/tx.ts`, and 3b's five camera members of `canvas/api/parts/navigation.ts`, CR 3b-1). 2C's other members are the board page's (status `board`): real when the page passes its `board` handles, a stub naming 2C on a bare port (as in the unit tests). Every member of a wave-3 owner is a stub naming its owner until the owner lands its part (W1-2); a landed part composed from the canvas's own members is listed in `COMPOSED_BY_PARTS` and is `composed` (CR 3b-1). The table is generated from `LOBBY_CANVAS_MEMBERS`; the contracts test fails when the object, the table and the `@owner` annotations in `lobby-canvas.ts` disagree.

#### The member table (generated from `LOBBY_CANVAS_MEMBERS`)

| Member | Owner | Today |
|---|---|---|
| `items` | 2C | C0 port (real) |
| `get` | 2C | C0 port (real) |
| `bounds` | 2C | C0 port (real) |
| `selection` | 2C | C0 port (real) |
| `select` | 2C | C0 port (real) |
| `viewport.get` | 2C | C0 port (real) |
| `viewport.set` | 2C | C0 port (real) |
| `viewport.fit` | 2C | C0 port (real) |
| `sceneToScreen` | 2C | C0 port (real) |
| `screenToScene` | 2C | C0 port (real) |
| `transact` | 2C | C0 port (real) |
| `setTool` | 2C | C0 port (real) |
| `tool` | 2C | C0 port (real) |
| `on` | 2C | C0 port (real) |
| `editingId` | 2C | C0 port (real) |
| `leaseHolder` | 2C | C0 port (real) |
| `collaborators` | 2C | C0 port (real) |
| `saveStatus` | 2C | C0 port (real) |
| `engine` | 2C | C0 port (real) |
| `tx.create` | 2C | C0 port (real) |
| `tx.update` | 2C | C0 port (real) |
| `tx.delete` | 2C | C0 port (real) |
| `on:changed` | 2C | C0 port (real) |
| `on:selectionChanged` | 2C | C0 port (real) |
| `on:viewportChanged` | 2C | C0 port (real) |
| `on:pointer` | 2C | C0 port (real) |
| `boundsOf` | 2C | composed (real) |
| `isHidden` | 2C | composed (real) |
| `isLocked` | 2C | composed (real) |
| `doc.get` | 2C | composed (real) |
| `doc.entries` | 2C | composed (real) |
| `doc.set` | 2C | composed (real) |
| `tx.createMany` | 2C | composed (real) |
| `transact.joinPrevious` | 2C | board page (real with the board handles) |
| `viewport.zoomTo` | 3b | composed (real) |
| `viewport.centerOn` | 3b | composed (real) |
| `viewport.ensureVisible` | 3b | composed (real) |
| `viewport.zoomStep` | 3b | composed (real) |
| `viewport.stop` | 2C | board page (real with the board handles) |
| `viewport.moving` | 2C | board page (real with the board handles) |
| `viewport.limits` | 3b | composed (real) |
| `viewport.screenRect` | 2C | board page (real with the board handles) |
| `viewport.remeasure` | 2C | board page (real with the board handles) |
| `readOnly` | 2C | board page (real with the board handles) |
| `container` | 2C | board page (real with the board handles) |
| `focus` | 2C | board page (real with the board handles) |
| `hasKeyboard` | 2C | board page (real with the board handles) |
| `setCursor` | 2C | board page (real with the board handles) |
| `pointer` | 2C | board page (real with the board handles) |
| `gesture` | 2C | board page (real with the board handles) |
| `hitTest` | 2C | board page (real with the board handles) |
| `hovered` | 2C | board page (real with the board handles) |
| `visibleBounds` | 2C | composed (real) |
| `hide` | 2C | board page (real with the board handles) |
| `sceneToOverlay` | 2C | composed (real) |
| `overlayToScene` | 2C | composed (real) |
| `theme` | 2C | board page (real with the board handles) |
| `text.of` | 2C | composed (real) |
| `text.canEdit` | 2C | board page (real with the board handles) |
| `text.edit` | 2C | board page (real with the board handles) |
| `text.stop` | 2C | board page (real with the board handles) |
| `text.editorElement` | 2C | board page (real with the board handles) |
| `text.measure` | 2C | board page (real with the board handles) |
| `text.replace` | 2C | board page (real with the board handles) |
| `styles.next` | 2C | board page (real with the board handles) |
| `styles.setNext` | 2C | board page (real with the board handles) |
| `styles.of` | 3a | part (real) |
| `styles.apply` | 3a | part (real) |
| `presence.peers` | 2C | board page (real with the board handles) |
| `presence.peer` | 2C | board page (real with the board handles) |
| `follow.current` | 3c | stub |
| `follow.start` | 3c | stub |
| `follow.stop` | 3c | stub |
| `history.undo` | 2C | board page (real with the board handles) |
| `history.redo` | 2C | board page (real with the board handles) |
| `history.canUndo` | 2C | board page (real with the board handles) |
| `history.canRedo` | 2C | board page (real with the board handles) |
| `export.svg` | 3e | stub |
| `export.png` | 3e | stub |
| `export.canvas` | 3e | stub |
| `export.copy` | 3e | stub |
| `files.urlOf` | 3g | part (real) |
| `files.status` | 2C | board page (real with the board handles) |
| `files.insert` | 3g | part (real) |
| `settings.get` | 2C | board page (real with the board handles) |
| `settings.set` | 2C | board page (real with the board handles) |
| `tx.reorder` | 2C | composed (real) |
| `tx.setFrame` | 2C | composed (real) |
| `tx.group` | 2C | composed (real) |
| `tx.ungroup` | 2C | composed (real) |
| `tx.bind` | 2C | composed (real) |
| `tx.duplicate` | 2C | composed (real) |
| `on:change` | 2C | board page (real with the board handles) |
| `on:input` | 2C | board page (real with the board handles) |
| `on:toolChanged` | 2C | board page (real with the board handles) |
| `on:editingChanged` | 2C | board page (real with the board handles) |
| `on:resize` | 2C | board page (real with the board handles) |
| `on:docChanged` | 2C | board page (real with the board handles) |
| `on:followChanged` | 3c | stub |

99 members: 26 C0 port, 17 composed, 39 board page, 2 landed parts, 15 stubs (3b 5, 3c 4, 3e 4, 3g 2).

### 2.3 Parts: no owner edits another owner's file

The members owned by wave-3 owners are built in their own module under `canvas/api/parts/` and spread into the canvas by `impl.ts`: `navigation.ts` (3b: `viewport.zoomTo`, `centerOn`, `ensureVisible`, `zoomStep`, `limits`), `styles.ts` (3a: `styles.of`, `styles.apply`), `follow.ts` (3c: `follow.*`, `on('followChanged')`), `export.ts` (3e: `export.*`), `files.ts` (3g: `files.urlOf`, `files.insert`). A part gets `PartDeps` (`port`, `registries`, `self()` for the whole canvas); one that needs the engine reads the board page's handles through `canvas/overrides.ts` `boardEngineOf(registries)` and writes only through `self().transact`. Parts live in `canvas/**`, so they may import `@excalidraw/*`.

## 3. Registries (`canvas/api/registries.ts`)

`FeatureRegistries extends CanvasRegistries` (C0). `createFeatureRegistries()` makes one set per board page; a change to any registry notifies `subscribe` listeners (the board page re-renders its chrome).

| Registry | Entry | Replaces (tldraw) | Rendered or dispatched by | Contributed by |
|---|---|---|---|---|
| `keys` (C0) | `KeyHandlerSpec` | `overrides.actions[].kbd`, `editor.on('event')` key handling | 2C's capture-phase allowlist (`canvas/input/`) | through `commands` and `featureKeys` (the installer adapts them) |
| `commands` | `CommandSpec` (`id`, `label`, `kbd`, `scope`, `readOnlyAllowed`, `enabled`, `run`) | `overrides.actions` | menus, toolbar, shortcuts dialog (3a); keys (2C) | every feature |
| `featureKeys` | `FeatureKeySpec` (chords, `match`, `handle` with the context) | stateful key handlers (type-to-edit, mind-map Tab/Enter) | 2C (via `keys`) | 3a, 3d, 3i |
| `tools` / `pointerTools` (C0) | `FeatureToolSpec` (label, kbd, `readOnlyAllowed`, cursor, toolbar slot, pointer callbacks) | `overrides.tools`, `StateNode` tools (`root.addChild`) | 2C's custom-tool dispatch; 3a's toolbar | 3c (comment), 3f (vote), 3g (open-card) |
| `contextMenu`, `mainMenu` | `MenuEntrySpec` (group, order, label, command or `run`, `visible`, `disabled`, `checked`, submenu, custom row) | `DefaultContextMenu`, `DefaultMainMenu`, `TldrawUiMenu*` | 3a's menu shells (host slots) | every feature |
| `selectionBar` | `SelectionBarItemSpec` | canvas-ux `SelectionBar` and the buttons AI and tags add | 3a's selection-bar shell | 3a, 3d, 3h |
| `panels` | `CanvasPanelSpec` | `BoardFeature.panels` | 2C's dock (the ported `FeatureDock`) | as today |
| `topBar` | `TopBarItemSpec` (pinned, overflow caption) | `BoardFeature.TopBarItem`, `PINNED_TOP_BAR_FEATURES`, `OVERFLOW_CAPTION` | 2C's top bar | as today |
| `featureOverlays` | `FeatureOverlaySpec` (`scene` or `screen` layer, order, pointer, `focusMode: show/hide`) | `BoardFeature.Overlay`, `InFrontOfTheCanvas`, `ShapeWrapper`, `CollaboratorCursor` | 2C's overlay root | 3c, 3d, 3e, 3f, 3g, 3h |
| `hostSlots` | one component per `HostSlotName` | `components.Toolbar`, `StylePanel`, `ContextMenu`, `MainMenu`, `KeyboardShortcutsDialog`, `NavigationPanel` | 2C's board page | the slot's owner (below) |
| `contentHandlers` | `ContentHandlerSpec` (kinds, priority, `handle`) | `registerExternalContentHandler`, `putExternalContent` | 2C's paste/drop listeners, `files.insert` | 3b (paste as notes), 3g (files) |
| `customData` (C0) | `CustomDataHandlerSpec` (`onDuplicate`) | `onDuplicate` of meta keys | 2C's `onDuplicate` | 3d (mind-map relink), 3e (`present.index`) |
| `cursorVisible` | provider `(sid) => boolean` | `components.CollaboratorCursor` (present-aware cursor), "hide cursors" | 2C's cursor layer | 3e (present), 3f (hide cursors) |
| `menusOpen` | provider `() => boolean` | `editor.menus.hasAnyOpenMenus()` | anyone | 3a |
| `hitGuard`, `hidden`, `dragger`, `slots`, `overlays` (C0) | as C0 | — | as C0 | as C0 (`hidden` through `canvas.hide`) |

**Focus mode** (`canvas.settings` `focusMode`, set by present mode): the board page hides its chrome (dock, top bar, host slots) and every overlay layer except those with `focusMode: 'show'`.

**Host slots** (one provider each; a second is refused and logged): `toolbar`, `stylePanel`, `contextMenu`, `mainMenu`, `shortcutsDialog`, `selectionBar` (3a), `navigation` (3b), `phoneSheet`, `liveRegion` (3i).

## 4. `CanvasFeature` and `CanvasFeatureContext` (`canvas/api/feature.ts`)

`CanvasFeatureContext` is today's `FeatureContext` (`features/types.ts`) with `editor` replaced by `canvas: LobbyCanvas` and `registries: FeatureRegistries` added; `board`, `role`, `me`, `workspace`, `api`, `events`, `notify`, `dismiss`, `openPanel`, `activePanel` are unchanged. Components the board page renders get it from `useCanvasFeatureContext()` (panels and top-bar items also get it as `ctx`).

| `BoardFeature` (tldraw page) | `CanvasFeature` (Excalidraw page) |
|---|---|
| `id` | `id` |
| `panels: FeaturePanel[]` | `panels: CanvasPanelSpec[]` (same fields plus `order`; `Component` → `component`, `icon` is a component) |
| `TopBarItem` | `topBar: TopBarItemSpec[]` (`pinned`, `overflowCaption` move from FeatureHost into the entry) |
| `Overlay` (child of `<Tldraw>`) | `overlays: FeatureOverlaySpec[]` |
| `overrides.actions` | `commands: CommandSpec[]` (with `kbd`) |
| `overrides.tools` | `tools: FeatureToolSpec[]` |
| `overrides.translations` | the feature's own strings (`langCode` is `'en'`) |
| `components.Toolbar` / `StylePanel` / `ContextMenu` / `MainMenu` / `KeyboardShortcutsDialog` / `NavigationPanel` | `slots` (host slots, §3) |
| `components.ShapeWrapper` / `CollaboratorCursor` | `overlays` / `registries.cursorVisible` |
| context-menu content added inside `DefaultContextMenu` | `contextMenu: MenuEntrySpec[]` |
| selection-bar buttons | `selectionBar: SelectionBarItemSpec[]` |
| `registerExternalContentHandler` in `onMount` | `contentHandlers: ContentHandlerSpec[]` |
| `options.maxShapesPerPage`, `cameraMovingTimeoutMs` | canvas-schema `limits.ts` (server-enforced); 2C's engine config |
| `onMount(ctx)` | `onMount(ctx)` (after the first `welcome`) |

`installCanvasFeatures(CANVAS_FEATURES, ctx)` (the board page calls it once per canvas) registers every static declaration in feature order, adapts commands with `kbd`, feature keys and tools to the C0 `keys` and `pointerTools` registries, runs each `onMount` (a throw is logged, the others still mount), and returns one cleanup that undoes everything in reverse.

## 5. Signals and helpers

- **`lib/signals.ts`** replaces tldraw's `atom`, `computed`, `react`, `transact`, `useValue` and `unsafe__withoutCapture` (→ `untracked`) with the same shapes, plus `source` (a value-less signal adapters track and bump) and `subscribeValue`. Computeds are lazy and cached; effects run once per batch and not when a computed keeps its value; an effect that writes what it read re-runs, and a runaway loop throws after 1,000 rounds; an unobserved computed holds no reference from its dependencies. 9 unit tests.
- **`canvas/api/geometry.ts`** replaces `Box`, `Vec`, `Mat`: `rect`, `center`, `union`, `fromPoints`, `expand`, `translate`, `containsPoint`, `containsRect`, `intersects`, `intersection`, `distance`, `sameRect`, `corners` (rotated like Excalidraw).
- **`canvas/api/items.ts`** replaces shape types and parent chains: `itemKindOf` (note, text, label, shape, arrow, line, draw, highlight, image, file-card, frame), `labelOf`, `containerOf`, `textOf`, `arrowsOf`, `arrowEnds`, `childrenOf`, `outerGroupOf`, `groupMembers`, `contentItems`, `lobbyValue`, `lobbyEntries`.
- **`canvas/api/keys.ts`**: chords (`'mod+shift+f'`, `'alt+1'`, `'shift+f10'`), `matchChord` (letters and digits on `code`, so Alt+1 on a Mac and non-Latin layouts match; exact modifier sets), `formatChord` per platform.

## 6. The tldraw map

The tables below are generated by `docs/research/excalidraw/wave1/gen-contract-tables.ts` from the frozen sources. `canvas/api/tldraw-map.ts` maps every `editor.*` member and every imported tldraw symbol used in `apps/web/src` outside `canvas/` (168 files: 137 distinct members, 201 distinct symbols) to its replacement. Target notation: `canvas:<member>` (a LobbyCanvas member; `on:<event>` an event), `registry:<key>`, `context:<key>`, `helper:<module>.<fn>`, `schema:<module>.<export>`, `type:<Name>`, `feature:<owner>` (the owner computes it over `items()`), `dropped` (with the reason). The test scans the tree: a new member, a new symbol or a new file with tldraw and no owner fails it, and so does a target the API does not have.

### 6.1 `editor.*` members → replacement (generated)

| `editor.` member | Uses (files) | Replacement | Implemented by | Note |
|---|---|---|---|---|
| `getShape` | 149 (39) | `canvas:get` | 2C |  |
| `getShapePageBounds` | 58 (22) | `canvas:bounds` | 2C | axis-aligned, rotation included |
| `getCurrentPageId` | 56 (23) | `dropped` | — | one page; send SINGLE_PAGE_ID where a contract still carries a page id (C1) |
| `getContainer` | 53 (29) | `canvas:container` | 2C |  |
| `getIsReadonly` | 45 (28) | `canvas:readOnly` | 2C |  |
| `getSelectedShapeIds` | 35 (22) | `canvas:selection` | 2C | hidden (collapsed) ids already filtered out |
| `run` | 34 (13) | `canvas:transact` | 2C | `run(fn, {history: 'ignore'})` around selection or camera changes needs no transact |
| `getEditingShapeId` | 28 (15) | `canvas:editingId` | 2C |  |
| `focus` | 27 (14) | `canvas:focus` | 2C |  |
| `markHistoryStoppingPoint` | 26 (14) | `canvas:transact` | 2C | the transact label is the undo step |
| `getViewportPageBounds` | 25 (17) | `canvas:viewport.get` | 2C |  |
| `getInstanceState` | 24 (16) | `canvas:readOnly`, `canvas:hasKeyboard`, `canvas:pointer`, `canvas:follow.current`, `canvas:styles.next`, `canvas:settings.get` | 2C, 3c | isReadonly → readOnly, isFocused → hasKeyboard, isHoveringCanvas → pointer().overCanvas, followingUserId → follow.current, stylesForNextShape → styles.next, isFocusMode → settings.get().focusMode, exportBackground → ExportOptions.background |
| `getSortedChildIdsForParent` | 23 (11) | `helper:items.childrenOf`, `canvas:items` | contracts, 2C | a frame’s children; the page’s children are items() in paint order |
| `getViewportScreenBounds` | 22 (12) | `canvas:viewport.screenRect` | 2C |  |
| `isShapeOrAncestorLocked` | 20 (14) | `canvas:isLocked` | 2C |  |
| `select` | 20 (14) | `canvas:select` | 2C |  |
| `getAncestorPageId` | 19 (13) | `dropped` | — | one page |
| `pageToViewport` | 19 (9) | `canvas:sceneToOverlay` | 2C |  |
| `zoomToBounds` | 18 (14) | `canvas:viewport.zoomTo` | 3b |  |
| `getZoomLevel` | 17 (13) | `canvas:viewport.get` | 2C | viewport.get().zoom |
| `isShapeHidden` | 17 (10) | `canvas:isHidden` | 2C |  |
| `store` | 17 (13) | `canvas:on:change`, `canvas:items`, `canvas:doc.set` | 2C | listen → on("change") (source local/history/remote); allRecords/query → items(); put of document meta → doc.set; _flushHistory → dropped (changes are reported per batch) |
| `updateShapes` | 16 (6) | `canvas:tx.update` | 2C |  |
| `getCamera` | 14 (6) | `canvas:viewport.get` | 2C | camera {x, y, z} → viewport {x, y, width, height, zoom} (scene rectangle) |
| `getCurrentPageShapeIds` | 14 (8) | `canvas:items` | 2C |  |
| `getCurrentPageShapes` | 14 (11) | `canvas:items` | 2C |  |
| `getCurrentToolId` | 14 (11) | `canvas:tool` | 2C |  |
| `inputs` | 14 (8) | `canvas:pointer`, `canvas:gesture` | 2C | getCurrentPagePoint → pointer().scene, getCurrentScreenPoint → pointer().screen, getShiftKey → pointer().shift, getIsDragging → gesture(), keys → the key event |
| `markEventAsHandled` | 14 (6) | `canvas:on:input`, `registry:keys` | 2C, registry | event.handled(); a key handler that returns true is stopped and prevented |
| `isIn` | 13 (11) | `canvas:gesture` | 2C | isIn('select.idle') → gesture() === 'idle' |
| `off` | 13 (11) | `canvas:on` | 2C | on() returns the unsubscribe |
| `on` | 13 (11) | `canvas:on` | 2C | 'event' → input, 'resize' → resize, 'stop-following' → followChanged, 'unmount' → the feature cleanup |
| `updateShape` | 13 (6) | `canvas:tx.update` | 2C |  |
| `createShape` | 12 (5) | `canvas:tx.create` | 2C |  |
| `getSelectedShapes` | 11 (10) | `canvas:selection`, `canvas:get` | 2C |  |
| `setCurrentPage` | 11 (7) | `dropped` | — | one page |
| `getOnlySelectedShape` | 10 (9) | `canvas:selection` | 2C | selection.length === 1 |
| `getShapeAtPoint` | 10 (7) | `canvas:hitTest` | 2C |  |
| `options` | 10 (7) | `dropped` | — | animationMediumMs → CAMERA_ANIMATION_MS; maxShapesPerPage → canvas-schema limits (MAX_ITEMS); maxPages → one page |
| `timers` | 10 (5) | `dropped` | — | plain setTimeout/requestAnimationFrame, cleared in the feature cleanup |
| `createShapes` | 9 (6) | `canvas:tx.createMany` | 2C |  |
| `getDocumentSettings` | 9 (4) | `canvas:doc.get` | 2C | meta.drStartView → startView, drWorkshop → workshop, drTagList:<k> → tagDef:<k> |
| `menus` | 9 (6) | `registry:menusOpen` | registry | hasAnyOpenMenus/hasOpenMenus → registries.menusOpen.call() |
| `getCollaborators` | 8 (5) | `canvas:collaborators`, `canvas:presence.peers` | 2C | roster (uncapped) vs streamed cursors |
| `getShapePageTransform` | 8 (3) | `canvas:get`, `helper:geometry.corners` | 2C, contracts | no parent transforms: x, y are scene coordinates; rotation = angle |
| `reparentShapes` | 8 (4) | `canvas:tx.setFrame`, `canvas:tx.reorder` | 2C |  |
| `setCamera` | 8 (7) | `canvas:viewport.set` | 2C |  |
| `setCurrentTool` | 8 (6) | `canvas:setTool`, `canvas:text.edit` | 2C | 'select.editing_shape' → text.edit (through the lease); tool ids per BUILT_IN_TOOLS ('draw' → 'freedraw', 'geo' → 'rectangle'/'ellipse'/'diamond') |
| `undo` | 8 (2) | `canvas:history.undo` | 2C |  |
| `getAsset` | 7 (5) | `helper:items.lobbyValue`, `canvas:files.urlOf` | contracts, 3g | file facts are customData.lobby.file on the element; no asset records |
| `getBindingsFromShape` | 7 (4) | `helper:items.arrowEnds` | contracts |  |
| `getPointInShapeSpace` | 7 (5) | `canvas:get`, `helper:geometry.translate` | 2C, contracts | subtract the element’s x, y |
| `getSelectionPageBounds` | 7 (6) | `canvas:boundsOf` | 2C |  |
| `getShapeAndDescendantIds` | 7 (5) | `helper:items.childrenOf`, `helper:items.groupMembers`, `helper:items.labelOf` | contracts |  |
| `stopFollowingUser` | 6 (4) | `canvas:follow.stop` | 3c |  |
| `updateDocumentSettings` | 6 (3) | `canvas:doc.set` | 2C |  |
| `deleteShapes` | 5 (2) | `canvas:tx.delete` | 2C |  |
| `getPage` | 5 (4) | `dropped` | — | one page; legacy page names come from lb_doc.import.legacyPages |
| `setEditingShape` | 5 (2) | `canvas:text.edit`, `canvas:text.stop` | 2C |  |
| `setSelectedShapes` | 5 (5) | `canvas:select` | 2C |  |
| `canEditShape` | 4 (2) | `canvas:text.canEdit` | 2C |  |
| `getCurrentPageBounds` | 4 (3) | `canvas:boundsOf` | 2C | boundsOf([]) is empty; boundsOf() with no selection is every item |
| `getPointInParentSpace` | 4 (1) | `canvas:get` | 2C | scene coordinates everywhere |
| `getShapeAncestors` | 4 (4) | `helper:items.containerOf`, `helper:items.outerGroupOf`, `canvas:get` | contracts, 2C | frameId for the frame |
| `getShapeGeometry` | 4 (4) | `canvas:bounds`, `helper:geometry.corners` | 2C, contracts |  |
| `getShapeMaskedPageBounds` | 4 (2) | `canvas:visibleBounds` | 2C |  |
| `getShapeUtil` | 4 (2) | `canvas:text.of`, `helper:items.itemKindOf` | 2C, contracts |  |
| `registerExternalContentHandler` | 4 (2) | `registry:contentHandlers` | registry |  |
| `selectNone` | 4 (4) | `canvas:select` | 2C | select([]) |
| `startFollowingUser` | 4 (3) | `canvas:follow.start` | 3c | by session id (RosterEntry.sid) |
| `createBindings` | 3 (2) | `canvas:tx.bind` | 2C |  |
| `findShapeAncestor` | 3 (3) | `helper:items.containerOf`, `canvas:get` | contracts, 2C |  |
| `getCameraOptions` | 3 (3) | `canvas:viewport.limits` | 3b |  |
| `getCurrentTheme` | 3 (3) | `canvas:theme` | 2C |  |
| `getPages` | 3 (2) | `dropped` | — | one page |
| `getStyleForNextShape` | 3 (2) | `canvas:styles.next` | 2C |  |
| `getSvgString` | 3 (2) | `canvas:export.svg` | 3e |  |
| `root` | 3 (1) | `registry:tools` | registry | root.addChild(StateNode) → a FeatureToolSpec |
| `setCursor` | 3 (1) | `canvas:setCursor`, `registry:tools` | 2C, registry | a tool’s cursor is FeatureToolSpec.cursor |
| `stopCameraAnimation` | 3 (3) | `canvas:viewport.stop` | 2C |  |
| `updateViewportScreenBounds` | 3 (3) | `canvas:viewport.remeasure` | 2C |  |
| `zoomToSelectionIfOffscreen` | 3 (3) | `canvas:viewport.ensureVisible` | 3b |  |
| `canCreateShapes` | 2 (2) | `schema:limits.MAX_ITEMS` | contracts | the server cap counts items (a note and its label = 1) |
| `deleteShape` | 2 (2) | `canvas:tx.delete` | 2C |  |
| `findCommonAncestor` | 2 (2) | `helper:items.outerGroupOf`, `canvas:get` | contracts, 2C |  |
| `getAssets` | 2 (2) | `canvas:items` | 2C | file facts live on the elements (customData.lobby.file) |
| `getCameraState` | 2 (2) | `canvas:viewport.moving` | 2C |  |
| `getCanUndo` | 2 (1) | `canvas:history.canUndo` | 2C |  |
| `getCollaboratorsOnCurrentPage` | 2 (2) | `canvas:presence.peers` | 2C |  |
| `getColorMode` | 2 (2) | `canvas:theme` | 2C |  |
| `getCurrentPage` | 2 (2) | `dropped` | — | one page |
| `getCurrentPageShapesSorted` | 2 (2) | `canvas:items` | 2C | paint order |
| `getHitTestMargin` | 2 (2) | `canvas:hitTest` | 2C | HitTestOptions.margin |
| `getPath` | 2 (1) | `canvas:gesture`, `canvas:tool` | 2C |  |
| `getRichTextEditor` | 2 (2) | `canvas:text.editorElement` | 2C |  |
| `getShapeLocalTransform` | 2 (2) | `canvas:get` | 2C |  |
| `getShapeParent` | 2 (1) | `helper:items.containerOf`, `helper:items.outerGroupOf` | contracts |  |
| `isShapeOfType` | 2 (1) | `helper:items.itemKindOf` | contracts |  |
| `resolveAssetUrl` | 2 (2) | `canvas:files.urlOf` | 3g |  |
| `textMeasure` | 2 (2) | `canvas:text.measure` | 2C |  |
| `updateTheme` | 2 (2) | `dropped` | — | the note palette is 3a’s StyleValues mapping (canvas-ux/palette.ts); dark mode is the engine’s filter |
| `user` | 2 (2) | `canvas:settings.set`, `canvas:theme` | 2C | updateUserPreferences → settings.set; getIsDarkMode → theme() |
| `bailToMark` | 1 (1) | `canvas:transact` | 2C | throw inside the transact callback: nothing is applied |
| `cancel` | 1 (1) | `canvas:text.stop` | 2C | {cancel: true} |
| `complete` | 1 (1) | `canvas:text.stop` | 2C |  |
| `createAssets` | 1 (1) | `dropped` | — | no asset records: an image element carries fileId and customData.lobby.file (3g) |
| `deleteBindings` | 1 (1) | `canvas:tx.bind` | 2C | bind(arrow, end, null) |
| `dispatch` | 1 (1) | `dropped` | — | synthetic tldraw events; text.edit({initialText}) replays the first key |
| `disposables` | 1 (1) | `dropped` | — | the feature cleanup |
| `getBaseZoom` | 1 (1) | `canvas:viewport.limits` | 3b |  |
| `getBindingsToShape` | 1 (1) | `helper:items.arrowsOf` | contracts |  |
| `getCurrentPageShapesInReadingOrder` | 1 (1) | `feature:3i` | 3i | reading order over items() (§4.8) |
| `getEfficientZoomLevel` | 1 (1) | `canvas:viewport.get` | 2C | the level-of-detail zoom is viewport.get().zoom |
| `getHoveredShape` | 1 (1) | `canvas:hovered`, `canvas:get` | 2C |  |
| `getHoveredShapeId` | 1 (1) | `canvas:hovered` | 2C |  |
| `getOnlySelectedShapeId` | 1 (1) | `canvas:selection` | 2C |  |
| `getPageShapeIds` | 1 (1) | `canvas:items` | 2C |  |
| `getResizeScaleFactor` | 1 (1) | `dropped` | — | tldraw’s dynamic size mode |
| `getSelectedShapeAtPoint` | 1 (1) | `canvas:hitTest` | 2C | HitTestOptions.selectedFirst |
| `isDisposed` | 1 (1) | `dropped` | — | the feature cleanup runs before the canvas goes away |
| `isPointInShape` | 1 (1) | `canvas:hitTest` | 2C | HitTestOptions.filter |
| `isReplayingHistory` | 1 (1) | `canvas:on:change` | 2C | change.source === 'history' |
| `navigateToDeepLink` | 1 (1) | `feature:3b` | 3b | copy-link parser (?el=, ?view=, legacy ?d=) then select / viewport.zoomTo |
| `overlays` | 1 (1) | `dropped` | — | tldraw canvas overlays; Lobby overlays are DOM layers that take their own events |
| `pageToScreen` | 1 (1) | `canvas:sceneToScreen` | 2C |  |
| `putExternalContent` | 1 (1) | `canvas:files.insert` | 3g |  |
| `redo` | 1 (1) | `canvas:history.redo` | 2C |  |
| `screenToPage` | 1 (1) | `canvas:screenToScene` | 2C |  |
| `selectAdjacentShape` | 1 (1) | `feature:3i` | 3i | keyboard traversal (§4.8) |
| `selectFirstChildShape` | 1 (1) | `feature:3i` | 3i | keyboard traversal (§4.8) |
| `selectParentShape` | 1 (1) | `feature:3i` | 3i | keyboard traversal (§4.8), with helper items.containerOf |
| `setStyleForNextShapes` | 1 (1) | `canvas:styles.setNext` | 2C |  |
| `sideEffects` | 1 (1) | `canvas:on:change`, `canvas:transact.joinPrevious` | 2C | after-change handlers → on("change"); a derived write inside the user’s step → transact(…, {joinPrevious: true}) |
| `toggleLock` | 1 (1) | `canvas:tx.update` | 2C | {locked} |
| `toImage` | 1 (1) | `canvas:export.png` | 3e |  |
| `updateAssets` | 1 (1) | `canvas:tx.update` | 2C | customData.lobby.file.name (the only client-writable file field) |
| `updateInstanceState` | 1 (1) | `dropped` | — | read-only is the role’s interaction config (2C); e2e forges writes through a raw socket (§6.3) |

137 members mapped; 137 in use today.

### 6.2 Imported tldraw symbols → replacement (generated)

| Group | Owner | Symbols | Replacement | Note |
|---|---|---|---|---|
| editor | contracts | `Editor`, `useEditor` | `context:canvas`, `helper:feature.useCanvasFeatureContext` | Editor → LobbyCanvas (ctx.canvas); useEditor() → useCanvasFeatureContext().canvas |
| signals | contracts | `atom`, `Atom`, `computed`, `Computed`, `react`, `transact`, `useValue`, `unsafe__withoutCapture`, `isEqual` | `helper:signals.atom`, `helper:signals.computed`, `helper:signals.react`, `helper:signals.transact`, `helper:signals.useValue`, `helper:signals.untracked` | lib/signals.ts (same shapes); unsafe__withoutCapture → untracked; isEqual → the `isEqual` option or the feature’s own compare |
| records | contracts | `TLShape`, `TLShapeId`, `TLRecord`, `TLPageId`, `TLParentId`, `TLNoteShape`, `TLGeoShape`, `TLImageShape`, `TLArrowShape`, `TLShapePartial`, `TLArrowBinding`, `TLBindingCreate`, `TLInstancePageState`, `IndexKey`, `JsonObject`, `TLRichText`, `TLStoreSnapshot`, `RecordsDiff` | `type:CanvasElement`, `type:LobbyItemKind`, `type:CanvasChange` | elements are CanvasElement with string ids; kinds via items.itemKindOf; diffs are CanvasChange |
| ids | contracts | `createShapeId`, `isShapeId`, `createUserId` | `canvas:tx.create`, `schema:refs.toShapeRef`, `schema:refs.fromShapeRef` | tx.create returns the new id (props.id may choose one); api object refs stay shape:<id>; user ids are RosterEntry.uid |
| geometry | contracts | `Box`, `Vec`, `Mat`, `VecLike` | `helper:geometry.union`, `helper:geometry.center`, `helper:geometry.corners`, `type:Bounds`, `type:ScenePoint` | canvas/api/geometry.ts (plain rectangles and points; no parent spaces) |
| rich-text | 2C | `toRichText`, `renderPlaintextFromRichText`, `renderHtmlFromRichTextForMeasurement`, `startEditingShapeWithRichText` | `canvas:text.of`, `canvas:text.edit`, `canvas:text.measure`, `canvas:tx.create` | plain text only (§1 non-goals): create with props.text, read text.of, measure text.measure, edit text.edit |
| ui-kit | 3a | `TldrawUiMenuGroup`, `TldrawUiMenuItem`, `TldrawUiMenuSubmenu`, `TldrawUiMenuActionItem`, `TldrawUiMenuCheckboxItem`, `TldrawUiMenuToolItem`, `TldrawUiToolbar`, `TldrawUiToolbarButton`, `TldrawUiButtonIcon`, `DefaultContextMenu`, `DefaultContextMenuContent`, `DefaultMainMenu`, `DefaultToolbar`, `DefaultStylePanel`, `DefaultKeyboardShortcutsDialog`, `DefaultKeyboardShortcutsDialogContent`, `ArrangeMenuSubmenu`, `EditMenuSubmenu`, `EditSubmenu`, `ExportFileContentSubMenu`, `ReorderMenuSubmenu`, `MoveToPageMenu`, `ViewSubmenu`, `AccessibilityMenu`, `ColorSchemeMenu`, `InputModeMenu`, `ExtrasGroup`, `LockGroup`, `MiscMenuGroup`, `UndoRedoGroup`, `KeyboardShortcutsMenuItem`, `SelectAllMenuItem`, `UnlockAllMenuItem`, `CursorChatItem`, `ToggleDebugModeItem`, `ToggleDynamicSizeModeItem`, `ToggleEdgeScrollingItem`, `ToggleFocusModeItem`, `ToggleGridItem`, `TogglePasteAtCursorItem`, `ToggleSnapModeItem`, `ToggleToolLockItem`, `ToggleWrapModeItem`, `ToolbarItem`, `StylePanelSection`, `StylePanelSubheading`, `StylePanelColorPicker`, `StylePanelDashPicker`, `StylePanelFillPicker`, `StylePanelFontPicker`, `StylePanelGeoShapePicker`, `StylePanelLabelAlignPicker`, `StylePanelOpacityPicker`, `StylePanelSizePicker`, `StylePanelSplinePicker`, `StylePanelTextAlignPicker`, `StylePanelArrowKindPicker`, `StylePanelArrowheadPicker`, `useStylePanelContext`, `useTldrawUiComponents`, `useActions`, `useTools`, `useToasts`, `useTranslation`, `useBreakpoint`, `usePassThroughWheelEvents`, `useShowCollaborationUi`, `PORTRAIT_BREAKPOINT`, `EditorPortal`, `TLComponents`, `TLUiOverrides`, `TLUiOverrideHelpers`, `TLUiActionItem`, `TLUiActionsContextType`, `TLUiToolItem`, `TLUiToolsContextType`, `TLUiEventSource`, `TLUiContextMenuProps`, `TLUiMainMenuProps`, `TLUiStylePanelProps`, `TLUiKeyboardShortcutsDialogProps` | `registry:contextMenu`, `registry:mainMenu`, `registry:commands`, `registry:tools`, `registry:hostSlots`, `registry:selectionBar`, `context:notify` | Lobby’s own UI: 3a owns the menu, toolbar, style-panel and shortcuts shells (host slots) that render the registries; overrides.actions → commands, overrides.tools → tools, translations → the feature’s own strings, useToasts → ctx.notify, the breakpoint → CSS and matchMedia |
| shape-utils | 2C | `defaultShapeUtils`, `defaultBindingUtils`, `createTLSchemaFromUtils`, `GeoShapeUtil`, `NoteShapeUtil`, `FrameShapeUtil`, `BaseBoxShapeUtil`, `HTMLContainer`, `Group2d`, `Geometry2d`, `DefaultShapeWrapper`, `TLShapeWrapperProps`, `TLIndicatorPath`, `getDisplayValues`, `NoteShapeUtilDisplayValues`, `getArrowInfo`, `GeoShapeGeoStyle`, `StateNode` | `registry:featureOverlays`, `registry:tools`, `schema:groups.kindOf` | element types are Excalidraw’s (canvas-schema elements.ts); custom faces (file cards, tag chips) are overlays; StateNode tools are FeatureToolSpecs; converted tldraw data is 2D’s tldraw-import |
| store-sync | 2C | `createTLStore`, `TLStore`, `DocumentRecordType`, `PageRecordType`, `InstancePageStateRecordType`, `CameraRecordType`, `PointerRecordType`, `UserRecordType`, `AssetRecordType`, `TLDOCUMENT_ID`, `TLINSTANCE_ID`, `TLPOINTER_ID`, `HistoryManager`, `squashRecordDiffs`, `useSync`, `UseSyncOptions`, `UseSyncConnectFn`, `TLPersistentClientSocket`, `TLRemoteSyncError`, `TLSocketStatusChangeEvent`, `RemoteTLStoreWithStatus`, `* as tlsync`, `Tldraw`, `TldrawOptions`, `TLOnMountHandler` | `canvas:engine`, `canvas:saveStatus`, `canvas:history.undo`, `canvas:doc.get` | the sync engine core (canvas/sync), the Excalidraw host and Lobby’s undo replace the store, useSync and <Tldraw>; lb_doc replaces the document record |
| assets | 3g | `TLAsset`, `TLAssetId`, `TLImageAsset`, `TLAssetStore`, `TLAssetContext` | `canvas:files.urlOf`, `canvas:files.insert`, `canvas:files.status`, `helper:items.lobbyValue` | fileId = the Lobby version id; facts in customData.lobby.file; the loader is canvas/files (2C core, 3g placement) |
| styles-theme | 3a | `DefaultColorStyle`, `DefaultFontStyle`, `TLDefaultColorStyle`, `TLDefaultFillStyle`, `TLDefaultFontStyle`, `TLDefaultSizeStyle`, `getColorValue`, `getFontFamily`, `TLTheme`, `TLThemeColors`, `getUserPreferences`, `setUserPreferences`, `TLUser`, `TLUserStore` | `canvas:styles.next`, `canvas:styles.setNext`, `canvas:theme`, `canvas:settings.get`, `type:StyleValues` | StyleValues use the engine’s field names; the palette names are 3a’s; preferences are settings (local only) |
| input-events | 2C | `TLEventInfo`, `TLPointerEventInfo`, `TLKeyboardEventInfo` | `canvas:on:input`, `type:CanvasInputEvent`, `type:KeyEventLike` | capture-phase input stream and the key registry |
| presence | 2C | `TLInstancePresence`, `TLPresenceStateInfo`, `getDefaultUserPresence`, `createCachedUserResolve`, `TLCursorProps`, `DefaultCursor` | `canvas:presence.peers`, `canvas:collaborators`, `registry:cursorVisible` | identity comes from the ticket (roster); cursors are drawn by 2C’s overlay; features filter them through cursorVisible |
| export | 3e | `copyAs`, `getSvgAsImage`, `useSvgExportContext`, `useDelaySvgExport` | `canvas:export.svg`, `canvas:export.png`, `canvas:export.copy` | canvas/export (Excalidraw exportToSvg/Blob with Lobby’s font embedding) |
| deep-links | 3b | `createDeepLinkString`, `parseDeepLinkString` | `feature:3b` | new ?el= and ?view= links plus the legacy ?d= parser (§3.6, C2) |
| external-content | 3g | `defaultHandleExternalFileContent`, `defaultHandleExternalTextContent`, `TLDefaultExternalContentHandlerOpts` | `registry:contentHandlers`, `canvas:files.insert` | paste and drop go through contentHandlers (priority order); files through files.insert |

201 symbols in 16 groups.

## 7. Files and ported folders per owner

### 7.1 Files that use tldraw → porting owner (generated)

| Owner | Files (tests) | Files |
|---|---|---|
| 2C | 23 (8) | `board/BoardPage.tsx`, `board/EditingBadges.tsx`, `board/TopBar.tsx`, `board/note-label-cache.test.ts`, `board/note-label-cache.ts`, `board/pan-layer.test.ts`, `board/pan-layer.ts`, `board/presence.test.ts`, `board/presence.ts`, `board/touch-guard.ts`, `features/FeatureHost.tsx`, `features/types.ts`, `sync-quality/perPropUndo.test.ts`, `sync-quality/perPropUndo.ts`, `sync-quality/rebaseGuard.test.ts`, `sync-quality/rebaseGuard.ts`, `sync-quality/saveTracker.test.ts`, `sync-quality/saveTracker.ts`, `sync-quality/undoSteps.test.ts`, `sync-quality/uploads.test.ts`, `sync-quality/uploads.ts`, `sync-quality/useSaveStatus.ts`, `theme/tldraw-sync.ts` |
| 3a | 21 (4) | `features/canvas-ux/ContextMenu.tsx`, `features/canvas-ux/MainMenu.tsx`, `features/canvas-ux/Overlay.tsx`, `features/canvas-ux/ShortcutsDialog.tsx`, `features/canvas-ux/StylePanel.tsx`, `features/canvas-ux/Toolbar.tsx`, `features/canvas-ux/bridge.ts`, `features/canvas-ux/dblclick-note.ts`, `features/canvas-ux/export-gate.tsx`, `features/canvas-ux/index.tsx`, `features/canvas-ux/keyboard-scope.test.ts`, `features/canvas-ux/keyboard-scope.ts`, `features/canvas-ux/keyboard.ts`, `features/canvas-ux/keys.ts`, `features/canvas-ux/locked-hint-runtime.ts`, `features/canvas-ux/overrides.tsx`, `features/canvas-ux/palette.test.ts`, `features/canvas-ux/palette.ts`, `features/canvas-ux/ui-defaults.test.ts`, `features/keyboard-map.test.ts`, `ui/place-at-center.ts` |
| 3b | 15 (3) | `dashboard/search/content-search.test.ts`, `features/canvas-ux/FramesPanel.tsx`, `features/canvas-ux/NavigationPanel.tsx`, `features/canvas-ux/SearchPanel.tsx`, `features/canvas-ux/TemplatesPanel.tsx`, `features/canvas-ux/arrange-grid-runtime.ts`, `features/canvas-ux/board-start-view.ts`, `features/canvas-ux/bulk-paste-handler.ts`, `features/canvas-ux/bulk-paste.ts`, `features/canvas-ux/copy-link.ts`, `features/canvas-ux/frame-order.test.ts`, `features/canvas-ux/search-filter.test.ts`, `features/canvas-ux/select-by-type-runtime.ts`, `features/canvas-ux/start-view-runtime.ts`, `features/canvas-ux/template-insert.ts` |
| 3c | 22 (4) | `features/comments/CommentsOverlay.tsx`, `features/comments/CommentsPanel.tsx`, `features/comments/CommentsTopBar.tsx`, `features/comments/Composer.tsx`, `features/comments/ContextMenuItem.tsx`, `features/comments/ThreadView.tsx`, `features/comments/controller.test.ts`, `features/comments/controller.ts`, `features/comments/geometry.ts`, `features/comments/index.tsx`, `features/comments/model.test.ts`, `features/comments/store.ts`, `features/comments/tool.ts`, `features/people/PeopleBar.tsx`, `features/people/frames.test.ts`, `features/people/frames.ts`, `features/people/index.tsx`, `features/people/roster.ts`, `features/present-export/live/LiveUi.tsx`, `features/present-export/live/controller.test.ts`, `features/present-export/live/controller.ts`, `features/present-export/live/store.ts` |
| 3d | 26 (4) | `features/mindmap/ContextMenuGroup.tsx`, `features/mindmap/Overlay.tsx`, `features/mindmap/bridge.ts`, `features/mindmap/commands.ts`, `features/mindmap/keyboard.ts`, `features/mindmap/keys.ts`, `features/mindmap/overrides.tsx`, `features/mindmap/runtime.ts`, `features/mindmap/style.ts`, `features/mindmap/tree-index.test.ts`, `features/mindmap/tree-index.ts`, `features/mindmap/visibility.test.ts`, `features/mindmap/visibility.ts`, `features/tags/ContextMenu.tsx`, `features/tags/Overlay.tsx`, `features/tags/SearchTagFilter.tsx`, `features/tags/ShapeWrapper.tsx`, `features/tags/TagPicker.tsx`, `features/tags/TagsPanel.tsx`, `features/tags/csv.test.ts`, `features/tags/csv.ts`, `features/tags/hooks.ts`, `features/tags/index.tsx`, `features/tags/runtime.ts`, `features/tags/search.test.ts`, `features/tags/search.ts` |
| 3e | 21 (5) | `features/present-export/ExportDialog.tsx`, `features/present-export/PresentOverlay.tsx`, `features/present-export/controller.ts`, `features/present-export/csv-export.test.ts`, `features/present-export/csv-export.ts`, `features/present-export/export-render.ts`, `features/present-export/index.tsx`, `features/present-export/present-session.ts`, `features/present-export/slides.test.ts`, `features/present-export/slides.ts`, `features/present-export/text-layer.test.ts`, `features/present-export/text-layer.ts`, `features/sharing/ExportPolicySection.tsx`, `features/sharing/export-policy.test.ts`, `features/sharing/export-policy.ts`, `features/sharing/index.tsx`, `features/thumbnails/capture.ts`, `features/thumbnails/changes.test.ts`, `features/thumbnails/changes.ts`, `features/thumbnails/render.ts`, `features/thumbnails/schematic.ts` |
| 3f | 15 (1) | `features/workshops/PlusOnes.tsx`, `features/workshops/Reactions.tsx`, `features/workshops/VoteSetupDialog.tsx`, `features/workshops/VotingPanel.tsx`, `features/workshops/WorkshopBar.tsx`, `features/workshops/WorkshopOverlay.tsx`, `features/workshops/follow.ts`, `features/workshops/hooks.ts`, `features/workshops/index.tsx`, `features/workshops/plus-ones.test.ts`, `features/workshops/plus-ones.ts`, `features/workshops/private-notes/PrivateNotesPanel.tsx`, `features/workshops/private-notes/SetupDialog.tsx`, `features/workshops/private-notes/canvas.ts`, `features/workshops/session-settings.ts` |
| 3g | 12 (1) | `assets/PendingImageNames.tsx`, `assets/asset-store.test.ts`, `assets/asset-store.ts`, `assets/pending-images.ts`, `board/ExternalContent.tsx`, `features/canvas-ux/download-originals.ts`, `file-card/FileCardShapeUtil.tsx`, `file-card/FileCardView.tsx`, `file-card/PdfViewer.tsx`, `file-card/open-original.ts`, `file-card/place-pages.ts`, `file-card/viewer-state.ts` |
| 3h | 9 (1) | `features/ai/Overlay.tsx`, `features/ai/actions.test.ts`, `features/ai/actions.ts`, `features/ai/apply.ts`, `features/ai/menus.tsx`, `features/ai/runtime.ts`, `features/ai/target.ts`, `features/history/CheckpointPreview.tsx`, `features/history/HistoryPanel.tsx` |
| 3i | 1 (0) | `ui/SkipLink.tsx` |
| W4 | 2 (1) | `negative-types.ts`, `schema.test.ts` |

167 files (32 tests); 0 without an owner.

### 7.2 Where each owner's ported code goes

| Owner | Feature id(s) in `CANVAS_FEATURES` | Ported folder(s) (created at wave 1) | Also owns |
|---|---|---|---|
| 3a | `canvas-ux` | `features/canvas-ux/ported/**` except `navigation/` | `canvas/api/parts/styles.ts`; host slots `toolbar`, `stylePanel`, `contextMenu`, `mainMenu`, `shortcutsDialog`, `selectionBar`; the keyboard-map test |
| 3b | `navigation` | `features/canvas-ux/ported/navigation/**` | `canvas/api/parts/navigation.ts`; host slot `navigation` |
| 3c | `comments`, `people`, `present-live` | `features/comments/ported/**`, `features/people/ported/**`, `features/present-export/live/ported/**` | `canvas/api/parts/follow.ts` |
| 3d | `mindmap`, `tags` | `features/mindmap/ported/**`, `features/tags/ported/**` | — |
| 3e | `present-export`, `thumbnails`, `sharing` | `features/present-export/ported/**`, `features/thumbnails/ported/**`, `features/sharing/ported/**` | `canvas/api/parts/export.ts`, `canvas/export/**` |
| 3f | `workshops` | `features/workshops/ported/**` | — |
| 3g | `media` | `file-card/ported/**` (file cards, assets, external content) | `canvas/api/parts/files.ts`, `canvas/files/place.ts` |
| 3h | `history`, `ai` | `features/history/ported/**`, `features/ai/ported/**` | `canvas/preview/**` |
| 3i | `a11y` | `features/a11y/ported/**` | host slots `phoneSheet`, `liveRegion` |
| 2C | — | the Excalidraw board page, the ported `FeatureHost` (dock, top bar), `canvas/api/impl.ts` | every 2C stub of §2.1 |

## 8. The freeze tests (`apps/web/src/canvas/api/contracts.test.ts`, 13 tests)

1. `LOBBY_CANVAS_MEMBERS` lists each member once with a known owner; the built canvas matches it (C0 and composed members are real, every stub names the table's owner); every non-core member carries the same `@owner` in `lobby-canvas.ts`.
2. Stubs throw `NotImplementedError` with the owner (members, `LobbyTx` members, events, `joinPrevious`).
3. The tldraw map covers every `editor.*` member and every imported tldraw symbol in the tree (each symbol in one group), and every target resolves.
4. Every file that uses tldraw has a porting owner.
5. Ported code imports no tldraw, no engine, and only `canvas/api/index.ts` from the canvas.
6. `CANVAS_FEATURES` has unique ids, and each ported file names a known owner.
7. Host slots take one provider; `installCanvasFeatures` registers in feature order, wires `kbd` commands into the C0 key registry, survives a throwing `onMount` and undoes everything; `keyConflicts` finds a chord claimed twice in one scope.

Besides: `geometry.test.ts` (4), `items.test.ts` (4), `keys.test.ts` (4), `lib/signals.test.ts` (9), and two compile-time checks (`CANVAS_FEATURE_CONTEXT_KEYS` and `FACADE_V1_VERBS` are complete).

## 9. e2e: helpers for ported specs

### 9.1 `e2e/tests/support/canvas.ts` (frozen signatures)

Every canvas write goes through `window.lobbyCanvas` (the facade, so through `transact` and the sync engine); clicks go to `sceneToScreen` coordinates of an element; convergence is the facade's convergence hash; forged writes use a raw WebSocket (`e2e/spike-b/support/forge.ts`). Exports:

- **Calling the facade:** `canvasCall(page, verb, ...args)` (typed over `CanvasFacade` = the C0 facade plus the wave-1 verbs). Until 2E lands a wave-1 verb, it falls back to spike B's `window.__lobbyHarness` where that has the verb (`ready`, `me`, `viewport`, `setViewport`, `screenToScene`), else fails with "facade verb <name> not implemented (2E)".
- **Sessions:** `waitForCanvas(page)`, `openCanvasSession(browser, board, user)` (checks the `welcome` names the user), and `test` = fixtures.ts `test` plus `canvasSession(user, {role})`; `expect`.
- **Reads:** `items`, `item`, `itemText`, `itemBounds`, `selection`, `tool`, `editingId`, `saveState`, `viewport`, `readOnly`, `hash`, `pushedOps`, `collaborators`, `leaseHolder`, `waitForItem(page, id, predicate)`.
- **Writes:** `createItem`, `createNote({x, y, text, color, size})`, `updateItem`, `deleteItem`, `select`, `selectNone`, `setTool`, `zoomToFit`, `setViewport`, `undo`, `redo`.
- **UI:** `sceneToScreen`, `screenToScene`, `itemCenterOnScreen`, `clickItem(page, id, {button, modifiers})`, `dblclickItem`, `dragItem(page, id, delta)`.
- **Text:** `TEXT_EDITOR` (`textarea.excalidraw-wysiwyg`), `waitForTextEditor(page, id)` (editing id, focused and writable: the lease is granted), `startTextEditing` (double-click), `startTextEditingWithKeyboard` (select + Enter), `stopTextEditing` (Escape), `typeText`.
- **Sync:** `expectSaved(page)`, `expectConverged(reference, others)`.

| Today's spec call (`window.editor` / board.ts) | Ported spec |
|---|---|
| `openSession`, `session(user)`, `waitForBoard` | `openCanvasSession`, `canvasSession(user)`, `waitForCanvas` |
| `createShape`, `createShapes` | `createItem`, `createNote` (one per element; the facade writes one transact each) |
| `getShape`, `getCurrentPageShapes`, `getCurrentPageShapeIds` | `item`, `items` |
| `shapeText` (`plainText(props.richText)`) | `itemText` |
| `getShapePageBounds`, `shapeBounds` | `itemBounds` (`width`/`height`, not `w`/`h`) |
| `updateShape(s)`, `deleteShapes`, `toggleLock`, `reparentShapes` | `updateItem` (`{locked}`, `{frameId}`), `deleteItem` |
| `select`, `selectNone`, `getSelectedShapeIds`, `getOnlySelectedShape` | `select`, `selectNone`, `selection` |
| `setCurrentTool`, `getCurrentToolId` | `setTool`, `tool` (Lobby tool names, `BUILT_IN_TOOLS`) |
| `getEditingShapeId`, `getRichTextEditor`, `setEditingShape` | `editingId`, `waitForTextEditor`, `startTextEditing…` |
| `pageToScreen`, `shapeCenterOnScreen`, `toScreen`, `screenToPage`, `pageToViewport` | `sceneToScreen`, `itemCenterOnScreen`, `screenToScene` |
| `zoomToFit`, `zoomToBounds`, `zoomToSelection`, `setCamera`, `getCamera`, `getZoomLevel`, `getViewportPageBounds`, `getViewportScreenBounds` | `zoomToFit`, `canvasCall(page, 'zoomTo', b)`, `setViewport`, `viewport` (scene rect + zoom); the canvas rectangle is the page's own layout |
| `getCameraState`, `stopCameraAnimation` | `canvasCall(page, 'cameraMoving')` |
| `markHistoryStoppingPoint`, `undo`, `redo`, `getCanUndo` | nothing (each facade verb is one step), `undo`, `redo`, `canvasCall(page, 'canUndo')`; the real key is `ControlOrMeta+z` |
| `getDocumentSettings`, `updateDocumentSettings` | `canvasCall(page, 'doc', key)`, `canvasCall(page, 'setDoc', entries)` |
| `getBindingsFromShape`, `createBindings` | `canvasCall(page, 'arrowEnds', id)`; bind by `updateItem(arrow, {startBinding})` (the server keeps `boundElements` symmetric) |
| `getSortedChildIdsForParent`, `isShapeHidden`, `getShapeAtPoint`, `getShapesAtPoint` | `canvasCall(page, 'children' / 'isHidden' / 'hitTest', …)` |
| `getSvgString`, `toImage` | `canvasCall(page, 'exportSvg', ids)`; PNG through the export UI (download) |
| `getAsset`, `getAssets`, `resolveAssetUrl` | `item(page, id).customData.lobby.file`; the file routes through `page.request` |
| `getCollaborators`, `getInstanceState().followingUserId` | `collaborators`, `canvasCall(page, 'following')` |
| `getIsReadonly`, `updateInstanceState({isReadonly: false})` (forging) | `readOnly`; forging through a raw socket |
| `expectConverged` (record-by-record) | `expectConverged` (convergence hash, tombstones included) |
| `duplicateShapes`, `putContentOntoCurrentPage`, `getContentFromCurrentPage` | the real keys (`ControlOrMeta+d`, `+c`, `+v`) |
| `.tl-*` selectors, `[data-shape-id]` | `data-lobby-*` / `data-testid` on overlays; `TEXT_EDITOR` |

### 9.2 Wave-1 facade verbs (`apps/web/src/canvas/api/facade.types.ts`)

`ready`, `me`, `readOnly`, `text`, `viewport`, `setViewport`, `zoomTo`, `screenToScene`, `hitTest`, `isHidden`, `gesture`, `cameraMoving`, `undo`, `redo`, `canUndo`, `doc`, `setDoc`, `editText`, `stopEditing`, `arrowEnds`, `children`, `following`, `exportSvg`, on top of C0's `items`, `get`, `create`, `update`, `delete`, `select`, `selection`, `tool`, `setTool`, `sceneToScreen`, `bounds`, `zoomToFit`, `editingId`, `leaseHolder`, `collaborators`, `saveState`, `hash`, `pushedOps`, `leaseState`. 2E implements them in `canvas/test-facade.ts` on `LobbyCanvas`, behind the same dev-auth guard; every write still goes through `transact`.

### 9.3 Running ported specs

`E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw` runs `e2e/excalidraw/*.spec.ts` with the default suite's stack fixture (api + sync + worker, dev sign-in), the fixture's worker option `engine: 'excalidraw'` (W1-3: the stack launcher starts sync with `EXCALIDRAW_SYNC_ENV`, that is `DRAFTROOM_ENGINE=excalidraw`, `DRAFTROOM_TEST_HOOKS=1` and `DRAFTROOM_BACKUP_STORE=off` until 2B ports backups to `lb_*` files, **under** any per-spec `syncEnv`), and the web app built with `VITE_LOBBY_ENGINE=excalidraw` and the dev-auth guard into `apps/web/dist/lc-web-<port>`. Since wave 2 that build's `/b/:boardId` is Lobby's board page (2C, `canvas/board/**`); spike B's page is at `?page=spike`, or the default of a build with `VITE_LOBBY_BOARD_PAGE=spike` (W1-8). `e2e/excalidraw/canvas-helpers.spec.ts` checks the helpers against the board page (§11; wave 2's run: `docs/research/excalidraw/WAVE-2.md`).

## 10. Contract requests and what is not frozen

Not frozen by this step, with the reason (each is also in the workflow result):

1. **AGENTS.md (plan §10) is unchanged.** Repository rules are the owner's; the plan makes the change "with the owner's approval", and a workflow instruction is not that approval. The proposed text is plan §10; the owner applies or approves it.
2. **canvas-schema is not re-reviewed or re-frozen here.** It stays spike B's C0 contract (`CONTRACTS_REV` 4, the spike lead's change-request rule) while spike B runs and may still change it (the O2 lost-edit fix, the deferred `EngineCore.pendingLeases()` and idempotent offline-queue CRs). The wave-1 review of `packages/canvas-schema/src/**` (plan §7.2 row 1) happens when spike B closes; until then this API only reads canvas-schema.
3. **The wave-1 facade verbs are types only.** Their implementation is `apps/web/src/canvas/test-facade.ts`, spike B's O3 file; 2E implements them after spike B closes (the helpers fall back to the spike harness for five of them meanwhile).
4. **`transact(…, {joinPrevious})` is frozen as an option, but its feasibility is 2C's to confirm**: the history controller (`canvas/history/**`, spike-owned) must fold a derived write into the tab's previous step with remote changes interleaved. If it cannot, the mind map's re-layout becomes its own step and this option is withdrawn by a change request.
5. **`text.replace` needs the lease from code** (acquire, write, release) on spike A's lease client (`canvas/lease/**`, spike-owned); 2C confirms the client supports a programmatic acquire without an open editor.
6. **`presence.peers` and `follow`** read the presence hub (`canvas/presence/hub.ts` `PeerView`, spike-owned), which uses `LobbyEngineCore` events beyond the frozen `EngineCore`. If 2C moves presence onto the frozen interface, that is a change request to spike B's `sync/types.ts` (the spike lead's file).
7. **Not built (other owners or later steps):** the Excalidraw board page that calls `createLobbyCanvas` and `installCanvasFeatures` and renders the host slots, dock, top bar and overlay layers (2C; until it lands, ported features cannot be seen in a browser: the spike board page does not render `CANVAS_FEATURES`); the four missing engine probes of plan §6.5 (`NEVER` off Excalidraw's own stack, `addFiles` first entry, embeddable z-order, `restoreElements` on templates); the e2e map from `window.editor` calls is guidance (§9.1), not machine-checked.
8. **Lockfile PR #1 is empty**: no dependency is missing for waves 2–3 (the five `@excalidraw/*` packages and `tldraw-import`'s five MIT tldraw packages were added at spike B's C0).

**Status after the wave-2 integration** (`docs/research/excalidraw/WAVE-2.md`): item 4 is confirmed feasible by 2C (on a second tab one undo reverts both steps and redo restores both; `canvas/board/history-join.ts` folds the entries through the controller's live undo list until spike B's history owner adds `LobbyHistory.mergeTop()`, W1-9); item 5 is confirmed (`text.replace` acquires and releases the lease from code with no editor open, and waits for the push before releasing); item 6 needs no change request now (the board page reads a board-side peer store on `LobbyEngineCore.on` and `roster()`, as the spike's hub does); item 7's board page is built (2C). Items 1, 2 and 3 are unchanged. Item 8: two importer edges are now requested (`apps/api` → `@draftroom/tldraw-import`, `apps/sync` → `@draftroom/board-ops`) and not applied (W1-9).

## 11. Gate

Windows 11 workstation, Node 24.19.0, pnpm 10.34.5; the machine was shared with other agents' runs. One run each unless stated; logs in the contracts owner's scratchpad (`gate-merge/`, `gate-w1/`, `lc-smoke-*.log`).

**Step 1, on the merge commit 6210fc5** (a detached worktree, so the run saw none of the wave-1 edits):

| Check | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,458 files |
| typecheck (`pnpm -r typecheck`) + engine-probe tsc | PASS |
| Node-safety tsc (`apps/sync/tsconfig.node-safe.json`) | PASS |
| `pnpm test` | PASS: 4,208 passed, 36 skipped (374 files, 9 skipped) |
| `pnpm test:arrows` | PASS: 85/85 |
| asset and host-rewrite plugin tests | PASS 9/9 |
| hash check in Chromium (spike B contracts) | PASS |
| the default (tldraw) build's whole e2e suite, `E2E_PORT_BASE=6400` | **PASS: 341/341** (25.5 min; 340 chromium + 1 branded-Chrome) |
| spike A suite, `SPIKE_WEB_PORT=6450` | PASS: 99 passed, 2 skipped (opt-in) (19.7 min) |
| A8 browser probe (port 6453) | PASS |
| normal build, engine markers | PASS, **0** marker hits, no `excalidraw-assets/` |
| engine flag without the dev-auth guard | PASS, 0 marker files |

**On the wave-1 working tree** (the freeze commit's content):

| Check | Result |
|---|---|
| lint | PASS, 1,500 files |
| typecheck (15 projects) + engine-probe tsc + Node-safety tsc | PASS |
| `pnpm test` | PASS: 4,242 passed, 36 skipped (379 files); the 34 new tests are §8's |
| `pnpm test:arrows`, plugin tests, hash check in Chromium | PASS (85/85, 9/9, 1/1) |
| normal build, engine markers (the spike's plus `EXCALIDRAW-CONTRACTS`, `canvas.docKeys`, `useCanvasFeatureContext outside`, `CANVAS_FEATURES`) | PASS, 0 hits |
| engine flag without the dev-auth guard | PASS, 0 marker files |
| `e2e/excalidraw/canvas-helpers.spec.ts` (`E2E_PORT_BASE=6410`, the Excalidraw page on the spike board page) | PASS 5/5 (three runs: 1 + 2 + 2) |

Not re-run on the working tree: the default e2e suite and the spike A suite (the wave-1 changes add no import to the default build, which the marker check confirms, and touch no spike A page).

## 12. Change log

| Rev | Date | Change | By |
|---|---|---|---|
| W1-1 | 2026-09-29 | The wave-1 freeze (this document) | contracts |
| W1-2 | 2026-09-29 | CR by 2C (wave 2, commit `e010263`; **accepted** at the wave-2 integration): `MemberStatus` gains `board` (2C's members that need the board page's engine: real with the `board` handles of `createLobbyCanvas`, a stub naming 2C on a bare port); 2C's 49 stubs become 10 composed and 39 board-page members; the contracts test checks `board` members as stubs on a bare port and as real members with fake board handles, and runs the composed `tx` writes on a bare port. The list of members, their owners and every signature are unchanged. | 2C |
| W1-3 | 2026-09-29 | CR W1-2E-1 by 2E (commit `080d536`), **accepted**: `e2e/excalidraw/playwright.config.ts` sets the fixture's worker option `engine: 'excalidraw'` instead of `use.syncEnv`. Before, a spec's own `test.use({syncEnv})` (the conflicts spec's `TEXT_LEASE_MS`) replaced the config's object and ran sync on the tldraw engine against the Excalidraw build. The launcher (`e2e/tests/support/stack.ts` `engineSyncEnv`, 2E's) now puts `EXCALIDRAW_SYNC_ENV` (engine, test hooks, backups off) under any spec `syncEnv` and refuses a `syncEnv` naming another engine. Additive: no spec used the config's `syncEnv`, and the default suite's stacks are unchanged (`engine` defaults to `tldraw`). | 2E |
| W1-4 | 2026-09-29 | CR W1-2E-2 by 2E (commit `c729546`), **accepted**: `e2e/tests/support/canvas.ts`, bodies only (no signature or type change). `startTextEditingWithKeyboard` focuses the canvas before Enter; `canvasCall` derives `readOnly` (the harness session's welcome flag) and `text` (a text's own text, a frame's name, else its bound label's) until the page has those verbs; the page's own verb always wins. | 2E |
| W1-5 | 2026-09-29 | CR 2F-1 by 2F (commit `8a7e7af`), **accepted on `engine/excalidraw`**: the room extension mount point in spike B's C0 seam files. `apps/sync/src/engine-switch.ts` gains `registerRoomExtension(ext)` and `extendElementRoom(service, deps)` (an extension's `InternalRoute`s are mounted after the room's own, behind the same secret check; with none registered the service is returned unchanged), and `loadEngine('excalidraw')` also imports `./room-internal/index.ts`; `app.ts` wraps the factory's service in one line. These are spike B lead files (C0 table, `apps/sync`), so the spike B lead is asked to adopt the change in spike B's `CONTRACTS.md` change log; merges of `spike/excalidraw` into this branch keep it. Review notes: `extendElementRoom` builds a new object that forwards the service's members by name, so a member later added to `ElementRoomService` must be forwarded there too (a required one fails the typecheck; an optional one would be dropped silently); `engine-switch.ts` now type-imports `BoardStore` from `./room/store.ts` (erased at run time). | 2F (CR), integration |
| W1-6 | 2026-09-29 | CR 2F-2 by 2F (same commit), **accepted as an optional interface**: `ElementRoomService.prepareBoard?(boardId)` and `serverWrite?(boardId, apply)`, with `ServerWriteTx`, `ServerWriteChange`, `ServerWriteOutcome` and `ServerWriteApply`. Nothing implements them yet. O1 implements them in `apps/sync/src/room/**` and may amend the semantics, with 2F's OK, through a change request. Until then 2F's restore and place-notes answer 503 on a board whose room is open. | 2F (CR), O1 (implements) |
| W1-7 | 2026-09-29 | CR 2F-3 by 2F (commit `e19c6da`), **accepted**: `packages/contracts/src/history.ts` `CheckpointContent` gains optional `format: 'lobby-elements'`, `elements` and `doc` for v2 checkpoints; a v1 answer is unchanged. Compatible with the bridge release's edits of the same file on `r0/bridge` (checkpoint reasons, `BoardCheckpoint.newCanvas`, the new-canvas messages), which change other declarations. Readers: 3h (the Excalidraw preview) and R0. | 2F |
| W1-8 | 2026-09-29 | Integration decision on a file outside the wave-1 freeze: 2C's edit of `apps/web/src/App.tsx` (a spike B C0 file, lead-owned) is **accepted**. In a build with the engine flag and the dev-auth guard, `/b/:boardId` lazy-loads `canvas/board/route.tsx`, which opens Lobby's board page, or spike B's page for `?page=spike` or in a build with `VITE_LOBBY_BOARD_PAGE=spike`. The guard is still inlined (0 engine markers in the normal build and in the engine-flag build without the guard). Consequence: spike B's suite run on this branch needs `VITE_LOBBY_BOARD_PAGE: 'spike'` in `e2e/spike-b/playwright.config.ts` (spike-owned; a request to spike B). Also regenerated here: §7.1 (`dashboard/template-catalog.ts` no longer imports tldraw after 2D; 167 files). | 2C, integration |
| W1-9 | 2026-09-29 | Requests recorded and **not applied** (details in `docs/research/excalidraw/WAVE-2.md`): CR-2D-1 (room, O1: a label created in the same push as its new locked container is refused `LOCKED`); CR-2D-2 (`LobbyTx.insert(elements)` for prepared elements, contracts and 2C; 3b's template insert and paste-as-notes need it); the importer edges `apps/api` → `@draftroom/tldraw-import` and `apps/sync` → `@draftroom/board-ops` (the lockfile owner); `LobbyHistory.mergeTop()` (spike B's history owner); plan §3.3 says `ai.by` is stamped if absent, but canvas-schema's `AiValue` requires it (the contracts owner decides which changes). | integration |
