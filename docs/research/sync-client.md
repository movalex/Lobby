# Research: sync-client (browser side), tldraw 5.4.2 + @tldraw/sync 5.4.2

Date: 2026-09-26. Scope: React + Vite + TypeScript client for Draftroom, using `tldraw@5.4.2` and `@tldraw/sync@5.4.2`.

How this was checked: every signature below was read from the published 5.4.2 tarballs (`npm pack`). Each package ships its `src/`, and `tldraw` also ships a `DOCS.md` and `RELEASE_NOTES.md`. Behavior was then tested in a scratch Vite app talking to a small Node `TLSocketRoom` server, running in a real browser (Chromium pane). Source paths are given as `<package>@5.4.2 <path>:<line>`. The same files are on GitHub at `https://github.com/tldraw/tldraw/blob/v5.4.2/packages/<pkg>/<path>`.

Confidence tags:
- **[src]**: read in the 5.4.2 source or `.d.ts`.
- **[emp]**: observed in the scratch app or server.
- **[docs]**: taken only from tldraw's shipped docs.
- **UNVERIFIED**: not confirmed.

---

## 0. TL;DR: where 5.4.2 differs from older assumptions

| Assumption (pre-5.x or from memory) | Reality in 5.4.2 |
|---|---|
| `useSync({ userInfo: {id,name,color} })` | **Removed.** Use `users?: TLUserStore`, where `currentUser` is a `Signal<TLUser \| null>`. Passing `userInfo` is a type error [src][emp]. |
| `ShapeUtil.indicator()` returns JSX | **Deprecated, no longer rendered.** `abstract getIndicatorPath(shape): TLIndicatorPath \| undefined` is required. It returns a `Path2D` drawn on a canvas overlay [src]. |
| Custom shape type is `TLBaseShape<'x', Props>` | Still allowed, but the documented pattern is module augmentation of `TLGlobalShapePropsMap` plus `TLShape<'x'>` [src][emp]. |
| Presence is the only user data synced | Presence (`instance_presence`) is ephemeral. **`user:` records are document-scoped and persisted**: the editor writes them when it stamps attribution (e.g. editing note text) [src][emp]. |
| `useSync` adds tldraw's default shapes when you pass `shapeUtils` | **It does not.** Pass `[...defaultShapeUtils, ...custom]` and `[...defaultBindingUtils, ...custom]`. Passing only custom utils together with the default bindings **throws** at schema creation [src][emp]. |
| Inline options are fine | `uri`, `assets`, `users`, `connect` and the utils arrays are **effect dependencies**. An inline `uri: async () => ...` causes an endless reconnect loop [emp]. |
| No license key means a watermark only | In production (https, non-loopback, `NODE_ENV=production`) with no key or a key for the wrong domain, **the editor is hidden after 5 s** [src]. |
| Vite needs no config | `vite build` needs none. **`vite` dev with `@tldraw/assets/imports.vite` fails** in Vite 8.3.1 until you add `optimizeDeps.exclude: ['@tldraw/assets']` (seen on Windows) [emp]. |
| Server rejects clients whose schema it lacks | It **accepts the connection**. The first push of an unknown shape type then fails with `INVALID_RECORD`, a fatal error with no auto-retry [emp]. |
| `<Tldraw deepLinks>` prop | Deprecated. Use `options={{ deepLinks: true }}` [src]. |

---

## 1. Versions verified together

These versions installed with no peer-dependency conflicts, passed `tsc --noEmit` (strict), passed `vite build` and ran in the browser against a Node `TLSocketRoom` [emp]:

| Package | Version | Notes |
|---|---|---|
| `tldraw` | 5.4.2 | depends on exact `@tldraw/*@5.4.2` and `@tiptap/*@^3.12.1` (resolved 3.31.3) |
| `@tldraw/sync` | 5.4.2 | depends on `tldraw@5.4.2`, `@tldraw/sync-core@5.4.2` |
| `@tldraw/tlschema` | 5.4.2 | MIT, no React imports in its compiled output |
| `@tldraw/validate` | 5.4.2 | source of `T` for React-free schema code |
| `@tldraw/assets` | 5.4.2 | self-hosted fonts, icons, translations |
| `react` / `react-dom` | 19.3.0 | peer range is `^18.2.0 \|\| ^19.2.1` |
| `@types/react` / `@types/react-dom` | 19.3.0 | |
| `vite` | 8.3.1 | tldraw's own template uses `^8.0.16` |
| `@vitejs/plugin-react` | 6.1.1 | template uses `^6.0.1` |
| `typescript` | 5.9.3 | template uses `^5.8.3`. TS 7.0.2 is `latest` on npm but was **not tested** |
| Node (tooling and server) | 24.19.0 | tldraw requires Node `>=22.12.0` since v5.2 (RELEASE_NOTES v5.2) |
| `ws` (server probe only) | 8.18.3 | |

Peer dependencies (from `npm view … peerDependencies` and each `package.json`) [src]:
```json
"tldraw":            { "react": "^18.2.0 || ^19.2.1", "react-dom": "^18.2.0 || ^19.2.1" }
"@tldraw/sync":      { "react": "^18.2.0 || ^19.2.1", "react-dom": "^18.2.0 || ^19.2.1" }
"@tldraw/sync-core": same react peers (the compiled output does not import react)
"@tldraw/tlschema":  same react peers (the compiled output does not import react)
```
Tip for the React-free server package: npm 7+ and pnpm auto-install peer dependencies. The server probe was installed with `--legacy-peer-deps`, so React was absent, and `@tldraw/sync-core`, `@tldraw/tlschema` and `@tldraw/validate` still ran [emp]. With pnpm you can set `auto-install-peers=false` or just ignore the peer warning (UNVERIFIED for pnpm specifically).

Install:
```bash
pnpm add --save-exact tldraw@5.4.2 @tldraw/sync@5.4.2 @tldraw/assets@5.4.2 react@19.3.0 react-dom@19.3.0
pnpm add -D --save-exact vite@8.3.1 @vitejs/plugin-react@6.1.1 typescript@5.9.3 @types/react@19.3.0 @types/react-dom@19.3.0
# packages/canvas-schema:
pnpm add --save-exact @tldraw/tlschema@5.4.2 @tldraw/validate@5.4.2
```
Pin every `@tldraw/*` package to the **same exact version**. tldraw does not follow semver: minor versions may break things (DOCS.md "How tldraw is versioned").

### tsconfig requirement
`skipLibCheck: true` is **required** unless you add lodash typings. With `skipLibCheck: false`, tsc fails inside tldraw's own `.d.ts` files [emp]:
```
node_modules/@tldraw/sync-core/dist-esm/index.d.mts(3,31): error TS2307: Cannot find module 'lodash'
node_modules/@tldraw/utils/dist-esm/index.d.mts(1,36): error TS7016: ... 'lodash.isequal' implicitly has an 'any' type.
```
The tsconfig that worked: `target ES2022`, `module ESNext`, `moduleResolution bundler`, `jsx react-jsx`, `strict`, `isolatedModules`, `verbatimModuleSyntax`, `skipLibCheck: true`, `types: ["vite/client"]`.

### vite.config.ts that worked for both `vite build` and `vite` dev [emp]
```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
export default defineConfig({
  plugins: [react()],
  // Needed only if you import '@tldraw/assets/imports.vite' (self-hosted assets).
  // Without it, Vite 8.3.1's rolldown dep optimizer fails in dev with
  // "[UNLOADABLE_DEPENDENCY] Could not load node_modules/@tldraw/assets/translations/da.json?url"
  // (seen on Windows, "os error 123"). `vite build` works either way.
  optimizeDeps: { exclude: ['@tldraw/assets'] },
})
```
Build output: one JS chunk of 1,981.51 kB minified / 607.89 kB gzip (tldraw + React + TipTap), 77 kB CSS, and 16 woff2 fonts, one icon sprite and translation JSONs emitted as hashed assets. Vite prints a ">500 kB chunk" warning. Code-split the board route with `React.lazy`.

---

## 2. `useSync` (@tldraw/sync 5.4.2)

### 2.1 Exact public signature
From `@tldraw/sync@5.4.2 dist-cjs/index.d.ts` and `src/useSync.ts:179` [src]:
```ts
export declare function useSync(opts: UseSyncOptions & TLStoreSchemaOptions): RemoteTLStoreWithStatus;

export declare type UseSyncOptions = UseSyncOptionsWithConnectFn | UseSyncOptionsWithUri;

export declare interface UseSyncOptionsBase {
  themes?: Partial<TLThemes>;
  assets: TLAssetStore;                      // REQUIRED
  users?: TLUserStore;                       // identity for presence + attribution
  onCustomMessageReceived?(data: any): void;
  getUserPresence?(store: TLStore, user: TLUser): null | TLPresenceStateInfo;
  /* @internal, excluded from public types: onMount, roomId, trackAnalyticsEvent */
}
export declare interface UseSyncOptionsWithUri extends UseSyncOptionsBase {
  uri: (() => Promise<string> | string) | string;   // string OR (async) function
  connect?: never;
}
export declare interface UseSyncOptionsWithConnectFn extends UseSyncOptionsBase {
  connect: UseSyncConnectFn;                 // custom transport
  uri?: never;
}
export declare type UseSyncConnectFn = (query: { sessionId: string; storeId: string }) => TLPersistentClientSocket;
```
`TLStoreSchemaOptions` (`@tldraw/editor@5.4.2 src/lib/config/createTLStore.ts`) is a **union**. You pass either a list of utils **or** a prebuilt schema, never both:
```ts
export declare type TLStoreSchemaOptions = {
  assetUtils?: readonly TLAnyAssetUtilConstructor[];
  bindingUtils?: readonly TLAnyBindingUtilConstructor[];
  migrations?: readonly MigrationSequence[];
  records?: Record<string, CustomRecordInfo>;
  shapeUtils?: readonly TLAnyShapeUtilConstructor[];
} | {
  schema?: StoreSchema<TLRecord, TLStoreProps>;
};
```
- `roomId`, `trackAnalyticsEvent` and `onMount` exist at runtime but are `@internal`, stripped from the public `.d.ts` (`/* Excluded from this release type */`). `roomId` defaults to `'default'` and is used only for analytics events. Put the room in the `uri`.
- `userInfo` does not exist. The probe's `// @ts-expect-error userInfo was removed` compiles, so the property is rejected [emp].

### 2.2 Return type and status values
```ts
export declare type RemoteTLStoreWithStatus =
  | (Extract<TLStoreWithStatus, { status: 'synced-remote' }> & { readonly objectAccess: TLObjectStoreAccess })
  | Exclude<TLStoreWithStatus, { status: 'not-synced' } | { status: 'synced-local' } | { status: 'synced-remote' }>;

// from @tldraw/editor:
export declare type TLStoreWithStatus =
  | { readonly connectionStatus: 'offline' | 'online'; readonly error?: undefined; readonly status: 'synced-remote'; readonly store: TLStore }
  | { readonly error: Error; readonly status: 'error'; readonly store?: undefined }
  | { readonly error?: undefined; readonly status: 'loading'; readonly store?: undefined }
  | { readonly error?: undefined; readonly status: 'not-synced'; readonly store: TLStore }
  | { readonly error?: undefined; readonly status: 'synced-local'; readonly store: TLStore };

export declare type TLObjectStoreAccess = 'read' | 'write';   // defaults to 'write'
```
So for `useSync`, the possible states are:

| `status` | Extra fields | Meaning |
|---|---|---|
| `'loading'` | none | Socket created, first connect and hydration not finished |
| `'synced-remote'` | `store`, `connectionStatus: 'online' \| 'offline'`, `objectAccess` | Loaded at least once. `connectionStatus` flips to `'offline'` while reconnecting. The store stays live and editable [emp] |
| `'error'` | `error: Error` (a `TLRemoteSyncError` with `.reason`) | Fatal. `useSync` closes the socket and **does not auto-retry** (`src/useSync.ts:355-378`) |

`TLRemoteSyncError.reason: string | TLSyncErrorCloseEventReason`, where the reasons (`@tldraw/sync-core` d.ts) are: `'RATE_LIMITED' | 'CLIENT_TOO_OLD' | 'INVALID_RECORD' | 'ROOM_FULL' | 'NOT_FOUND' | 'SERVER_TOO_OLD' | 'UNKNOWN_ERROR' | 'NOT_AUTHENTICATED' | 'FORBIDDEN'` [src]. `TLRemoteSyncError` and `TLSyncErrorCloseEventReason` are re-exported from `@tldraw/sync` (`export * from "@tldraw/sync-core"`).

Internals worth knowing [src, `src/useSync.ts`]:
- `connectionStatus` is the socket status, with `'error'` mapped to `'offline'` (L307-313, L427-430).
- The store is created with `collaboration: { status, mode }` signals (L317-327). This is how tldraw's UI knows it is multiplayer (`useShowCollaborationUi`, `useCollaborationStatus`). The server can force read-only per session: `mode` becomes `'readonly'` when `onAfterConnect` reports `isReadonly` (L379-395).
- Transient disconnects are handled by `ClientWebSocketAdapter`'s `ReconnectManager` (`@tldraw/sync-core src/lib/ClientWebSocketAdapter.ts:379-418`). Backoff runs from `ACTIVE_MIN_DELAY=500ms` to `ACTIVE_MAX_DELAY=2000ms` while the tab is visible, and from 1 s to 5 min while hidden (`DELAY_EXPONENT=1.5`). It listens to `window 'online'` and `document 'visibilitychange'`.
- **Reserved query params:** `sessionId` and `storeId` are appended to your URI. Including either yourself throws (L286-296). `sessionId = TAB_ID`, which is stable per browser tab. `storeId` is new for each `useSync` effect run. Observed server-side: `?token=dev-token&sessionId=TLDRAW_INSTANCE_STATE_V1_…&storeId=…` [emp].
- A `uri` function is called **on every connection attempt** (`new ClientWebSocketAdapter(async () => …)`, L281). Put short-lived auth-token fetching inside it. `http(s)://` URIs are upgraded to `ws(s)://` [docs, d.ts comment].

### 2.3 STABILITY REQUIREMENT (verified failure)
The effect's dependency list (`src/useSync.ts:407-419`) is `[assets, onMount, connect, _users, roomId, schema, setState, track, uri, getUserPresence, onCustomMessageReceived]`. The schema is recomputed when `shapeUtils` or `bindingUtils` identities change (`useTLSchemaFromUtils` does a shallow compare of the options object; `@tldraw/editor src/lib/hooks/useTLStore.ts:24-34`).
- `getUserPresence` and `onCustomMessageReceived` are wrapped in `useReactiveEvent` / `useEvent`, so inline functions are fine for these two.
- **Everything else must be referentially stable.** An inline `uri: async () => ...` in the probe produced an endless connect-disconnect loop: 300+ connections in seconds, and the console showed `WebSocket is closed before the connection is established` [emp]. Fix: define at module level or with `useCallback` or `useMemo`.

### 2.4 Canonical client code (compiled and ran against the Node server) [emp]
```tsx
import { useSync, TLRemoteSyncError, type RemoteTLStoreWithStatus } from '@tldraw/sync'
import { computed, createUserId, defaultBindingUtils, defaultShapeUtils, getDefaultUserPresence,
  Tldraw, UserRecordType, type TLUserStore } from 'tldraw'
import 'tldraw/tldraw.css'

const customShapeUtils = [CardShapeUtil]                          // module level = stable
const allShapeUtils = [...defaultShapeUtils, ...customShapeUtils]  // defaults REQUIRED for useSync
const allBindingUtils = [...defaultBindingUtils]

async function getSyncUri() {                                     // module level = stable
  const token = await fetchSyncToken(boardId)                     // called on every (re)connect
  return `wss://sync.example.com/connect/${encodeURIComponent(boardId)}?token=${token}`
}

function Board({ me, onRetry }: { me: { id: string; name: string; color: string }; onRetry(): void }) {
  const users = useMemo<TLUserStore>(() => ({
    currentUser: computed('currentUser', () =>
      UserRecordType.create({ id: createUserId(me.id), name: me.name, color: me.color })),
  }), [me.id, me.name, me.color])

  const store: RemoteTLStoreWithStatus = useSync({
    uri: getSyncUri,
    assets: assetStore,               // module-level constant
    users,
    shapeUtils: allShapeUtils,
    bindingUtils: allBindingUtils,
    getUserPresence(store, user) {    // optional; inline is OK here
      const p = getDefaultUserPresence(store, user)
      return p && { ...p, meta: { app: 'draftroom' } }
    },
  })

  if (store.status === 'loading') return <Connecting />
  if (store.status === 'error') {
    const reason = store.error instanceof TLRemoteSyncError ? store.error.reason : store.error.message
    return <SyncError reason={String(reason)} onRetry={onRetry} />   // remount to retry
  }
  return (
    <>
      {store.connectionStatus === 'offline' && <ReconnectingBanner />}
      <Tldraw store={store.store} shapeUtils={customShapeUtils} assetUrls={assetUrls}
              options={{ deepLinks: true }} licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY} />
    </>
  )
}
// Retry pattern: the parent holds `const [attempt, setAttempt] = useState(0)` and renders
// <Board key={attempt} onRetry={() => setAttempt(n => n + 1)} />. Verified to reconnect cleanly after an INVALID_RECORD error [emp].
```

### 2.5 Passing the store to `<Tldraw>`
`TldrawEditorWithStoreProps.store: TLStore | TLStoreWithStatus` [src]. Two options:
1. `store={store.store}` after handling `loading` and `error` yourself, as above. This gives full control over the UI.
2. `store={store}` (the whole status object). `TldrawEditor` then renders `components.LoadingScreen` while `'loading'` and **throws `store.error`** on `'error'`, which the editor's `ErrorFallback` boundary catches (`@tldraw/editor src/lib/TldrawEditor.tsx:451-470`). Both official templates use this form.

`<Tldraw shapeUtils>` merges your utils with `defaultShapeUtils` itself (`mergeArraysAndReplaceDefaults('type', _shapeUtils, defaultShapeUtils)`, `tldraw src/lib/Tldraw.tsx:200`). Pass only the **custom** utils to `<Tldraw>`, and pass **defaults plus custom** to `useSync`.

### 2.6 Connecting, reconnecting and error UI
- `'loading'`: show your own screen, or let `<Tldraw>` render `LoadingScreen`.
- `'synced-remote'` with `connectionStatus === 'offline'`: the editor stays editable (`getIsReadonly()` was `false` after the server was killed) [emp]. The default `SharePanel` → `PeopleMenu` swaps to `<OfflineIndicator/>` (`tldraw src/lib/ui/components/SharePanel/DefaultPeopleMenu.tsx:35`), which was observed [emp]. Custom UI can read it through `useCollaborationStatus(): 'online' | 'offline' | null` (exported from `tldraw`) or through `store.connectionStatus`.
- "Pending local changes survive reconnect and are pushed when back online": [docs] only ("When offline, changes are queued locally and sync when the connection resumes"). Not exercised against a persistent server (UNVERIFIED). What was observed [emp]: when the server restarted with an **empty** in-memory room, reconnecting clients were **wiped** to the server's (empty) state. The server is authoritative. `onAfterConnect` calls `store.ensureStoreIsUsable()` to recreate a page (`useSync.ts:387-393`).
- `'error'`: fatal and not retried. Offer a Retry button that remounts. Map reasons to messages: `NOT_AUTHENTICATED` → re-login, `FORBIDDEN` → no access, `NOT_FOUND` → board missing, `CLIENT_TOO_OLD` → "reload to update", `SERVER_TOO_OLD` or `INVALID_RECORD` → "the app was updated; reload", `ROOM_FULL`, `RATE_LIMITED`.
- "Saved" indicator: `useSync` has no "server acknowledged my writes" signal (checked the public types; UNVERIFIED whether something internal exposes it). `connectionStatus: 'online'` only means the socket is up.

---

## 3. `TLAssetStore` and stable asset URLs

### 3.1 Interface (`@tldraw/tlschema@5.4.2` d.ts) [src]
```ts
export declare interface TLAssetStore {
  upload(asset: TLAsset, file: File, abortSignal?: AbortSignal): Promise<{ meta?: JsonObject; src: string }>;
  resolve?(asset: TLAsset, ctx: TLAssetContext): null | Promise<null | string> | string;
  remove?(assetIds: TLAssetId[]): Promise<void>;
}
export declare interface TLAssetContext {
  screenScale: number;            // CSS px on screen / native px
  steppedScreenScale: number;     // power-of-2 step of screenScale
  dpr: number;
  networkEffectiveType: null | string;
  shouldResolveToOriginal: boolean; // true for copy/paste + SVG exports without pixelRatio
}
```
- `upload` returns **an object** `{ src, meta? }`, not a bare string. `src` is written to `asset.props.src` and synced to everyone. `meta` is shallow-merged into `asset.meta` (`defaultHandleExternalFileAsset`, `tldraw src/lib/defaultExternalContentHandlers.ts:147-165`). Verified: the server snapshot held `props.src = "http://localhost:5858/uploads/asset_1115147698-red.png"` and `meta = { uploadedAt: … }` [emp].
- If `resolve` is omitted it defaults to `(asset) => asset.props.src` (`@tldraw/editor src/lib/config/createTLStore.ts:84`). Use `resolve` to add short-lived signed tokens or resize params per render. Returning `null` renders a broken-asset placeholder [docs].
- If `remove` is omitted it defaults to a no-op. It is called **only** from `editor.deleteAssets()` (`Editor.ts:5219-5234`), inside `run(…, { history: 'ignore' })`. The default handlers call `deleteAssets` when an upload fails. Deleting a shape **never** deletes its asset record [docs]. Recommendation: **do not delete bytes in `remove`**. Undo and other collaborators can bring a shape back. Garbage-collect server-side by reference counting against the room snapshot and retained history (matches the build plan's "deleting a shape is not permission to delete the file").
- When no `assets` store is given, the default is `inlineBase64AssetStore` (data URLs inside records; `createTLStore.ts:102-107`). With `useSync`, `assets` is **required** by the type.

### 3.2 How a dropped or pasted file becomes an asset (default handlers) [src][emp]
`<Tldraw>` registers the default handlers **before** your `onMount`, so anything you register in `onMount` replaces the default for that type [docs]. The flow for `putExternalContent({ type: 'files', files })` (`defaultHandleExternalFileContent`, `defaultExternalContentHandlers.ts:392-476`) is:
1. Validate count (`editor.options.maxFilesAtOnce`), size (`maxAssetSize`, default 10 MB = `DEFAULT_MAX_ASSET_SIZE`) and MIME type. Sanitize SVGs.
2. Ask the matching `AssetUtil` for an asset record. `src` starts as `''` (observed `"src": ""`) [emp].
3. For images, `editor.createTemporaryAssetPreview(assetId, file)` creates a **`blob:` object URL held in an in-memory Map on the Editor**. It is never written to a record and is revoked after `options.temporaryAssetPreviewLifetimeMs` (3 min) (`Editor.ts:9442-9519`). Observed `getTemporaryAssetPreview(id)` → `"blob:http:…"` [emp].
4. Create the asset (empty `src`) and the image or video shape immediately (`createShapesForAssets` → `ShapeUtil.createShapeForAsset`).
5. In the background, `getAssetForExternalContent({type:'file'})` → registered `'file'` asset handler → `editor.uploadAsset()` → **your `TLAssetStore.upload`**. Then `updateAssets([{...newAsset, id}])` sets the stable URL. On failure it shows a toast and calls `deleteAssets`.

Other paths that could leak base64 into records, and what 5.4.2 does:
- **Pasting tldraw content that contains `data:image` or `data:video` assets** (for example from a local-only tldraw instance): `putContentOntoCurrentPage` strips `src` to `null`, converts the data URL to a `File` and re-uploads it through the asset store (`Editor.ts:9992-10033`) [src].
- **Excalidraw paste** builds assets with `src: file.dataURL` and then goes through `putContentOntoCurrentPage`, so it is re-uploaded by the rule above [src].
- **`svg-text` paste** is wrapped in `new File([text], 'asset.svg')` and goes through the asset store (`defaultHandleExternalSvgTextContent`) [src].
- **Exports** embed data URLs in the *exported file* only, not in records [docs].
- **Programmatic `editor.createAssets()`** with a data URL would be stored as-is. The server should reject it (see below).

To guarantee no base64 in the board: (a) always pass a real `TLAssetStore`. (b) Optionally add a server-side validation (`TLSocketRoom` `authorizeRecord` or a storage check) that rejects `asset` records whose `props.src` starts with `data:`. That belongs to the server-topic docs; not verified here.

### 3.3 Hooking and configuring
```ts
// Limits via props on <Tldraw> (TLExternalContentProps):
//   maxAssetSize?: number; maxImageDimension?: number;
//   acceptedImageMimeTypes?: readonly string[]; acceptedVideoMimeTypes?: readonly string[]
<Tldraw maxAssetSize={25 * 1024 * 1024} acceptedVideoMimeTypes={['video/mp4', 'video/webm']} … />

// Replace or wrap a default handler in onMount (these defaults are exported from 'tldraw'):
editor.registerExternalContentHandler('files', async (content) => { /* … */ })
editor.registerExternalAssetHandler('file', async ({ file, assetId }) => { /* must return TLAsset */ })
editor.registerExternalAssetHandler('url', unfurlViaOurServer)   // bookmarks, see below
```
Signatures [src, `Editor.ts`]:
```ts
registerExternalAssetHandler<T extends TLExternalAsset['type']>(type: T, handler: null | ((info: TLExternalAsset & { type: T }) => Promise<TLAsset>)): this
uploadAsset(asset: TLAsset, file: File, abortSignal?: AbortSignal): Promise<{ src: string; meta?: JsonObject }>
createTemporaryAssetPreview(assetId: TLAssetId, file: File): string | undefined
```
New file types are added through an `AssetUtil` (`static type`, `static props`, `getSupportedMimeTypes()`, `getAssetFromFile()`), plus a `ShapeUtil` with `static handledAssetTypes` and `createShapeForAsset()` [docs][src: `ShapeUtil.handledAssetTypes`, `createShapeForAsset` in d.ts]. This path will matter later for PDF, audio and other media.

**Bookmarks:** the default `'url'` asset handler does a browser `fetch(url, { mode: 'no-cors' })` and parses OG tags (`defaultExternalContentHandlers.ts:257-311`). A `no-cors` response is opaque, so in practice it yields empty metadata. Both official templates register a server-side unfurl handler instead. Draftroom needs an `/unfurl` endpoint.

### 3.4 Verified asset store (probe)
```ts
export const assetStore: TLAssetStore = {
  async upload(asset, file, abortSignal) {
    const key = `${asset.id.replace(/[^a-zA-Z0-9]/g, '_')}-${encodeURIComponent(file.name)}`
    const res = await fetch(`${API}/uploads/${key}`, { method: 'PUT', body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' }, signal: abortSignal })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    return { src: `${API}/uploads/${key}`, meta: { uploadedAt: Date.now() } }
  },
  resolve(asset, _ctx) { return asset.props.src },
  // no remove(): server-side GC by reference instead
}
```
For Draftroom's direct-to-object-storage flow, `upload()` should: (1) call the API to reserve quota and create `asset_versions` → get `{assetVersionId, uploadUrl, canonicalSrc}`, (2) PUT the file to `uploadUrl` with the `abortSignal`, (3) return `{ src: canonicalSrc, meta: { assetVersionId } }`. Use a stable app URL such as `https://app/…/assets/<versionId>`, never a presigned URL. `resolve()` then maps `canonicalSrc` to a short-TTL signed URL. Keep `resolve` cheap; it runs per render and zoom step. Caching per `(asset.id, steppedScreenScale)` is advisable (UNVERIFIED performance).

Note: the asset **id** for dropped files looked content-hashed (`asset:1115147698`). Two drops of identical bytes may share one asset id (UNVERIFIED; inferred from `getHashForBuffer` being imported in the handlers file).

---

## 4. Custom shapes in 5.x

### 4.1 `ShapeUtil` API (required and common members) [src: `@tldraw/editor` d.ts `export declare abstract class ShapeUtil<Shape extends TLShape = TLShape>`]
```ts
static type: string;
static props?: RecordProps<TLUnknownShape>;                 // validators (T.* or StyleProps)
static migrations?: LegacyMigrations | MigrationSequence | TLPropsMigrations;
static handledAssetTypes?: readonly string[];
static configure<T>(this: T, options: Partial<Options>): T;
options: {};
abstract getDefaultProps(): Shape['props'];
abstract getGeometry(shape: Shape, opts?: TLGeometryOpts): Geometry2d;
abstract component(shape: Shape): any;
abstract getIndicatorPath(shape: Shape): TLIndicatorPath | undefined;   // NEW in 5.0, required
/** @deprecated SVG indicators are no longer rendered. */ indicator(_shape: Shape): any;
createShapeForAsset?(asset: TLAsset, position: VecModel): null | TLShapePartial;
getText(shape): string | undefined;  getReferencedUserIds(shape): string[];
canEdit / canResize / canBind / canSnap / canCrop / isAspectRatioLocked / hideResizeHandles / …
onResize?, onBeforeCreate?, onBeforeUpdate?, onTranslate*, onRotate*, onHandleDrag*, onDoubleClick*, toSvg?, …

export declare type TLIndicatorPath = { additionalPaths?: Path2D[]; clipPath?: Path2D; path: Path2D } | Path2D;
```
`BaseBoxShapeUtil<Shape extends TLBaseBoxShape>` supplies `getGeometry` (Rectangle2d), `onResize`, `getHandleSnapGeometry` and `getInterpolatedProps`, but **not** `getIndicatorPath`. You still implement that [src].
`TLBaseBoxShape = ExtractShapeByProps<{ h: number; w: number }>`.

### 4.2 Type registration: module augmentation of `TLGlobalShapePropsMap` [src][emp]
```ts
// @tldraw/tlschema d.ts
export declare interface TLGlobalShapePropsMap {}
export declare type TLShape<K extends keyof TLIndexedShapes = keyof TLIndexedShapes> = TLIndexedShapes[K];
```
- The docs augment `declare module 'tldraw'`. For React-free shared code, augment **`'@tldraw/tlschema'`**, where the interface is declared. `tldraw` re-exports it (`tldraw` → `export * from "@tldraw/editor"` → `export * from "@tldraw/tlschema"`). Verified: augmenting `'@tldraw/tlschema'` in `shared/canvas-schema.ts` made `editor.createShape({ type: 'dr-card', … })` type-check through `import { Editor } from 'tldraw'`. Typos (`titel`), wrong enum values and unknown types (`'not-a-shape'`) are compile errors [emp].
- Shape type names are global (RELEASE_NOTES v4.3). Prefix them (`dr-card`, `dr-sticky`, …).
- Risk: augmentation merges only if both programs resolve **the same physical** `@tldraw/tlschema` package. Keep one version, deduped (pnpm does this for identical versions).

### 4.3 Migrations: exact API and a verified example
```ts
export declare function createShapePropsMigrationIds<const S extends string, const T extends Record<string, number>>(
  shapeType: S, ids: T): { [k in keyof T]: `com.tldraw.shape.${S}/${T[k]}` };
export declare function createShapePropsMigrationSequence(migrations: TLPropsMigrations): TLPropsMigrations;  // pass-through
export declare interface TLPropsMigrations { readonly sequence: Array<StandaloneDependsOn | TLPropsMigration> }
export declare interface TLPropsMigration {
  readonly id: MigrationId; readonly dependsOn?: MigrationId[];
  readonly up: (props: any) => any;
  readonly down?: 'none' | 'retired' | ((props: any) => any);
}
```
Rules from `@tldraw/tlschema src/recordsWithProps.ts:157-276` [src]:
- The sequence id is `com.tldraw.shape.<type>`. Migration ids must be `com.tldraw.shape.<type>/<n>` (use the helper). If you pass a full `MigrationSequence` instead, its `sequenceId` must match or an assert fires.
- `up` and `down` receive a **mutable copy of `props`**. Either mutate in place or return new props.
- `down` only counts when it is a function. The sync server rejects an **older** client with `CLIENT_TOO_OLD` if any migration between the two versions lacks a `down` (`TLSyncRoom.ts:1045-1049`). With `down` present, the server down-migrates records for old tabs during a rolling deploy. Keep `down` for recent migrations.
- Never edit a shipped migration; append a new one.

Verified example: add a prop, rename a prop, add a rich-text prop. It ran in Node with **only** `@tldraw/tlschema` and `@tldraw/validate` installed (no React) [emp]:
```ts
// packages/canvas-schema/src/card.ts (React-free)
import { createShapePropsMigrationIds, createShapePropsMigrationSequence, createTLSchema,
  defaultBindingSchemas, defaultShapeSchemas, DefaultColorStyle, richTextValidator, toRichText,
  type RecordProps, type SchemaPropsInfo, type TLDefaultColorStyle, type TLRichText, type TLShape } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const CARD_TYPE = 'dr-card' as const
export interface CardShapeProps { w: number; h: number; color: TLDefaultColorStyle; title: string;
  status: 'todo' | 'doing' | 'done'; body: TLRichText }
declare module '@tldraw/tlschema' { interface TLGlobalShapePropsMap { [CARD_TYPE]: CardShapeProps } }
export type CardShape = TLShape<typeof CARD_TYPE>

export const cardShapeProps: RecordProps<CardShape> = {
  w: T.nonZeroNumber, h: T.nonZeroNumber, color: DefaultColorStyle, title: T.string,
  status: T.literalEnum('todo', 'doing', 'done'), body: richTextValidator,
}
// v0 {w,h,color,text} -> v1 +status -> v2 text→title -> v3 +body
export const cardVersions = createShapePropsMigrationIds(CARD_TYPE, { AddStatus: 1, RenameTextToTitle: 2, AddBody: 3 })
export const cardShapeMigrations = createShapePropsMigrationSequence({ sequence: [
  { id: cardVersions.AddStatus, up(p) { p.status = 'todo' }, down(p) { delete p.status } },
  { id: cardVersions.RenameTextToTitle,
    up(p) { p.title = p.text ?? ''; delete p.text }, down(p) { p.text = p.title; delete p.title } },
  { id: cardVersions.AddBody, up(p) { p.body = toRichText('') }, down(p) { delete p.body } },
]})
export const draftroomShapeSchemas = {
  [CARD_TYPE]: { props: cardShapeProps, migrations: cardShapeMigrations },
} satisfies Record<string, SchemaPropsInfo>
export function createDraftroomSchema() {   // server side
  return createTLSchema({ shapes: { ...defaultShapeSchemas, ...draftroomShapeSchemas },
                          bindings: { ...defaultBindingSchemas } })
}
```
Probe output (`schema.migratePersistedRecord(v0Record, oldSchema, 'up' | 'down')`) [emp]:
```
card sequence version 3
up:   props {"w":100,"h":50,"color":"blue","status":"todo","title":"old text","body":{"type":"doc","content":[{"type":"paragraph"}]}}
validates after up: true
down: props {"w":100,"h":50,"color":"blue","text":"old text"}
invalid status rejected: At shape(type = dr-card).props.status: Expected "todo" or "doing" or "done", got nope
```

### 4.4 Client `ShapeUtil` using the shared schema parts (verified to compile and render)
```tsx
import { BaseBoxShapeUtil, HTMLContainer, renderPlaintextFromRichText, toRichText, type TLIndicatorPath } from 'tldraw'
import { CARD_TYPE, cardShapeMigrations, cardShapeProps, type CardShape } from '@draftroom/canvas-schema'

export class CardShapeUtil extends BaseBoxShapeUtil<CardShape> {
  static override type = CARD_TYPE
  static override props = cardShapeProps
  static override migrations = cardShapeMigrations
  getDefaultProps(): CardShape['props'] {
    return { w: 240, h: 140, color: 'yellow', title: 'Card', status: 'todo', body: toRichText('') }
  }
  component(shape: CardShape) {
    return <HTMLContainer style={{ pointerEvents: 'all' }}>
      <strong>{shape.props.title}</strong> {renderPlaintextFromRichText(this.editor, shape.props.body)}
    </HTMLContainer>
  }
  getIndicatorPath(shape: CardShape): TLIndicatorPath {
    const p = new Path2D(); p.roundRect(0, 0, shape.props.w, shape.props.h, 8); return p
  }
  override getText(shape: CardShape) { return shape.props.title }
}
```
Gotcha [emp]: a `StyleProp` inside props (here `color: DefaultColorStyle`) is **overridden by the editor's current "next shape" style** when shapes are created. The card came out `color: 'black'`, not the `'yellow'` from `getDefaultProps`. Use a plain `T.literalEnum(...)` if the default must win.

### 4.5 What the server may import (no React)
| Need | Import from | React? |
|---|---|---|
| `T` validators | `@tldraw/validate` (**not** re-exported by `@tldraw/tlschema`) | no |
| `createTLSchema`, `defaultShapeSchemas`, `defaultBindingSchemas`, `defaultAssetSchemas`, `createShapePropsMigrationIds/Sequence`, `DefaultColorStyle`, `richTextValidator`, `toRichText`, `createShapeId`, `RecordProps`, `TLShape`, `TLGlobalShapePropsMap`, `commentSchemaRecords` | `@tldraw/tlschema` | no. The compiled `dist-esm` imports only `@tldraw/state`, `@tldraw/store`, `@tldraw/utils` and `@tldraw/validate` [src] |
| `TLSocketRoom`, `SQLiteSyncStorage`, `NodeSqliteWrapper`, `InMemorySyncStorage` | `@tldraw/sync-core` | no |
| `ShapeUtil`, `defaultShapeUtils`, `createTLSchemaFromUtils`, JSX | `tldraw` / `@tldraw/editor` | **yes**, client only |

Monorepo layout for the plan's `packages/canvas-schema`: put **props, migrations, the augmentation and `createDraftroomSchema()`** there. Keep `*ShapeUtil.tsx` in `apps/web`.

### 4.6 Keeping client and server schemas identical
- The client builds its schema from utils (`createTLSchemaFromUtils` → `createTLSchema({ shapes: utilsToMap(checkShapesAndAddCore(shapeUtils)), bindings: …, assets: …, records, migrations })`, `createTLStore.ts:116-139`). Note that `createTLSchema` falls back to the defaults **only when a key is `undefined`**: `shapes = defaultShapeSchemas`, `bindings = defaultBindingSchemas`, `assets = defaultAssetSchemas` (`@tldraw/tlschema src/createTLSchema.ts:339-345`).
- Verified in Node: `createTLSchemaFromUtils({ shapeUtils: [...defaultShapeUtils, Card], bindingUtils: [...defaultBindingUtils] }).serialize()` and `createDraftroomSchema().serialize()` have **identical sequence versions**; only key order differs, and the room compares with a deep `isEqual`. `shapeUtils: [Card]` alone **throws**: `Migration 'com.tldraw.binding.arrow/1' depends on missing migration 'com.tldraw.shape.arrow/4'` [emp].
- Alternative: give the client the exact same schema object with `useSync({ schema: createDraftroomSchema(), … })`. `TLStoreSchemaOptions` allows it, but then you cannot also pass `shapeUtils` to `useSync`; `<Tldraw shapeUtils>` still needs the utils for rendering. Not run in the browser (UNVERIFIED at runtime; type-valid per the union).
- **Recommended CI test:** assert `JSON.stringify(sortKeys(clientSchema.serialize())) === JSON.stringify(sortKeys(createDraftroomSchema().serialize()))`. `tldraw` can be imported in Node 24 for this, but the process does not exit on its own (it keeps a timer alive), so call `process.exit()` or run it under vitest [emp].
- Failure modes when they diverge [emp][src]:
  - Server missing a client shape type: **connection accepted**, and the first push of that record gives `status: 'error'`, reason **`INVALID_RECORD`** [emp].
  - Client has newer versions of known sequences than the server: `SERVER_TOO_OLD` (`TLSyncRoom.ts:987-1003`) [src].
  - Client older and a migration lacks `down`: `CLIENT_TOO_OLD` [src].
  - **Deploy order: server first, then clients.**

---

## 5. Presence and users

### 5.1 Identity: `TLUserStore` (replaces `userInfo`)
```ts
export declare interface TLUserStore {
  currentUser: Signal<null | TLUser>;                 // presence + attribution
  resolve?(userId: string): Signal<null | TLUser>;    // display names for other users' ids
}
export declare interface TLUser extends BaseRecord<'user', TLUserId> { name: string; color: string; imageUrl: string; meta: JsonObject }
export declare function createUserId(id: string): TLUserId;   // 'u-alice' -> 'user:u-alice'
export declare const UserRecordType: RecordType<TLUser, never>;
export declare function createCachedUserResolve(fn: (userId: string) => null | TLUser): (userId: string) => Signal<null | TLUser>;
```
(Note: the v5.0 release notes describe `getCurrentUser()`. The shipped 5.4.2 interface is a `currentUser` **property Signal**. Trust the `.d.ts`.)

Flow (`useSync.ts:217-258, 329-331`) [src]:
1. `users.currentUser` goes to the store (`createTLStore({ users })`) for attribution. If `null`, a non-null presence user is derived from local `TLUserPreferences` (localStorage).
2. `createPresenceStateDerivation(currentUser, { getUserPresence })` builds the presence record from `getUserPresence ?? getDefaultUserPresence`. That fills `userId`, `userName` and `color` from the `TLUser`, plus cursor, selection, camera, brush and so on.
3. If `users.resolve` is not given, `useSync` resolves other users from `instance_presence` records (default path) or only the current user (custom path).

Verified [emp]: Alice's tab saw Bob as `{ userId: 'user:u-bob', userName: 'Bob', color: '#1971c2', meta: { app: 'draftroom' }, cursor: {x,y,type:'default',rotation:0} }`, and the custom `getUserPresence` meta was propagated.

**Gotcha [emp]:** `editor.user` (local `TLUserPreferences`: name, color, locale, theme, used by the people menu's "you" entry and user-preferences UI) is **separate** from `users.currentUser`. In the probe, `editor.user.getName()` returned `''` with a random color while presence broadcast "Alice". To keep them in sync, also pass `<Tldraw user={useTldrawCurrentUser({ userPreferences, setUserPreferences })}>`. See the official `apps/examples/src/examples/users/sync-custom-user/SyncCustomUser.tsx` (v5.4.2):
```ts
export declare function useTldrawCurrentUser(opts: {
  setUserPreferences?: (userPreferences: TLUserPreferences) => void;
  userPreferences?: Signal<TLUserPreferences> | TLUserPreferences;
}): TLCurrentUser;
```

Presence record fields (`TLInstancePresence`, tlschema d.ts): `userId: TLUserId; userName; lastActivityTimestamp; color; camera; selectedShapeIds; currentPageId; brush; scribbles; screenBounds; followingUserId; cursor {x,y,type,rotation} | null; chatMessage; meta`. `getUserPresence` returning `null` hides the user entirely (spectator). Setting `camera: undefined` disables following [docs].

### 5.2 How collaborators are drawn (5.x)
- **Cursors**: DOM layer `LiveCollaborators`, which uses the `TLEditorComponents.CollaboratorCursor?: ComponentType<TLCursorProps> | null` slot (default `DefaultCursor`) (`@tldraw/editor src/lib/components/LiveCollaborators.tsx`). `TLCursorProps = { userId; className?; point: VecModel | null; zoom; color?; name: string | null; chatMessage }`. Override with `components={{ CollaboratorCursor: MyCursor }}` or hide with `null`. The name is suppressed when it equals `'New User'`.
- **Selections, brushes, scribbles and off-screen hint arrows** are canvas `OverlayUtil`s in `defaultOverlayUtils`: `CollaboratorShapeIndicatorOverlayUtil`, `CollaboratorBrushOverlayUtil`, `CollaboratorScribbleOverlayUtil`, `CollaboratorHintOverlayUtil`. Customize via the `overlayUtils` prop. `CollaboratorCursorOverlayUtil` is exported but `@deprecated` [src].
- **People menu / share panel**: `SharePanel` → `PeopleMenu` (avatars, follow). It shows `OfflineIndicator` when offline [src][emp].
- Visibility is decided by `editor.getVisibleCollaboratorsOnCurrentPage()`. `editor.getCollaborators()` returns every `TLInstancePresence` [src].

### 5.3 What is persisted vs ephemeral (source-verified plus observed)
Record scopes (probe printout of `schema.types[*].scope`) [emp]:
```
asset, binding, document, page, shape, user  -> 'document'   (synced + persisted)
camera, instance, instance_page_state, pointer -> 'session'  (never leave the tab)
instance_presence                              -> 'presence' (synced, never persisted)
```
- The client pushes only document-scope changes as document diffs: `this.store.listen(…, { source: 'user', scope: 'document' })` (`@tldraw/sync-core src/lib/TLSyncClient.ts:570-579`). Presence is pushed through a separate `presence` field.
- The server keeps presence in an **in-memory `PresenceStore` (an `AtomMap`)**, separate from `storage` (`TLSyncRoom.ts:265, 1617-1636`). It deletes the entry on session close (L546-552). The presence lane never goes through `authorizeRecord`; registering the presence type there is a construction-time error (L178-179, L412-417).
- Observed room snapshot after two users moved cursors: `byType: { document: 1, page: 1, user: 2, shape: 3, asset: 1 }`, with **no `instance_presence`** [emp].
- **But `user:` records are persisted** [src][emp]. `Editor.getAttributionUserId()` calls `_ensureUserRecord(user)`, which does `store.put([user])` with `history: 'ignore'` (`Editor.ts:4396-4425`). `NoteShapeUtil` stamps `textLastEditedBy` (raw id, e.g. `'u-alice'`) whenever note text changes. Observed: both `user:u-alice {name:'Alice', color:'#e03131', imageUrl:'', meta:{}}` and `user:u-bob` ended up in the server room. **Privacy implication**: display names and colors, plus `imageUrl` and `meta` if you set them, of anyone who edits become part of the durable board document, exports and clipboard. Feed only what you are happy to persist (id and display name), and treat user renames as updates to these records.

---

## 6. Undo/redo, deep links, default tools, rich text

### 6.1 History [src][emp]
```ts
undo(): this;  redo(): this;  canUndo(): boolean;  canRedo(): boolean;  // reactive; getCanUndo()/getCanRedo() also exist
clearHistory(): this;
markHistoryStoppingPoint(name?: string): string;   // returns mark id
squashToMark(markId: string): this;  bail(): this;  bailToMark(id: string): this;
run(fn: () => void, opts?: { history?: 'ignore' | 'record-preserveRedoStack' | 'record'; ignoreShapeLock?: boolean }): this;
```
- Only `source: 'user'` changes are recorded. Remote changes (`'remote'`) are never on the local stack [docs]. Verified: after Bob created a card, Alice's `canUndo()` was `false` and `undo()` did not remove Bob's card. Local undo and redo worked (1 → 0 → 1 shapes) [emp].
- Asset operations run with `history: 'ignore'` [src]. Undoing an image insert removes the shape, not the upload.
- Default UI: Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, plus the `undo` and `redo` actions [src: `ui/context/actions.tsx`].

### 6.2 Deep links [src][emp]
```ts
export declare type TLDeepLink =
  | { type: 'viewport'; bounds: BoxModel; pageId?: TLPageId }
  | { type: 'page'; pageId: TLPageId }
  | { type: 'shapes'; shapeIds: TLShapeId[] };
createDeepLink(opts?: { param?: string; to?: TLDeepLink; url?: string | URL }): URL;
navigateToDeepLink(opts?: { param?: string; url?: string | URL } | TLDeepLink): Editor;
registerDeepLinkListener(opts?: TLDeepLinkOptions): () => void;
interface TLDeepLinkOptions { param?: string; debounceMs?: number; getUrl?(editor): string | URL;
  getTarget?(editor): TLDeepLink; onChange?(url: URL, editor): void }
// Enable: <Tldraw options={{ deepLinks: true | TLDeepLinkOptions }} />   (the `deepLinks` prop is @deprecated)
```
- The `createDeepLink` JSDoc example uses `{ type: 'selection' }`, which is **wrong**. That is a type error in 5.4.2; use `'shapes'` (probe `@ts-expect-error`) [emp].
- Observed [emp]: with `options.deepLinks: true`, the URL is kept updated as `?…&d=v0.0.295.1191.page` (viewport and page). Other query params are preserved. `createDeepLink({ to: { type: 'shapes', shapeIds } })` gave `…&d=sUjGUHAbtEGaNVTqM004bQ`. The default `onChange` uses `history.replaceState`; with a router, pass `onChange: (url) => navigate(url, { replace: true })`.

### 6.3 Default shapes and tools available in `<Tldraw>` [src: tldraw d.ts]
- `defaultShapeUtils` = text, bookmark, draw, geo, note, line, frame, arrow, highlight, embed, image, video. `group` is always added as the core shape.
- `defaultShapeTools` = `TextShapeTool, DrawShapeTool, GeoShapeTool, NoteShapeTool, LineShapeTool, FrameShapeTool, ArrowShapeTool, HighlightShapeTool`.
- `defaultTools` = `EraserTool, HandTool, LaserTool, ZoomTool, SelectTool`.
- `defaultBindingUtils` = `ArrowBindingUtil`.
- Images and video have **no shape tool**. They arrive by drop, paste or the toolbar's `asset` item / `insert-media` action (`Ctrl/Cmd+U` → `helpers.insertMedia()` file picker). Embeds come from the `embed` toolbar item (`EmbedDialog`) or URL paste [src: `ui/hooks/useTools.tsx`, `ui/context/actions.tsx`].
- So notes, text, arrows, frames and images are all available out of the box, matching the build plan's v1 canvas scope.

### 6.4 Rich text format [src][emp]
- `TLRichText = T.TypeOf<typeof richTextValidator>`, where `richTextValidator: T.ObjectValidator<{ attrs?: any; content: unknown[]; type: string }>`. This is **TipTap / ProseMirror JSON**, for example `{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] }`. `toRichText('')` gives `{ type:'doc', content:[{ type:'paragraph' }] }` [emp].
- `note` props: `color, labelColor, size, font, fontSizeAdjustment, align, verticalAlign, growY, url, richText, scale, textLastEditedBy: string | null`. `text` props: `color, size, font, textAlign, w, richText, scale, autoSize`. `frame` props: `w, h, name, color`. `geo` and `arrow` also carry rich-text labels.
- Helpers from `tldraw`: `toRichText(text)`, `renderPlaintextFromRichText(editor, rt)`, `renderHtmlFromRichText(editor, rt)`, `renderRichTextFromHTML(editor, html)`, `renderHtmlFromRichTextWithExtensions(rt, extensions)`. Use plaintext for search indexing and CSV export.
- The editor is TipTap v3 (`@tiptap/core|react|pm|starter-kit ^3.12.1`, resolved 3.31.3).
- **Concurrency**: sync diffs are structural `put` / `patch` / `append` operations on record props (`@tldraw/sync-core src/lib/diff.ts:185-300`). Pure string appends are `append`; anything else inside `richText` becomes a nested patch or put. This is **not** a text CRDT. Two people typing in the same note will overwrite each other's edits to the same text node, in server order. That conclusion comes from the source; the two-writer case was **not** tested (UNVERIFIED). It supports the build plan's recommendation of a prototype test and possibly an edit lease.

---

## 7. License behavior (`@tldraw/editor@5.4.2 src/lib/license/*`) [src]

- Prop: `licenseKey?: string` on `<Tldraw>` / `TldrawEditorBaseProps`. If the prop is absent, `LicenseProvider` reads env vars in this order (`LicenseProvider.tsx:79-107`): `process.env.TLDRAW_LICENSE_KEY`, `NEXT_PUBLIC_…`, `REACT_APP_…`, `GATSBY_…`, `VITE_TLDRAW_LICENSE_KEY`, `PUBLIC_…`, then the same names on `import.meta.env`. **In Vite, `VITE_TLDRAW_LICENSE_KEY` in `.env` is picked up automatically.** (The string is in the built bundle [emp]. It is a public, domain-locked key, so shipping it to the browser is expected.)
- "Development" detection (`LicenseManager.ts:176-196`):
  ```ts
  if (hostname.endsWith('.localhost')) return NODE_ENV !== 'production'
  return protocol === 'http:' || (protocol === 'https:' && isLoopbackHost(hostname)) || NODE_ENV !== 'production'
  // loopback = localhost | ::1 | 127.x.x.x
  ```
  So **any plain `http:` origin counts as development**, even a production build. Only https on a real hostname with `NODE_ENV=production` is "production".
- States (`getLicenseState`, L591-667) and their effects:

| Situation | State | Effect |
|---|---|---|
| Dev (as defined above), no key or invalid key | `unlicensed` | Watermark "Get a license for production" (`Watermark.tsx:26`). The editor works. **Observed on `http://localhost` with both `vite preview` (production build) and `vite` dev: `data-testid="tl-watermark-unlicensed"` present** [emp] |
| Dev, valid key | `licensed` | No watermark. If `crypto.subtle` is unavailable (insecure context), the result is `has-key-development-mode` → `unlicensed` with a console note |
| Production, no key | `unlicensed-production` | Console error block ("No tldraw license key provided! …"). **After `LICENSE_TIMEOUT = 5000 ms` the editor unmounts and a hidden `<div data-testid="tl-license-expired">` renders, so the page is blank** (`LicenseProvider.tsx:34-76`). A tracking GET to `https://cdn.tldraw.com/<ver>/watermarks/watermark-track.svg?...&url=<page url>` is sent (`maybeTrack`, L225-252) |
| Production, key valid but hostname not in `hosts` | `unlicensed-production` | Same as above: hidden after 5 s. `hosts` allows an exact match, `www.` variants, `*`, and `*.domain.com` globs (L388-434) |
| Evaluation or trial license (valid) | `licensed` | No watermark (tracked). Expires with **no grace period**, which leads to `expired` and the editor hidden after 5 s |
| Annual license past its expiry date | `licensed` for 30 days (console warning), then `expired` | Hidden after 5 s |
| License with the `WITH_WATERMARK` flag | `licensed-with-watermark` | Watermark shown |

- Feature flags: licenses carry `FEAT_COLLABORATION` and `FEAT_COMMENTING` bits (`LicenseManager.ts:26-30`). In 5.4.2 the **only consumer** of these flags in `tldraw`, `@tldraw/editor`, `@tldraw/sync` and `@tldraw/sync-core` is `useCommentingEnabled` (commenting UI). `useSync` and collaboration are **not** gated by the flag today (grep of all four packages' `src`) [src]. Development enables all features. This may change in future versions (risk).
- Consequence for Render: `*.onrender.com` staging and the production domain must both be listed in the key's `hosts`, or staging goes blank after 5 s. Plain-http environments never go blank.

---

## 8. CSS, fonts, icons, translations and the CDN

- Required CSS: `import 'tldraw/tldraw.css'` (package `exports` has `"./tldraw.css"`). It can also be pulled in with `@import url('tldraw/tldraw.css')`. The container must have an explicit size (`position: fixed; inset: 0` or similar). Recommended viewport meta: `width=device-width, initial-scale=1, viewport-fit=cover` [docs].
- **By default tldraw fetches static assets from `https://cdn.tldraw.com/5.4.2/…`** [src: `@tldraw/editor src/lib/utils/assets.ts` `CDN_BASE_URL`; `tldraw src/lib/utils/static-assets/assetUrls.ts` fonts; `tldraw src/lib/ui/assetUrls.ts` icon sprite `icons/icon/0_merged.svg#<name>`, `translations/<locale>.json`, `embed-icons/<type>.png`]. Shape fonts are IBM Plex Sans/Serif/Mono and Shantell Sans.
- Self-hosting with `@tldraw/assets@5.4.2` (package files: `imports.js`, `imports.vite.js`, `urls.js`, `selfHosted.js`, plus `fonts/`, `icons/`, `translations/`, `embed-icons/`):
  ```ts
  import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite' // `?url` imports; bundled + hashed by Vite
  // or: import { getAssetUrlsByMetaUrl } from '@tldraw/assets/urls'  // new URL(path, import.meta.url)
  // or: import { getAssetUrls } from '@tldraw/assets/selfHosted'     // copy folders to /public; getAssetUrls({ baseUrl })
  const assetUrls = getAssetUrlsByImport()      // module level (the prop must be memoized/stable)
  <Tldraw assetUrls={assetUrls} … />
  // types: export type AssetUrlOptions = { baseUrl?: string } | ((assetUrl: string) => string)
  ```
  Verified with `imports.vite`: **zero requests to `*.tldraw.com`** during load, editing and image upload, in both `vite preview` and `vite` dev (network log). All fonts and the icon sprite came from `localhost:4173/assets/*` [emp]. Needs the `optimizeDeps.exclude: ['@tldraw/assets']` workaround in dev (section 1).
- Remaining CDN contact even when self-hosted: the license tracking beacon in unlicensed production, evaluation or watermark states (above). Bookmarks and embeds fetch third-party URLs by design.
- `@tldraw/sync` lists `ws` as a dependency. It did not break the browser build (the bundle built and ran) [emp].

---

## 9. Empirical verification log

Scratch location: `C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/research/sync-client/`
- `app/`: Vite + React client (`shared/canvas-schema.ts`, `src/CardShapeUtil.tsx`, `src/assetStore.ts`, `src/App.tsx`, `vite.config.ts`, `tsconfig.json`)
- `server/`: React-free Node probe (`migrate-probe.ts`, `server.ts` using `TLSocketRoom` + `ws`, installed with `--legacy-peer-deps`, no `react` in `node_modules`). Run directly with Node 24 type-stripping (`node server.ts`)
- `pkgs/`: extracted 5.4.2 tarballs (source of all `[src]` citations)

| # | Check | Result |
|---|---|---|
| 1 | `tsc --noEmit` strict, `skipLibCheck: false` | FAIL inside tldraw d.ts (lodash typings) |
| 2 | `tsc --noEmit` strict, `skipLibCheck: true` | PASS, including `@ts-expect-error` checks: `userInfo` rejected, deep link `'selection'` rejected, bad enum rejected |
| 3 | Negative test (wrong prop type, typo prop, unknown shape type) | 3 expected errors, so augmentation of `'@tldraw/tlschema'` is effective through `'tldraw'` |
| 4 | `vite build` (Vite 8.3.1) | PASS, 1.98 MB JS / 608 kB gzip |
| 5 | `vite` dev with `@tldraw/assets/imports.vite` | FAIL `UNLOADABLE_DEPENDENCY …?url`, then PASS with `optimizeDeps.exclude` |
| 6 | Migrations up and down in React-free Node | PASS (output in section 4.3) |
| 7 | Client schema from utils vs server `createTLSchema` | identical versions (key order differs) |
| 8 | `shapeUtils` without defaults | throws (arrow binding dependency) |
| 9 | Inline `uri` function | reconnect storm; fixed by a stable reference |
| 10 | Two tabs, presence | names, colors, cursor and custom meta propagated; no presence in the server snapshot |
| 11 | Note text edit | `textLastEditedBy: 'u-alice'`; `user:` records persisted in the room |
| 12 | `putExternalContent({type:'files'})` PNG | asset `src` `''`, then stable URL; `meta` merged; blob preview in memory only; server has no data URL |
| 13 | Kill server | status stays `synced-remote`, `connectionStatus 'offline'`, editable, `OfflineIndicator` shown |
| 14 | Server restarted with empty room | clients reconnected and were wiped to the empty state |
| 15 | Server schema without `dr-card` | connect OK, then `INVALID_RECORD` on the first card push; Retry via `key` remount OK after fixing the server |
| 16 | Remote change and local undo | remote change not undoable |
| 17 | License on `http://localhost` | `tl-watermark-unlicensed` watermark, editor functional |

---

## 10. UNVERIFIED and open items
1. Offline edits being pushed on reconnect to a **persistent** room (docs say yes; not exercised).
2. Behavior on `https` plus a real hostname without a key (hide after 5 s): source-verified only, not observed.
3. `optimizeDeps` failure on Linux/macOS (seen on Windows only). Keep the exclude regardless.
4. TypeScript 7.x compatibility with tldraw's `.d.ts` (tested 5.9.3 only).
5. React 18.2 at runtime (peer range allows it; tested 19.3.0 only).
6. Two users editing the same note text at the same moment (expected last-writer-wins per diff path; needs the build plan's prototype test).
7. `useSync({ schema })` variant at runtime.
8. Whether identical dropped files always dedupe to one asset id.
9. pnpm-specific peer auto-install behavior for the React-free server package.
