# A16 (static half) and the Node-checkable probes of §6.5 (spike A, node owner)

**Status: PASS (3/3 runs, 23/23 tests each)** for the static half of A16 and every Node-checkable probe of
§6.5. The dynamic half of A16 (P1–P8 triggered in a browser, the guard, forwarded double-clicks, touch) is the
host owner's and is **UNRUN here**.

Code: `apps/web/test/engine-probe/editor-open-paths.test.ts`, `node-probes.test.ts`, `bundle.ts`, run by the
vitest project `engine-probe` (the only change to the shared `vitest.config.ts`: one added project entry,
`include: ['apps/web/test/engine-probe/**/*.test.ts']`, `testTimeout: 60_000`).

## Command

```
export PATH="/c/Program Files/nodejs:/c/Users/Chase/AppData/Roaming/npm:$PATH"
npx vitest run --reporter=verbose --project engine-probe      # 3 times in a row
```

Runs 1, 2 and 3: 2 files, **23/23 passed** each.

## A16 static: editor-open call sites

Both builds are checked. esbuild keeps class-member names in `dist/prod` (they are property accesses), so the
names survive minification and the prod count is meaningful.

| Bundle (`@excalidraw/excalidraw` 0.18.0-1118751) | `.startTextEditing(` calls | mentions | `.handleTextWysiwyg(` calls | mentions | in other chunks |
|---|---|---|---|---|---|
| `dist/dev/index.js` | **7** | 8 (7 + definition) | **2** | 3 (2 + definition) | 0 |
| `dist/prod/index.js` | **7** | 8 | **2** | 3 | 0 |

The probe counts both calls and every mention, so a reference passed around without a call (a new indirect
path) also fails it. A mutation test proves it fails on any other count: one extra call → `{calls: 8,
mentions: 9}`; one removed → `{calls: 6, mentions: 7}`; `const open = this.handleTextWysiwyg` → `{calls: 2,
mentions: 4}`.

Dev call sites, with the enclosing function found by the probe; they match the plan's P1–P8 table line for line:

| Line (`dist/dev/index.js`) | Enclosing function | Plan path |
|---|---|---|
| 27824 | `onDrop` (AppToolDrag, sticky-note tool) | P7 |
| 44176 | `onKeyDown` | P1 |
| 44864 | `handleCanvasDoubleClick` | P3, P4, P8 |
| 46350, 46374 | `handleTextOnPointerDown` | P6 |
| 51313 | `onPointerUpFromPointerDownHandler` (sticky-note tool click) | P7 |
| 51681 | `onPointerUpFromPointerDownHandler` (second click on a selected text/label) | P5 |
| `handleTextWysiwyg` 44685 | `startTextEditing` (definition at 44544): every path above ends here | — |
| `handleTextWysiwyg` 51250 | `onPointerUpFromPointerDownHandler` (text drawn by drag) | P6 |

## Other §6.5 probes that run in Node

| Probe | Result |
|---|---|
| `getStickyNoteLayout` / `newTextElement` run in Node | Yes with the server provider. Without one, `newTextElement` throws `ReferenceError: document is not defined` (element `index.js:5731-5735`, `5754-5758`) |
| `duplicateElement` sets `created` | Yes: `created = updated` on every copy, also from `created: null` (element `index.js:17932-17939`), so `onDuplicate` must reset it |
| `created` and updates | Excluded from `ElementUpdate` **by type only** (`mutateElement.d.ts:3`): `newElementWith(el, { created: 123 })` writes it at runtime |
| Sticky-note footer depends on `created` | `getStickyNoteFooter` returns null for `created: null` and for notes under 75 px; `"7 Sep"` in the current year, `"7 Sep 2026"` otherwise (element `index.js:6855-6883`) |
| `CaptureUpdateAction` | `IMMEDIATELY`, `NEVER`, `EVENTUALLY` |
| E7 static half: `updateScene` runs no sticky-note re-layout | `relayoutStickyNotes` has exactly 1 caller in dev (paste styles, excalidraw `index.js:11819`) and 1 mention in prod |
| §2.5.4 static half: the open editor follows scene updates | `textWysiwyg` subscribes with `app.scene.onUpdate(` (excalidraw `index.js:25600`) |
| §2.7 static half: `savePointer` | Returns before `onPointerUpdate` when `!isInteractionEnabled() && !isToolSupported(activeTool)` (excalidraw `index.js:47780-47801`) |
| E2/E3: index validation in the published builds | Never runs (see finding 2) |
| Element sizes vs §3.5 | See the table below |

### Element sizes (bytes of `JSON.stringify`, run 1; runs 2 and 3 within ±3 B)

| Element | Bytes | Limit (§3.5) |
|---|---|---|
| rectangle | 474 | ≤ 32 KiB |
| 22-character bound label (Lobby builder) | 718 | text ≤ 144 KiB |
| note + its label | 1,222 | — |
| freedraw, 2,500 pen points + pressures, rounded to 2 decimals | 51,302 | ≤ 64 KiB: **fits** |
| same, unrounded | 121,581 | **does not fit** |
| arrow / line, 1,000 points, rounded | 15,476 / 15,476 | ≤ 32 KiB: fits |
| line, 1,000 points, unrounded | 39,553 | **does not fit** |
| text, 20,000 three-byte characters, wrapped | 123,119 | ≤ 144 KiB: fits |
| 200 `plusOne:<40-char uid>` keys | 12,001 | ≤ 12 KiB (12,288): fits by 287 B |

## Engine findings (differences from the plan)

1. **Coordinates.** `_newElementBase` logs `console.error("New element size or position is too large")` when
   `|x|`, `|y|`, `|width|` or `|height|` exceeds **1e6** (element `index.js:16334-16343`); §3.5 allows ±1e7 on
   the wire. Proposal: limit to ±1e6 (or accept console noise for converted boards laid out far to the right).
2. **E3 is not enforced by Excalidraw in the npm builds.** `Scene.replaceAllElements` validates indices only if
   common's `isDevEnv()`/`isTestEnv()` is true or `window.DEBUG_FRACTIONAL_INDICES` is set (element
   `index.js:18947-18958`); common's `import.meta.env` is `{ DEV: true }` / `{PROD:!0}` with no `MODE`, so it
   never is. A label sorted below its container is accepted and not fixed; with the debug flag it only logs.
   The plan's "dev builds throw" (E3) is wrong for these packages. Details in A8.md.
3. **`Scene` must not be used on the server.** In plain Node it throws `ReferenceError: window is not
   defined` on its first call per 60 s (element `index.js:18949`), and its lodash throttle timer keeps the
   process alive for a minute.
4. **Line and arrow points must be rounded too**, not only freedraw: 1,000 unrounded points (39.6 KB) break the
   32 KiB limit. §3.5's rounding rule covers `points` of every type; the client rounding in §2.5.3 says
   "freedraw and line" and should say "freedraw, line and arrow".
5. **The `plusOne` budget is tight**: 12,001 B for 200 keys with 40-character uids (limit 12,288). Longer uids
   would overflow it. Proposal: 16 KiB, or cap uid length in the key spec.
6. `savePointer` also returns when `clientX` or `clientY` is 0 (`if (!x || !y) return;`, excalidraw
   `index.js:47787-47789`): a pointer on the very first pixel row or column is never reported. Irrelevant to
   Lobby, whose own listener reads the pointer (§2.7).

## §6.5 probes that need a browser (left for the host and render owners)

| Probe | Spike check | Owner |
|---|---|---|
| `NEVER` keeps remote edits off the stack | E4 | host |
| `registerAction` replaces `undo` | §2.8 | host |
| `addFiles` keeps the first entry for an id | §2.10.3 | render |
| `updateImageCache` still marks failures `status: "error"` | A7 | render |
| Fonts loading changes no version | A9 (E5) | render |
| `onDuplicate` can override `created` (Ctrl+D, Alt-drag, paste) | A1 | host |
| `interaction` config shape and its keyboard/clipboard behaviour | A4 | host |
| Embeddable z-order; footer hidden in pixels when `created` is null | A1 | render |
| `savePointer` early return, behaviourally (presence silent under `interaction`) | A4 | host |
| `updateScene` runs no re-layout, and the open editor follows scene updates, behaviourally | A17 (E7) | host |
| `restoreElements` leaves templates untouched | §6.1 | render |
| A16 dynamic half: P1–P8 with no grant, the guard, forwarded double-clicks, `preventDefault` on a swallowed second `touchstart` | A16 | host |

The index-collision probe (E2) is covered here in Node **and** in a real browser (A8.md).
