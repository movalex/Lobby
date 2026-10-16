// OWNER: WS2 (wave S). The version lists of one board page, per deliverable (asset id): fetched when a chip, the
// viewer or "Upload new version" first asks, refreshed when the api says the asset has a new version
// (ASSET_VERSION_EVENT, after the upload's COMMIT), on every event-stream (re)open (events are hints: a missed one only
// delays the chip), and when a card shows a version the cached list does not know (another tab's write reached this
// one before its event). Never stored in the browser, never synced.
import { ASSET_VERSION_EVENT, AssetVersionEvent, type ListAssetVersionsResponse } from '@draftroom/contracts'
import type { CanvasFeatureContext, FeatureRegistries } from '../../../canvas/api/index.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { listAssetVersions } from './client.ts'

/** A list asked again for a version it does not know waits at least this long between asks. */
export const UNKNOWN_VERSION_REFETCH_MS = 2_000

type Fetcher = (boardId: string, assetId: string) => Promise<ListAssetVersionsResponse | null>

interface Entry {
  readonly value: Atom<ListAssetVersionsResponse | null>
  inflight: Promise<ListAssetVersionsResponse | null> | null
  /** a fetch was asked while one ran: one more after it */
  again: boolean
  fetchedAt: number
}

export class VersionStore {
  private readonly entries = new Map<string, Entry>()
  readonly boardId: string
  private readonly fetcher: Fetcher
  private readonly now: () => number
  constructor(boardId: string, fetcher: Fetcher = listAssetVersions, now: () => number = Date.now) {
    this.boardId = boardId
    this.fetcher = fetcher
    this.now = now
  }

  private entry(assetId: string): Entry {
    let e = this.entries.get(assetId)
    if (!e) {
      e = {
        value: atom<ListAssetVersionsResponse | null>(`versions:${assetId}`, null),
        inflight: null,
        again: false,
        fetchedAt: 0,
      }
      this.entries.set(assetId, e)
    }
    return e
  }

  /** The list's signal (null until it is known, or while the api offers none); asks for it the first time. */
  list(assetId: string): Atom<ListAssetVersionsResponse | null> {
    const fresh = !this.entries.has(assetId)
    const e = this.entry(assetId)
    if (fresh) void this.refresh(assetId)
    return e.value
  }

  /** Asks again when the card shows a version the list does not have (throttled). */
  ensure(assetId: string, versionId: string): void {
    const e = this.entry(assetId)
    const list = e.value.get()
    if (list?.versions.some((v) => v.versionId === versionId)) return
    if (e.inflight || this.now() - e.fetchedAt < UNKNOWN_VERSION_REFETCH_MS) return
    void this.refresh(assetId)
  }

  /**
   * Fetches the list now. One request at a time per asset: an ask while one runs makes exactly one more after it (and
   * gets the running one's answer).
   */
  refresh(assetId: string): Promise<ListAssetVersionsResponse | null> {
    const e = this.entry(assetId)
    if (e.inflight) {
      e.again = true
      return e.inflight
    }
    e.again = false
    e.fetchedAt = this.now()
    const run = this.fetcher(this.boardId, assetId)
      .catch(() => null)
      .then((got) => {
        // a failed refresh keeps what the page knew (the chip stays as it was)
        if (got || e.value.get() === null) e.value.set(got)
        return e.value.get()
      })
      .finally(() => {
        e.inflight = null
        if (e.again) void this.refresh(assetId)
      })
    e.inflight = run
    return run
  }

  /** The list as soon as it is known: the cached one, the running fetch's answer, or a new fetch's. */
  whenLoaded(assetId: string): Promise<ListAssetVersionsResponse | null> {
    const e = this.entry(assetId)
    if (e.inflight) return e.inflight
    const known = e.value.get()
    return known ? Promise.resolve(known) : this.refresh(assetId)
  }

  /** Every list this page asked for, again (the event stream reopened). */
  refreshAll(): void {
    for (const [assetId, e] of this.entries) if (!e.inflight) void this.refresh(assetId)
  }

  /** The handler of ASSET_VERSION_EVENT. */
  onEvent(data: unknown): void {
    const parsed = AssetVersionEvent.safeParse(data)
    if (parsed.success && this.entries.has(parsed.data.assetId)) void this.refresh(parsed.data.assetId)
  }
}

const stores = new WeakMap<FeatureRegistries, VersionStore>()

/** The board page's store, listening to its event stream from the first ask. */
export function versionStoreOf(
  ctx: Pick<CanvasFeatureContext, 'registries' | 'board' | 'events'>,
): VersionStore {
  let s = stores.get(ctx.registries)
  if (!s) {
    const store = new VersionStore(ctx.board.id)
    stores.set(ctx.registries, store)
    ctx.events.on(ASSET_VERSION_EVENT, (data) => store.onEvent(data))
    ctx.events.onResync(() => store.refreshAll())
    s = store
  }
  return s
}

/** The 1-based number of `versionId` in the list ("v3"), or null when the list does not know it. */
export function versionNumber(list: ListAssetVersionsResponse | null, versionId: string): number | null {
  return list?.versions.find((v) => v.versionId === versionId)?.n ?? null
}
