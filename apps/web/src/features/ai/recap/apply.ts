// OWNER: W2 (wave L, L2-3). "Add as Recap frame" (editors): the recap as native, editable board content in ONE undo
// step: a frame "Recap · 8 Oct" where the person is looking (beside the frames it recaps, else around the middle of
// the view, clear of what is there: ../ported/apply.ts pageSpotNear; then brought into this tab's view only), its
// heading, the planned-vs-actual table
// (text and rectangles), the top voted lines, the AI's headline, decisions and questions as text, and the action
// items as sticky notes. One transact writes everything; the notes join the frame in a second write folded into
// the same undo step (the note builder takes no frame, and the port drops a change to an element created in the
// same step: CR-3H-3, as ../ported/apply.ts does). Kinds: 'ai-recap' (the frame), 'ai-recap-heading',
// 'ai-recap-item' (the AI's parts, with `lobby.ai` and the run id) and 'recap-table' / 'recap-item' (the room's
// own results, no AI provenance); with AI off the frame and heading are 'recap' and 'recap-heading'. Only plain
// text goes in.

import { LOBBY_INK, LOBBY_PALETTE } from '@draftroom/board-ops/elements'
import { type CanvasElement, items, type LobbyCanvas } from '../../../canvas/api/index.ts'
import { plural } from '../copy.ts'
import { bringIntoView, FONT_FAMILY, layoutText, newId, pageSpotNear } from '../ported/apply.ts'
import { aiCustomData } from '../ported/provenance.ts'
import type { RecapPlan } from './plan.ts'

/** The frame's inner layout (scene units). */
export const RECAP_W = 1120
const PAD = 48
const GAP = 20
const SECTION_GAP = 36
const NOTE = 200
const NOTE_GAP = 24
const ROW_H = 40
const COLS = [520, 220, 220] as const

export interface RecapApplied {
  readonly frameId: string
  /** every element it made (the frame first) */
  readonly ids: string[]
}

type Props = Record<string, unknown>

/** The plan as pieces in the frame's space (pure but for text measurement), and the frame's height. */
function layout(canvas: LobbyCanvas, plan: RecapPlan) {
  const inner = RECAP_W - 2 * PAD
  const pieces: (
    | {
        kind: 'text'
        dx: number
        dy: number
        text: string
        original: string
        size: number
        ai: boolean
        role: string
      }
    | { kind: 'rect'; dx: number; dy: number; w: number; h: number; fill: string }
    | { kind: 'note'; dx: number; dy: number; text: string }
  )[] = []
  let y = PAD
  const text = (words: string, size: number, ai: boolean, role: string, dx = 0, width = inner) => {
    const b = layoutText(canvas, words, size, width)
    pieces.push({ kind: 'text', dx: PAD + dx, dy: y, text: b.text, original: words, size, ai, role })
    return b
  }
  y += text(plan.title, 36, plan.ai, 'heading').height + GAP
  y += text(plan.scopeLabel, 18, false, 'item').height + GAP
  if (plan.headline) y += text(plan.headline, 20, true, 'item').height + SECTION_GAP
  else y += SECTION_GAP - GAP
  if (plan.plannedVsActual?.length) {
    y += text('Planned vs actual', 24, false, 'table').height + GAP
    const rows = [
      ['Section', 'Planned', 'Actual'],
      ...plan.plannedVsActual.map((r) => [
        r.name,
        r.plannedMin === null ? '—' : `${r.plannedMin} min`,
        `${r.actualMin} min`,
      ]),
    ]
    rows.forEach((row, i) => {
      pieces.push({
        kind: 'rect',
        dx: PAD,
        dy: y,
        w: COLS[0] + COLS[1] + COLS[2],
        h: ROW_H,
        fill: i === 0 ? LOBBY_PALETTE['light-violet'].semi : LOBBY_PALETTE.white.solid,
      })
      let dx = 12
      row.forEach((c, j) => {
        const b = layoutText(canvas, c, 18, (COLS[j] ?? 200) - 24)
        pieces.push({
          kind: 'text',
          dx: PAD + dx,
          dy: y + Math.max(4, (ROW_H - b.height) / 2),
          text: b.text.split('\n')[0] ?? '',
          original: c,
          size: 18,
          ai: false,
          role: 'table',
        })
        dx += COLS[j] ?? 200
      })
      y += ROW_H
    })
    y += SECTION_GAP
  }
  const section = (title: string, lines: readonly string[], ai: boolean, role: string) => {
    if (!lines.length) return
    y += text(title, 24, ai, role).height + GAP
    for (const l of lines) y += text(l, 20, ai, role).height + 8
    y += SECTION_GAP - 8
  }
  section(
    'Top voted',
    plan.topVoted.map((v) => `${v.rank}. ${v.label} · ${plural(v.votes, 'vote')}`),
    false,
    'item',
  )
  section(
    'Decisions',
    plan.decisions.map((d) => `• ${d.text}`),
    true,
    'item',
  )
  section(
    'Open questions',
    plan.questions.map((q) => `• ${q.text}`),
    true,
    'item',
  )
  if (plan.actions.length) {
    y += text('Action items', 24, true, 'item').height + GAP
    const cols = Math.max(1, Math.floor((inner + NOTE_GAP) / (NOTE + NOTE_GAP)))
    plan.actions.forEach((a, i) => {
      pieces.push({
        kind: 'note',
        dx: PAD + (i % cols) * (NOTE + NOTE_GAP),
        dy: y + Math.floor(i / cols) * (NOTE + NOTE_GAP),
        text: a.owner ? `${a.task}\nOwner: ${a.owner}` : a.task,
      })
    })
    y += Math.ceil(plan.actions.length / cols) * (NOTE + NOTE_GAP) - NOTE_GAP + SECTION_GAP
  }
  return { pieces, height: Math.max(320, Math.round(y + PAD - SECTION_GAP)) }
}

/**
 * Writes the recap frame (see the header), selects it and brings it into this tab's view (the camera only, never
 * a write); returns its id and every element it made. `by`: this person (the server checks `lobby.ai.by` is the
 * writer). `near`: the frames a 'selection' recap is about (element ids: the frame goes beside them), else none
 * (around the middle of the view).
 */
export function applyRecap(
  canvas: LobbyCanvas,
  plan: RecapPlan,
  by: string,
  near: readonly string[] = [],
): RecapApplied {
  const { pieces, height } = layout(canvas, plan)
  const at = pageSpotNear(canvas, { w: RECAP_W, h: height }, near)
  const run = plan.runId
  const stamp = (ai: boolean, kind: string): Props =>
    ai
      ? aiCustomData(by, `recap${kind ? `-${kind}` : ''}`, run)
      : { lobby: { kind: `recap${kind ? `-${kind}` : ''}` } }
  const frameId = newId()
  const ids: string[] = [frameId]
  const notes: string[] = []
  canvas.transact('ai: recap frame', (tx) => {
    tx.create('frame', {
      id: frameId,
      x: at.x,
      y: at.y,
      width: RECAP_W,
      height,
      name: plan.title,
      customData: plan.ai ? aiCustomData(by, 'recap', run) : { lobby: { kind: 'recap' } },
    })
    for (const p of pieces) {
      const x = at.x + p.dx
      const y = at.y + p.dy
      if (p.kind === 'rect') {
        ids.push(
          tx.create('rectangle', {
            id: newId(),
            x,
            y,
            width: p.w,
            height: p.h,
            backgroundColor: p.fill,
            fillStyle: 'solid',
            strokeColor: LOBBY_PALETTE.grey.solid,
            strokeWidth: 1,
            roughness: 0,
            frameId,
            customData: stamp(false, 'table'),
          }),
        )
      } else if (p.kind === 'text') {
        ids.push(
          tx.create('text', {
            id: newId(),
            x,
            y,
            text: p.text,
            originalText: p.original,
            fontFamily: FONT_FAMILY,
            fontSize: p.size,
            textAlign: 'left',
            verticalAlign: 'top',
            strokeColor: LOBBY_INK,
            frameId,
            autoResize: p.text === p.original,
            customData: stamp(p.ai, p.role),
          }),
        )
      } else {
        const id = newId()
        tx.create('note', {
          id,
          labelId: `${id}.t`,
          x,
          y,
          size: NOTE,
          text: p.text,
          backgroundColor: LOBBY_PALETTE['light-green'].noteFill,
          customData: aiCustomData(by, 'recap-item', run),
        })
        notes.push(id)
        ids.push(id)
      }
    }
  })
  if (notes.length)
    canvas.transact('ai: recap frame', (tx) => tx.setFrame(notes, frameId), { joinPrevious: true })
  canvas.select([frameId])
  bringIntoView(canvas, [frameId], { inset: 64 })
  return { frameId, ids }
}

/** The newest recap frame on the board (this person's or anyone's), for "Export recap as PDF". */
export function latestRecapFrame(canvas: Pick<LobbyCanvas, 'items'>): CanvasElement | null {
  let best: CanvasElement | null = null
  let bestAt = -1
  for (const el of canvas.items()) {
    if (el.type !== 'frame') continue
    const kind = items.lobbyValue(el, 'kind')
    if (kind !== 'recap' && kind !== 'ai-recap') continue
    const at = (el.customData as { lobbyServer?: { createdAt?: number } } | null)?.lobbyServer?.createdAt ?? 0
    if (at >= bestAt) {
      best = el
      bestAt = at
    }
  }
  return best
}
