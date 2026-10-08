// zod's CSP setting (jitless) is index.html's classic head script public/zod-jitless.js: it must run before
// the shared chunk that holds zod and the api's schemas, which an import here would not achieve.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

// ---- K5-2: the soft keyboard ---------------------------------------------------------------------------
//
// index.html asks for `interactive-widget=resizes-content`: where the browser honours it (Chrome on Android),
// the keyboard shrinks the layout viewport, so the board, its sheets and the comment popover already end
// above it. Where it does not (Safari on iPhone and iPad), the keyboard covers the bottom of the layout
// viewport and only the visual viewport shrinks. `--dr-kb-inset` on <html> is how far the visual viewport
// ends above the layout viewport's bottom: the part a `position: fixed; bottom: 0` sheet loses behind the
// keyboard. styles.css and comments.css lift the phone sheets and the docked comment popover by it.
// `data-dr-kb` is on <html> while it is more than 0.
//
// A page the person zoomed in (pinch, scale above 1) also has a visual viewport smaller than the layout one;
// that is not a keyboard, so the inset stays 0 then.

/** The keyboard inset in CSS px: never below 0, 0 while the page is zoomed in. */
export function keyboardInset(
  innerHeight: number,
  viewportHeight: number,
  offsetTop: number,
  scale = 1,
): number {
  if (!Number.isFinite(innerHeight) || !Number.isFinite(viewportHeight) || !Number.isFinite(offsetTop))
    return 0
  if (scale > 1.01) return 0
  return Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop))
}

/** The part of `window` the keyboard listener reads (a stub in main.test.ts). */
export interface KeyboardWindow {
  readonly innerHeight: number
  readonly visualViewport?: Pick<
    VisualViewport,
    'height' | 'offsetTop' | 'scale' | 'addEventListener' | 'removeEventListener'
  > | null
  readonly document: { readonly documentElement: Pick<HTMLElement, 'style' | 'toggleAttribute'> }
  addEventListener(type: 'resize', listener: () => void): void
  removeEventListener(type: 'resize', listener: () => void): void
}

/** Keeps `--dr-kb-inset` (and `data-dr-kb`) on <html> current; returns the uninstaller. */
export function installKeyboardInset(win: KeyboardWindow): () => void {
  const vv = win.visualViewport
  if (!vv) return () => {}
  const root = win.document.documentElement
  let last: number | null = null
  const update = () => {
    const inset = keyboardInset(win.innerHeight, vv.height, vv.offsetTop, vv.scale)
    if (inset === last) return
    last = inset
    root.style.setProperty('--dr-kb-inset', `${inset}px`)
    root.toggleAttribute('data-dr-kb', inset > 0)
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  win.addEventListener('resize', update)
  update()
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    win.removeEventListener('resize', update)
  }
}

// The app itself (a test imports this module in Node, where there is no document: nothing mounts there).
if (typeof document !== 'undefined') {
  const el = document.getElementById('root')
  if (!el) throw new Error('#root missing')
  installKeyboardInset(window)
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
