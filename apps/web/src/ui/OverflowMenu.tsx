import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * The top bar's "⋯" menu on narrow screens (PRI-02). Its content stays MOUNTED while the panel is
 * closed (hidden with `visibility`, never `display: none`), so controls that live in it keep working
 * the way they do in the full-width bar: a keyboard shortcut or tldraw menu entry that opens a
 * feature's dialog from inside the panel still shows that dialog (styles.css keeps a modal <dialog>
 * visible inside the hidden panel), a timer keeps ticking and chiming.
 *
 * Portaled to <body> (the top bar is a stacking context under tldraw's UI) and placed under the
 * button. Closes on an outside press, Escape, focus leaving it, or when a presentation starts.
 */
export function OverflowMenu({
  label,
  testId,
  children,
}: {
  /** Accessible name of the button and the panel, e.g. "More board controls". */
  label: string
  testId: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const panelId = useId()
  const [place, setPlace] = useState<CSSProperties>({})

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = button.current?.getBoundingClientRect()
      if (!r) return
      setPlace({
        top: Math.round(r.bottom + 6),
        right: Math.max(8, Math.round(window.innerWidth - r.right)),
      })
    }
    update()
    window.addEventListener('resize', update)
    // Into the panel: its first control (keyboard users land where they were going).
    panel.current?.querySelector<HTMLElement>('button, [href], input, select, [tabindex="0"]')?.focus()
    return () => window.removeEventListener('resize', update)
  }, [open])

  useEffect(() => {
    if (!open) return
    const inside = (n: Node | null) => !!n && (!!panel.current?.contains(n) || !!button.current?.contains(n))
    // A modal opened from inside the panel (an export dialog) owns Escape and the pointer until it closes.
    const modalOpen = () => !!panel.current?.querySelector('dialog[open]')
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target as Node) && !modalOpen()) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || modalOpen()) return
      if (!inside(document.activeElement) && document.activeElement !== document.body) return
      setOpen(false)
      button.current?.focus()
    }
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null
      if (to && !inside(to) && !modalOpen()) setOpen(false)
    }
    // Presenting covers the whole board: the menu must not float over the slides.
    const html = document.documentElement
    const watch = new MutationObserver(() => {
      if (html.hasAttribute('data-dr-presenting')) setOpen(false)
    })
    watch.observe(html, { attributes: true, attributeFilter: ['data-dr-presenting'] })
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    const p = panel.current
    p?.addEventListener('focusout', onFocusOut)
    return () => {
      watch.disconnect()
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      p?.removeEventListener('focusout', onFocusOut)
    }
  }, [open])

  return (
    <>
      <button
        ref={button}
        type="button"
        className="dr-iconbtn dr-overflow__button"
        data-testid={testId}
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="5" cy="12" r="1.9" fill="currentColor" />
          <circle cx="12" cy="12" r="1.9" fill="currentColor" />
          <circle cx="19" cy="12" r="1.9" fill="currentColor" />
        </svg>
      </button>
      {createPortal(
        <section
          ref={panel}
          id={panelId}
          className="dr-overflow"
          data-open={open ? 'true' : 'false'}
          data-testid={`${testId}-panel`}
          aria-label={label}
          style={place}
        >
          {children}
        </section>,
        document.body,
      )}
    </>
  )
}
