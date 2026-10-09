// OWNER: W5 (wave L, L5-1 run of show). The agenda: the board's frames in present order with their planned
// minutes (customData.lobby.present.mins), the live section, and the presenter's actual times. Foundation: the
// cross-workstream export below, frozen; W5 writes the module (agendaOf and the presenter's timings) and
// replaces its body.

/** One section of the run of show as it went: planned minutes (null: none set) and the time it really took. */
export interface AgendaActual {
  readonly frameId: string
  /** the frame's name as shown in the frames panel */
  readonly name: string
  readonly plannedMin: number | null
  readonly actualMs: number
}

/**
 * The presenter's actual time per section of the run of show on `boardId`, in present order, as this tab
 * recorded it (sessionStorage, presenter-only), or null when this tab presented no agenda on that board (a
 * follower, a fresh tab, storage blocked). W2's Wrap up shows "Planned vs actual" from it when it is not null.
 *
 * Foundation stub: null (no agenda is recorded before W5's run of show).
 */
export function agendaActuals(boardId: string): readonly AgendaActual[] | null {
  void boardId
  return null
}
