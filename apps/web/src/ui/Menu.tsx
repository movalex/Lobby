import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'

export interface MenuEntry<A extends string> {
  action: A
  label: string
  tone?: 'danger'
}

/**
 * A menu button (WAI-ARIA menu pattern): Enter/Space/ArrowDown open it on the first item, arrows,
 * Home/End move, Escape closes and returns focus to the button, Tab or an outside click closes.
 */
export function MenuButton<A extends string>({
  label,
  items,
  onSelect,
  children,
  className = 'dr-iconbtn',
  testId,
  align = 'end',
}: {
  /** Accessible name of the button, e.g. "Board options for Retro". */
  label: string
  items: readonly MenuEntry<A>[]
  onSelect(action: A): void
  children: ReactNode
  className?: string
  testId?: string
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    itemRefs.current[focusIndex]?.focus()
  }, [open, focusIndex])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  if (!items.length) return null

  const openAt = (i: number) => {
    setFocusIndex(i)
    setOpen(true)
  }
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const onMenuKey = (e: KeyboardEvent) => {
    const last = items.length - 1
    if (e.key === 'ArrowDown') setFocusIndex((i) => (i >= last ? 0 : i + 1))
    else if (e.key === 'ArrowUp') setFocusIndex((i) => (i <= 0 ? last : i - 1))
    else if (e.key === 'Home') setFocusIndex(0)
    else if (e.key === 'End') setFocusIndex(last)
    else if (e.key === 'Escape') close(true)
    else if (e.key === 'Tab') {
      setOpen(false)
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="dr-menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            openAt(0)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            openAt(items.length - 1)
          }
        }}
      >
        {children}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={`dr-menu dr-menu--${align}`}
          onKeyDown={onMenuKey}
        >
          {items.map((item, i) => (
            <button
              key={item.action}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              type="button"
              role="menuitem"
              tabIndex={i === focusIndex ? 0 : -1}
              className={`dr-menu__item${item.tone === 'danger' ? ' dr-menu__item--danger' : ''}`}
              data-action={item.action}
              onClick={() => {
                close(true)
                onSelect(item.action)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
