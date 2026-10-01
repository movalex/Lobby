// React glue for the features' overlays and slots: re-render on the port's events (document changes,
// selection, viewport), throttled to one render per animation frame.
import { useEffect, useState } from 'react'
import type { CanvasEventMap, CanvasPort } from '../../port.ts'

type PortEvent = Exclude<keyof CanvasEventMap, 'pointer'>

/** A counter that changes (once per frame at most) when any of `events` fires on `port`. */
export function usePortTick(port: CanvasPort, events: readonly PortEvent[]): number {
  const [tick, setTick] = useState(0)
  const key = events.join(',')
  useEffect(() => {
    let frame: number | null = null
    const bump = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        setTick((t) => t + 1)
      })
    }
    const offs = key.split(',').map((e) => port.on(e as PortEvent, bump as never))
    return () => {
      for (const off of offs) off()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [port, key])
  return tick
}

/** Re-renders when `subscribe` calls back (the runtime's toast, a feature store). */
export function useSubscription(subscribe: (l: () => void) => () => void): number {
  const [tick, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((t) => t + 1)), [subscribe])
  return tick
}

/** The viewport-clipped screen position of a scene point, or null when it is off screen (with a margin). */
export function onScreen(
  port: CanvasPort,
  x: number,
  y: number,
  margin = 40,
): { x: number; y: number } | null {
  const p = port.sceneToScreen({ x, y })
  const vw = typeof window === 'undefined' ? 10_000 : window.innerWidth
  const vh = typeof window === 'undefined' ? 10_000 : window.innerHeight
  if (p.x < -margin || p.y < -margin || p.x > vw + margin || p.y > vh + margin) return null
  return p
}
