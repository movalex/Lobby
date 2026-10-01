// The Excalidraw board page's save indicator state (./engineSave.ts), with the display rules the tldraw
// page had: "Saving…" is never delayed on the way in, and once shown it stays at least
// `minVisibleMs` and `settleMs` after the last change was acknowledged, so a burst of edits does not
// flicker. Leaving the page while only this tab holds the changes (a guest's memory queue, an upload in
// flight) asks first. No tldraw, no engine.

import { useEffect, useRef, useState } from 'react'
import { type EngineSaveInput, engineDisplayState, engineSaveView, engineUnloadRisk } from './engineSave.ts'
import type { SaveStatusView } from './SaveStatus.tsx'
import type { DisplayState } from './save-state.ts'

export interface EngineSaveOptions {
  settleMs?: number
  minVisibleMs?: number
}

export function useEngineSaveStatus(
  input: EngineSaveInput,
  { settleMs = 250, minVisibleMs = 500 }: EngineSaveOptions = {},
): { state: DisplayState; view: SaveStatusView } {
  const state = engineDisplayState(input)
  const [held, setHeld] = useState(false)
  const since = useRef<number | null>(null)
  useEffect(() => {
    if (state === 'saving') {
      since.current ??= performance.now()
      setHeld(true)
      return
    }
    if (!held) return
    if (state !== 'saved' && state !== 'readonly') {
      since.current = null
      setHeld(false)
      return
    }
    const shown = performance.now() - (since.current ?? 0)
    const t = setTimeout(
      () => {
        since.current = null
        setHeld(false)
      },
      Math.max(settleMs, minVisibleMs - shown),
    )
    return () => clearTimeout(t)
  }, [state, held, settleMs, minVisibleMs])

  const unsafe = engineUnloadRisk(input)
  useEffect(() => {
    if (!unsafe) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', onBeforeUnload)
    return () => removeEventListener('beforeunload', onBeforeUnload)
  }, [unsafe])

  const shown: DisplayState = held && (state === 'saved' || state === 'readonly') ? 'saving' : state
  return { state: shown, view: engineSaveView(input, shown) }
}
