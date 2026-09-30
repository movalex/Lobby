// RETRO-14 on the Excalidraw canvas: Enter with one unlocked frame selected (./keys.ts), or a double-click on
// its name (./canvas-events.ts), opens a name field over the frame's heading. Enter or leaving the field
// keeps the name, Escape keeps the old one. A frame's name has no lease (docs/EXCALIDRAW-CONTRACTS.md §2.1
// `text.edit`: "a frame's name is `meta`, renamed with `tx.update(id, {name})` from Lobby's input"), so the
// rename is one plain write, one undo step. Renaming replaces the name (the field opens with it selected).
import { useEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { uxState } from './state.ts'

/** Excalidraw draws a frame's name 14 px high, just above the frame (FRAME_STYLE nameFontSize, nameOffsetY). */
export const FRAME_NAME_PX = 14
export const FRAME_NAME_BAND_PX = 24

export function FrameRename({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const id = useValue(state.renamingFrame)
  const at = useValue('cux-frame-rename-at', () => {
    const fid = state.renamingFrame.get()
    const f = fid ? canvas.get(fid) : undefined
    if (f?.type !== 'frame') return null
    const p = canvas.sceneToOverlay({ x: f.x, y: f.y })
    const z = canvas.viewport.get().zoom
    return { x: p.x, y: p.y, width: Math.max(120, f.width * z) }
  }, [canvas, state])
  const frame = id ? canvas.get(id) : undefined
  const initial = String((frame as { name?: string | null } | undefined)?.name ?? '')
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    if (!id) return
    done.current = false
    setValue(initial)
    const el = input.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
    // a frame name is set once: re-open only for another frame
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!id || !at || frame?.type !== 'frame') return null
  const finish = (keep: boolean) => {
    if (done.current) return
    done.current = true
    state.renamingFrame.set(null)
    const name = value.trim()
    const f = canvas.get(id)
    if (keep && f && !canvas.readOnly() && name !== String((f as { name?: string | null }).name ?? ''))
      canvas.transact('rename frame', (tx) => tx.update(id, { name: name || null }))
    canvas.focus({ preventScroll: true })
  }
  return (
    <input
      ref={input}
      className="cux-frame-rename"
      data-testid="frame-rename"
      data-frame-id={id}
      aria-label="Frame name"
      value={value}
      style={{ left: at.x, top: at.y - FRAME_NAME_BAND_PX, width: at.width }}
      onChange={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}
