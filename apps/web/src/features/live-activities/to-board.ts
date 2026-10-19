// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2.5). "Results to board": a REVEALED activity's results written as
// ordinary elements by the facilitator's own client, in ONE canvas.transact (one undo step; the sync server validates
// every op as usual and re-lays out nothing), as features/workshops/ported/vote-board.ts does for a dot vote (read,
// never edited; its placement helpers are imported):
//  - a poll or a scale: a frame of rectangle bars and texts, every element tagged customData.lobby.kind 'poll-chart';
//  - a word cloud: a frame of free texts (./word-cloud-layout.ts over canvas.text.measure, the server's metrics),
//    tagged 'word-cloud'; or "As sticky notes": one note per word with its count, in a 'word-cloud' frame.
// Placed in free space near the middle of the view, then shown. Nothing here reads an answer: only the revealed
// aggregates everyone on the board already sees, so no element can carry who answered what (the author of every
// element is the facilitator, from their ticket). No URL of any kind goes into an element.
//
// A tab that only receives the elements writes nothing: this runs only from the facilitator's press.

import {
  ACTIVITY_LIMITS,
  type ActivityResults,
  LIVE_ELEMENT_KINDS,
  type LiveActivity,
} from '@draftroom/contracts'
import type { LobbyCanvas, LobbyTx } from '../../canvas/api/index.ts'
import { findEmptySpot } from '../canvas-ux/placement.ts'
import { zoomToBounds } from '../workshops/ported/camera.ts'
import { dateTextOf, obstaclesOf } from '../workshops/ported/vote-board.ts'
import {
  type BoardPlan,
  cloudPlan,
  type Measure,
  notesPlan,
  PLAN_FONT,
  type PlanText,
  pollPlan,
  scalePlan,
} from './board-plan.ts'
import { seedOf } from './word-cloud-layout.ts'

export const POLL_CHART_KIND = LIVE_ELEMENT_KINDS.pollChart
export const WORD_CLOUD_KIND = LIVE_ELEMENT_KINDS.wordCloud

/** How a word cloud goes on the board. */
export type PlaceAs = 'chart' | 'notes'

/** A fresh element id (ELEMENT_ID_PATTERN). */
function newId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `la${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}

const kindData = (kind: string) => ({ lobby: { kind } })
const r2 = (n: number) => Math.round(n * 100) / 100

/** The plan of a revealed activity's results (null when there is nothing to place). */
export function planFor(
  activity: LiveActivity,
  results: ActivityResults,
  measure: Measure,
  opts: { as?: PlaceAs; now?: Date } = {},
): { plan: BoardPlan; kind: string } | null {
  const dateText = dateTextOf(activity.revealedAt, opts.now ?? new Date())
  if (activity.kind === 'poll' && results.kind === 'poll')
    return {
      kind: POLL_CHART_KIND,
      plan: pollPlan({
        prompt: activity.prompt,
        options: activity.config.options,
        results,
        dateText,
        measure,
      }),
    }
  if (activity.kind === 'scale' && results.kind === 'scale')
    return {
      kind: POLL_CHART_KIND,
      plan: scalePlan({
        prompt: activity.prompt,
        min: activity.config.min,
        max: activity.config.max,
        minLabel: activity.config.minLabel,
        maxLabel: activity.config.maxLabel,
        results,
        dateText,
        measure,
      }),
    }
  if (activity.kind === 'words' && results.kind === 'words') {
    if (results.words.length === 0) return null
    return {
      kind: WORD_CLOUD_KIND,
      plan:
        opts.as === 'notes'
          ? notesPlan({
              prompt: activity.prompt,
              results,
              dateText,
              measure,
              maxNotes: ACTIVITY_LIMITS.cloudWordsMax,
            })
          : cloudPlan({ prompt: activity.prompt, results, dateText, measure, seed: seedOf(activity.id) }),
    }
  }
  return null
}

/** A plan text's create props: the engine takes a centred text's middle as its `x` (vote-board.ts textProps). */
function textProps(t: PlanText, origin: { x: number; y: number }, frameId: string, kind: string) {
  return {
    id: newId(),
    x: r2(origin.x + t.x + (t.align === 'center' ? t.width / 2 : 0)),
    y: r2(origin.y + t.y),
    text: t.text,
    originalText: t.text,
    fontFamily: PLAN_FONT,
    fontSize: t.fontSize,
    textAlign: t.align,
    verticalAlign: 'top',
    strokeColor: t.color,
    frameId,
    autoResize: true,
    customData: kindData(kind),
  }
}

/** Writes a plan at `at` in one transact (the caller's label is its undo step). Returns the frame id. */
export function writePlan(
  canvas: Pick<LobbyCanvas, 'transact'>,
  plan: BoardPlan,
  kind: string,
  at: { x: number; y: number },
  label: string,
): string {
  const frameId = newId()
  canvas.transact(label, (tx: LobbyTx) => {
    tx.create('frame', {
      id: frameId,
      x: at.x,
      y: at.y,
      width: plan.width,
      height: plan.height,
      name: plan.frameName,
      customData: kindData(kind),
    })
    for (const b of plan.rects)
      tx.create('rectangle', {
        id: newId(),
        x: r2(at.x + b.x),
        y: r2(at.y + b.y),
        width: b.width,
        height: b.height,
        backgroundColor: b.fill,
        fillStyle: 'solid',
        strokeColor: b.stroke,
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
        frameId,
        customData: kindData(kind),
      })
    for (const t of plan.texts) tx.create('text', textProps(t, at, frameId, kind))
    const notes: string[] = []
    for (const n of plan.notes)
      notes.push(
        tx.create('note', {
          id: newId(),
          x: r2(at.x + n.x),
          y: r2(at.y + n.y),
          text: n.text,
          backgroundColor: n.fill,
          customData: kindData(kind),
        }),
      )
    // a note's label is made with it: frame membership goes through setFrame, which moves both
    if (notes.length) tx.setFrame(notes, frameId)
  })
  return frameId
}

export interface PlaceOutcome {
  readonly frameId: string
  /** results left off the board (words past the cap) */
  readonly left: number
}

/**
 * "Results to board" for a revealed activity: one undo step, in free space near the middle of the view, then shown
 * (never closer than 100%). Null when it is not revealed or has nothing to place.
 */
export function resultsToBoard(
  canvas: LobbyCanvas,
  input: { activity: LiveActivity | null; results: ActivityResults | null },
  opts: { as?: PlaceAs; now?: Date } = {},
): PlaceOutcome | null {
  const { activity, results } = input
  if (activity?.status !== 'revealed' || !results) return null
  const made = planFor(activity, results, (text, style) => canvas.text.measure(text, style), opts)
  if (!made) return null
  const { plan, kind } = made
  const v = canvas.viewport.get()
  const at = findEmptySpot(
    { w: plan.width, h: plan.height },
    { x: v.x + v.width / 2, y: v.y + v.height / 2 },
    obstaclesOf(canvas),
    { gap: 80 },
  )
  const label = kind === WORD_CLOUD_KIND ? 'word cloud to board' : 'poll results to board'
  const frameId = writePlan(canvas, plan, kind, { x: r2(at.x), y: r2(at.y) }, label)
  canvas.select([frameId])
  const b = canvas.bounds(frameId)
  if (b) zoomToBounds(canvas, b, { maxZoom: 1, inset: 96 })
  return { frameId, left: plan.left }
}
