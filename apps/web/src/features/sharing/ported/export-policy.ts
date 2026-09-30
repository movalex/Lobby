// The board's export policy on the Excalidraw board page (docs/WAVE3-CONTRACTS.md "export-control"; the
// tldraw page's ../export-policy.ts, on lib/signals instead of tldraw's): whether this person may export,
// copy and download files here. UI hints only: the api refuses original downloads, the board archive,
// duplicate and restore-as-new on its own (403 EXPORT_DISABLED).
//
// One store per board id, fed by the sharing feature (./index.tsx: the first answer of GET
// /api/boards/:bid/export-policy, every `export-control.policy` board event, a refetch after each
// event-stream reconnect) and kept current with this person's role and kind. Readers are reactive (read
// inside `useValue` / `computed`): present-export's Export, Copy as PNG and PDF, and every ported feature
// with an export, copy or download entry (canvas-ux's copy and menus, file cards, the PDF viewer) import
// `exportAllowedOn` / `guardExportOn` from here.
//
// Until the first answer arrives the policy counts as 'everyone' (the default and by far the common
// case), so boards that never limit anyone do not flash disabled entries on open. The Share dialog keeps
// the tldraw page's store for its own section (board/ShareDialog.tsx, shared by both pages); a change an
// owner makes there reaches this store through the board event.

import { EXPORT_CONTROL_EVENTS, type ExportPolicy, ExportPolicyEvent } from '@draftroom/contracts'
import type { ApiClient } from '../../../api/client.ts'
import type { NoticeInput } from '../../../board/board-context.ts'
import type { BoardRole } from '../../../lib/permissions.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import type { BoardEvents } from '../../events.ts'
import {
  createPolicyOrder,
  exportAllowedWith,
  exportCertainWith,
  exportPolicyApi,
  notifyExportOff,
  type PolicyOrder,
} from '../export-rules.ts'

export { EXPORT_OFF_TEXT, exportPolicySentence, notifyExportOff } from '../export-rules.ts'

export interface ExportState {
  /** null until the first answer (treated like 'everyone') */
  readonly policy: Atom<ExportPolicy | null>
  /** this person's role on the board (null until known) */
  readonly role: Atom<BoardRole | null>
  /** whether this person is a name-only guest (null until known) */
  readonly guest: Atom<boolean | null>
  /** whether the policy is stored (an owner chose it or a client link set it); null until known */
  readonly stored: Atom<boolean | null>
}

const boards = new Map<string, { state: ExportState; order: PolicyOrder }>()

function entry(boardId: string) {
  let e = boards.get(boardId)
  if (!e) {
    e = {
      state: {
        policy: atom<ExportPolicy | null>(`lobby-export-policy:${boardId}`, null),
        role: atom<BoardRole | null>(`lobby-export-role:${boardId}`, null),
        guest: atom<boolean | null>(`lobby-export-guest:${boardId}`, null),
        stored: atom<boolean | null>(`lobby-export-stored:${boardId}`, null),
      },
      order: createPolicyOrder(),
    }
    boards.set(boardId, e)
  }
  return e
}

export const exportStateOf = (boardId: string): ExportState => entry(boardId).state

/** Reactive: may this person export on `boardId`? */
export function exportAllowedOn(boardId: string): boolean {
  const s = exportStateOf(boardId)
  return exportAllowedWith(s.role.get(), s.policy.get(), s.guest.get())
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
 * Keeps `boardId`'s policy current: the answer now, every policy event, and a refetch after every
 * event-stream (re)connect (events are hints; a missed one is repaired by the next resync). Returns the
 * cleanup.
 */
export function syncExportPolicy(opts: { boardId: string; api: ApiClient; events: BoardEvents }): () => void {
  const { boardId, events } = opts
  const { state, order } = entry(boardId)
  const client = exportPolicyApi(opts.api)
  let stopped = false
  const controller = new AbortController()
  const refetch = () => {
    const may = order.begin()
    client.get(boardId, controller.signal).then(
      (s) => {
        if (stopped || !may()) return
        state.policy.set(s.exportPolicy)
        if (s.policySet !== undefined) state.stored.set(s.policySet)
      },
      () => {}, // keep what we had: the server enforces, and the next resync asks again
    )
  }
  const offEvent = events.on(EXPORT_CONTROL_EVENTS.policy, (data) => {
    const parsed = ExportPolicyEvent.safeParse(data)
    if (!parsed.success) return
    order.event()
    state.policy.set(parsed.data.exportPolicy)
    state.stored.set(true) // every change stores it
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
  }
}
