// The board's export policy on this client (docs/WAVE3-CONTRACTS.md "export-control"): whether this
// person may export, copy and download files here. UI hints only: the api refuses original downloads,
// the board archive, duplicate and restore-as-new on its own (403 EXPORT_DISABLED).
//
// One store per board id, fed by the sharing feature's overlay (ExportPolicySync: the first answer of
// GET /api/boards/:bid/export-policy, every `export-control.policy` board event, a refetch after each
// event-stream reconnect) and by the Share dialog after an owner changed it. Readers are reactive
// (tldraw signals): present-export (Export, Copy as PNG, PDF), canvas-ux (copy, menus), the file card
// (Download) and the PDF viewer (Download original) update the moment the policy or the role changes.
//
// Until the first answer arrives the policy counts as 'everyone' (the default and by far the common
// case), so boards that never limit anyone do not flash disabled entries on open.

import {
  EXPORT_CONTROL_EVENTS,
  EXPORT_DISABLED_MESSAGE,
  type ExportPolicy,
  ExportPolicyEvent,
  ExportPolicyState,
  exportAllowedFor,
} from '@draftroom/contracts'
import { type Atom, atom, type Editor } from 'tldraw'
import type { ApiClient } from '../../api/client.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import type { BoardRole } from '../../lib/permissions.ts'
import type { BoardEvents } from '../events.ts'

/** What people see wherever an export, copy or download entry is turned off. */
export const EXPORT_OFF_TEXT = EXPORT_DISABLED_MESSAGE

export interface BoardExportState {
  /** null until the first answer (treated like 'everyone'). */
  policy: Atom<ExportPolicy | null>
  /** This person's role on the board (from the board page; null until known). */
  role: Atom<BoardRole | null>
}

const boards = new Map<string, BoardExportState>()

export function boardExportState(boardId: string): BoardExportState {
  let state = boards.get(boardId)
  if (!state) {
    state = {
      policy: atom<ExportPolicy | null>(`dr-export-policy:${boardId}`, null),
      role: atom<BoardRole | null>(`dr-export-role:${boardId}`, null),
    }
    boards.set(boardId, state)
  }
  return state
}

/** Pure rule behind the UI (tested): unknown role or policy = allowed; the server decides anyway. */
export function exportAllowedWith(role: BoardRole | null, policy: ExportPolicy | null): boolean {
  if (role === null || policy === null) return true
  return exportAllowedFor(role, policy)
}

/** Reactive when read inside useValue / computed: may this person export on `boardId`? */
export function exportAllowedOnBoard(boardId: string): boolean {
  const s = boardExportState(boardId)
  return exportAllowedWith(s.role.get(), s.policy.get())
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

/** Says why an export, copy or download did nothing. */
export function notifyExportOff(notify: (n: NoticeInput) => void) {
  notify({ key: 'export-off', text: EXPORT_OFF_TEXT, testId: 'export-off-notice', timeoutMs: 6000 })
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

const enc = encodeURIComponent

export function exportPolicyApi(api: ApiClient) {
  return {
    get: (boardId: string, signal?: AbortSignal) =>
      api.request('GET', `/api/boards/${enc(boardId)}/export-policy`, { schema: ExportPolicyState, signal }),
    put: (boardId: string, exportPolicy: ExportPolicy) =>
      api.request('PUT', `/api/boards/${enc(boardId)}/export-policy`, {
        body: { exportPolicy },
        schema: ExportPolicyState,
      }),
  }
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
  const state = boardExportState(boardId)
  const client = exportPolicyApi(opts.api)
  binding(editor).set({ boardId, notify })
  let seq = 0
  let stopped = false
  const controller = new AbortController()
  const refetch = () => {
    const mine = ++seq
    client.get(boardId, controller.signal).then(
      (s) => {
        if (!stopped && mine === seq) state.policy.set(s.exportPolicy)
      },
      () => {}, // keep what we had: the server enforces, and the next resync asks again
    )
  }
  const offEvent = events.on(EXPORT_CONTROL_EVENTS.policy, (data) => {
    const parsed = ExportPolicyEvent.safeParse(data)
    if (!parsed.success) return
    seq++ // an answer to an older request must not overwrite the event
    state.policy.set(parsed.data.exportPolicy)
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
