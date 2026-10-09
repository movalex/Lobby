// L8-2: sort by any lens, and place notes on a 2x2, with AI. The AI returns only names (the groups of a lens)
// or scores (two integers per note, from -5 to 5, on two named axes); Lobby's own layout puts the notes
// down, so nothing lands out of bounds or on top of anything.
//
//  - sortByLens: runAi('sort', {lens}) names groups of notes; the groups become columns (./plan.ts), the
//    headings carrying the run (`customData.lobby.ai`, kind `ai-sort-label`).
//  - placeOnMatrix: runAi('score', {axes}) scores the notes; ./layout.ts layoutMatrix puts each in its
//    quadrant on a grid. The 2x2 is the template's squares or a matrix this feature made (./matrix.ts), or,
//    when there is neither, one made now from the axes the person named: a frame, a cross and six axis words,
//    all new elements, in the same undo step as the moves.
//  - both go through ./execute.ts: showAiPreview over 10 moves, and the board read again at the moment of
//    writing. They move only notes (with their bound labels), skip what is locked, under another tab's lease
//    or being dragged, and write no arrow: the server re-snaps what is bound to a note that moved. A note
//    the AI left out of a sort, or did not score, stays where it is and is counted.
import { LOBBY_INK, newElementId } from '@draftroom/board-ops/elements'
import { fromShapeRef, toShapeRef } from '@draftroom/canvas-schema/refs'
import {
  AI_MAX_REQUEST_SHAPES,
  AI_SORT_LENS_MAX_CHARS,
  AI_THEME_NAME_MAX_CHARS,
  type AiResult,
  type AiScoreAxis,
} from '@draftroom/contracts'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  items,
  type LobbyCanvas,
} from '../../canvas/api/index.ts'
import { BESIDE_GAP, placeBeside } from '../ai/layout.ts'
import { aiCustomData } from '../ai/ported/public.ts'
import { bringIntoView } from './apply.ts'
import { plural } from './copy.ts'
import { sortDeps } from './deps.ts'
import { type BuiltPlan, executePlan, type Outcome, type PlanProblem, type PlanSpec } from './execute.ts'
import {
  boxOf,
  isBoundLabel,
  isFrame,
  isLive,
  LABEL_FONT_FAMILY,
  layoutLabel,
  unionRects,
  withNameBand,
} from './geom.ts'
import {
  layoutMatrix,
  type MatrixLayout,
  type MatrixNote,
  matrixFrameSize,
  QUADRANT_KEYS,
  type QuadrantKey,
  type Rect,
} from './layout.ts'
import {
  AXIS_KINDS,
  type AxisRole,
  detectMatrix,
  MATRIX_BOTTOM_BAND,
  MATRIX_FRAME_KIND,
  MATRIX_LEFT_BAND,
  MATRIX_RIGHT_MARGIN,
  MATRIX_TOP_MARGIN,
  type MatrixQuadrant,
  type MatrixTarget,
  madeQuadrantAreas,
} from './matrix.ts'
import { eligibility, MAX_SORT_NOTES, skippedText, targetNotes } from './model.ts'
import { type PlanGroup, planColumns } from './plan.ts'
import { columnsBuilt, measureOf, NEED_NOTES } from './run.ts'
import { rememberScores, showScores } from './scores.ts'

const AI_LIMIT = Math.min(MAX_SORT_NOTES, AI_MAX_REQUEST_SHAPES)

const notice = (ctx: CanvasFeatureContext, text: string) =>
  ctx.notify({ key: 'sort', text, testId: 'sort-notice', timeoutMs: 8000 })

const isSort = (r: AiResult | null): r is Extract<AiResult, { action: 'sort' }> => r?.action === 'sort'
const isScore = (r: AiResult | null): r is Extract<AiResult, { action: 'score' }> => r?.action === 'score'

type Targets = { readonly problem: string } | { readonly movable: CanvasElement[] }

/** The notes an AI request is about: at least two, and at most what the api reads. */
function aiTargets(ctx: CanvasFeatureContext, ids: readonly string[]): Targets {
  const { canvas } = ctx
  const all = targetNotes(canvas, ids)
  if (all.length < 2) return { problem: NEED_NOTES }
  if (all.length > AI_LIMIT)
    return { problem: `That is ${all.length} notes. Use up to ${AI_LIMIT} at a time.` }
  const { movable, skipped } = eligibility(canvas, all)
  if (movable.length < 2)
    return { problem: skipped.length ? `${skippedText(skipped)} Nothing to do.` : NEED_NOTES }
  return { movable }
}

// ---- sort by a lens ----------------------------------------------------------------------------------------------

/** Sorts `ids` (default: the selection) into columns named by `lens`: "customer journey stage", "effort". */
export async function sortByLens(
  ctx: CanvasFeatureContext,
  lens: string,
  ids: readonly string[] = ctx.canvas.selection,
): Promise<Outcome> {
  const { canvas } = ctx
  if (canvas.readOnly()) return { status: 'refused', reason: 'read-only' }
  const words = lens.trim().replace(/\s+/g, ' ').slice(0, AI_SORT_LENS_MAX_CHARS)
  if (!words) {
    notice(ctx, 'Say how the notes should be grouped, for example “customer journey stage”.')
    return { status: 'nothing', reason: 'no-lens' }
  }
  const t = aiTargets(ctx, ids)
  if ('problem' in t) {
    notice(ctx, t.problem)
    return { status: 'nothing', reason: t.problem }
  }
  const call = () =>
    sortDeps().runAi(ctx, {
      action: 'sort',
      shapeIds: t.movable.map((n) => toShapeRef(n.id)),
      lens: words,
    })
  const first = await call()
  if (!isSort(first)) return { status: 'nothing', reason: 'ai' }
  const title = `Sort by ${words.length > 32 ? `${words.slice(0, 31).trimEnd()}…` : words}`
  const makeBuild = (res: Extract<AiResult, { action: 'sort' }>) => (): BuiltPlan | PlanProblem => {
    const now = aiTargets(ctx, ids)
    if ('problem' in now) return { problem: now.problem }
    const ok = new Map(now.movable.map((n) => [n.id, n]))
    const used = new Set<string>()
    const groups: PlanGroup[] = res.themes
      .map((th, i) => ({
        key: `lens:${i}`,
        label: th.name.trim().slice(0, AI_THEME_NAME_MAX_CHARS) || `Group ${i + 1}`,
        ids: th.noteIds
          .map((r) => fromShapeRef(r))
          .filter((id): id is string => {
            if (!id || !ok.has(id) || used.has(id)) return false
            used.add(id)
            return true
          }),
      }))
      .filter((g) => g.ids.length > 0)
    if (!groups.length)
      return { problem: 'The AI did not name any groups for these notes. Try another lens.' }
    const left = ok.size - used.size
    const plan = planColumns(canvas, groups, measureOf(ctx))
    const { skipped } = eligibility(canvas, targetNotes(canvas, ids))
    return columnsBuilt(ctx, plan, skipped, {
      title,
      customData: () => aiCustomData(ctx.me.user.id, 'sort-label', res.runId),
      ...(left > 0
        ? {
            extra: `${plural(left, 'note')} the AI did not place stayed where ${left === 1 ? 'it was' : 'they were'}.`,
          }
        : {}),
    })
  }
  const spec: PlanSpec = {
    title,
    runId: first.runId,
    build: makeBuild(first),
    retry: async () => {
      const again = await call()
      return isSort(again) ? makeBuild(again) : null
    },
  }
  return executePlan(ctx, spec)
}

// ---- place on a 2x2 ----------------------------------------------------------------------------------------------

export type PlaceOutcome = Outcome | { readonly status: 'needs-axes' }

/** Whether `axes` are two axes the api takes (a name, and the words at both ends). */
export function validAxes(
  axes: readonly AiScoreAxis[] | undefined,
): axes is readonly [AiScoreAxis, AiScoreAxis] {
  return (
    !!axes &&
    axes.length === 2 &&
    axes.every(
      (a) =>
        a.name.trim().length > 0 &&
        a.name.length <= 24 &&
        a.low.trim().length > 0 &&
        a.low.length <= 16 &&
        a.high.trim().length > 0 &&
        a.high.length <= 16,
    )
  )
}

/** Page-level things a new matrix frame must keep clear of (frames with their name band), minus `leaving`. */
function pageObstacles(canvas: LobbyCanvas, leaving: ReadonlySet<string>): Rect[] {
  const out: Rect[] = []
  for (const el of canvas.items()) {
    if (!isLive(el) || el.frameId || isBoundLabel(el) || canvas.isHidden(el.id) || leaving.has(el.id))
      continue
    if (el.type === 'arrow') {
      const ends = items.arrowEnds(el)
      if ((ends.start && leaving.has(ends.start)) || (ends.end && leaving.has(ends.end))) continue
    }
    const b = boxOf(el)
    out.push(isFrame(el) ? withNameBand(b) : b)
  }
  return out
}

/** Things inside the squares' frames that stay where they are (not the matrix's own cross and words). */
function stayingIn(canvas: LobbyCanvas, frameIds: ReadonlySet<string>, moving: ReadonlySet<string>): Rect[] {
  const own = new Set<string>(Object.values(AXIS_KINDS))
  own.add(MATRIX_FRAME_KIND)
  const out: Rect[] = []
  for (const el of canvas.items()) {
    if (!isLive(el) || !el.frameId || !frameIds.has(el.frameId) || isBoundLabel(el) || moving.has(el.id))
      continue
    const kind = items.lobbyValue(el, 'kind')
    if (typeof kind === 'string' && own.has(kind)) continue
    if (el.type === 'arrow') {
      const ends = items.arrowEnds(el)
      if ((ends.start && moving.has(ends.start)) || (ends.end && moving.has(ends.end))) continue
    }
    out.push(boxOf(el))
  }
  return out
}

/** Whether frame `f` could be `extra` taller without running into anything below it on the page. */
function mayGrow(canvas: LobbyCanvas, f: CanvasElement, extra: number, moving: ReadonlySet<string>): boolean {
  const b = boxOf(f)
  const strip: Rect = { x: b.x, y: b.y + b.h, w: b.w, h: extra + BESIDE_GAP / 2 }
  return pageObstacles(canvas, moving).every((o) => {
    if (o.x === b.x && o.w === b.w && o.y + o.h >= b.y + b.h && o.y <= b.y + b.h) return true
    return !(o.x < strip.x + strip.w && strip.x < o.x + o.w && o.y < strip.y + strip.h && strip.y < o.y + o.h)
  })
}

interface Scored {
  readonly el: CanvasElement
  readonly x: number
  readonly y: number
}

/** The elements a made matrix frame is: the frame, the cross, the six words (ids fresh on each call). */
function matrixElements(
  ctx: CanvasFeatureContext,
  frameBox: Rect,
  axes: readonly [AiScoreAxis, AiScoreAxis],
) {
  const [across, up] = axes
  const frameId = newElementId()
  const areas = madeQuadrantAreas(frameBox)
  const qw = areas['low-high'].w
  const qh = areas['low-high'].h
  const x0 = areas['low-high'].x
  const y0 = areas['low-high'].y
  const measure = measureOf(ctx)
  const custom = (kind: string) => ({ lobby: { kind } })
  const word = (
    role: AxisRole,
    text: string,
    x: number,
    y: number,
    width: number,
    align: 'left' | 'center' | 'right',
    fontSize: number,
  ) => {
    const style = { fontFamily: LABEL_FONT_FAMILY, fontSize }
    const wrapped = layoutLabel((t, s) => measure(t, { ...s, fontSize }), text, width)
    const left = align === 'left' ? x : align === 'center' ? x - wrapped.width / 2 : x - wrapped.width
    return {
      id: newElementId(),
      x: Math.round(left),
      y: Math.round(y),
      text: wrapped.text,
      originalText: text,
      fontFamily: style.fontFamily,
      fontSize,
      textAlign: align,
      verticalAlign: 'top',
      strokeColor: LOBBY_INK,
      frameId,
      autoResize: wrapped.text === text,
      customData: custom(AXIS_KINDS[role]),
      box: { x: Math.round(left), y: Math.round(y), w: wrapped.width, h: wrapped.height },
    }
  }
  const under = y0 + 2 * qh + 14
  const leftW = MATRIX_LEFT_BAND - 24
  const texts = [
    word('xLow', across.low, x0, under, qw - 8, 'left', 18),
    word('xName', across.name, x0 + qw, under, 2 * qw - 8, 'center', 20),
    word('xHigh', across.high, x0 + 2 * qw, under, qw - 8, 'right', 18),
    word('yHigh', up.high, frameBox.x + 12, y0 + 4, leftW, 'left', 18),
    word('yName', up.name, frameBox.x + 12, y0 + qh - 12, leftW, 'left', 20),
    word('yLow', up.low, frameBox.x + 12, y0 + 2 * qh - 28, leftW, 'left', 18),
  ]
  const frame = {
    id: frameId,
    x: frameBox.x,
    y: frameBox.y,
    width: frameBox.w,
    height: frameBox.h,
    name: `${up.name} by ${across.name}`.slice(0, 80),
    customData: custom(MATRIX_FRAME_KIND),
  }
  const line = (x: number, y: number, w: number, h: number) => ({
    x,
    y,
    width: w,
    height: h,
    points: [
      [0, 0],
      [w, h],
    ],
    strokeColor: '#7d8799',
    strokeStyle: 'dashed',
    strokeWidth: 2,
    frameId,
    customData: custom(MATRIX_FRAME_KIND),
  })
  const lines = [line(x0 + qw, y0, 0, 2 * qh), line(x0, y0 + qh, 2 * qw, 0)]
  return { frame, texts, lines, areas, frameId }
}

/** Where a made matrix frame of `size` goes: beside the notes' frames (or the notes), clear of the page. */
function matrixSpot(canvas: LobbyCanvas, notes: readonly CanvasElement[], size: { w: number; h: number }) {
  const moving = new Set(notes.map((n) => n.id))
  const anchors = notes.map((n) => {
    const f = n.frameId ? canvas.get(n.frameId) : undefined
    return isLive(f) && isFrame(f) ? withNameBand(boxOf(f)) : boxOf(n)
  })
  const anchor = unionRects(anchors) as Rect
  const obstacles = pageObstacles(canvas, moving)
  // the frame's name sits over its top edge
  const block = { w: size.w, h: size.h + 40 }
  const at = placeBeside(block, anchor, obstacles, null, ['right', 'below']) ?? {
    x: anchor.x + anchor.w + BESIDE_GAP,
    y: anchor.y,
  }
  return { x: Math.round(at.x), y: Math.round(at.y + 40) }
}

/**
 * Places `ids` (default: the selection) on a 2x2 by the scores the AI gives them on `axes` (the template's, or a
 * matrix this feature made, name their own; `axes` is what a new matrix is made from). Resolves 'needs-axes'
 * when the notes belong with no 2x2 and no axes were given.
 */
export async function placeOnMatrix(
  ctx: CanvasFeatureContext,
  o: { ids?: readonly string[]; axes?: readonly [AiScoreAxis, AiScoreAxis] } = {},
): Promise<PlaceOutcome> {
  const { canvas } = ctx
  const ids = o.ids ?? canvas.selection
  if (canvas.readOnly()) return { status: 'refused', reason: 'read-only' }
  const t = aiTargets(ctx, ids)
  if ('problem' in t) {
    notice(ctx, t.problem)
    return { status: 'nothing', reason: t.problem }
  }
  const movable = t.movable
  const found = detectMatrix(canvas, movable)
  const axes = found?.axes ?? o.axes
  if (!axes) return { status: 'needs-axes' }
  if (!validAxes(axes)) {
    notice(ctx, 'Name both axes, and the words at each end of them.')
    return { status: 'nothing', reason: 'axes' }
  }
  const call = () =>
    sortDeps().runAi(ctx, {
      action: 'score',
      shapeIds: movable.map((n) => toShapeRef(n.id)),
      axes: [axes[0], axes[1]],
    })
  const first = await call()
  if (!isScore(first)) return { status: 'nothing', reason: 'ai' }

  const title = `Place by ${axes[1].name.toLowerCase()} and ${axes[0].name.toLowerCase()}`
  const makeBuild = (res: Extract<AiResult, { action: 'score' }>) => (): BuiltPlan | PlanProblem =>
    buildPlacement(ctx, ids, o.axes, res, title)
  return executePlan(ctx, {
    title,
    runId: first.runId,
    build: makeBuild(first),
    retry: async () => {
      const again = await call()
      return isScore(again) ? makeBuild(again) : null
    },
  })
}

/** The plan that puts the notes where `res` scores them, built from the board as it is now. */
function buildPlacement(
  ctx: CanvasFeatureContext,
  ids: readonly string[],
  askedAxes: readonly [AiScoreAxis, AiScoreAxis] | undefined,
  res: Extract<AiResult, { action: 'score' }>,
  title: string,
): BuiltPlan | PlanProblem {
  const { canvas } = ctx
  const now = aiTargets(ctx, ids)
  if ('problem' in now) return { problem: now.problem }
  const movable = now.movable
  const { skipped } = eligibility(canvas, targetNotes(canvas, ids))
  const byId = new Map(res.scores.map((s) => [fromShapeRef(s.id) ?? s.id, s]))
  const scored: Scored[] = []
  const unscored: CanvasElement[] = []
  for (const n of movable) {
    const s = byId.get(n.id)
    if (!s || s.unscored) unscored.push(n)
    else scored.push({ el: n, x: s.x, y: s.y })
  }
  if (!scored.length) return { problem: 'The AI could not score these notes. Try again.' }
  const moving = new Set(scored.map((s) => s.el.id))

  // the 2x2: the template's, a made one, or a new one made now
  let target: MatrixTarget | null = detectMatrix(canvas, movable)
  let made: ReturnType<typeof matrixElements> | null = null
  const axes = target?.axes ?? askedAxes
  if (!axes) return { problem: 'Name the two axes first.' }
  const sizeOf = (s: Scored) => {
    const b = boxOf(s.el)
    return { w: b.w, h: b.h }
  }
  const cell = {
    w: Math.max(...scored.map((s) => sizeOf(s).w)),
    h: Math.max(...scored.map((s) => sizeOf(s).h)),
  }
  if (!target) {
    const counts = new Map<QuadrantKey, number>()
    for (const s of scored) {
      const k = `${s.x > 0 ? 'high' : 'low'}-${s.y > 0 ? 'high' : 'low'}` as QuadrantKey
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const size = matrixFrameSize(Math.max(...counts.values()), cell)
    const w = MATRIX_LEFT_BAND + 2 * size.quadW + MATRIX_RIGHT_MARGIN
    const h = MATRIX_TOP_MARGIN + 2 * size.quadH + MATRIX_BOTTOM_BAND
    const at = matrixSpot(canvas, movable, { w, h })
    made = matrixElements(ctx, { x: at.x, y: at.y, w, h }, axes)
    target = {
      source: 'made',
      axes,
      quadrants: Object.fromEntries(
        QUADRANT_KEYS.map((k) => [
          k,
          { frameId: made?.frameId ?? '', area: (made as NonNullable<typeof made>).areas[k] },
        ]),
      ) as Record<QuadrantKey, MatrixQuadrant>,
    }
  }
  const frames = [...new Set(QUADRANT_KEYS.map((k) => (target as MatrixTarget).quadrants[k].frameId))]
  if (!made && frames.some((f) => canvas.isLocked(f)))
    return { problem: 'The squares of this 2x2 are locked. Unlock them to place notes.' }

  const matrixNotes: MatrixNote[] = scored.map((s) => ({ id: s.el.id, ...sizeOf(s), x: s.x, y: s.y }))
  const frameSet = new Set(frames)
  const obstacles = made ? [] : stayingIn(canvas, frameSet, moving)
  const areas = Object.fromEntries(
    QUADRANT_KEYS.map((k) => [k, (target as MatrixTarget).quadrants[k].area]),
  ) as Record<QuadrantKey, Rect>
  let layout: MatrixLayout = layoutMatrix({ quadrants: areas, notes: matrixNotes, obstacles })
  // a template's square that is too small for its notes grows downward when nothing is in its way
  const grow = new Map<string, number>()
  if (!made && layout.unplaced.length) {
    const grownAreas = { ...areas }
    for (const k of QUADRANT_KEYS) {
      if (!layout.unplaced.some((u) => u.quadrant === k)) continue
      const frame = canvas.get((target as MatrixTarget).quadrants[k].frameId)
      const need = layout.heightNeeded[k] - areas[k].h
      if (frame && need > 0 && mayGrow(canvas, frame, need, moving)) {
        grownAreas[k] = { ...areas[k], h: areas[k].h + need }
        grow.set(frame.id, Math.max(grow.get(frame.id) ?? 0, need))
      }
    }
    if (grow.size) layout = layoutMatrix({ quadrants: grownAreas, notes: matrixNotes, obstacles })
  }
  if (!layout.placed.length) return { problem: 'No note fits this 2x2 at the moment.' }

  const place = new Map(layout.placed.map((p) => [p.id, p]))
  const noteMoves = scored
    .filter((s) => place.has(s.el.id))
    .map((s) => {
      const p = place.get(s.el.id) as NonNullable<ReturnType<typeof place.get>>
      const b = boxOf(s.el)
      const frameId = (target as MatrixTarget).quadrants[p.quadrant].frameId
      return {
        el: s.el,
        // the element's own x, y move by the same difference as its box
        x: s.el.x + (p.x - b.x),
        y: s.el.y + (p.y - b.y),
        frameId,
      }
    })
  const moves = noteMoves
    .filter((m) => m.x !== m.el.x || m.y !== m.el.y)
    .map((m) => ({ id: m.el.id, x: m.x, y: m.y }))
  const creates: BuiltPlan['creates'] = made
    ? [
        { x: made.frame.x, y: made.frame.y, w: made.frame.width, h: made.frame.height, kind: 'frame' },
        ...made.texts.map((t) => ({ x: t.box.x, y: t.box.y, w: t.box.w, h: t.box.h, kind: 'text' })),
      ]
    : []
  const left = unscored.length
  const stuck = layout.unplaced.length
  const extra = [
    left
      ? `${plural(left, 'note')} the AI could not score stayed where ${left === 1 ? 'it was' : 'they were'}.`
      : '',
    stuck
      ? `${plural(stuck, 'note')} did not fit and stayed where ${stuck === 1 ? 'it was' : 'they were'}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
  const shown = new Map<string, { x: number; y: number }>(scored.map((s) => [s.el.id, { x: s.x, y: s.y }]))
  const built = made
  return {
    skipped,
    moves,
    creates,
    summary: `Moves ${plural(moves.length, 'note')} onto a 2x2${built ? ' (a new frame)' : ''}`,
    noop: moves.length === 0 && !made && grow.size === 0,
    ...(extra ? { extra } : {}),
    action: { label: 'Show scores', testId: 'sort-show-scores', onClick: () => showScores(canvas, true) },
    apply() {
      let moved = 0
      canvas.transact(title, (tx) => {
        if (built) {
          tx.create('frame', built.frame)
          for (const l of built.lines) tx.create('line', { id: newElementId(), ...l })
          for (const t of built.texts) {
            const { box: _box, ...props } = t
            tx.create('text', props)
          }
        }
        for (const [frameId, extraH] of grow) {
          const f = canvas.get(frameId)
          if (f) tx.update(frameId, { height: f.height + Math.ceil(extraH) })
        }
        const toFrame = new Map<string, string[]>()
        for (const m of noteMoves) {
          if ((m.el.frameId ?? null) !== m.frameId)
            toFrame.set(m.frameId, [...(toFrame.get(m.frameId) ?? []), m.el.id])
        }
        for (const [frameId, list] of toFrame) tx.setFrame(list, frameId)
        for (const m of noteMoves) {
          const dx = m.x - m.el.x
          const dy = m.y - m.el.y
          if (!dx && !dy) continue
          tx.update(m.el.id, { x: m.x, y: m.y })
          const label = items.labelOf(m.el, (id) => canvas.get(id))
          if (label) tx.update(label.id, { x: label.x + dx, y: label.y + dy })
          moved++
        }
      })
      rememberScores(canvas, shown, [axes[0].name, axes[1].name])
      const bounds = unionRects([
        ...noteMoves.map((m) => ({ x: m.x, y: m.y, w: m.el.width, h: m.el.height })),
        ...(built
          ? [{ x: built.frame.x, y: built.frame.y, w: built.frame.width, h: built.frame.height }]
          : []),
      ])
      bringIntoView(canvas, bounds ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } : null)
      return {
        moved,
        ok: true,
        text: `${title}: ${plural(moved, 'note')} placed. Ctrl+Z undoes it.`,
      }
    },
  }
}
