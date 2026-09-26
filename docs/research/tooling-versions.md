# Tooling versions: verified pins for the Draftroom monorepo

Verified 2026-09-26 on Windows 11, Node 24.19.0, pnpm 10.34.5, npm 11.17.
Every version below was installed and exercised in a scratch copy of the planned layout. The scratch repo lives outside this repo:

- Final recommended variant: `C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/research/tooling-versions/mf/`
- Earlier variant that also had `better-sqlite3` and `tsx` installed: `.../tooling-versions/mono/`

Anything I could not check directly is marked **UNVERIFIED**.

---

## 0. Decisions

| Area | Decision | Why (details in §3) |
|---|---|---|
| Runtime | **Node 24.19.0**, `engines: ">=24.15.0 <25"` | Type stripping is Stable from v24.12.0. `node:sqlite` is a release candidate from v24.15.0 and prints no ExperimentalWarning. |
| Package manager | **pnpm 10.34.5** (`packageManager` field) | As requested. Catalogs, `catalogMode`, `allowBuilds`, `minimumReleaseAge` and `overrides: catalog:` all work on 10.34.5 (tested). |
| TypeScript | **7.0.2** (native Go `tsc`) | tldraw's own monorepo builds with `typescript ^7.0.2`. All 4 packages type-check under 7.0.2, and under 6.0.3 with the same results. Project references, `-b`, composite and declaration emit all work. |
| TS fallback | 6.0.3 (or `typescript: npm:@typescript/typescript6@6.0.2`) | Only needed if we adopt a tool that uses the TS compiler API, such as typescript-eslint (its peer range is `typescript >=4.8.4 <6.1.0`). |
| Web | React 19.3.0, Vite 8.3.1, @vitejs/plugin-react 6.1.1, tldraw 5.4.2 | tldraw peer range is `^18.2.0 \|\| ^19.2.1`. Dev server, prod build and the two-browser e2e all pass. |
| Sync runner (dev + prod) | **Plain `node src/server.ts`**: Node 24 native type stripping, no tsx, no build step | Stable, zero dependencies, starts in 0.3 s (tsx: 1.2 s). Dev and prod run identically. Needs `erasableSyntaxOnly`, `verbatimModuleSyntax` and `.ts` import extensions. |
| Sync prod build | **None.** Fallback if ever needed: esbuild single-file bundle (verified) | `tsc` emit doesn't remove the need for type stripping (see §3.4). |
| SQLite | **`node:sqlite` `DatabaseSync`** via tldraw `NodeSqliteWrapper` | Built in, no native addon, has `backup()`. `better-sqlite3@13.0.3` also verified as a drop-in fallback (same wrapper). |
| Unit tests | **Vitest 5.0.2** (root, `test.projects`) | Node-side tests using `node:sqlite` and tldraw sync-core pass. |
| E2E | **@playwright/test 1.63.0**, headless shell only (`--only-shell chromium`) | Two isolated `browser.newContext()`s sharing one room: verified passing. |
| Lint/format | **Biome 2.5.14** only | One binary. Doesn't need the TS compiler API, which matters with TS 7. |
| Shared internal package | `exports: { ".": "./src/index.ts" }` (no build) | Works in TS 7 (bundler and nodenext resolution), Vite dev/build, Vitest, and native Node. |

---

## 1. Pinned version table (exact; put these in the pnpm catalog)

| Package | Exact version | Used by | Notes |
|---|---|---|---|
| node (runtime) | 24.19.0 | all | `.node-version` = `24.19.0`; root `engines.node` = `>=24.15.0 <25` |
| pnpm | 10.34.5 | root `packageManager` | pnpm 12.6.0 exists; we're on 10 on purpose |
| typescript | 7.0.2 | root dev | binary only; no `tsserver` in the package (§3.2) |
| @types/node | 24.19.0 | root dev + `overrides` | published 2026-09-25 22:09 UTC, so it needs a `minimumReleaseAgeExclude` entry until ~2026-09-26 22:09 UTC |
| tldraw | 5.4.2 | web | |
| @tldraw/sync | 5.4.2 | web | |
| @tldraw/sync-core | 5.4.2 | sync | |
| @tldraw/tlschema | 5.4.2 | canvas-schema, sync | |
| @tldraw/validate | 5.4.2 | canvas-schema | source of `T` validators |
| react | 19.3.0 | web (sync gets it via auto-installed peer) | |
| react-dom | 19.3.0 | web | |
| @types/react | 19.3.0 | web dev | |
| @types/react-dom | 19.3.0 | web dev | |
| vite | 8.3.1 | web dev | bundles with rolldown 1.2.11 |
| @vitejs/plugin-react | 6.1.1 | web dev | peer `vite: ^8.0.0` |
| vitest | 5.0.2 | root dev | peer `vite: ^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0`; engines `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| @playwright/test | 1.63.0 | e2e dev | browser: Chrome for Testing / headless shell 153.0.8010.12 (playwright build v1243) |
| ws | 8.21.3 | sync + `overrides` | 8.22.0 was published today (2026-09-26 15:00 UTC); 8.21.3 is the newest release older than 24 h |
| @types/ws | 8.18.1 | sync dev | |
| @biomejs/biome | 2.5.14 | root dev | |
| *Fallback only:* better-sqlite3 | 13.0.3 | sync | only if we move off `node:sqlite` (§3.5) |
| *Fallback only:* @types/better-sqlite3 | 9.6.0 | sync dev | |
| *Optional:* tsx | 4.23.15 | scripts | only needed for enums, parameter properties, JSX or tsconfig `paths` under Node |
| *Optional:* esbuild | 0.28.2 | sync build | only for the bundle fallback (§3.4) |
| *TS fallback:* typescript | 6.0.3 | root dev | or alias `@typescript/typescript6@6.0.2` |

Latest npm dist-tags on 2026-09-26, for context: react 19.3.0, vite 8.3.1, vitest 5.0.2 (V4 line: 4.1.11), @vitejs/plugin-react 6.1.1, @playwright/test 1.63.0, ws 8.22.0, tsx 4.23.15, typescript 7.0.2 (6.x: 6.0.3), better-sqlite3 13.0.3, @biomejs/biome 2.5.14, @types/node 26.6.3 (24.x: 24.19.0), typescript-eslint 8.70.1, eslint 10.11.0, prettier 3.9.9.

---

## 2. What was actually run (final variant `mf/`)

```
pnpm install --frozen-lockfile        -> Done in 2.6s (no build scripts, no peer warnings)
pnpm typecheck  (tsc 7.0.2 per pkg)   -> canvas-schema, sync, web, e2e: Done (0 errors)
pnpm lint       (biome check .)       -> Checked 26 files. No fixes applied.
vitest run                            -> 2 files, 2 tests passed (projects: canvas-schema, sync)
pnpm --filter @draftroom/web build    -> 843 modules, dist/assets/index-*.js 1,935 kB (579 kB gzip), 480 ms
CI=1 pnpm e2e   (playwright)          -> 1 passed (6.6s): two contexts share a room + custom shape + 3rd context
```

The earlier variant (`mono/`) also passed all of the above with `better-sqlite3@13.0.3`, `@types/better-sqlite3@9.6.0` and `tsx@4.23.15` installed. It had 3 tests, including one that runs `better-sqlite3` through `NodeSqliteWrapper`.

Other experiments run:

- TS 6.0.3 against the same 4 projects: all pass (exit 0).
- `skipLibCheck: false` under TS 6.0.3 and TS 7.0.2: **identical** failures. Web: 6 errors, from tldraw `.d.ts` importing `lodash*` without types. Sync: 71 errors, because DOM types are pulled in through sync-core's `.d.ts` `import ... from 'tldraw'`. So `skipLibCheck: true` is required regardless of TS version.
- Negative type test: `editor.createShape({ type: 'card', props: { title: 123 } })` and `{ type: 'not-a-shape' }` are both rejected under TS 7 and TS 6. This proves the `TLGlobalShapePropsMap` augmentation from the shared package reaches `tldraw`'s `Editor` types.
- `tsc -b` with composite + declaration emit, project references, a `noEmit` root referencing a composite project, and `--isolatedDeclarations`: all work on TS 7 (§3.2).
- Vite dev server (`vite --port 5183`) + sync server: editor mounted, custom shape rendered, 0 console errors or warnings.
- `node src/server.ts` and `tsx src/server.ts`: both serve `/healthz` and accept tldraw sync sockets.
- Filtered prod install `pnpm install --frozen-lockfile --prod --filter "@draftroom/sync..."`: 17 packages, 45 MB (with better-sqlite3), server starts with `node src/server.ts`.
- `pnpm deploy --prod --legacy`: output **fails** under native type stripping (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). See §5.
- esbuild bundle of the sync server (584 KB single `.mjs`): starts and serves.
- `node:sqlite` `backup()` of a live WAL room database: 11 pages copied, 7 rows readable in the copy.

---

## 3. Findings by topic

### 3.1 tldraw 5.4.2 requirements (npm metadata, `npm view <pkg>@5.4.2`)

`tldraw`, `@tldraw/sync`, `@tldraw/sync-core`, `@tldraw/tlschema` and `@tldraw/editor` all declare:

```json
"peerDependencies": { "react": "^18.2.0 || ^19.2.1", "react-dom": "^18.2.0 || ^19.2.1" },
"engines": { "node": ">=22.12.0" }
```

- `@tldraw/sync-core` and `@tldraw/tlschema` declare React peers too, even though their runtime code never imports React. I grepped `dist-esm`: sync-core imports only `@tldraw/state`, `@tldraw/store`, `@tldraw/tlschema`, `@tldraw/utils` and `nanoevents`. pnpm 10's default `autoInstallPeers: true` quietly installs react/react-dom 19.3.0 for `apps/sync`, with no warnings. No action needed.
- All `@tldraw/*` packages pin each other exactly (`"@tldraw/state": "5.4.2"` and so on), so they **must** move in lockstep. The catalog enforces this.
- `@tldraw/sync-core@5.4.2` depends on `ws: ^8.18.0`. Without an override, pnpm gave it `ws@8.22.0` next to our 8.21.3. `overrides: ws: 'catalog:'` fixes that (verified: one copy in the lockfile). tldraw's own root `package.json` also pins ws via `resolutions` (`"ws": "8.21.0"`, from `raw.githubusercontent.com/tldraw/tldraw/v5.4.2/package.json`).
- **TypeScript used by tldraw itself:** the root devDeps at tag v5.4.2 have `"typescript": "^7.0.2"`, `"vitest": "^4.1.7"` and `"tsx": "^4.19.2"`. Lint/format there is `oxlint`/`oxfmt`. `@tldraw/sync-core`'s own devDeps also list `typescript ^7.0.2`. tldraw's templates still say `typescript ^5.8.3`, `vite ^8.0.16` and `@vitejs/plugin-react ^6.0.1` (templates/vite/package.json and templates/simple-server-example/package.json at v5.4.2).
- The published `.d.ts` files are not self-contained:
  - `@tldraw/sync-core/dist-esm/index.d.mts` has `import { SerializedSchemaV2 } from 'tldraw'`, `import { TLDocument } from 'tldraw'`, `import { TLPage } from 'tldraw'` and `import { DebouncedFunc } from 'lodash'`. Neither `tldraw` nor `@types/lodash` is a dependency of sync-core.
  - In our monorepo these still resolve through pnpm's hidden hoisting (`node_modules/.pnpm/node_modules/tldraw`).
  - With `skipLibCheck: true` (required anyway) this is harmless and costs nothing at runtime, because the imports are type-only.
- Custom shapes in 5.x are typed by augmenting `TLGlobalShapePropsMap`, then using `TLShape<'card'>`. Source: `@tldraw/tlschema/dist-cjs/index.d.ts` line ~5113 `export declare interface TLGlobalShapePropsMap`, and the doc comment on `TLBaseShape`: "Custom shapes should be defined by augmenting the TLGlobalShapePropsMap type".
- In 5.4.2, `ShapeUtil` makes `getIndicatorPath(shape): TLIndicatorPath | undefined` **abstract** (required). `indicator()` is optional. `TLIndicatorPath = { additionalPaths?: Path2D[]; clipPath?: Path2D; path: Path2D } | Path2D`. Source: `@tldraw/editor@5.4.2/dist-cjs/index.d.ts`.

### 3.2 TypeScript 7.0.2: is it a drop-in `tsc`?

Checked against the package contents (`npm pack typescript@7.0.2`) and the Microsoft announcement (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

**Package shape:**
- `bin: { "tsc": "./bin/tsc" }` only. There is **no `tsserver`** bin and no `lib/typescript.js`.
- `exports["."]` is `./lib/version.cjs`, which exports only `version` and `versionMajorMinor`.
- The native binary comes from per-platform optional deps: `@typescript/typescript-win32-x64@7.0.2`, `@typescript/typescript-linux-x64@7.0.2`, and so on. There is no install script, so pnpm needs no `allowBuilds` entry for it.

**As a CLI type checker it is a drop-in** for our purposes:
- Same results as TS 6.0.3 on all 4 projects, including tldraw's `.d.ts` (identical error sets with `skipLibCheck: false`).
- Project references work. `tsc -b` with `composite: true`, `declaration`, `declarationMap` and `rewriteRelativeImportExtensions` emitted `.js` + `.d.ts` + `.d.ts.map` for canvas-schema and `.js` for sync.
- A `noEmit` root project that references a composite project builds and reports errors.
- `--isolatedDeclarations` works and reports TS9010/TS9013/TS9038.
- New flags `--checkers`, `--builders` and `--singleThreaded` are listed in `tsc --help --all`.
- Removed options are hard errors (verified): `baseUrl` gives `TS5102 Option 'baseUrl' has been removed`, and `moduleResolution: node10` gives `TS5108`. Per the announcement, `target: es5`, `downlevelIteration`, `module: amd/umd/systemjs/none` and `moduleResolution: classic` are also removed, and `esModuleInterop`/`allowSyntheticDefaultImports` can no longer be `false`.
- New defaults per the announcement: `strict: true`, `module: esnext`, `types: []`, `rootDir: ./`, `noUncheckedSideEffectImports: true`. Our base tsconfig sets `strict`, `module`, `target`, `lib` and `types` explicitly, so it behaves the same under TS 6 and TS 7 (verified).

**Not drop-in:**
- **No stable programmatic API in 7.0**, per the announcement ("expected in 7.1"). Anything that `require('typescript')` for the compiler API won't work with 7.0.2: typescript-eslint, ts-morph, ts-jest, api-extractor, and tsup/rollup-plugin-dts `.d.ts` bundling. Evidence: `typescript-eslint@8.70.1` peer is `"typescript": ">=4.8.4 <6.1.0"`. We avoid all of these.
  - Vite 8, Vitest 5, Playwright and Biome don't use the TS API. Vite uses rolldown/oxc to transpile, Playwright uses its own transform, and Biome is a standalone binary. Verified by running all of them.
- **Editor:**
  - `typescript.tsdk` pointing at `node_modules/typescript/lib` won't work, because there is no tsserver.
  - In VS Code, TS 7 comes from the `TypeScriptTeam.native-preview` extension (per the announcement).
  - That extension is **not on Open VSX** (`https://open-vsx.org/api/TypeScriptTeam/native-preview` returns "Extension not found"), and Cursor uses Open VSX. So in Cursor the editor will likely use its bundled TS 5.x/6.x language service. **UNVERIFIED** which version Cursor bundles.
  - Mitigation: our tsconfig type-checks identically under TS 6.0.3 and TS 7.0.2 (verified), so editor squiggles and CLI results should match. CI (`pnpm typecheck`) is the source of truth.
  - If editor mismatch becomes a problem, install both, using the pattern from the announcement: `"typescript": "npm:@typescript/typescript6@6.0.2"` (bin `tsc6`) next to `"@typescript/native": "npm:typescript@7.0.2"`. **UNVERIFIED** in our repo.

**Recommendation: TS 7.0.2.** It's what tldraw itself builds with. It passed every check here, and none of our chosen tools need the API. Fall back to **6.0.3** only if someone insists on typescript-eslint or another API-based tool before TS 7.1.

### 3.3 Vite 8 / plugin-react / Vitest / Playwright

- `@vitejs/plugin-react@6.1.1`: peer `vite: ^8.0.0`, engines `^20.19.0 || >=22.12.0`. There are optional peers for Babel and the React Compiler (`@rolldown/plugin-babel`, `babel-plugin-react-compiler`), not needed here. Dev and build both verified with tldraw 5.4.2.
- `vite@8.3.1` bundles with `rolldown ~1.2.9` (resolved 1.2.11). Its optional peers include `esbuild ^0.27.0 || ^0.28.0` and `tsx ^4.8.1`, but neither is needed.
- Build output with tldraw: one 1.94 MB chunk (579 kB gzip), plus a "chunks larger than 500 kB" warning. This is expected for tldraw. Split later with `build.rolldownOptions.output.codeSplitting`, or raise `build.chunkSizeWarningLimit`.
- **tldraw gotcha (verified):** the `shapeUtils` passed to `useSync` must be referentially stable. An inline `[...defaultShapeUtils, ...custom]` inside the component caused React error #301 (too many re-renders) in the production build. Hoist it to module scope or `useMemo`.
- **Vitest 5.0.2** works with Vite 8.3.1 and runs Node-side tests for the sync server: `node:sqlite`, `better-sqlite3` and `@tldraw/sync-core` `TLSocketRoom` all worked in the `environment: 'node'` project.
  - Config is `test.projects` with inline projects.
  - Vitest 5 changes relevant to us (from https://vitest.dev/guide/migration): inline projects now `extends: true` by default; `sharedViteServer` is on by default; `clearMocks` defaults to `true`; `vi.mock`/`vi.hoisted` must be top-level; `expect.poll()` rejects on timeout; unawaited async assertions fail the test; artifacts go to `.vitest/` (add it to `.gitignore`); `VITEST_POOL_ID`/`VITEST_WORKER_ID` are now 1-based.
  - Fallback: Vitest **4.1.11** (V4 dist-tag, peer `vite ^6 || ^7 || ^8`) is what tldraw uses. It isn't needed, and I did not run it here.
  - Vitest 5 lists `vite` as a peer. pnpm auto-installed the same `vite@8.3.1` for the root `vitest`, and the lockfile has a single `vite@8.3.1`.
- **Playwright 1.63.0:**
  - `playwright install --help` lists `--only-shell` ("only install headless shell when installing chromium") and `--no-shell`.
  - Headless runs use `chromium-headless-shell`. I installed **only** the shell with `npx playwright install --only-shell --no-progress chromium`, and the e2e passed.
  - Sizes, from the CDN `Content-Length` and disk:

    | Build | win64 download | linux64 download | On disk (Windows) |
    |---|---|---|---|
    | chromium-headless-shell 153.0.8010.12 | 120 MB | 120 MB | 271 MB |
    | full Chrome for Testing 153.0.8010.12 | 205 MB | 196 MB | not installed |

    On Windows the install also pulls ffmpeg (1.4 MB) and winldd (0.3 MB). Browsers install to `%LOCALAPPDATA%\ms-playwright`.
  - Use plain `playwright install chromium` (full + shell) only if someone wants headed or debug runs locally.
  - On Linux CI, add `--with-deps` for system libraries (per `--help`; **UNVERIFIED** on a Linux runner here).
  - **Two independent browser contexts against one room: verified.** `browser.newContext()` ×2 (isolated storage and IndexedDB, so two separate tldraw sessions) on `/?room=<id>`. A creates a custom `card` shape, and B renders it (`getByTestId('card-shape')`). B creates a `geo` shape, and A sees `['card','geo']`. A fresh third context then loads 2 shapes from the room. Total 2.3 s.
  - `webServer` accepts an array (sync server + `vite build && vite preview`).

### 3.4 ws, tsx vs Node 24 native type stripping, and how to ship apps/sync

**ws:** latest 8.x is 8.22.0 (2026-09-26 15:00 UTC; adds a `protocols` option and a `close()` state fix, per the GitHub release). Pin **8.21.3** (2026-08-07) because of the 24 h release-age guard. `@types/ws@8.18.1` depends on `@types/node: "*"`, hence the `@types/node` override. Our server uses `new WebSocketServer({ noServer: true })` + `handleUpgrade`, and tldraw's `WebSocketMinimal` accepts the `ws` socket directly (`room.handleSocketConnect({ sessionId, socket: ws })`). Verified end-to-end.

**Node 24 native type stripping** (docs: https://nodejs.org/docs/latest-v24.x/api/typescript.html):
- Stability 2 (Stable) since v24.12.0. No warning since v24.3.0. `process.features.typescript === 'strip'` on 24.19.0 (verified).
- Limitations, each verified on 24.19.0:

  | Syntax | Result |
  |---|---|
  | `enum` | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript enum is not supported in strip-only mode` |
  | parameter properties | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode` |
  | extensionless relative import (`./y`) | `ERR_MODULE_NOT_FOUND` (`./y.ts` works) |
  | importing a type without `type` | runtime `SyntaxError: The requested module './t.ts' does not provide an export named 'T'` |
  | `.ts` under `node_modules` | `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |

  - `--experimental-transform-types` makes enums work, but prints an ExperimentalWarning. Don't use it.
  - Per the docs, tsconfig `paths` are not honored (use `#subpath` imports), and `.tsx` is unsupported (fine for the server).
- The type checker catches all of these before runtime, with `erasableSyntaxOnly: true` (TS1294 on the parameter property, verified) and `verbatimModuleSyntax: true`. `allowImportingTsExtensions: true` allows the `.ts` specifiers when `noEmit`.
- **Workspace packages still work.** pnpm links `@draftroom/canvas-schema` as a symlink, and Node resolves the real path `packages/canvas-schema/src/index.ts`, which is outside `node_modules`, so stripping applies. Verified: `node src/server.ts` imports the shared package's `.ts` source.

**tsx 4.23.15** (esbuild ~0.28.0) also works on Node 24 with ESM + tldraw packages + the workspace `.ts` package (verified: server ran, sockets accepted). Import-only startup: native `node` 0.31 s vs `tsx` 1.16 s. tsx is only worth adding if we need syntax Node can't strip.

**Dev runner recommendation: `node --watch`, restricted with `--watch-path`:**

```json
"dev": "node --watch --watch-preserve-output --watch-path=./src --watch-path=../../packages/canvas-schema/src src/server.ts",
"start": "node src/server.ts"
```

- Verified on Windows: plain `node --watch` **and** `tsx watch` both restarted the server when a file under `node_modules/.pnpm/@tldraw+utils@5.4.2/...` was touched. The Node docs say `node_modules` is ignored by default, but that isn't what happened.
- With the two `--watch-path` flags it restarted only on `src` and `canvas-schema/src` changes, including edits to the shared package.
- The docs list `--watch`, `--watch-path` and `--watch-preserve-output` as Stable. Linux behaviour of `--watch-path` is **UNVERIFIED**, but dev is on Windows.

**Production build recommendation: none.**
- Render runs `node apps/sync/src/server.ts` after a normal workspace install.
- `tsc` emit is not a simplification. `rewriteRelativeImportExtensions` rewrites relative `.ts` to `.js` (verified), but the emitted `rooms.js` still imports `@draftroom/canvas-schema`, whose `exports` points at `.ts` source. So you'd also need to emit canvas-schema and add export conditions.
- **Fallback (verified): bundle with esbuild 0.28.2.** It produces a 584 KB single `.mjs` that starts and serves:

  ```bash
  esbuild src/server.ts --bundle --platform=node --target=node24 --format=esm \
    --outfile=dist/server.mjs --external:better-sqlite3 \
    --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  ```

  The `createRequire` banner is for CJS deps inside an ESM bundle. `--external:better-sqlite3` only matters if that fallback driver is in use. Use this only if we ever need a `node_modules`-free artifact or `pnpm deploy`.

### 3.5 SQLite: `node:sqlite` vs `better-sqlite3`

tldraw 5.4.2 `NodeSqliteWrapper` supports both. From `@tldraw/sync-core/dist-cjs/index.d.ts`:

```ts
export declare class NodeSqliteWrapper implements TLSyncSqliteWrapper {
    constructor(db: SyncSqliteDatabase, config?: TLSyncSqliteWrapperConfig | undefined);
    exec(sql: string): void;
    prepare<TResult extends TLSqliteRow | void = void, TParams extends TLSqliteInputValue[] = TLSqliteInputValue[]>(sql: string): TLSyncSqliteStatement<TResult, TParams>;
    transaction<T>(callback: () => T): T;
}
export declare interface SyncSqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        iterate(...params: unknown[]): IterableIterator<unknown>;
        run(...params: unknown[]): unknown;
    };
}
// doc comment: "Works with both `node:sqlite` DatabaseSync (Node.js 22.5+) and `better-sqlite3` Database."
```

| | `node:sqlite` (Node 24.19.0) | `better-sqlite3@13.0.3` |
|---|---|---|
| Install | built in | N-API addon, prebuilds for linux/linuxmusl/darwin/win32 × x64/arm64 **inside the tarball** (11.4 MB .tgz) |
| Flag / warning | none; no ExperimentalWarning (verified) | none |
| Stability | 1.2 Release candidate since v24.15.0 (docs history: unflagged v22.13.0/v23.4.0) | mature; used by tldraw's `templates/simple-server-example` (`^12.10.0`) |
| SQLite version | 3.53.3 (`process.versions.sqlite`) | 3.53.4 |
| Backup API | `backup(sourceDb, path, options?): Promise<number>` (`@types/node@24.19.0` sqlite.d.ts:1092); verified on a live WAL DB | `db.backup()` (exists, `typeof === 'function'`) |
| Busy timeout default | `timeout: 0` ms (docs), so set `new DatabaseSync(file, { timeout: 5000 })` if a second connection (e.g. backup) can contain | 5000 ms (**UNVERIFIED**, from memory of the better-sqlite3 docs) |
| pnpm 10 build config | none | **must be `allowBuilds: { better-sqlite3: false }`** (see below) |
| Linux prebuild requirements | n/a | `linux-x64.node` references `GLIBC_2.34` and `GLIBCXX_3.4.29` (grepped from the binary). Render's native runtime and `node:24-bookworm` should satisfy this (**UNVERIFIED** on Render). |
| Works with NodeSqliteWrapper + SQLiteSyncStorage + TLSocketRoom | yes (vitest + e2e) | yes (vitest) |

**Recommendation: `node:sqlite`.**
- It has no native binary, no glibc coupling, no pnpm build policy and no extra package, and it provides the backup API the build plan needs.
- The risk is API churn while it's an RC. We pin Node exactly, and `better-sqlite3@13.0.3` is a one-line swap (`new Database(file)` instead of `new DatabaseSync(file)`, same wrapper), verified working.
- Verified on-disk result: the e2e room DB has tables `documents(id, state BLOB, lastChangedClock)`, `tombstones`, `metadata` and `objects`; `journal_mode` is `wal`; there are 7 rows after the test.

**better-sqlite3 13 + pnpm 10 gotcha (verified):**
- v13 removed `prebuild-install`. It has no `install` script and sets `"gypfile": false`, but still ships `binding.gyp`.
- pnpm 10 sees `binding.gyp` and treats the package as needing `node-gyp rebuild`. So a plain install fails under `strictDepBuilds: true` with `ERR_PNPM_IGNORED_BUILDS Ignored build scripts: better-sqlite3@13.0.3`.
- Approving it (`true`) would **compile from source**, which needs Python and a C++ toolchain. Python isn't installed on this machine.
- The correct setting is `allowBuilds: { better-sqlite3: false }`. The bundled prebuild then loads (`lib/binding.js` picks `prebuilds/<platform>-<arch>.node`), and `new Database(':memory:')` works.
- After changing `allowBuilds`, an incremental `pnpm install` still reported the stale `ignoredBuilds` from `node_modules/.modules.yaml`. A fresh install (delete `node_modules`) cleared it.

### 3.6 pnpm 10.34.5 workspace specifics (verified against the bundled `pnpm.cjs` and by running it)

- **`catalog:`** Versions live once in `pnpm-workspace.yaml` under `catalog:`, and packages use `"tldraw": "catalog:"`. The lockfile records `specifier: 'catalog:'` → `version: 5.4.2`.
- **`catalogMode: strict`** is accepted (valid values `strict | prefer | manual`, default `manual`).
- **`overrides` with `catalog:`** works: `overrides: { '@types/node': 'catalog:', ws: 'catalog:' }`, and the lockfile shows `overrides: '@types/node': 24.19.0, ws: 8.21.3`. This was needed because `@types/ws` → `@types/node: "*"` resolved `@types/node@26.6.3` next to 24.19.0.
- **`workspace:*`** is used for `@draftroom/canvas-schema` in web and sync.
- **`allowBuilds`:**
  - pnpm 10.34.5 translates this map form into `onlyBuiltDependencies` / `ignoredBuiltDependencies`. See `pnpm.cjs` around line 18350: `case true: settings.onlyBuiltDependencies.push(...)`, `case false: settings.ignoredBuiltDependencies.push(...)`.
  - `pnpm approve-builds` writes `allowBuilds` when neither legacy key exists.
  - pnpm 11 uses only `allowBuilds` (https://pnpm.io/blog/releases/11.0), so the map form is forward-compatible.
  - With `strictDepBuilds: true`, any unlisted package that has a build script fails the install.
  - In the final dependency set (no tsx/esbuild, no better-sqlite3) **nothing needs a build script**, so `allowBuilds: {}`.
  - If tsx is added, pnpm pulls `esbuild@0.28.2` (postinstall `node install.js`). It then also becomes resolved as Vite's optional peer. Add `esbuild: true` in that case.
- **`minimumReleaseAge: 1440`** (value is minutes: `pnpm.cjs` does `minimumReleaseAge * 60 * 1e3`). Verified: `pnpm add ws` picked `8.21.3 (8.22.0 is available)`.
  - It also **blocked our exact pin** `@types/node@24.19.0`, which was published under 24 h ago.
  - The version-scoped exclusion `minimumReleaseAgeExclude: ['@types/node@24.19.0']` fixed it (verified). Remove the exclusion after 2026-09-26 ~22:10 UTC.
  - `--frozen-lockfile` installs don't re-resolve, so CI isn't affected.
- **Filtered install for the sync deploy (verified):** `pnpm install --frozen-lockfile --prod --filter "@draftroom/sync..."` gives "Scope: 2 of 5 workspace projects" and 17 packages. Quote the `--filter` globs in `package.json` scripts (`--filter \"./apps/*\"`), or a POSIX shell will expand them on Linux.

### 3.7 Internal package consumed by Vite and Node without a build

`packages/canvas-schema/package.json`:

```json
{ "name": "@draftroom/canvas-schema", "type": "module", "exports": { ".": "./src/index.ts" } }
```

Verified consumers:
- TS 7 with `moduleResolution: bundler` (web) and `nodenext` (sync).
- Vite 8 dev and build (linked workspace deps are transpiled as source).
- Vitest 5.
- Node 24 native stripping (because the symlink target is outside `node_modules`).
- tsx.

Rules for code in this package: erasable syntax only, `.ts` extensions on relative imports, and `import type` for types. `tsconfig.base.json` enforces all three.

Keep canvas-schema dependent only on `@tldraw/tlschema` + `@tldraw/validate`, not `tldraw`, so the server never pulls in the UI package.

Do **not** use `pnpm deploy` or `dependenciesMeta.injected` with this pattern. Verified: `pnpm --filter @draftroom/sync deploy --prod --legacy <dir>` copies canvas-schema into `node_modules/.pnpm/...`, and `node` then throws `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. If a self-contained artifact is ever needed, use the esbuild bundle (§3.4).

### 3.8 Lint/format: Biome 2.5.14

- One dev dependency and one `biome.json`. `biome check .` does format + lint + import sorting.
- It needs no TS compiler API, so it's compatible with TS 7. ESLint + typescript-eslint is not: the peer is `typescript <6.1.0`.
- The native binary comes via optional dep `@biomejs/cli-win32-x64@2.5.14`, with no install script.
- `biome init` in 2.5.14 generates `"linter": { "rules": { "preset": "recommended" } }`. That is the 2.5 schema; older examples use `"recommended": true`.
- Windows gotcha (verified): when the absolute path to `biome.exe` exceeds 260 characters, the launcher fails with `spawnSync ... biome.exe ENOENT`. The real repo path is 136 characters, so this won't bite unless the repo is cloned very deep.

---

## 4. Verified sample files (exact contents from `mf/`)

### `pnpm-workspace.yaml`

```yaml
packages:
  - apps/*
  - packages/*
  - e2e

# Single source of truth for shared versions. Reference with "catalog:" in package.json.
catalog:
  # tldraw: keep every @tldraw/* package in lockstep (they pin each other exactly)
  tldraw: 5.4.2
  '@tldraw/sync': 5.4.2
  '@tldraw/sync-core': 5.4.2
  '@tldraw/tlschema': 5.4.2
  '@tldraw/validate': 5.4.2
  # react
  react: 19.3.0
  react-dom: 19.3.0
  '@types/react': 19.3.0
  '@types/react-dom': 19.3.0
  # build / runtime tooling
  typescript: 7.0.2
  '@types/node': 24.19.0
  vite: 8.3.1
  '@vitejs/plugin-react': 6.1.1
  vitest: 5.0.2
  '@playwright/test': 1.63.0
  ws: 8.21.3
  '@types/ws': 8.18.1
  '@biomejs/biome': 2.5.14

# `pnpm add` must use a catalog version when one exists.
catalogMode: strict

# Supply-chain guard: ignore versions published less than 24h ago (value is minutes).
minimumReleaseAge: 1440
# Exact-version exclusions for pins that are newer than the window (remove once they age out).
minimumReleaseAgeExclude:
  - '@types/node@24.19.0'

# pnpm 10 blocks dependency lifecycle scripts by default. allowBuilds (map form) is accepted by
# pnpm 10.34.5 and is the only form in pnpm 11+. true = may run install scripts, false = skip silently.
# Nothing in this dependency set needs a build script today.
allowBuilds: {}

# Fail the install if a dependency with an unapproved build script shows up.
strictDepBuilds: true

overrides:
  # @types/ws depends on "@types/node": "*", which would pull the newest @types/node (26.x)
  # next to our Node-24 typings. Force one copy everywhere.
  '@types/node': 'catalog:'
  # @tldraw/sync-core depends on ws ^8.18.0; keep a single ws copy (tldraw's own repo pins ws too).
  ws: 'catalog:'
```

If falling back to better-sqlite3, add to the catalog `better-sqlite3: 13.0.3` and `'@types/better-sqlite3': 9.6.0`, and set `allowBuilds: { better-sqlite3: false }`. If adding tsx, add `tsx: 4.23.15` and `allowBuilds: { esbuild: true }`. Both variants were verified in `mono/`.

### Root `package.json`

```json
{
  "name": "draftroom",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.34.5",
  "engines": {
    "node": ">=24.15.0 <25"
  },
  "scripts": {
    "dev": "pnpm -r --parallel --filter \"./apps/*\" dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "pnpm --filter @draftroom/e2e test",
    "lint": "biome check .",
    "format": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

Also add a `.node-version` file containing `24.19.0` (Render reads it; see §6).

### `tsconfig.base.json`

No project references and no build. Each package runs `tsc -p .`, and the shared package's source is checked as part of each consumer program.

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "types": []
  }
}
```

### Per-package tsconfigs

```jsonc
// apps/web/tsconfig.json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["es2023", "dom", "dom.iterable"], "jsx": "react-jsx", "types": ["vite/client"] },
  "include": ["src", "vite.config.ts"] }

// apps/sync/tsconfig.json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext", "types": ["node"] },
  "include": ["src"] }

// packages/canvas-schema/tsconfig.json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src"] }

// e2e/tsconfig.json
{ "extends": "../tsconfig.base.json", "compilerOptions": { "lib": ["es2023", "dom"], "types": ["node"] }, "include": ["**/*.ts"] }
```

### Package manifests

```jsonc
// apps/web/package.json
{ "name": "@draftroom/web", "private": true, "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview", "typecheck": "tsc -p ." },
  "dependencies": { "@draftroom/canvas-schema": "workspace:*", "@tldraw/sync": "catalog:", "react": "catalog:", "react-dom": "catalog:", "tldraw": "catalog:" },
  "devDependencies": { "@types/react": "catalog:", "@types/react-dom": "catalog:", "@vitejs/plugin-react": "catalog:", "vite": "catalog:" } }

// apps/sync/package.json
{ "name": "@draftroom/sync", "private": true, "type": "module",
  "scripts": {
    "dev": "node --watch --watch-preserve-output --watch-path=./src --watch-path=../../packages/canvas-schema/src src/server.ts",
    "start": "node src/server.ts",
    "typecheck": "tsc -p ." },
  "dependencies": { "@draftroom/canvas-schema": "workspace:*", "@tldraw/sync-core": "catalog:", "@tldraw/tlschema": "catalog:", "ws": "catalog:" },
  "devDependencies": { "@types/ws": "catalog:" } }

// packages/canvas-schema/package.json
{ "name": "@draftroom/canvas-schema", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p ." },
  "dependencies": { "@tldraw/tlschema": "catalog:", "@tldraw/validate": "catalog:" } }

// e2e/package.json  (CI: "playwright install --only-shell chromium" — the exact command verified via npx)
{ "name": "@draftroom/e2e", "private": true, "type": "module",
  "scripts": { "test": "playwright test", "install-browsers": "playwright install --only-shell chromium", "typecheck": "tsc -p ." },
  "devDependencies": { "@playwright/test": "catalog:" } }
```

### `vitest.config.ts` (root)

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'canvas-schema', environment: 'node', include: ['packages/canvas-schema/src/**/*.test.ts'] } },
      { test: { name: 'sync', environment: 'node', include: ['apps/sync/src/**/*.test.ts'] } },
    ],
  },
})
```

When web unit tests arrive, add a third inline project with `environment: 'jsdom'` and add `jsdom` to the catalog. That setup is **UNVERIFIED** here; tldraw itself uses `jsdom ^29.1.1` + `vitest-canvas-mock`.

### `apps/web/vite.config.ts`

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
```

### `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.14/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "includes": ["**", "!**/dist", "!**/.data", "!**/test-results", "!**/playwright-report"]
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 110 },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded" } },
  "linter": { "enabled": true, "rules": { "preset": "recommended" } },
  "assist": { "enabled": true, "actions": { "source": { "organizeImports": "on" } } }
}
```

### `.gitignore` additions

```
node_modules
dist
.data
.vitest
test-results
playwright-report
*.tsbuildinfo
*.log
```

### `e2e/playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test'

const SYNC_PORT = process.env.E2E_SYNC_PORT ?? '5871'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '4181'
const WEB_URL = `http://localhost:${WEB_PORT}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: WEB_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @draftroom/sync start',
      url: `http://localhost:${SYNC_PORT}/healthz`,
      env: { PORT: SYNC_PORT, DATA_DIR: './.data/e2e-rooms' },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm --filter @draftroom/web build && pnpm --filter @draftroom/web exec vite preview --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: { VITE_SYNC_URL: `ws://localhost:${SYNC_PORT}` },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
```

E2E ports differ from the dev defaults (5858/5173/4173) so e2e can run while dev servers are up. On this machine, other processes were already listening on 5858 and 4173.

### `e2e/tests/two-browsers.spec.ts` (passing)

```ts
import { expect, type Page, test } from '@playwright/test'

type EditorLike = {
  createShape(shape: Record<string, unknown>): unknown
  getCurrentPageShapes(): { type: string }[]
}
declare global {
  interface Window {
    editor?: EditorLike
  }
}

async function openBoard(page: Page, roomId: string) {
  await page.goto(`/?room=${roomId}`)
  await page.waitForFunction(() => window.editor !== undefined, undefined, { timeout: 30_000 })
}

test('two independent browser contexts share one room', async ({ browser }) => {
  const roomId = `e2e-${Date.now()}`
  // Two isolated contexts = two separate "users" (no shared storage/cookies/IndexedDB).
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await Promise.all([openBoard(a, roomId), openBoard(b, roomId)])

  // A creates the shared custom shape; B must render it (proves schema + sync + ShapeUtil).
  await a.evaluate(() => {
    window.editor?.createShape({
      type: 'card',
      x: 100,
      y: 100,
      props: { w: 220, h: 120, title: 'hello from A', color: 'khaki' },
    })
  })
  await expect(b.getByTestId('card-shape')).toHaveText('hello from A', { timeout: 15_000 })

  // B creates a default shape; A must see both.
  await b.evaluate(() => {
    window.editor?.createShape({ type: 'geo', x: 400, y: 100 })
  })
  await expect
    .poll(() =>
      a.evaluate(() =>
        window.editor
          ?.getCurrentPageShapes()
          .map((s) => s.type)
          .sort(),
      ),
    )
    .toEqual(['card', 'geo'])

  // A fresh third context loads the room state from the server.
  const ctxC = await browser.newContext()
  const c = await ctxC.newPage()
  await openBoard(c, roomId)
  await expect.poll(() => c.evaluate(() => window.editor?.getCurrentPageShapes().length)).toBe(2)

  await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()])
})
```

### Shared schema: `packages/canvas-schema/src/card-shape.ts` + `index.ts`

These are the minimal pieces used to prove the wiring. The canvas-schema research doc owns the real design.

```ts
// card-shape.ts
import { createShapePropsMigrationIds, createShapePropsMigrationSequence, type RecordProps, type TLShape } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const CARD_SHAPE_TYPE = 'card' as const

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    [CARD_SHAPE_TYPE]: { w: number; h: number; title: string; color: string }
  }
}

export type CardShape = TLShape<typeof CARD_SHAPE_TYPE>

export const cardShapeProps: RecordProps<CardShape> = {
  w: T.positiveNumber, h: T.positiveNumber, title: T.string, color: T.string,
}

const versions = createShapePropsMigrationIds(CARD_SHAPE_TYPE, { AddColor: 1 })

export const cardShapeMigrations = createShapePropsMigrationSequence({
  sequence: [{
    id: versions.AddColor,
    up(props: Record<string, unknown>) { props.color = 'yellow' },
    down(props: Record<string, unknown>) { delete props.color },
  }],
})

// index.ts
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import { CARD_SHAPE_TYPE, cardShapeMigrations, cardShapeProps } from './card-shape.ts'
export * from './card-shape.ts'
export const customShapeSchemas = { [CARD_SHAPE_TYPE]: { props: cardShapeProps, migrations: cardShapeMigrations } }
export const draftroomSchema = createTLSchema({
  shapes: { ...defaultShapeSchemas, ...customShapeSchemas },
  bindings: defaultBindingSchemas,
})
```

Verified: `draftroomSchema.serialize().sequences['com.tldraw.shape.card'] === 1`, and the `geo` sequence is present too.

### Sync server core: `apps/sync/src/rooms.ts` + `server.ts` (runs under plain `node`)

```ts
// rooms.ts (excerpt)
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'

export function createRoom(db: DatabaseSync) {
  const sql = new NodeSqliteWrapper(db)
  const storage = new SQLiteSyncStorage<TLRecord>({ sql })
  return new TLSocketRoom<TLRecord, void>({ schema: draftroomSchema, storage })
}
// file DBs: new DatabaseSync(join(dataDir, `${roomId}.db`)); db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
// NOTE: no constructor parameter properties (not erasable) — assign fields explicitly.

// server.ts (excerpt)
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { RoomRegistry } from './rooms.ts'
const wss = new WebSocketServer({ noServer: true })
http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = /^\/connect\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname)
  const sessionId = url.searchParams.get('sessionId')
  if (!match?.[1] || !sessionId) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => {
    registry.get(match[1]).handleSocketConnect({ sessionId, socket: ws })
  })
})
```

The tldraw client connects to `ws://host/connect/<room>?sessionId=...&storeId=...`, as observed in Playwright's websocket event.

### Web wiring: `apps/web/src/App.tsx` (excerpt)

```tsx
import { useSync } from '@tldraw/sync'
import { defaultShapeUtils, type Editor, type TLAssetStore, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { CardShapeUtil } from './CardShapeUtil.tsx'

// Must be referentially stable: useSync rebuilds the store (-> React error #301 loop)
// if it receives a new array on every render.
const shapeUtils = [CardShapeUtil]
const syncShapeUtils = [...defaultShapeUtils, ...shapeUtils]

export function App({ roomId }: { roomId: string }) {
  const store = useSync({ uri: `${SYNC_URL}/connect/${roomId}`, assets, shapeUtils: syncShapeUtils })
  return <Tldraw store={store} shapeUtils={shapeUtils} onMount={(editor) => { window.editor = editor }} />
}
```

`CardShapeUtil extends BaseBoxShapeUtil<CardShape>` with `static override type/props/migrations`, `getDefaultProps()`, `component()` and `getIndicatorPath()` returning a `Path2D`.

---

## 5. Gotchas found empirically (all reproduced)

1. **Unstable `shapeUtils` passed to `useSync`** leads to React error #301 in the production build. Hoist the array or `useMemo` it.
2. **better-sqlite3 13 + pnpm 10:** set `allowBuilds: { better-sqlite3: false }`, not `true`. Also, incremental installs keep a stale `ignoredBuilds` list in `.modules.yaml`.
3. **`@types/ws` pulls in `@types/node@26`** unless you add `overrides: { '@types/node': 'catalog:' }`.
4. **`@tldraw/sync-core` pulls in a second `ws`** unless you add `overrides: { ws: 'catalog:' }`.
5. **`minimumReleaseAge` also applies to exact pins.** Use version-scoped `minimumReleaseAgeExclude`.
6. **`pnpm deploy` + source-`exports` + native stripping is incompatible** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Deploy from a normal workspace install, or bundle with esbuild.
7. **`node --watch` and `tsx watch` restart when `node_modules` files are touched** on Windows/pnpm. Use `--watch-path`.
8. **`skipLibCheck: true` is mandatory** with tldraw 5.4.2 `.d.ts`, on TS 6 and TS 7 alike (missing lodash types, and DOM types leaking into the server via `import ... from 'tldraw'` in sync-core's `.d.ts`).
9. **Unquoted `--filter ./apps/*`** in a script gets glob-expanded by `sh` on Linux. Quote it.
10. **Windows MAX_PATH:** Biome's launcher fails with `ENOENT` when `biome.exe`'s absolute path is over 260 characters. Keep the clone path short.
11. **A composite project's `.tsbuildinfo` can mask CLI flag changes.** Re-running `tsc -p` with an extra `--isolatedDeclarations` flag on an up-to-date composite project first reported success. After deleting the `.tsbuildinfo` it reported the errors. Observed on TS 7.0.2; not investigated further, and it doesn't affect the recommended `noEmit` setup.

---

## 6. Render / Linux notes

- **Node version:** Render's precedence (https://render.com/docs/node-version) is `NODE_VERSION` env var > `.node-version` > `.nvmrc` > `package.json engines`. The default for new services is 24.21.0. Commit `.node-version` = `24.19.0` so Render matches local dev, and bump both together. Render recommends always giving `engines` an upper bound, which ours has (`<25`).
- **pnpm on Render: UNVERIFIED.** Render's docs don't describe pnpm or corepack handling; a Render feedback item requests corepack support. Node 24.19.0 ships corepack 0.35.0 (verified locally). A reasonable build command: `corepack enable && pnpm install --frozen-lockfile --prod --filter "@draftroom/sync..."`. Start command: `node apps/sync/src/server.ts`. Verify on first deploy; the Render-deploy research topic should confirm.
- **Static web:** `pnpm install --frozen-lockfile --filter "@draftroom/web..." && pnpm --filter @draftroom/web build`, publishing `apps/web/dist`. **UNVERIFIED** on Render.
- If we ever switch to `better-sqlite3`, its `linux-x64.node` prebuild needs glibc ≥ 2.34 and GLIBCXX_3.4.29. With `node:sqlite` there's no such constraint.

---

## 7. UNVERIFIED / open items

- Which TypeScript version Cursor's built-in language service uses, and whether Cursor can load TS 7's LSP. The `TypeScriptTeam.native-preview` extension is not on Open VSX.
- Vitest jsdom setup for web component tests (not needed yet).
- Playwright `--with-deps` on a Linux CI runner.
- pnpm/corepack behaviour in Render's native Node build environment.
- `--watch-path` behaviour on Linux (dev is Windows-only for now).
- better-sqlite3's default busy timeout (believed 5000 ms; not checked).
- Vitest 4.1.11 was not run (5.0.2 was); 4.1.11's peer range covers Vite 8 per npm metadata.

## 8. Sources

- npm registry metadata (`npm view <pkg>@<ver> peerDependencies engines dependencies dist-tags time`) for every package in §1.
- Tarballs inspected: `typescript@7.0.2` (package.json exports/bin, `lib/`), `@tldraw/sync-core@5.4.2`, `@tldraw/tlschema@5.4.2`, `@tldraw/sync@5.4.2`, `tldraw@5.4.2` (`dist-cjs/index.d.ts`, `dist-esm`), `better-sqlite3@13.0.3` (package.json, `lib/binding.js`, `prebuilds/`).
- tldraw repo at tag v5.4.2: `package.json`, `templates/vite/{package.json,tsconfig.json,vite.config.ts}`, `templates/simple-server-example/{package.json,tsconfig.json,vite.config.mts,src/server/rooms.ts,src/server/server.ts}` (raw.githubusercontent.com).
- TypeScript 7.0 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- TypeScript 6.0 release notes: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
- Node 24 docs: https://nodejs.org/docs/latest-v24.x/api/sqlite.html, https://nodejs.org/docs/latest-v24.x/api/typescript.html, https://nodejs.org/docs/latest-v24.x/api/cli.html
- Vitest migration guide: https://vitest.dev/guide/migration
- better-sqlite3 releases: https://github.com/WiseLibs/better-sqlite3/releases (v13.0.0 N-API / bundled prebuilds)
- ws releases: https://github.com/websockets/ws/releases (8.22.0, 8.21.3)
- pnpm 11 release notes (allowBuilds): https://pnpm.io/blog/releases/11.0 ; pnpm 10.34.5 bundle `C:/Users/Chase/AppData/Roaming/npm/node_modules/pnpm/dist/pnpm.cjs`
- Render Node version: https://render.com/docs/node-version
- Open VSX lookup: https://open-vsx.org/api/TypeScriptTeam/native-preview
