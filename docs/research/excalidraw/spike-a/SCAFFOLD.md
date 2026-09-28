# SCAFFOLD: spike A engine host, assets, route, harness, import rule

**Status: PASS** (3 of 3 runs, 2026-09-28, branch `spike/excalidraw`, Windows 11, Node 24, pnpm 10.34.5,
Vite 8.3.1 (rolldown), Playwright 1.63.0 headless Chromium shell). Engine: `@excalidraw/excalidraw`
0.18.0-1118751 (plus element, common, math, fractional-indexing at the same version).

This is the base the other spike A owners build on. It is not one of the plan's A1-A17 checks; it is the
scaffold those checks need, and the "SCAFFOLD" item of the spike A task.

## What was built

| Item | File(s) |
|---|---|
| Engine host with the fixed props of plan §2.3.2 | `apps/web/src/canvas/engine/ExcalidrawHost.tsx`, `engineGlobals.ts`, `interaction.ts` (+ `interaction.test.ts`) |
| Self-hosted fonts at `/excalidraw-assets/` | `apps/web/build/excalidraw-assets.ts`, one import + one plugin entry in `apps/web/vite.config.ts` |
| Dev-only route `/spike/:name` | `apps/web/src/canvas/spike/SpikeRoute.tsx`, `harness.ts`, `pages/engine.tsx`; 10 lines in `apps/web/src/App.tsx`; `VITE_LOBBY_ENGINE` typed in `vite-env.d.ts` |
| Spike Playwright config and helpers | `e2e/spike/playwright.config.ts`, `e2e/spike/support/{ports,page,watch,spike-global}.ts`, `e2e/spike/tests/smoke.spec.ts`, `"spike"` script in `e2e/package.json` |
| Import rule | `biome.json` (`style/noRestrictedImports` + one override) |
| Build folder no longer ignored | `.gitignore`: `!/apps/web/build/` (the repo-wide `build/` pattern ignored the new plugin file) |

### Props, checked name by name in the installed types

`dist/types/excalidraw/types.d.ts` of 0.18.0-1118751: `ExcalidrawProps` 668; `initialData` 686;
`onExcalidrawAPI` 692; `onInitialize` 704; `onPaste` 715; `onDuplicate` 741; `langCode` 748;
`interaction` 765 (`InteractionConfig` 549-633, `tools` inside `enabled`); `ui` 789; `theme` 818;
`UIOptions` 821 (`CanvasActions` 900, `UIOptions` 914); `handleKeyboardGlobally` 827; `onLinkOpen` 832;
`validateEmbeddable` 840; `renderEmbeddable` 841; `aiEnabled` 842. The runtime destructures the same
names (`dist/dev/index.js` 52555-52601).

Values: `ui={false}`, `handleKeyboardGlobally={false}`, `aiEnabled={false}`, `langCode="en"`, `theme` from
the page, `validateEmbeddable={() => false}`, `renderEmbeddable={() => null}`,
`UIOptions={{ tools: { image: false }, canvasActions: { changeViewBackgroundColor, clearCanvas, export,
loadScene, saveToActiveFile, toggleTheme, saveAsImage: all false } }}` (all 7 `CanvasActions` keys),
`interaction` omitted for `editor` and `{ enabled: { navigation: true, links: true, tools: { custom: true } } }`
for `commenter`, `viewer` and `guest` (a limited guest), `initialData={{ appState: { currentItemFontFamily: 6,
currentItemRoughness: 0 } }}` (no elements: the scene will arrive from sync). `onDuplicate`, `onPaste`,
`onLinkOpen`, `gridModeEnabled`, `objectsSnapModeEnabled` and `children` are optional pass-throughs.

## Commands

Every run executed, in order, from the repo root (script: [`scripts/scaffold-run.sh`](scripts/scaffold-run.sh),
reproduced here):

```sh
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"; unset VITE_LOBBY_ENGINE
pnpm lint
pnpm -r typecheck
pnpm exec vitest run --project web
pnpm --filter @draftroom/e2e spike            # SPIKE_WEB_PORT unset = 7740
# normal (tldraw) build, no VITE_LOBBY_ENGINE, then grep it for engine markers
(cd apps/web && pnpm exec vite build --outDir dist/normal-check)
grep -rl -- <marker> apps/web/dist/normal-check   # markers below; each must hit 0 files
# engine flag WITHOUT the dev-auth guard: the route and its chunks must be absent
(cd apps/web && VITE_LOBBY_ENGINE=excalidraw pnpm exec vite build --outDir dist/noguard-check)
grep -rl -- <marker> apps/web/dist/noguard-check/assets
```

Normal-build markers: `EXCALIDRAW_ASSET_PATH`, `EXCALIDRAW_THROTTLE_RENDER`, `excalidraw-assets`,
`excalidraw__canvas`, `esm.sh`, `__lobbySpike`, `@excalidraw/`, `excalidraw-room-persistence`,
`oss-collab.excalidraw`, `Xiaolai`, `spike-engine`; plus "no `excalidraw-assets/` folder". (The bare word
`excalidraw` is not a marker: tldraw 5.4.2 itself contains it, for its Excalidraw-clipboard paste support.)
Engine-only-build markers: `__lobbySpike`, `spike-engine`, `spike-missing`, `excalidraw__canvas`,
`EXCALIDRAW_ASSET_PATH`, `@excalidraw/`.

The smoke spec has three tests:
1. `/spike/engine?role=editor&theme=light` loads; `window.__lobbySpike.api` exposes `updateScene`,
   `getSceneElements`, `setActiveTool`, `onPointerDown`, `registerAction`; appState has
   `currentItemFontFamily 6`, `currentItemRoughness 0`, theme light; the globals are set; the scene is
   empty; no visible button/input/link inside `.excalidraw` (ui false). A `stickynote` with a bound Nunito
   label made by `convertToExcalidrawElements(..., { regenerateIds: false })` and `api.updateScene(...,
   NEVER)` reads back as 2 elements, label `containerId` = note id, note `boundElements` lists the label,
   text and `fontFamily 6` kept. It renders: the static canvas pixel 12 px inside the note's corner equals
   the note's `backgroundColor` (±24 per channel), and the label's box holds ≥ 20 dark pixels;
   `document.fonts.check('20px Nunito')`. At least one 200 response from `/excalidraw-assets/fonts/Nunito/`;
   every `.woff2` response comes from `127.0.0.1` under `/excalidraw-assets/fonts/` or `/assets/`. 0 foreign
   requests, 0 console errors, 0 page errors.
2. `/spike/no-such-page` shows the page list (no crash, no foreign request).
3. Harness self-test: a `fetch('https://blocked.invalid/probe')` is aborted by `openSpike`'s default block
   and still listed by `foreignRequests()`; one `<a download>` click counts 1 download; one `alert` counts 1
   dialog; one `showSaveFilePicker()` counts 1 picker call.

## Runs

| Run | lint | typecheck (14 packages) | web unit | spike smoke | normal build | normal grep hits | engine-only build | engine-only grep hits |
|---|---|---|---|---|---|---|---|---|
| 1 | PASS | PASS | PASS, 1133/1133 | PASS, 3/3 (7.4 s) | PASS, 84 assets | 0 | PASS, 84 assets | 0 |
| 2 | PASS | PASS | PASS, 1133/1133 | PASS, 3/3 (7.5 s) | PASS, 84 assets | 0 | PASS, 84 assets | 0 |
| 3 | PASS | PASS | PASS, 1133/1133 | PASS, 3/3 (7.6 s) | PASS, 84 assets | 0 | PASS, 84 assets | 0 |

Each smoke run rebuilt `apps/web/dist/spike-7740` (its `index.html` mtime was later than the run's start
every time) and the preview server was gone afterwards (no listener on 7740-7749).

Numbers (identical in all three runs): note corner pixel `[255,223,107]` = backgroundColor `#ffdf6b`;
404 dark pixels in the label box; 35 requests, one font file
(`/excalidraw-assets/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2`,
the Latin subset); 0 foreign requests; 0 console errors.

Build: the engine build emits 233 font files (14 MB, Liberation left out) under
`dist/spike-7740/excalidraw-assets/fonts/`. For reference only (A13 owns the measurement): the engine page
chunk `engine-*.js` is 1,605,397 B (499,009 B gzip) and the engine's main shared chunk
`chunk-Z5NKEFVG-*.js` 1,821,028 B (741,906 B gzip).

Dev server (`vite`, not only preview), the same plugin, 3 runs on port 7742 (script [`scripts/dev-check.mjs`](scripts/dev-check.mjs), `node scripts/dev-check.mjs <repo root>`, in the
repo): Nunito served 200 `font/woff2` from `/excalidraw-assets/fonts/Nunito/`; 0 foreign requests;
0 console errors; `/excalidraw-assets/fonts/Liberation/LiberationSans-Regular.woff2` 404; a malformed
escape under the base 404.

## Engine behaviour found (file:line in the installed 0.18.0-1118751 dist)

1. **Every font has an esm.sh source, and a missing local font triggers it.** `ExcalidrawFontFace.createUrls`
   (`@excalidraw/excalidraw/dist/dev/chunk-FN755BR4.js:1225-1249`) builds `new URL('./fonts/<Family>/<file>',
   EXCALIDRAW_ASSET_PATH)` and then *always* appends `ASSETS_FALLBACK_URL` (`:1277`),
   `https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/` (the bundle's `PKG_VERSION` is `0.18.0`, not the
   pinned nightly). Observed: a text element with `fontFamily: 9` (Liberation Sans, deliberately not served,
   plan §2.12) makes the browser request `/excalidraw-assets/fonts/Liberation/LiberationSans-Regular.woff2`
   (404) and then `esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/Liberation/LiberationSans-Regular.woff2`.
   Consequences: (a) the A12 host-rewrite of `esm.sh` is required, not only defence in depth, because any
   local font miss (a missing family, a deploy that lost a file) goes third-party; (b) server validation
   (§3.5) should reject `fontFamily` values Lobby does not serve (at least 9) so no board can trigger it;
   (c) CSP `font-src 'self'` (§2.12) would block it at cut-over. With Vite's SPA fallback a miss was a
   200 `index.html`, which also moves the browser to the next source, so the plugin answers 404 for any
   unlisted path under the base, in dev and in preview. The static host's rewrite rules need the same
   (A12 / deploy).
2. **The asset path is read lazily.** Fonts register on the first `Fonts.registered` access
   (`chunk-FN755BR4.js:3072-3082`, `init()` at `:3207`), not at module evaluation, so "before Excalidraw
   loads" means "before the first render"; `engineGlobals.ts` sets it at module evaluation anyway (it is
   the first import of `ExcalidrawHost.tsx`; Biome's organizeImports keeps side-effect imports in place).
   `EXCALIDRAW_THROTTLE_RENDER` is read per render (`dist/dev/index.js:24464`) and only honoured on React ≥ 18
   (Lobby: 19.3.0).
3. **`convertToExcalidrawElements` regenerates every id by default** (`@excalidraw/element/dist/dev/index.js:24527`,
   `opts?.regenerateIds !== false`). A skeleton `id: 'note-1'` came back as a random id until
   `{ regenerateIds: false }` was passed. Relevant to the converter port, server-made notes (A3) and every
   spec that addresses elements by id.
4. **`onExcalidrawAPI` fires before the editor is initialised** (`index.js:49154`, in the App constructor
   path; the types say "editor is not yet mounted"); **`onInitialize` fires after the initial scene loads**
   (`index.js:49441`). `window.__lobbySpike.ready` resolves on `onInitialize`.
5. **`ui={false}` still mounts empty containers**: `.layer-ui__wrapper` and `footer.layer-ui__wrapper__footer`
   (`index.js:30857`) are in the DOM with no controls; no button, input or link is visible. The smoke asserts
   "no visible control"; the pixel/visual pin is A5.
6. **UIOptions normalisation** (`index.js:52604-52618`): `canvasActions` is merged over the defaults;
   `export: false` skips the `saveFileToDisk` merge; `toggleTheme: false` stays false (only `null` is
   promoted to true when `theme` is given with `onThemeChange` or omitted).
7. **Package entry points.** `@excalidraw/excalidraw/index.css` is exported with only `development` and
   `production` conditions (no `default`); Vite resolves it. `@excalidraw/excalidraw/package.json` is not
   exported, so the plugin finds the fonts from the main entry (`default` → `dist/prod/index.js`) and uses the
   sibling `fonts/`. `dist/dev/fonts` and `dist/prod/fonts` are byte-identical (`diff -rq`). The CSS itself
   references the four `Assistant` UI fonts with relative `url()`s, which Vite bundles into `/assets/` with
   hashes, so the UI font is served from `/assets/`, not `/excalidraw-assets/` (none was requested with
   `ui={false}`).
8. **File pickers bypass Playwright's download events.** Excalidraw's file I/O goes through
   browser-fs-access 0.38.0, which picks the File System Access implementation when
   `"showOpenFilePicker" in self` at module evaluation (`browser-fs-access/dist/index.modern.js`), and the
   Chromium headless shell has `showSaveFilePicker` and `showOpenFilePicker` (checked in the page). So a
   Ctrl+Shift+S or Ctrl+O would call a picker, not an `<a download>` / `<input type=file>`, and
   Playwright's `download` / `filechooser` events would stay at 0 even if the key worked. The shared
   helper `instrumentFilePickers` (install before navigation) counts those calls; A6 and B5 must use it,
   or their "0 downloads" is not evidence.
9. For A1: a note made by `convertToExcalidrawElements` gets `created` and draws the date footer ("28 Sep"
   in the light and dark screenshots). For pixel probes in dark mode: the canvas is colour-transformed
   (the yellow note paints brown), so compare against the light theme or the transformed colour.

## Deviations from the plan / task, and why

- `.gitignore` gained `!/apps/web/build/`: the repo-wide `build/` pattern ignored the plugin file the task
  asked for (and Biome, which honours `.gitignore`, would not have linted it).
- The asset plugin is active only when `VITE_LOBBY_ENGINE=excalidraw`, so the normal build carries no engine
  files. It emits the fonts whenever that flag is set, with or without the dev-auth guard (14 MB unused in a
  flag-only build); the route is what the guard controls.
- The spike route is matched in `App()` before `SessionProvider`, not in `lib/routing.ts`: "must not require
  sign-in" means no `/api/me` call either (a failed one would log a console error).
- The dev-auth test is inlined in `App.tsx` next to `DEV_AUTH_ENABLED`. With only the imported const, a
  `VITE_LOBBY_ENGINE=excalidraw` build without dev auth still emitted the engine chunks (6 marker files,
  255 assets) although the route was unreachable at run time: rolldown did not fold the cross-module
  constant. Inlined, that build has 0 marker files and the same 84 assets as the normal build.
- `window.__lobbySpike` also carries `lib` (a few engine exports: `convertToExcalidrawElements`,
  `CaptureUpdateAction`, `newElementWith`, `restoreElements`, `FONT_FAMILY`, the coordinate helpers), `theme`,
  `setTheme` and a free `extra` slot, because specs may not import `@excalidraw`.
- The preview proxy of the spike config targets `SPIKE_WEB_PORT + 1` (api) and `+ 2` (sync) unless
  `SPIKE_API_ORIGIN` / `SPIKE_SYNC_ORIGIN` are set, so a spike run never reaches someone's local dev servers
  on the default 5858/5859.
- `openSpike` aborts every non-localhost request by default (`allowForeign: true` turns that off); the attempt
  is still recorded.
- `role=guest` means a limited (read-only) guest. A guest who may edit is `editor` to the canvas.
- `appState` defaults are set through `initialData.appState` (no elements), since plan §2.3.2's
  `initialData: null` leaves no other place for them before the first scene. `currentItemStickynoteBackgroundColor`
  (Lobby yellow) is not set yet: the task did not list it and the colour is not defined in the plan.

## Incident

During the first run of the dev-server probe of finding 1 (before request blocking was added), the headless
browser sent one GET to `esm.sh` for the public Liberation Sans font file. Nothing else was sent. The three
recorded dev runs, and all spike specs through `openSpike`, abort foreign requests before they leave the
machine.
