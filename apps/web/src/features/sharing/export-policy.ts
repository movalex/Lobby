// The board's export policy on this client (docs/WAVE3-CONTRACTS.md "export-control"): whether this
// person may export, copy and download files here. UI hints only: the api refuses original downloads,
// the board archive, duplicate and restore-as-new on its own (403 EXPORT_DISABLED).
//
// One store per board id, fed by the sharing feature's overlay (ExportPolicySync: the first answer of
// GET /api/boards/:bid/export-policy, every `export-control.policy` board event, a refetch after each
// event-stream reconnect) and by the Share dialog after an owner changed it. Readers are reactive
// (tldraw signals): present-export (Export, Copy as PNG, PDF), canvas-ux (copy, menus), the file card
// (Download) and the PDF viewer (Download original) update the moment the policy, the role or the
// person's kind (a name-only guest is limited whatever their role) changes. The canvas's asset resolver
// asks exportCertainOnBoard before playing an animated WebP from its original.
//
// Until the first answer arrives the policy counts as 'everyone' (the default and by far the common
// case), so boards that never limit anyone do not flash disabled entries on open.

import {
  EXPORT_CONTROL_EVENTS,
  type ExportPolicy,
  ExportPolicyEvent,
  type ExportPolicyState,
} from '@draftroom/contracts'
import { type Atom, atom, type Editor } from 'tldraw'
import type { ApiClient } from '../../api/client.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import type { BoardRole } from '../../lib/permissions.ts'
import type { BoardEvents } from '../events.ts'
import { exportAllowedWith, exportCertainWith, exportPolicyApi, notifyExportOff } from './export-rules.ts'

// The engine-neutral rules live in ./export-rules.ts (wave 3e: the Excalidraw page's store uses them too).
export {
  clientExportAllowed,
  clientLinkWillLimit,
  EXPORT_OFF_TEXT,
  exportAllowedWith,
  exportPolicyApi,
  exportPolicySentence,
  notifyExportOff,
} from './export-rules.ts'

export interface BoardExportState {
  /** null until the first answer (treated like 'everyone'). */
  policy: Atom<ExportPolicy | null>
  /** This person's role on the board (from the board page; null until known). */
  role: Atom<BoardRole | null>
  /**
   * Whether this person is a name-only guest (GET /api/me `kind`; null until known). Under 'editors'
   * they are limited whatever their role (a workshop link makes them editors).
   */
  guest: Atom<boolean | null>
  /**
   * Whether the policy is stored (an owner chose it, or a client link set it: DANA2-01). False while
   * the board uses the default, which the first client link turns off. null until known.
   */
  stored: Atom<boolean | null>
}

const boards = new Map<string, BoardExportState>()
/**
 * Per board, how answers and events are ordered: an answer applies only if no policy event arrived
 * after its request was sent, and no answer to a later request was applied already. So an answer read
 * on the server before a change never overwrites the event announcing that change, and a slow answer
 * never overwrites a newer one (while a failed newer request does not throw away an older answer).
 */
const order = new Map<string, { events: number; sent: number; applied: number }>()
const orderOf = (boardId: string) => {
  let o = order.get(boardId)
  if (!o) {
    o = { events: 0, sent: 0, applied: 0 }
    order.set(boardId, o)
  }
  return o
}

export function boardExportState(boardId: string): BoardExportState {
  let state = boards.get(boardId)
  if (!state) {
    state = {
      policy: atom<ExportPolicy | null>(`dr-export-policy:${boardId}`, null),
      role: atom<BoardRole | null>(`dr-export-role:${boardId}`, null),
      guest: atom<boolean | null>(`dr-export-guest:${boardId}`, null),
      stored: atom<boolean | null>(`dr-export-stored:${boardId}`, null),
    }
    boards.set(boardId, state)
  }
  return state
}

/** A board event: always the newest word on the policy. */
function applyPolicyEvent(boardId: string, policy: ExportPolicy) {
  orderOf(boardId).events++
  const s = boardExportState(boardId)
  s.policy.set(policy)
  s.stored.set(true) // every change stores it
}

/**
 * Call when sending a request that answers with the policy. The returned function applies that answer
 * unless something newer landed meanwhile (see `order`); true when it applied.
 */
function beginPolicyRequest(boardId: string): (policy: ExportPolicy, stored?: boolean) => boolean {
  const o = orderOf(boardId)
  const mine = ++o.sent
  const eventsThen = o.events
  return (policy, stored) => {
    if (o.events !== eventsThen || o.applied > mine) return false
    o.applied = mine
    const s = boardExportState(boardId)
    s.policy.set(policy)
    if (stored !== undefined) s.stored.set(stored) // an older server leaves it out
    return true
  }
}

/** Reactive when read inside useValue / computed: may this person export on `boardId`? */
export function exportAllowedOnBoard(boardId: string): boolean {
  const s = boardExportState(boardId)
  return exportAllowedWith(s.role.get(), s.policy.get(), s.guest.get())
}

/**
 * Whether this person CERTAINLY may export on `boardId`: the policy is known, and it is 'everyone' or
 * they are an editor or owner with an account. Unlike exportAllowedOnBoard, anything unknown counts as
 * no. The canvas asks this before loading an original the api keeps from limited viewers (an animated
 * WebP: only the uploading client knows it is animated, so the api cannot tell it from a still image
 * with a preview, SEAM-10), so it never asks for an original the api would refuse.
 */
export function exportCertainOnBoard(boardId: string): boolean {
  const s = boardExportState(boardId)
  return exportCertainWith(s.role.get(), s.policy.get(), s.guest.get())
}

// ---- per editor (for tldraw overrides and shape utils, which only get the editor) ------------------

interface EditorBinding {
  boardId: string
  notify(n: NoticeInput): void
}
const bindings = new WeakMap<Editor, Atom<EditorBinding | null>>()

function binding(editor: Editor): Atom<EditorBinding | null> {
  let b = bindings.get(editor)
  if (!b) {
    b = atom<EditorBinding | null>('dr-export-binding', null)
    bindings.set(editor, b)
  }
  return b
}

/** Reactive: may this person export on the board `editor` shows? (true before the board is bound). */
export function exportAllowed(editor: Editor): boolean {
  const b = binding(editor).get()
  return b ? exportAllowedOnBoard(b.boardId) : true
}

/** Reactive: the export policy of the board `editor` shows (null until known or before binding). */
export function exportPolicyOf(editor: Editor): ExportPolicy | null {
  const b = binding(editor).get()
  return b ? boardExportState(b.boardId).policy.get() : null
}

/**
 * For entry points that only have the editor (tldraw actions, the clipboard hook, shape utils): true
 * when exporting is allowed; otherwise shows the notice and returns false.
 */
export function guardExport(editor: Editor): boolean {
  if (exportAllowed(editor)) return true
  const b = binding(editor).get()
  if (b) notifyExportOff(b.notify)
  return false
}

// ---- feeding the store ---------------------------------------------------------------------------

/** The Share dialog asking on open: the answer lands in the store unless something newer did first. */
export async function refreshExportPolicy(api: ApiClient, boardId: string, signal?: AbortSignal) {
  const apply = beginPolicyRequest(boardId)
  const s = await exportPolicyApi(api).get(boardId, signal)
  if (!signal?.aborted) apply(s.exportPolicy, s.policySet)
}

/** An owner's change (the server checks manage_access); its answer lands like a refresh's. */
export async function saveExportPolicy(
  api: ApiClient,
  boardId: string,
  exportPolicy: ExportPolicy,
): Promise<ExportPolicyState> {
  const apply = beginPolicyRequest(boardId)
  const saved = await exportPolicyApi(api).put(boardId, exportPolicy)
  apply(saved.exportPolicy, saved.policySet ?? true) // this tab at once when the event stream is down; otherwise the event did
  return saved
}

/**
 * Binds `editor` to its board and keeps the board's policy current: the answer now, every policy
 * event, and a refetch after every event-stream (re)connect (events are hints; a missed one is
 * repaired by the next resync). Returns the cleanup.
 */
export function syncExportPolicy(opts: {
  editor: Editor
  boardId: string
  api: ApiClient
  events: BoardEvents
  notify(n: NoticeInput): void
}): () => void {
  const { editor, boardId, events, notify } = opts
  const client = exportPolicyApi(opts.api)
  binding(editor).set({ boardId, notify })
  let stopped = false
  const controller = new AbortController()
  const refetch = () => {
    const apply = beginPolicyRequest(boardId)
    client.get(boardId, controller.signal).then(
      (s) => {
        if (!stopped) apply(s.exportPolicy, s.policySet)
      },
      () => {}, // keep what we had: the server enforces, and the next resync asks again
    )
  }
  const offEvent = events.on(EXPORT_CONTROL_EVENTS.policy, (data) => {
    const parsed = ExportPolicyEvent.safeParse(data)
    if (!parsed.success) return
    // An answer to an older request must not overwrite the event.
    applyPolicyEvent(boardId, parsed.data.exportPolicy)
  })
  // onResync runs at once when the stream is already connected, and after every reconnect.
  let resynced = false
  const offResync = events.onResync(() => {
    resynced = true
    refetch()
  })
  if (!resynced) refetch()
  return () => {
    stopped = true
    controller.abort()
    offEvent()
    offResync()
    if (binding(editor).get()?.boardId === boardId) binding(editor).set(null)
  }
}
