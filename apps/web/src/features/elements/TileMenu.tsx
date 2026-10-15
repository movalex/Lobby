// OWNER: WS3 (wave Q). A tile's actions (a right-click, the context-menu key or Shift+F10 on the active tile): a small
// menu at the pointer or under the tile (WAI-ARIA menu: it takes the keyboard on its first item, the arrows, Home and End
// move, Enter runs, Escape or a click elsewhere closes it and gives the keyboard back to where it was). It is drawn in
// the page's body, so the dock's own stacking never puts the board's canvas over it.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface TileMenuItem {
  readonly id: string
  readonly label: string
  readonly tone?: 'danger'
  run(): void
}

export function TileMenu({
  label,
  at,
  items,
  onClose,
}: {
  label: string
  at: { x: number; y: number }
  items: readonly TileMenuItem[]
  onClose(refocus: boolean): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [focus, setFocus] = useState(0)
  const [pos, setPos] = useState(at)

  useEffect(() => {
    buttons.current[focus]?.focus({ preventScroll: true })
  }, [focus])
  // kept on screen
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))
    const y = Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))
    if (x !== at.x || y !== at.y) setPos({ x, y })
  }, [at])
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose(false)
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [onClose])

  const last = items.length - 1
  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="dr-menu dr-el-menu"
      style={{ position: 'fixed', left: pos.x, top: pos.y }}
      data-testid="element-menu"
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') setFocus((i) => (i >= last ? 0 : i + 1))
        else if (e.key === 'ArrowUp') setFocus((i) => (i <= 0 ? last : i - 1))
        else if (e.key === 'Home') setFocus(0)
        else if (e.key === 'End') setFocus(last)
        else if (e.key === 'Escape') onClose(true)
        else if (e.key === 'Tab') onClose(true)
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          ref={(el) => {
            buttons.current[i] = el
          }}
          type="button"
          role="menuitem"
          tabIndex={i === focus ? 0 : -1}
          className={`dr-menu__item${item.tone === 'danger' ? ' dr-menu__item--danger' : ''}`}
          data-action={item.id}
          onClick={() => {
            onClose(true)
            item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}
