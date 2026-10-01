// A11Y-04: ArrowLeft/Right (and Up/Down), Home and End move the focus along a toolbar's own buttons (ARIA
// toolbar), or a menu's (the toolbar's More popover, W5-22). Keys typed into a field inside the bar (a
// popover's input) are left alone. The same rule as the tldraw page's selection bar (../Overlay.tsx
// moveInToolbar).
export function moveInToolbar(e: KeyboardEvent, bar: HTMLElement | null) {
  if (!bar || e.altKey || e.ctrlKey || e.metaKey) return
  const target = e.target
  if (!(target instanceof HTMLButtonElement) || !bar.contains(target)) return
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(
    (b) => b.closest('[role="toolbar"], [role="menu"]') === bar,
  )
  const i = buttons.indexOf(target)
  if (i < 0) return
  const next =
    e.key === 'ArrowRight' || e.key === 'ArrowDown'
      ? buttons[(i + 1) % buttons.length]
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? buttons[(i - 1 + buttons.length) % buttons.length]
        : e.key === 'Home'
          ? buttons[0]
          : e.key === 'End'
            ? buttons[buttons.length - 1]
            : undefined
  if (!next) return
  e.preventDefault()
  next.focus()
}

/** A bar's own buttons (not those of a popover or a menu one of its items opens inside it). */
export function ownButtons(bar: HTMLElement): HTMLButtonElement[] {
  return [...bar.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.closest('[role="toolbar"], [role="menu"], [role="dialog"], [role="listbox"]') === bar,
  )
}

/**
 * W5-42: a bar is one Tab stop (a roving tab index over its own buttons: the one with the keyboard, else the
 * first that is enabled). Run after every render (`useLayoutEffect` without deps) and on focus.
 */
export function rove(bar: HTMLElement | null, focused?: EventTarget | null): void {
  if (!bar) return
  const own = ownButtons(bar)
  const active = (focused ?? bar.ownerDocument.activeElement) as HTMLButtonElement | null
  const stop = (active && own.includes(active) ? active : null) ?? own.find((b) => !b.disabled)
  for (const b of own) b.tabIndex = b === stop ? 0 : -1
}
