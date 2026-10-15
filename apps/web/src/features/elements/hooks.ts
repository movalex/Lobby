// OWNER: WS3 (wave Q). The Elements panel's data: the icons (loaded the first time the panel opens, a lazy chunk), each
// icon's geometry and each library item's elements once its tile scrolls into view (cached for the page), and the
// library's pages and folders. Nothing here throws: a source that cannot load is empty, and the panel says so.
import type {
  IconGeometry,
  IconIndex,
  IconSetId,
  LibraryFolder,
  LibraryItemSummary,
  LibraryScope,
} from '@draftroom/contracts'
import { type RefObject, useEffect, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { type AccessFacts, type ElementsAccess, elementsAccess } from './access.ts'
import {
  getLibraryItem,
  libraryAvailable,
  listLibrary,
  listLibraryFolders,
  subscribeLibrary,
} from './client.ts'
import { type IconsApi, loadIconsApi } from './icons-port.ts'
import type { ItemPreviewEl } from './Previews.tsx'

export type IconsState =
  | { readonly status: 'loading' }
  | { readonly status: 'none' }
  | { readonly status: 'ready'; readonly api: IconsApi; readonly index: IconIndex }

let iconsReady: IconsState = { status: 'loading' }

/** The icons and their index (loaded once per page). */
export function useIcons(): IconsState {
  const [s, set] = useState<IconsState>(iconsReady)
  useEffect(() => {
    if (s.status !== 'loading') return
    let live = true
    void (async () => {
      const api = await loadIconsApi()
      let next: IconsState = { status: 'none' }
      if (api)
        try {
          next = { status: 'ready', api, index: await api.loadIndex() }
        } catch (e) {
          console.warn('elements: the icon index did not load', e)
        }
      iconsReady = next
      if (live) set(next)
    })()
    return () => {
      live = false
    }
  }, [s.status])
  return s
}

/** Tests and a reload of the icons: forget what this page loaded. */
export function resetIconsState(): void {
  iconsReady = { status: 'loading' }
  geometry.clear()
}

/** Whether `ref` is (or has been) in view: a tile loads its drawing then. Without an IntersectionObserver: at once. */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    if (seen) return
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true)
      },
      { rootMargin: '120px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

const geometry = new Map<string, Promise<IconGeometry | null>>()

/** An icon's geometry once `load` is true (its shard is fetched once for the page). */
export function useIconGeometry(
  icons: IconsState,
  set: IconSetId,
  name: string,
  load: boolean,
): IconGeometry | null | undefined {
  const [g, setG] = useState<IconGeometry | null | undefined>(undefined)
  useEffect(() => {
    if (!load || icons.status !== 'ready') return
    const key = `${set}:${name}`
    let p = geometry.get(key)
    if (!p) {
      p = icons.api.loadGeometry(icons.index, set, name).catch(() => null)
      geometry.set(key, p)
    }
    let live = true
    void p.then((v) => {
      if (live) setG(v)
    })
    return () => {
      live = false
    }
  }, [icons, set, name, load])
  return g
}

const itemElements = new Map<string, Promise<readonly ItemPreviewEl[] | null>>()

/** A library item's elements for its drawing, once `load` is true (one read per item revision and page). */
export function useItemElements(
  workspaceId: string,
  item: Pick<LibraryItemSummary, 'id' | 'revision'>,
  load: boolean,
): readonly ItemPreviewEl[] | null | undefined {
  const [els, setEls] = useState<readonly ItemPreviewEl[] | null | undefined>(undefined)
  useEffect(() => {
    if (!load) return
    const key = `${workspaceId}/${item.id}@${item.revision}`
    let p = itemElements.get(key)
    if (!p) {
      p = getLibraryItem(workspaceId, item.id).then((r) =>
        r ? (r.elements as unknown as ItemPreviewEl[]) : null,
      )
      itemElements.set(key, p)
    }
    let live = true
    void p.then((v) => {
      if (live) setEls(v)
    })
    return () => {
      live = false
    }
  }, [workspaceId, item.id, item.revision, load])
  return els
}

export interface LibraryQuery {
  readonly scope: LibraryScope
  /** a folder id, 'none' (in no folder), 'all', or 'deleted' (Recently deleted) */
  readonly folder: string
  readonly enabled: boolean
  /** re-read when it changes (a save, an edit, a delete on this page) */
  readonly version: number
}

export interface LibraryList {
  readonly items: readonly LibraryItemSummary[]
  readonly loading: boolean
  readonly more: (() => void) | null
}

/** The Library tab's items for a scope and folder (pages of 60; `more` reads the next). */
interface ListState {
  readonly items: LibraryItemSummary[]
  readonly cursor: string | null
  readonly loading: boolean
}

export function useLibraryList(workspaceId: string, q: LibraryQuery): LibraryList {
  const [state, setState] = useState<ListState>({ items: [], cursor: null, loading: false })
  const [page, setPage] = useState<string | null>(null)
  // a new query starts again from its first page
  // biome-ignore lint/correctness/useExhaustiveDependencies: the inputs that start a new list
  useEffect(() => {
    setPage(null)
    setState({ items: [], cursor: null, loading: q.enabled })
  }, [workspaceId, q.scope, q.folder, q.enabled, q.version])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads the page after a change
  useEffect(() => {
    if (!q.enabled) return
    let live = true
    const folder = q.folder === 'all' || q.folder === 'deleted' ? undefined : q.folder
    setState((s) => ({ ...s, loading: true }))
    void listLibrary(workspaceId, {
      scope: q.scope,
      ...(folder ? { folder } : {}),
      ...(q.folder === 'deleted' ? { deleted: '1' as const } : {}),
      ...(page ? { cursor: page } : {}),
    }).then((r) => {
      if (!live) return
      setState((s) => ({
        items: page ? [...s.items, ...r.items.filter((i) => !s.items.some((x) => x.id === i.id))] : r.items,
        cursor: r.nextCursor,
        loading: false,
      }))
    })
    return () => {
      live = false
    }
  }, [workspaceId, q.scope, q.folder, q.enabled, q.version, page])
  return {
    items: state.items,
    loading: state.loading,
    more: state.cursor ? () => setPage(state.cursor) : null,
  }
}

/** A scope's folders (re-read with `version`). */
export function useFolders(
  workspaceId: string,
  scope: LibraryScope,
  enabled: boolean,
  version: number,
): readonly LibraryFolder[] {
  const [folders, setFolders] = useState<readonly LibraryFolder[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads the folders after a change
  useEffect(() => {
    if (!enabled) {
      setFolders([])
      return
    }
    let live = true
    void listLibraryFolders(workspaceId, scope).then((f) => {
      if (live) setFolders([...f].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)))
    })
    return () => {
      live = false
    }
  }, [workspaceId, scope, enabled, version])
  return folders
}

/** What the board page knows about the caller, for ./access.ts. */
export function accessFactsOf(
  ctx: Pick<CanvasFeatureContext, 'me' | 'workspace'>,
  libraryOnApi = libraryAvailable(ctx.workspace.id),
): AccessFacts {
  return {
    nameOnlyGuest: knownUserKind(ctx.me.user.id) === 'guest',
    workspaceRole: ctx.me.workspaces.find((w) => w.id === ctx.workspace.id)?.role ?? null,
    access: ctx.me.access,
    libraryOnApi,
  }
}

/** The caller's access to the panel's parts (it follows the api's library being found missing). */
export function useElementsAccess(ctx: Pick<CanvasFeatureContext, 'me' | 'workspace'>): ElementsAccess {
  const wid = ctx.workspace.id
  const [onApi, setOnApi] = useState(() => libraryAvailable(wid))
  useEffect(() => {
    setOnApi(libraryAvailable(wid))
    return subscribeLibrary(() => setOnApi(libraryAvailable(wid)))
  }, [wid])
  return elementsAccess(accessFactsOf(ctx, onApi))
}
