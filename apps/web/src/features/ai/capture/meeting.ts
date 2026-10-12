// OWNER: WS5 (wave N, N5-4). A meeting transcript's themes, decisions and actions as a frame "Meeting — <title or
// date>" with three columns: Themes (each theme's name over its notes as sticky notes), Decisions and Actions (each a
// sticky note; an action says "Owner: text" as plain text, the owner a name as the transcript wrote it, never linked
// to anyone). Only the notes are saved: the transcript itself never reaches the board.
//
// Planned here (pure but for the text measure it is given); written in ONE undo step: one transact makes the frame,
// its headings and the notes, a joinPrevious transact puts the notes in the frame (the note builder takes no frame:
// CR-3H-3, as ../recap/apply.ts does). Every element carries the create-only `ai` provenance and its kind.

import { LOBBY_INK, LOBBY_PALETTE } from '@draftroom/board-ops/elements'
import type { CaptureResult } from '@draftroom/contracts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { captureActionText, captureMeetingLine } from '../copy.ts'
import type { Rect } from '../layout.ts'
import { FONT_FAMILY } from '../ported/apply.ts'
import { aiCustomData } from '../ported/provenance.ts'
import type { AiPreviewPlan } from '../ported/public.ts'

type MeetingResult = Extract<CaptureResult, { kind: 'transcript' }>

/** A text's laid-out words and size (../ported/apply.ts layoutText for this canvas). */
export type TextLayout = (
  text: string,
  fontSize: number,
  maxWidth: number,
) => { readonly text: string; readonly width: number; readonly height: number }

export const MEETING_PAD = 48
export const MEETING_NOTE = 180
const NOTE_GAP = 20
const COL_GAP = 64
const HEADING = 30
const COLUMN_HEADING = 26
const THEME_HEADING = 22
const GAP = 16
/** The columns' widths: Themes holds two notes across, Decisions and Actions one. */
export const MEETING_COLUMNS = {
  themes: MEETING_NOTE * 2 + NOTE_GAP,
  decisions: MEETING_NOTE,
  actions: MEETING_NOTE,
} as const

type Props = Record<string, unknown>
export interface MeetingCreate {
  readonly kind: 'frame' | 'text' | 'note'
  readonly props: Props
  /** what the element is in the meeting (the tests and the preview read it) */
  readonly role: 'frame' | 'title' | 'column' | 'theme' | 'theme-note' | 'decision' | 'action'
}

export interface MeetingPlan {
  readonly frameId: string
  readonly creates: readonly MeetingCreate[]
  readonly noteIds: readonly string[]
  readonly bounds: Rect
  readonly preview: AiPreviewPlan
}

export interface MeetingPlanOptions {
  readonly origin: { readonly x: number; readonly y: number }
  readonly name: string
  readonly by: string
  readonly runId: string
  readonly newId: () => string
  readonly layout: TextLayout
}

const FILL = {
  theme: LOBBY_PALETTE.black.noteFill,
  decision: LOBBY_PALETTE['light-green'].noteFill,
  action: LOBBY_PALETTE['light-blue'].noteFill,
}

/** The frame's size for a result (for findSpot), and its pieces relative to its top-left. */
export function planMeeting(result: MeetingResult, opts: MeetingPlanOptions): MeetingPlan {
  const pieces: {
    kind: 'text' | 'note'
    role: MeetingCreate['role']
    dx: number
    dy: number
    props: Props
  }[] = []
  const stamp = (kind: string) => ({ customData: aiCustomData(opts.by, kind, opts.runId) })
  const text = (
    role: MeetingCreate['role'],
    words: string,
    size: number,
    dx: number,
    dy: number,
    width: number,
    kind: string,
  ) => {
    const b = opts.layout(words, size, width)
    pieces.push({
      kind: 'text',
      role,
      dx,
      dy,
      props: {
        text: b.text,
        originalText: words,
        fontFamily: FONT_FAMILY,
        fontSize: size,
        textAlign: 'left',
        verticalAlign: 'top',
        strokeColor: LOBBY_INK,
        autoResize: b.text === words,
        ...stamp(kind),
      },
    })
    return b.height
  }
  const note = (
    role: MeetingCreate['role'],
    words: string,
    dx: number,
    dy: number,
    fill: string,
    kind: string,
  ): void => {
    pieces.push({
      kind: 'note',
      role,
      dx,
      dy,
      props: { size: MEETING_NOTE, text: words, backgroundColor: fill, ...stamp(kind) },
    })
  }

  const width =
    MEETING_PAD * 2 +
    MEETING_COLUMNS.themes +
    MEETING_COLUMNS.decisions +
    MEETING_COLUMNS.actions +
    COL_GAP * 2
  const top =
    MEETING_PAD +
    text('title', opts.name, HEADING, MEETING_PAD, MEETING_PAD, width - 2 * MEETING_PAD, 'capture-heading') +
    GAP * 2
  const colX = {
    themes: MEETING_PAD,
    decisions: MEETING_PAD + MEETING_COLUMNS.themes + COL_GAP,
    actions: MEETING_PAD + MEETING_COLUMNS.themes + COL_GAP + MEETING_COLUMNS.decisions + COL_GAP,
  }
  const heads = { themes: 'Themes', decisions: 'Decisions', actions: 'Actions' } as const
  let tallest = 0
  for (const col of ['themes', 'decisions', 'actions'] as const) {
    let y = top
    y +=
      text('column', heads[col], COLUMN_HEADING, colX[col], y, MEETING_COLUMNS[col], 'capture-heading') + GAP
    if (col === 'themes')
      for (const t of result.themes) {
        y +=
          text('theme', t.name, THEME_HEADING, colX.themes, y, MEETING_COLUMNS.themes, 'capture-theme') + GAP
        for (const [i, n] of t.notes.entries())
          note(
            'theme-note',
            n,
            colX.themes + (i % 2) * (MEETING_NOTE + NOTE_GAP),
            y + Math.floor(i / 2) * (MEETING_NOTE + NOTE_GAP),
            FILL.theme,
            'capture-note',
          )
        y += Math.ceil(t.notes.length / 2) * (MEETING_NOTE + NOTE_GAP) + GAP
      }
    else {
      const list = col === 'decisions' ? result.decisions : result.actions.map((a) => captureActionText(a))
      for (const words of list) {
        note(
          col === 'decisions' ? 'decision' : 'action',
          words,
          colX[col],
          y,
          col === 'decisions' ? FILL.decision : FILL.action,
          col === 'decisions' ? 'capture-decision' : 'capture-action',
        )
        y += MEETING_NOTE + NOTE_GAP
      }
    }
    tallest = Math.max(tallest, y)
  }
  const height = Math.max(320, Math.round(tallest + MEETING_PAD))
  const frameId = opts.newId()
  const { x, y } = opts.origin
  const creates: MeetingCreate[] = [
    {
      kind: 'frame',
      role: 'frame',
      props: { id: frameId, x, y, width, height, name: opts.name, ...stamp('capture-meeting') },
    },
  ]
  const noteIds: string[] = []
  for (const p of pieces) {
    const id = opts.newId()
    if (p.kind === 'note') {
      noteIds.push(id)
      creates.push({
        kind: 'note',
        role: p.role,
        props: { id, labelId: `${id}.t`, x: x + p.dx, y: y + p.dy, ...p.props },
      })
    } else
      creates.push({
        kind: 'text',
        role: p.role,
        props: { id, x: x + p.dx, y: y + p.dy, frameId, ...p.props },
      })
  }
  const noteCount = result.themes.reduce((n, t) => n + t.notes.length, 0)
  const preview: AiPreviewPlan = {
    runId: opts.runId,
    title: 'Meeting notes',
    summary: captureMeetingLine({
      themes: result.themes.length,
      notes: noteCount,
      decisions: result.decisions.length,
      actions: result.actions.length,
    }),
    moves: [],
    recolors: [],
    creates: [
      { x, y, w: width, h: height, kind: 'frame', label: opts.name },
      ...creates
        .filter((c) => c.kind === 'note')
        .map((c) => ({
          x: Number(c.props.x),
          y: Number(c.props.y),
          w: MEETING_NOTE,
          h: MEETING_NOTE,
          kind: 'note',
          label: String(c.props.text ?? ''),
        })),
    ],
    groups: result.themes.map((t) => ({ name: t.name, count: t.notes.length })),
  }
  return { frameId, creates, noteIds, bounds: { x, y, w: width, h: height }, preview }
}

/** The frame's size before it is placed (planned at 0,0 with throwaway ids). */
export function meetingSize(
  result: MeetingResult,
  layout: TextLayout,
  name: string,
): { w: number; h: number } {
  let n = 0
  const p = planMeeting(result, {
    origin: { x: 0, y: 0 },
    name,
    by: 'x',
    runId: 'r',
    newId: () => `m${++n}`,
    layout,
  })
  return { w: p.bounds.w, h: p.bounds.h }
}

export const MEETING_UNDO_LABEL = 'ai: capture meeting'

/** Writes the plan in one undo step (see the header); selects the frame; returns every id it made. */
export function applyMeeting(
  canvas: Pick<LobbyCanvas, 'transact' | 'select'>,
  plan: MeetingPlan,
  label = MEETING_UNDO_LABEL,
): string[] {
  const made: string[] = []
  canvas.transact(label, (tx) => {
    for (const c of plan.creates) made.push(tx.create(c.kind, c.props))
  })
  if (plan.noteIds.length)
    canvas.transact(label, (tx) => tx.setFrame([...plan.noteIds], plan.frameId), { joinPrevious: true })
  canvas.select([plan.frameId])
  return made
}
