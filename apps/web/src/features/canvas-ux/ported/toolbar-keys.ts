// A11Y-04: ArrowLeft/Right (and Up/Down), Home and End move the focus along a toolbar's own buttons (ARIA
// toolbar). Keys typed into a field inside the bar (a popover's input) are left alone. The same rule as the
// tldraw page's selection bar (../Overlay.tsx moveInToolbar).
export function moveInToolbar(e: KeyboardEvent, bar: HTMLElement | null) {
  if (!bar || e.altKey || e.ctrlKey || e.metaKey) return
  const target = e.target
  if (!(target instanceof HTMLButtonElement) || !bar.contains(target)) return
  const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(
    (b) => b.closest('[role="toolbar"]') === bar,
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
