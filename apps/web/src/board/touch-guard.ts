// F18 (round-2 demo walk): on a phone every tap on the canvas logged "Unable to preventDefault inside
// passive event listener invocation." as a console error.
//
// Cause (tldraw 5.4.2, verified in node_modules): the canvas takes touchstart through React's
// `onTouchStart` (@tldraw/editor useCanvasEvents), which marks the event handled and calls
// preventDefault. React 17+ attaches its root touchstart listener as passive, so the browser ignores
// that call and logs the error instead: the preventDefault has never had an effect. Taps, selection
// and pinch zoom run on pointer events and `touch-action: none`; tldraw's own non-passive touchstart
// listeners (useDocumentEvents edge swipes, useGestureEvents pinch) do not check the handled flag.
//
// So the touchstart is marked handled one step earlier, on the editor's container (which the event
// reaches before React's root listener): tldraw's canvas handler then returns at its "already
// handled" check, exactly as tldraw's own InFrontOfTheCanvas wrapper does with touchstart. Nothing
// changes but the console.
//
// Not covered, on purpose: a tap on a tldraw toolbar tool button logs the same message once
// (TldrawUiMenuItem's onTouchStart calls preventDefault, then selects the tool; the click that follows
// selects it again, which is harmless). That handler has no "already handled" check, so silencing it
// would mean overriding preventDefault on tldraw's own events; it belongs upstream.

import type { Editor } from 'tldraw'

export function installTouchStartGuard(editor: Editor): () => void {
  const container = editor.getContainer()
  const onTouchStart = (e: TouchEvent) => {
    const target = e.target
    if (target instanceof Element && target.closest('.tl-canvas')) editor.markEventAsHandled(e)
  }
  container.addEventListener('touchstart', onTouchStart, { passive: true })
  return () => container.removeEventListener('touchstart', onTouchStart)
}
