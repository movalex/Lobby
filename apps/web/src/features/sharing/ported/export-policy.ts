// The board's export policy on the Excalidraw board page (docs/WAVE3-CONTRACTS.md "export-control"; the
// tldraw page's ../export-policy.ts, on lib/signals instead of tldraw's): whether this person may export,
// copy and download files here. UI hints only: the api refuses original downloads, the board archive,
// duplicate and restore-as-new on its own (403 EXPORT_DISABLED).
//
// K1-4 (wave K): ONE resource per board id, read once per board session and shared by every gate. Before,
// the sharing feature, canvas-ux's copy gate, the mind-map outline and the file cards each read
// GET /api/boards/:bid/export-policy on their own (about 4 reads per open: 270 for 68 tickets on staging,
// queued on a 0.1-CPU Postgres inside the open burst). Now every reader attaches to this resource
// (`syncExportPolicy` / `attachExportPolicy`, reference-counted per event stream) and reads its atoms:
//
//   - the first answer: one read when the first reader attaches to a board's event stream. A stream that is
//     already connected answers `onResync` at once, and that is the read. For one still connecting, the
//     gates (`attachExportPolicy`: canvas-ux, the mind map, the file cards, the History panel; installed with
//     the board's features, before the sharing feature's overlay mounts) wait up to HELLO_WAIT_MS for its
//     hello, which is then the one read (a read before it would have to be repeated after it); the sharing
//     feature's own sync (`syncExportPolicy`, when it is the first reader: the Share dialog's store on its
//     own) reads at once and again after the hello, as before;
//   - every `export-control.policy` event applies at once (the event wins over an answer to a request sent
//     before it) and invalidates: one read after it, for the server's `canExport` and `policySet`;
//   - every stream (re)connect invalidates (events are hints; a missed one is repaired by the resync);
//   - a sharing change in this tab (the Share dialog: `refreshExportPolicy`, `invalidateExportPolicy`).
// Concurrent first callers share one read, a read in flight for the current state is shared by every caller
// (`getExportPolicy`), and the second, third and fourth reader of a session read nothing. Another board id
// is another entry. When the last reader of a board detaches, its answer is kept for display but counts as
// stale: the next session reads again.
//
// Readers are reactive (read inside `useValue` / `computed`): present-export's Export, Copy as PNG and PDF,
// canvas-ux's copy and menus (../../canvas-ux/ported/export-gate.ts), the file cards and the PDF viewer
// (../../../file-card/ported/downloads.ts), the mind-map outline (../../mindmap/ported/export-gate.ts) and
// the History panel (../../history/ported/export-allowed.ts) import from here.
//
// Until the first answer arrives the gates fail closed (wave K.1, ../export-rules.ts `boardExportAllowed`): only
// the owner and editors with an account, whom no policy limits, get export and copy entries. Before, the
// policy counted as 'everyone' then, and a viewer on an export-off board saw those entries for a moment. The Share dialog's
// "Export and download" section (./ExportPolicySection.tsx; board/ShareDialog.tsx opens from the board
// page and the dashboard) reads and writes this same store (`refreshExportPolicy`, `saveExportPolicy`).

import {
  EXPORT_CONTROL_EVENTS,
  type ExportPolicy,
  ExportPolicyEvent,
  type ExportPolicyState,
} from '@draftroom/contracts'
import type { ApiClient } from '../../../api/client.ts'
import type { NoticeInput } from '../../../board/board-context.ts'
import type { BoardRole } from '../../../lib/permissions.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import type { BoardEvents } from '../../events.ts'
import {
  boardExportAllowed,
  createPolicyOrder,
  exportCertainWith,
  exportPolicyApi,
  notifyExportOff,
  type PolicyOrder,
} from '../export-rules.ts'

export { EXPORT_OFF_TEXT, exportPolicySentence, notifyExportOff } from '../export-rules.ts'

/** How long a gate that attaches to a stream still connecting waits for its hello before the first read. */
export const HELLO_WAIT_MS = 1_500

export interface ExportState {
  /** null until the first answer (treated like 'everyone') */
  readonly policy: Atom<ExportPolicy | null>
  /** this person's role on the board (null until known) */
  readonly role: Atom<BoardRole | null>
  /** whether this person is a name-only guest (null until known) */
  readonly guest: Atom<boolean | null>
  /** whether the policy is stored (an owner chose it or a client link set it); null until known */
  readonly stored: Atom<boolean | null>
  /** the server's own answer for this person (`canExport`), null until the first answer */
  readonly canExport: Atom<boolean | null>
}

interface Attachment {
  refs: number
  readonly detach: () => void
}

interface Entry {
  readonly boardId: string
  readonly state: ExportState
  readonly order: PolicyOrder
  /** bumped by every invalidation: an answer is current when it was asked for at the current generation */
  gen: number
  /** an answer asked for at the current generation has landed */
  fresh: boolean
  /** the read in flight, and the generation it was asked for at */
  inflight: { readonly gen: number; readonly promise: Promise<ExportPolicyState> } | null
  /** the last answer (what `getExportPolicy` resolves with while fresh) */
  last: ExportPolicyState | null
  /** the api the resource reads with: the latest reader's (every page passes the same client) */
  api: ApiClient | null
  /** live readers, per event stream */
  readonly live: Map<BoardEvents, Attachment>
}

const boards = new Map<string, Entry>()

function entry(boardId: string): Entry {
  let e = boards.get(boardId)
  if (!e) {
    e = {
      boardId,
      state: {
        policy: atom<ExportPolicy | null>(`lobby-export-policy:${boardId}`, null),
        role: atom<BoardRole | null>(`lobby-export-role:${boardId}`, null),
        guest: atom<boolean | null>(`lobby-export-guest:${boardId}`, null),
        stored: atom<boolean | null>(`lobby-export-stored:${boardId}`, null),
        canExport: atom<boolean | null>(`lobby-export-can:${boardId}`, null),
      },
      order: createPolicyOrder(),
      gen: 0,
      fresh: false,
      inflight: null,
      last: null,
      api: null,
      live: new Map(),
    }
    boards.set(boardId, e)
  }
  return e
}

/** One read for `e` at its current generation, shared by every caller until it settles. */
function read(e: Entry, api: ApiClient): Promise<ExportPolicyState> {
  e.api = api
  if (e.inflight && e.inflight.gen === e.gen) return e.inflight.promise
  const gen = e.gen
  const may = e.order.begin()
  const promise = exportPolicyApi(api)
    .get(e.boardId)
    .then((s) => {
      // an answer to a request sent before a later policy event (or overtaken by a later answer) is dropped
      if (may()) {
        e.state.policy.set(s.exportPolicy)
        if (s.policySet !== undefined) e.state.stored.set(s.policySet)
        e.state.canExport.set(s.canExport)
        e.last = s
      }
      // current only while a board session keeps it so (its events and resyncs); without one, every
      // caller that is not sharing this read asks again
      if (gen === e.gen && e.live.size > 0) e.fresh = true
      return s
    })
    .finally(() => {
      if (e.inflight?.promise === promise) e.inflight = null
    })
  e.inflight = { gen, promise }
  return promise
}

/** The answer is stale from now on: a live resource reads again, once (a read already asked for at the new
 * state is shared). */
function invalidate(e: Entry): void {
  e.gen++
  e.fresh = false
  if (e.live.size === 0 || !e.api) return
  read(e, e.api).catch(() => {}) // keep what we had: the server enforces, and the next resync asks again
}

export const exportStateOf = (boardId: string): ExportState => entry(boardId).state

/**
 * The board's policy for this person: the current answer when there is one (no request), otherwise one
 * read shared with every other caller. Rejects as the read does (the atoms keep what they had). `signal`
 * only stops this caller's wait; the shared read goes on for the others.
 */
export function getExportPolicy(
  api: ApiClient,
  boardId: string,
  signal?: AbortSignal,
): Promise<ExportPolicyState> {
  const e = entry(boardId)
  if (e.fresh && e.last && !e.inflight) return Promise.resolve(e.last)
  const shared = read(e, api)
  if (!signal) return shared
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** A sharing change in this tab (or anything else that may have changed the answer): read again, once. */
export function invalidateExportPolicy(boardId: string): void {
  invalidate(entry(boardId))
}

/** Reactive: may this person export on `boardId`? (closed before the first answer: `boardExportAllowed`) */
export function exportAllowedOn(boardId: string): boolean {
  const s = exportStateOf(boardId)
  return boardExportAllowed(s.role.get(), s.policy.get(), s.guest.get())
}

/** Reactive: whether this person CERTAINLY may export (anything unknown counts as no). */
export function exportCertainOn(boardId: string): boolean {
  const s = exportStateOf(boardId)
  return exportCertainWith(s.role.get(), s.policy.get(), s.guest.get())
}

/** Reactive: the board's policy (null until known). */
export const exportPolicyOn = (boardId: string): ExportPolicy | null => exportStateOf(boardId).policy.get()

/** True when exporting is allowed; otherwise shows the notice and returns false. */
export function guardExportOn(boardId: string, notify: (n: NoticeInput) => void): boolean {
  if (exportAllowedOn(boardId)) return true
  notifyExportOff(notify)
  return false
}

/**
 * The Share dialog asking on open, and after a change it made (a client link may have turned exporting
 * off): a sharing change, so the answer is read again (one read shared with any other caller of this
 * moment), and it lands in the store unless a policy event arrived after it was asked for.
 */
export async function refreshExportPolicy(api: ApiClient, boardId: string, signal?: AbortSignal) {
  const e = entry(boardId)
  invalidate(e)
  await getExportPolicy(api, boardId, signal)
}

/** An owner's change (the server checks manage_access); its answer lands like a refresh's. */
export async function saveExportPolicy(
  api: ApiClient,
  boardId: string,
  exportPolicy: ExportPolicy,
): Promise<ExportPolicyState> {
  const e = entry(boardId)
  const may = e.order.begin()
  const saved = await exportPolicyApi(api).put(boardId, exportPolicy)
  // this tab at once when the event stream is down; otherwise the event did (and newer ones win)
  if (may()) {
    e.state.policy.set(saved.exportPolicy)
    e.state.stored.set(saved.policySet ?? true) // an older server leaves it out
    e.state.canExport.set(saved.canExport)
    e.last = saved
  }
  return saved
}

/**
 * Installs the resource's listeners on one event stream (the first reader of that stream does). `patient`:
 * a stream that is not connected yet is given HELLO_WAIT_MS to say hello before the first read.
 */
function listen(e: Entry, events: BoardEvents, patient: boolean): () => void {
  const offEvent = events.on(EXPORT_CONTROL_EVENTS.policy, (data) => {
    const parsed = ExportPolicyEvent.safeParse(data)
    if (!parsed.success) return
    e.order.event()
    e.state.policy.set(parsed.data.exportPolicy)
    e.state.stored.set(true) // every change stores it
    invalidate(e) // `canExport` follows the policy: read it once
  })
  // onResync runs at once when the stream is already connected (that is the first read), and after every
  // reconnect
  let resynced = false
  let wait: ReturnType<typeof setTimeout> | null = null
  const offResync = events.onResync(() => {
    resynced = true
    if (wait !== null) clearTimeout(wait)
    wait = null
    invalidate(e)
  })
  if (!resynced) {
    if (!patient) invalidate(e)
    else
      wait = setTimeout(() => {
        wait = null
        // the hello is late (or the stream is broken): read without it; the hello reads again when it comes
        if (!resynced && !e.fresh) invalidate(e)
      }, HELLO_WAIT_MS)
  }
  return () => {
    if (wait !== null) clearTimeout(wait)
    offEvent()
    offResync()
  }
}

type AttachOptions = { boardId: string; api: ApiClient; events: BoardEvents }

function attach(opts: AttachOptions, patient: boolean): () => void {
  const e = entry(opts.boardId)
  e.api = opts.api
  let a = e.live.get(opts.events)
  if (a) a.refs++
  else {
    // registered before listening: a stream that is already connected reads at once, through `invalidate`
    const holder: { detach: () => void } = { detach: () => {} }
    a = { refs: 1, detach: () => holder.detach() }
    e.live.set(opts.events, a)
    holder.detach = listen(e, opts.events, patient)
  }
  const mine = a
  let done = false
  return () => {
    if (done) return
    done = true
    mine.refs--
    if (mine.refs > 0 || e.live.get(opts.events) !== mine) return
    e.live.delete(opts.events)
    mine.detach()
    // nobody keeps it current any more: kept for display, read again by the next session
    if (e.live.size === 0) e.fresh = false
  }
}

/**
 * The sharing feature's sync (its overlay, for the whole board session): keeps `boardId`'s policy current
 * while mounted. As the first reader of a stream that is still connecting it reads at once (and again
 * after the hello); after the gates (`attachExportPolicy`) it reads nothing more. Returns the detach.
 */
export function syncExportPolicy(opts: AttachOptions): () => void {
  return attach(opts, false)
}

/**
 * The gates' attach (canvas-ux, the mind map, the file cards, the History panel): the same shared resource;
 * as the first reader of a stream that is still connecting, it waits up to HELLO_WAIT_MS for the hello, so
 * a board open reads the policy once. Returns the detach.
 */
export function attachExportPolicy(opts: AttachOptions): () => void {
  return attach(opts, true)
}
