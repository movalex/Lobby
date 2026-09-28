// Loads the @tldraw/store and @tldraw/state module instances that @tldraw/sync-core itself uses.
//
// Why not `import '@tldraw/store'`: apps/sync does not depend on it directly (pnpm strict layout, and
// dependency lists are frozen), so the bare specifier does not resolve from here. Why the ESM entry:
// vitest loads sync-core as native ESM; a CJS copy of @tldraw/state would be a second reactive
// runtime, and TLSyncClient's `react()` would never see our presence atom change.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TLPresenceMode, TLSyncClient } from '@tldraw/sync-core'
import type { TLRecord, TLSchema, TLStore, TLStoreProps } from '@tldraw/tlschema'

// TLSyncClient throttles sends/rebases to animation frames unless NODE_ENV is 'test', in which case
// they run synchronously (@tldraw/utils FpsScheduler). Node has no requestAnimationFrame, and
// synchronous sends are what make the protocol tests deterministic.
process.env.NODE_ENV ??= 'test'
if (process.env.NODE_ENV !== 'test') throw new Error('the Node sync client requires NODE_ENV=test')

const syncCoreCjs = createRequire(import.meta.url).resolve('@tldraw/sync-core')
const fromSyncCore = createRequire(syncCoreCjs)

function esmEntry(pkg: string): string {
  // require.resolve returns the real (symlink-free) path of <pkg>/dist-cjs/index.js; Node's ESM loader
  // also realpaths, so this URL is the same module record sync-core's own `import` gets.
  const cjsEntry = fromSyncCore.resolve(pkg)
  return pathToFileURL(join(dirname(dirname(cjsEntry)), 'dist-esm', 'index.mjs')).href
}

export interface MutableSignal<T> {
  get(): T
  set(value: T): T
}

type ClientConfig = ConstructorParameters<typeof TLSyncClient<TLRecord, TLStore>>[0]
type StoreCtor = new (config: { schema: TLSchema; props: TLStoreProps; id?: string }) => TLStore

const storeModule = (await import(esmEntry('@tldraw/store'))) as { Store: StoreCtor }
const stateModule = (await import(esmEntry('@tldraw/state'))) as {
  atom: <T>(name: string, initial: T) => MutableSignal<T>
  react: (name: string, fn: () => void) => () => void
}

export function createStore(schema: TLSchema): TLStore {
  return new storeModule.Store({
    schema,
    props: {
      defaultName: '',
      // the Node client never uploads or resolves assets; these satisfy TLStoreProps only
      assets: { upload: async () => ({ src: '' }), resolve: async () => null, remove: async () => {} },
      users: {
        currentUser: stateModule.atom('currentUser', null),
        resolve: () => stateModule.atom('user', null),
      } as unknown as TLStoreProps['users'],
      onMount: () => {},
    },
  })
}

export function createAtom<T>(name: string, initial: T): MutableSignal<T> {
  return stateModule.atom(name, initial)
}

/** @tldraw/state's react() (the one sync-core uses): runs `fn` now and whenever what it read changes. */
export function react(name: string, fn: () => void): () => void {
  return stateModule.react(name, fn)
}

/** The atoms are real @tldraw/state atoms; only their static type comes from our narrow interface. */
export function clientSignals(
  presence: MutableSignal<TLRecord | null>,
  mode: MutableSignal<TLPresenceMode>,
): Pick<ClientConfig, 'presence' | 'presenceMode'> {
  return {
    presence: presence as unknown as ClientConfig['presence'],
    presenceMode: mode as unknown as ClientConfig['presenceMode'],
  }
}

/**
 * tldraw registers every loaded library copy on globalThis; more than one module format for a
 * package means two runtimes (the reactive state would silently split).
 */
export function loadedTldrawCopies(): Record<string, string[]> {
  const info = (
    globalThis as { __TLDRAW_LIBRARY_VERSIONS__?: { versions: { name: string; modules: string }[] } }
  ).__TLDRAW_LIBRARY_VERSIONS__
  const out: Record<string, string[]> = {}
  for (const v of info?.versions ?? []) {
    out[v.name] ??= []
    out[v.name]?.push(v.modules)
  }
  return out
}
