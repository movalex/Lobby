// OWNER: W5 (wave L, L5-3 vote results that move the meeting). What a revealed vote becomes on the board, written
// as ordinary elements in ONE canvas.transact each (one undo step, every op validated by the sync server):
//  - `resultsToBoard`: a frame with the vote's name, the date and how many people voted, one rectangle bar per
//    result (as tall as its count says) with its count and words, all tagged `customData.lobby.kind`
//    'vote-chart', placed in free space beside what was voted on;
//  - `gatherWinners`: the top N copied (or moved) into a "Top ideas" frame in rank order, each under its rank
//    and count; copies go through the registry's duplicate rules (a `plusOne:` key never comes along);
//  - `runOffPrefill`: what the setup dialog starts from for a run-off vote on the top N.
// The plans (numbers and words) are ../results-plan.ts. Nothing here reads a ballot: only a REVEALED vote's
// results, which everyone on the board already sees.

import { LOBBY_INK } from '@draftroom/board-ops/elements'
import type { VoteSession, WorkshopVoteState } from '@draftroom/contracts'
import { type CanvasElement, items, type LobbyCanvas, type LobbyTx } from '../../../canvas/api/index.ts'
import type { Rect } from '../../canvas-ux/placement.ts'
import {
  type ChartResult,
  PLAN_FONT_FAMILY,
  type PlanText,
  placeBeside,
  resultsPlan,
  type WinnerCandidate,
  winnersOf,
  winnersPlan,
} from '../results-plan.ts'
import type { VoteSetupPrefill } from '../store.ts'
import { zoomToBounds } from './camera.ts'
import { elementIdOf, labelOfRef } from './elements.ts'

/** Marks every element a results chart makes (customData.lobby.kind; a short word of the registry's pattern). */
export const VOTE_CHART_KIND = 'vote-chart'
/** The Top ideas frame, and the rank line over each copy. */
export const VOTE_WINNERS_KIND = 'vote-winners'
export const VOTE_RANK_KIND = 'vote-rank'

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** A fresh element id (ELEMENT_ID_PATTERN). */
function newId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `vr${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}

const kindData = (kind: string) => ({ lobby: { kind } })

// ---- where ------------------------------------------------------------------------------------------------------

/** The bounds of what the vote covered (a frame, the listed objects), or null: the whole board. */
export function scopeBounds(
  canvas: Pick<LobbyCanvas, 'get' | 'bounds'>,
  session: Pick<VoteSession, 'scope' | 'frameId' | 'selection'>,
): Rect | null {
  const refs =
    session.scope === 'frame' && session.frameId
      ? [session.frameId]
      : session.scope === 'selection'
        ? (session.selection ?? [])
        : []
  const boxes: Rect[] = []
  for (const ref of refs) {
    const id = elementIdOf(ref)
    if (!id || !isLive(canvas.get(id))) continue
    const b = canvas.bounds(id)
    if (b) boxes.push({ x: b.x, y: b.y, w: b.width, h: b.height })
  }
  if (boxes.length === 0) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  }
}

/** Everything on the board a new frame must keep clear of (a bound label is part of its container). */
export function obstaclesOf(canvas: Pick<LobbyCanvas, 'items' | 'bounds' | 'isHidden'>): Rect[] {
  const out: Rect[] = []
  for (const el of canvas.items()) {
    if (el.type === 'text' && el.containerId) continue
    if (canvas.isHidden(el.id)) continue
    const b = canvas.bounds(el.id)
    if (b) out.push({ x: b.x, y: b.y, w: b.width, h: b.height })
  }
  return out
}

// ---- results to board -----------------------------------------------------------------------------------------------

/** "Oct 9, 2026" in the viewer's locale. */
export function dateTextOf(iso: string | null, fallback: Date): string {
  const d = iso ? new Date(iso) : fallback
  return (Number.isFinite(d.getTime()) ? d : fallback).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

const textProps = (
  t: PlanText,
  id: string,
  origin: { x: number; y: number },
  frameId: string,
  kind: string,
) => ({
  id,
  x: Math.round((origin.x + t.x) * 100) / 100,
  y: Math.round((origin.y + t.y) * 100) / 100,
  text: t.text,
  originalText: t.text,
  fontFamily: PLAN_FONT_FAMILY,
  fontSize: t.fontSize,
  textAlign: t.align,
  verticalAlign: 'top',
  strokeColor: LOBBY_INK,
  frameId,
  autoResize: true,
  customData: kindData(kind),
})

/** The camera to a block just made (never closer than 100%), selecting it. */
function showResult(canvas: LobbyCanvas, frameId: string) {
  canvas.select([frameId])
  const b = canvas.bounds(frameId)
  if (b) zoomToBounds(canvas, b, { maxZoom: 1, inset: 96 })
}

export interface ResultsOutcome {
  readonly frameId: string
  readonly bars: number
}

/**
 * "Results to board": the chart as one undo step. Null when the vote is not revealed or has no results (the
 * panel does not offer it then).
 */
export function resultsToBoard(
  canvas: LobbyCanvas,
  vote: Pick<WorkshopVoteState, 'session' | 'results' | 'participants'>,
  now: Date = new Date(),
): ResultsOutcome | null {
  if (vote.session.status !== 'revealed' || !vote.results?.length) return null
  const get = (id: string) => canvas.get(id)
  const results: ChartResult[] = vote.results.map((r) => ({
    ref: r.shapeId,
    count: r.count,
    rank: r.rank,
    label: labelOfRef(r.shapeId, get),
  }))
  const plan = resultsPlan({
    title: vote.session.title,
    dateText: dateTextOf(vote.session.revealedAt, now),
    participants: vote.participants,
    results,
    measure: (text, style) => canvas.text.measure(text, style),
  })
  if (!plan) return null
  const at = placeBeside(
    { w: plan.width, h: plan.height },
    scopeBounds(canvas, vote.session),
    obstaclesOf(canvas),
  )
  const frameId = newId()
  canvas.transact('vote results to board', (tx) => {
    tx.create('frame', {
      id: frameId,
      x: at.x,
      y: at.y,
      width: plan.width,
      height: plan.height,
      name: plan.frameName,
      customData: kindData(VOTE_CHART_KIND),
    })
    for (const b of plan.bars)
      tx.create('rectangle', {
        id: newId(),
        x: Math.round((at.x + b.x) * 100) / 100,
        y: Math.round((at.y + b.y) * 100) / 100,
        width: b.width,
        height: b.height,
        backgroundColor: b.fill,
        fillStyle: 'solid',
        strokeColor: b.stroke,
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
        frameId,
        customData: kindData(VOTE_CHART_KIND),
      })
    for (const t of plan.texts) tx.create('text', textProps(t, newId(), at, frameId, VOTE_CHART_KIND))
  })
  showResult(canvas, frameId)
  return { frameId, bars: plan.bars.length }
}

// ---- gather the winners ---------------------------------------------------------------------------------------------

/** The results as candidates for gathering or a run-off (what each ref names now). */
export function candidatesOf(
  canvas: Pick<LobbyCanvas, 'get' | 'isLocked'>,
  results: readonly { shapeId: string; count: number; rank: number }[],
): WinnerCandidate[] {
  return results.map((r) => {
    const id = elementIdOf(r.shapeId)
    const el = id ? canvas.get(id) : undefined
    return {
      ref: r.shapeId,
      count: r.count,
      rank: r.rank,
      id,
      live: isLive(el),
      frame: el?.type === 'frame',
      locked: !!id && isLive(el) && canvas.isLocked(id),
    }
  })
}

export interface GatherOutcome {
  /** the Top ideas frame, or null when nothing could be gathered */
  readonly frameId: string | null
  readonly gathered: number
  readonly skipped: { gone: number; frames: number; locked: number }
}

/** Moves an element and its bound label by (dx, dy): a label keeps its own x, y. */
function moveBy(canvas: LobbyCanvas, tx: LobbyTx, el: CanvasElement, dx: number, dy: number) {
  tx.update(el.id, { x: el.x + dx, y: el.y + dy })
  const label = items.labelOf(el, (id) => canvas.get(id))
  if (label) tx.update(label.id, { x: label.x + dx, y: label.y + dy })
}

/**
 * "Gather the winners": the top `n` (ties at the cut-off included) into a "Top ideas" frame in rank order, one
 * undo step. Copies by default (`move` false: the originals stay where they are, with their +1s and frame);
 * `move` true moves the originals into the frame, out of whatever frame they were in. Locked ones, frames and
 * ones that are gone are left out and counted.
 */
export function gatherWinners(
  canvas: LobbyCanvas,
  vote: Pick<WorkshopVoteState, 'session' | 'results'>,
  opts: { n: number; move: boolean },
): GatherOutcome | null {
  if (vote.session.status !== 'revealed' || !vote.results?.length) return null
  const { winners, skipped } = winnersOf(candidatesOf(canvas, vote.results), opts.n)
  const plan = winnersPlan({
    winners,
    sizeOf: (id) => {
      const b = canvas.bounds(id)
      return b ? { width: b.width, height: b.height } : null
    },
    measure: (text, style) => canvas.text.measure(text, style),
  })
  if (!plan) return { frameId: null, gathered: 0, skipped }
  const at = placeBeside(
    { w: plan.width, h: plan.height },
    scopeBounds(canvas, vote.session),
    obstaclesOf(canvas),
  )
  const frameId = newId()
  let gathered = 0
  canvas.transact(opts.move ? 'move the winners into Top ideas' : 'gather the winners', (tx) => {
    tx.create('frame', {
      id: frameId,
      x: at.x,
      y: at.y,
      width: plan.width,
      height: plan.height,
      name: plan.frameName,
      customData: kindData(VOTE_WINNERS_KIND),
    })
    const inside: string[] = []
    for (const p of plan.places) {
      const el = canvas.get(p.winner.id)
      const b = canvas.bounds(p.winner.id)
      if (!isLive(el) || !b) continue
      const dx = at.x + p.x - b.x
      const dy = at.y + p.y - b.y
      if (opts.move) {
        moveBy(canvas, tx, el, dx, dy)
        inside.push(el.id)
      } else {
        const copy = tx.duplicate([el.id], { x: dx, y: dy }).get(el.id)
        if (!copy) continue
        inside.push(copy)
      }
      gathered++
      tx.create('text', textProps(p.rank, newId(), at, frameId, VOTE_RANK_KIND))
    }
    if (inside.length) tx.setFrame(inside, frameId)
  })
  showResult(canvas, frameId)
  return { frameId, gathered, skipped }
}

// ---- run-off ----------------------------------------------------------------------------------------------------------

/** The most votes a run-off gives each person by default: about a third of the candidates, at least one. */
const runOffVotes = (candidates: number) => Math.max(1, Math.ceil(candidates / 3))

/**
 * What the vote setup dialog opens with for a run-off on the top `n`: a vote over exactly those objects, one
 * vote per object, a few votes each. Null with fewer than two candidates left on the board (a run-off between
 * one thing is no vote). Locked ones are fine here: voting writes nothing to the board.
 */
export function runOffPrefill(
  canvas: Pick<LobbyCanvas, 'get' | 'isLocked'>,
  vote: Pick<WorkshopVoteState, 'session' | 'results'>,
  n: number,
): VoteSetupPrefill | null {
  if (!vote.results?.length) return null
  const candidates = candidatesOf(canvas, vote.results).map((c) => ({ ...c, locked: false }))
  const { winners } = winnersOf(candidates, n)
  if (winners.length < 2) return null
  return {
    scope: 'selection',
    refs: winners.map((w) => w.ref),
    onePerObject: true,
    title: `Run-off: ${vote.session.title}`.slice(0, 120),
    votesPerPerson: runOffVotes(winners.length),
  }
}
