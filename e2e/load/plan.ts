// Turns a profile (profiles.ts) and its generated boards into session plans: who joins which board when,
// with which role and signed ticket, and which notes each editor owns (disjoint, so the acked ledger of
// every note has exactly one writer). Pure apart from the ticket signature.
import { type GeneratedBoard, heavyBoard, l1Board, smallBoard } from './boards.ts'
import type { BoardLoad, Profile } from './profiles.ts'
import type { SessionPlan } from './session.ts'
import { type LoadUser, loadUser, mintTicket } from './tickets.ts'

/** The fixed board ids of the load runs (sync's BOARD_ID_RE: lowercase, 3–64 characters). */
export function boardIdsOf(p: Profile): { load: BoardLoad; ids: string[] }[] {
  return p.boards.map((b) => ({
    load: b,
    ids: Array.from({ length: b.boards }, (_, i) =>
      b.kind === 'small'
        ? `${p.name.toLowerCase()}-s${String(i).padStart(2, '0')}`
        : `${p.name.toLowerCase()}-${b.kind === 'l1' ? 'main' : b.kind}${b.boards > 1 ? `-${i}` : ''}`,
    ),
  }))
}

/** The boards of a profile, generated (deterministic: gen-boards writes the same ones to disk). */
export function boardsOf(
  p: Profile,
  opts: { fileIds?: readonly string[] } = {},
): Map<string, GeneratedBoard> {
  const out = new Map<string, GeneratedBoard>()
  for (const { load, ids } of boardIdsOf(p))
    ids.forEach((id, i) => {
      out.set(
        id,
        load.kind === 'heavy'
          ? heavyBoard(id, { fileIds: opts.fileIds })
          : load.kind === 'l1'
            ? l1Board(id)
            : smallBoard(id, 100 + i),
      )
    })
  return out
}

export interface TicketSource {
  ticket(boardId: string, user: LoadUser): string
}

/** Tickets signed with the run's own ticket secret (the fake-api runs). */
export function signedTickets(ticketSecret: string): TicketSource {
  return { ticket: (boardId, user) => mintTicket(ticketSecret, boardId, user) }
}

const EDITING_KINDS = new Set(['gesture', 'typist', 'oneshot', 'light'])

export function buildPlans(
  p: Profile,
  boards: Map<string, GeneratedBoard>,
  tickets: TicketSource,
): SessionPlan[] {
  const plans: SessionPlan[] = []
  let boardIndex = 0
  for (const { load, ids } of boardIdsOf(p)) {
    for (const boardId of ids) {
      const board = boards.get(boardId)
      if (!board) throw new Error(`no generated board ${boardId}`)
      // editors that own notes, in group order; each gets a disjoint slice of the notes outside frame 0
      // (frame 0 belongs to the frame dragger)
      const pool = board.noteIds.filter((id) => !board.frame0Notes.includes(id) || load.kind === 'small')
      const owners = load.groups.filter((g) => EDITING_KINDS.has(g.kind)).reduce((n, g) => n + g.count, 0)
      const slice = Math.max(1, Math.floor(pool.length / Math.max(1, owners)))
      let owner = 0
      let n = 0
      for (const [gi, group] of load.groups.entries()) {
        for (let i = 0; i < group.count; i++) {
          const user = loadUser(boardIndex, n, group.role)
          const own = EDITING_KINDS.has(group.kind) ? pool.slice(owner * slice, (owner + 1) * slice) : []
          if (EDITING_KINDS.has(group.kind)) owner++
          plans.push({
            key: `${boardId}:g${gi}:${group.kind}:${i}`,
            boardId,
            group,
            index: i,
            user,
            ticket: tickets.ticket(boardId, user),
            joinAtMs: 0,
            ownNotes: own,
          })
          n++
        }
      }
      boardIndex++
    }
  }
  // the join ramp: every session of the profile, evenly spread over joinRampMs, boards interleaved
  const order = [...plans.keys()].sort((a, b) => ((a * 7919) % plans.length) - ((b * 7919) % plans.length))
  const step = plans.length > 1 ? p.joinRampMs / (plans.length - 1) : 0
  return order.map((idx, k) => ({ ...(plans[idx] as SessionPlan), joinAtMs: Math.round(k * step) }))
}

/** The presence probe of each board: the first session of its first measuring watcher group (session.ts). */
export function probeSids(plans: readonly SessionPlan[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of plans)
    if (s.group.kind === 'watcher' && s.group.measureVisibility && s.index === 0 && !out.has(s.boardId))
      out.set(s.boardId, `${s.user.uid}:${s.key}`)
  return out
}

/** The fake api's view of the plans: every board with its members and files. */
export function membersOf(plans: readonly SessionPlan[]): Map<string, Map<string, 'editor' | 'viewer'>> {
  const out = new Map<string, Map<string, 'editor' | 'viewer'>>()
  for (const s of plans) {
    const m = out.get(s.boardId) ?? new Map()
    m.set(s.user.uid, s.user.role as 'editor' | 'viewer')
    out.set(s.boardId, m)
  }
  return out
}
