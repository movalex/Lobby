import { useEffect, useState } from 'react'

/**
 * The present-export feature marks a running presentation with this attribute on <html> (see
 * features/present-export/present-session.ts PRESENTING_ATTR); it hides the top bar and the notices.
 */
const PRESENTING_ATTR = 'data-dr-presenting'

export function isPresentingNow(): boolean {
  if (typeof document === 'undefined') return false
  if (document.documentElement.hasAttribute(PRESENTING_ATTR)) return true
  // Full screen without the top bar (e.g. the browser's own full screen on the canvas).
  const fs = document.fullscreenElement
  const pill = document.querySelector('[data-testid="timer-pill"]')
  return !!fs && !(pill && fs.contains(pill))
}

/** Whether the board is being presented (top bar hidden), kept current with the DOM. */
export function usePresenting(): boolean {
  const [presenting, setPresenting] = useState(isPresentingNow)
  useEffect(() => {
    const update = () => setPresenting(isPresentingNow())
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [PRESENTING_ATTR] })
    document.addEventListener('fullscreenchange', update)
    update()
    return () => {
      mo.disconnect()
      document.removeEventListener('fullscreenchange', update)
    }
  }, [])
  return presenting
}
