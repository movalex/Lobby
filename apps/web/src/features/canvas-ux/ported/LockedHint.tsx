// F8 on the Excalidraw canvas (the tldraw page's ../locked-hint-runtime.ts and LockedHintBar, LockedFrameBadges
// in ../Overlay.tsx): a press (select tool, editable board) on an element that is locked, or inside a
// locked frame, shows why nothing happens next to it and offers to unlock it (the engine ignores locked
// elements for selection, so the click or drag otherwise just does nothing). The next press elsewhere,
// Escape or a few seconds dismiss it. Locked frames show a lock before their name.
//
// Locking a frame locks what is inside it (./commands.ts, as Excalidraw's own lock does), so an element
// in a locked frame names the frame, and "Unlock frame" unlocks it with its contents.
import { useEffect, useRef } from 'react'
import type { CanvasElement, CanvasFeatureContext, CanvasInputEvent } from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { LockIcon } from '../icons.tsx'
import { type LockChainLike, lockedHintMessage, lockSource, unlockLabel } from '../locked-hint.ts'
import { lockTargets } from './commands.ts'
import { type LockedHint, uxState } from './state.ts'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** How long the hint stays up without another press. */
export const LOCKED_HINT_MS = 6000

let hintSeq = 0

/** The lock chain of `el` (itself, then its frame), as ../locked-hint.ts reads it. */
export function chainOf(ctx: CanvasFeatureContext, el: CanvasElement): LockChainLike[] {
  const get = (id: string) => ctx.canvas.get(id)
  const self = items.containerOf(el, get)
  const frame = self.frameId ? get(self.frameId) : undefined
  const link = (e: CanvasElement): LockChainLike => ({
    id: e.id,
    type: e.type === 'stickynote' ? 'note' : e.type,
    isLocked: ctx.canvas.isLocked(e.id),
    name: e.type === 'frame' ? String((e as { name?: string | null }).name ?? '') : undefined,
  })
  const chain = [link(self)]
  if (frame) chain.push(link(frame))
  return chain
}

/** The hint for a press on `hit`, or null when nothing locked is there. */
export function hintFor(
  ctx: CanvasFeatureContext,
  hit: CanvasElement,
  point: { x: number; y: number },
): LockedHint | null {
  const chain = chainOf(ctx, hit)
  const self = chain[0]
  // a locked frame explains its contents (its lock locked them), else the element's own lock
  const frame = chain[1]
  const source = frame?.isLocked ? frame : lockSource(chain)
  if (!self || !source) return null
  return {
    id: ++hintSeq,
    sourceId: source.id,
    message: lockedHintMessage(self, source, IS_MAC),
    unlockLabel: unlockLabel(source),
    point: { x: point.x, y: point.y },
  }
}

/** Wires the hint to the board's input stream. Returns the cleanup. */
export function installLockedHint(ctx: CanvasFeatureContext): () => void {
  const { canvas } = ctx
  const hint = uxState(canvas).lockedHint
  const clear = () => {
    if (hint.get()) hint.set(null)
  }
  const off = canvas.on('input', (e: CanvasInputEvent) => {
    if (e.type === 'key-down') {
      if (e.key === 'Escape') clear()
      return
    }
    if (e.type !== 'pointer-down') return
    if (e.button !== 0 || canvas.readOnly() || canvas.tool() !== 'select') return clear()
    const hit = canvas.hitTest(e.scene, { hitInside: true })
    if (!hit) return clear()
    const root = items.containerOf(hit, (x) => canvas.get(x))
    const frame = root.frameId ? canvas.get(root.frameId) : undefined
    if (!canvas.isLocked(root.id) && !(frame && canvas.isLocked(frame.id))) return clear()
    const next = hintFor(ctx, hit, e.scene)
    if (next) hint.set(next)
    else clear()
  })
  return () => {
    off()
    hint.set(null)
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

export function LockedHintBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const hint = useValue(state.lockedHint)
  const readOnly = useValue('cux-readonly', () => canvas.readOnly(), [canvas])
  const pos = useValue('cux-locked-hint-pos', () => {
    const h = state.lockedHint.get()
    if (!h) return null
    const v = canvas.sceneToOverlay(h.point)
    const vp = canvas.viewport.screenRect()
    const y = v.y - 52 < 60 ? v.y + 28 : v.y - 52
    return {
      x: clamp(v.x, 180, Math.max(180, vp.width - 180)),
      y: clamp(y, 60, Math.max(60, vp.height - 100)),
    }
  }, [canvas, state])
  const ref = useRef<HTMLDivElement>(null)
  const id = hint?.id
  useEffect(() => {
    if (id === undefined) return
    const t = setTimeout(() => {
      if (state.lockedHint.get()?.id === id) state.lockedHint.set(null)
    }, LOCKED_HINT_MS)
    return () => clearTimeout(t)
  }, [id, state])
  if (!hint || !pos) return null
  const dismiss = () => state.lockedHint.set(null)
  return (
    <div
      ref={ref}
      className="dr-cux-selbar dr-cux-lockhint"
      role="status"
      data-testid="locked-hint"
      data-source-id={hint.sourceId}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          dismiss()
          canvas.focus({ preventScroll: true })
        }
      }}
    >
      <span className="dr-cux-lockhint__icon" aria-hidden="true">
        <LockIcon />
      </span>
      <span className="dr-cux-lockhint__text">{hint.message}</span>
      {!readOnly && (
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="locked-hint-unlock"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const source = canvas.get(hint.sourceId)
            dismiss()
            if (!source || !canvas.isLocked(source.id)) return
            const targets = lockTargets(canvas, [source])
            canvas.transact('unlock', (tx) => {
              for (const t of targets) if (canvas.get(t)?.locked) tx.update(t, { locked: false })
            })
          }}
        >
          {hint.unlockLabel}
        </button>
      )}
      <button
        type="button"
        className="dr-iconbtn dr-iconbtn--sm"
        aria-label="Dismiss"
        data-testid="locked-hint-dismiss"
        onMouseDown={(e) => e.preventDefault()}
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  )
}

/** A lock before the name of each locked frame (moves with the camera). */
export function LockedFrameBadges({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const badges = useValue(
    'cux-locked-frames',
    () =>
      canvas
        .items()
        .filter((e) => e.type === 'frame' && e.locked && !(e as { isDeleted?: boolean }).isDeleted)
        .map((f) => ({ id: f.id, at: canvas.sceneToOverlay({ x: f.x, y: f.y }) })),
    [canvas],
  )
  if (!badges.length) return null
  return (
    <div data-testid="locked-frame-badges" data-count={badges.length}>
      {badges.map((b) => (
        <span
          key={b.id}
          className="cux-frame-lock"
          data-testid="locked-frame-badge"
          data-frame-id={b.id}
          style={{ left: b.at.x - 16, top: b.at.y - 18 }}
          aria-hidden="true"
        >
          <LockIcon />
        </span>
      ))}
    </div>
  )
}
