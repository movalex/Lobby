// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2). The face of every visible doc card: its Markdown-lite
// words drawn formatted (./DocBlocks.tsx) over the card, in scene units scaled with the zoom, like the file cards' faces
// (file-card/ported/CardLayer.tsx). The canvas under it still draws the label's plain words (what an old tab, an
// export and a thumbnail show): the face covers them with the card's own fill.
//
//  - Only cards in view, not hidden, read at a readable size (below MIN_SCREEN_FONT_PX on screen the canvas's own words
//    are what shows), and not open in the in-place editor (the editor shows the words while someone types there).
//  - Opaque elements painted above a card cut a hole in its face (file-card/ported/occluders.ts), so they stay seen.
//  - The layer takes no pointer events: a click, a drag, a selection go to the canvas. The links, the checklist boxes
//    (editors only) and the Open button take theirs (.dr-interactive). Their keyboard way in is the panel.
//  - What does not fit the card is cut with a fade and an Open button (the panel shows it all).
//  - In the dark theme the face takes the canvas's own filter, so it looks exactly as the card does.
import { isAllowedColor } from '@draftroom/canvas-schema/limits'
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { type Box, Occluders } from '../../file-card/ported/occluders.ts'
import { useValue } from '../../lib/signals.ts'
import { DocBlocks } from './DocBlocks.tsx'
import { docTitle } from './markdown-lite.ts'
import { DOC_CARD_KIND, DOC_FILL, DOC_PAD, docLabel, docWords } from './model.ts'
import { docCardsOn, docState, openDocPanel, parsedWords, toggleDocCheck } from './state.ts'
import './doc-cards.css'

/** Below this many screen px of font, the face steps aside (the canvas draws the words, unreadable either way). */
export const MIN_SCREEN_FONT_PX = 5
/** Excalidraw's dark theme filter (the canvas's): the face looks as the card does in either theme. */
export const DARK_FILTER = 'invert(93%) hue-rotate(180deg)'

const FONT_FAMILIES: Readonly<Record<number, string>> = {
  1: 'Virgil',
  2: 'Helvetica',
  3: 'Cascadia',
  5: 'Excalifont',
  6: 'Nunito',
  7: 'Lilita One',
  8: 'Comic Shanns',
}

export interface FaceEntry {
  readonly id: string
  readonly box: Box
  readonly angle: number
  readonly words: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly fontFamily: number
  readonly ink: string
  readonly fill: string
  readonly holes: readonly Box[]
  readonly radius: number
}

const colorOr = (c: unknown, fallback: string) =>
  typeof c === 'string' && c !== 'transparent' && isAllowedColor(c) ? c : fallback

/** The faces to draw now (reactive: the cards, the camera, the editor, hidden ids). */
export function facesOf(canvas: LobbyCanvas): FaceEntry[] {
  const cards = canvas.index.byKind(DOC_CARD_KIND)
  if (!cards.length) return []
  const vp = canvas.viewport.get()
  const editing = canvas.editingId()
  const margin = 200 / (vp.zoom || 1)
  let grid: Occluders | null = null
  let place: Map<string, number> | null = null
  const out: FaceEntry[] = []
  for (const el of cards) {
    if (el.type !== 'rectangle' || el.isDeleted || canvas.isHidden(el.id) || editing === el.id) continue
    const label = docLabel(canvas, el)
    const fontSize = Number((label as { fontSize?: unknown } | null)?.fontSize ?? 16) || 16
    if (fontSize * vp.zoom < MIN_SCREEN_FONT_PX) continue
    const box = { x: el.x, y: el.y, w: el.width, h: el.height }
    if (
      box.x > vp.x + vp.width + margin ||
      box.y > vp.y + vp.height + margin ||
      box.x + box.w < vp.x - margin ||
      box.y + box.h < vp.y - margin
    )
      continue
    let holes: readonly Box[] = []
    if (!el.angle) {
      if (!grid) {
        const all = canvas.items()
        grid = new Occluders(all, (id) => canvas.isHidden(id))
        place = new Map(all.map((e, i) => [e.id, i]))
      }
      holes = grid.holesAbove(place?.get(el.id) ?? 0, box)
    }
    const roundness = (el as { roundness?: { type?: number; value?: number } | null }).roundness
    out.push({
      id: el.id,
      box,
      angle: el.angle ?? 0,
      words: docWords(canvas, el),
      fontSize,
      lineHeight: Number((label as { lineHeight?: unknown } | null)?.lineHeight ?? 1.25) || 1.25,
      fontFamily: Number((label as { fontFamily?: unknown } | null)?.fontFamily ?? 6) || 6,
      ink: colorOr((label as { strokeColor?: unknown } | null)?.strokeColor, '#1b2330'),
      fill: colorOr((el as { backgroundColor?: unknown }).backgroundColor, DOC_FILL),
      holes,
      radius: roundness ? (roundness.value ?? 8) : 0,
    })
  }
  return out
}

const clipPath = (e: FaceEntry): string | undefined => {
  if (!e.holes.length) return undefined
  const r = (b: Box) => `M${b.x} ${b.y}H${b.x + b.w}V${b.y + b.h}H${b.x}Z`
  // the holes are in the card's own units already (occluders.ts holeOf)
  return `path(evenodd, "${r({ x: 0, y: 0, w: e.box.w, h: e.box.h })} ${e.holes.map(r).join(' ')}")`
}

/** The scene layer of the doc cards (the feature's overlay `doc-cards.faces`). */
export function DocFaceLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const canvas = ctx.canvas
  const on = useValue('doc-faces-on', () => docCardsOn(), [])
  const entries = useValue('doc-faces', () => (on ? facesOf(canvas) : []), [canvas, on])
  const zoom = useValue('doc-faces-zoom', () => canvas.viewport.get().zoom, [canvas])
  useValue('doc-faces-view', () => canvas.viewport.get(), [canvas])
  const dark = useValue('doc-faces-theme', () => canvas.theme() === 'dark', [canvas])
  const readOnly = useValue('doc-faces-ro', () => canvas.readOnly(), [canvas])
  const selected = useValue('doc-faces-sel', () => canvas.selection.join(' '), [canvas])
  if (!entries.length) return null
  const picked = new Set(selected ? selected.split(' ') : [])
  return (
    <>
      {entries.map((e) => {
        const c = canvas.sceneToOverlay({ x: e.box.x + e.box.w / 2, y: e.box.y + e.box.h / 2 })
        const style = {
          position: 'absolute' as const,
          left: c.x - e.box.w / 2,
          top: c.y - e.box.h / 2,
          width: e.box.w,
          height: e.box.h,
          transform: `scale(${zoom})${e.angle ? ` rotate(${e.angle}rad)` : ''}`,
          transformOrigin: 'center',
          clipPath: clipPath(e),
          borderRadius: e.radius,
          background: e.fill,
          color: e.ink,
          filter: dark ? DARK_FILTER : undefined,
          fontFamily: `${FONT_FAMILIES[e.fontFamily] ?? 'Nunito'}, var(--dr-font, system-ui), sans-serif`,
          fontSize: e.fontSize,
          lineHeight: e.lineHeight,
          ['--lobby-doc-pad' as string]: `${DOC_PAD}px`,
          ['--lobby-doc-fill' as string]: e.fill,
        } as CSSProperties
        return (
          <DocFace
            key={e.id}
            ctx={ctx}
            entry={e}
            style={style}
            canTick={!readOnly}
            selected={picked.has(e.id)}
          />
        )
      })}
    </>
  )
}

function DocFace({
  ctx,
  entry,
  style,
  canTick,
  selected,
}: {
  ctx: CanvasFeatureContext
  entry: FaceEntry
  style: CSSProperties
  canTick: boolean
  selected: boolean
}) {
  const doc = parsedWords(entry.words)
  const body = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  // what does not fit is cut: measured in the face's own (unscaled) units after every change of the words or size
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    setOverflow(el.scrollHeight > el.clientHeight + 1)
  }, [entry.words, entry.box.w, entry.box.h, entry.fontSize])
  // the words' nodes are made again only when the words change (the layer re-renders on every camera move)
  const title = useMemo(() => docTitle(entry.words) || 'Untitled doc', [entry.words])
  const onToggle = useMemo(
    () => (canTick ? (line: number) => void toggleDocCheck(ctx, entry.id, line) : null),
    [canTick, ctx, entry.id],
  )
  const panelOn = useValue('doc-face-panel', () => docState(ctx.canvas).target.get() === entry.id, [
    ctx,
    entry.id,
  ])
  return (
    <article
      className="lobby-doc"
      data-testid="doc-card-face"
      data-lobby-doc-card={entry.id}
      data-overflow={overflow || undefined}
      data-open={panelOn || undefined}
      aria-label={`Doc card: ${title}`}
      style={style}
    >
      <div ref={body} className="lobby-doc__body">
        <DocBlocks doc={doc} mode="face" onToggle={onToggle} />
      </div>
      {overflow && <div className="lobby-doc__fade" aria-hidden="true" />}
      {(overflow || selected) && !panelOn && (
        <button
          type="button"
          className="lobby-doc__open dr-interactive"
          data-testid="doc-card-open"
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => openDocPanel(ctx, entry.id, { edit: false })}
        >
          Open
        </button>
      )}
    </article>
  )
}
