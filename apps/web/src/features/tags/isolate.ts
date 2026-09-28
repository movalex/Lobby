// Keeps pointer, wheel and key events inside our floating UI from reaching tldraw (and canvas-ux's
// selection bar, whose own handler cancels mousedown to keep the canvas focused). Native listeners in
// the bubble phase run before React's root listener, so React never sees these keydowns: `onKey` gets
// them instead (the same approach as canvas-ux's useIsland).

import { useEffect, useRef } from 'react'

export function useIsolated<T extends HTMLElement>(onKey?: (e: KeyboardEvent) => void) {
  const ref = useRef<T>(null)
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      keyRef.current?.(e)
    }
    el.addEventListener('keydown', key)
    el.addEventListener('keyup', stop)
    el.addEventListener('pointerdown', stop)
    el.addEventListener('mousedown', stop)
    el.addEventListener('wheel', stop, { passive: true })
    return () => {
      el.removeEventListener('keydown', key)
      el.removeEventListener('keyup', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('mousedown', stop)
      el.removeEventListener('wheel', stop)
    }
  }, [])
  return ref
}
