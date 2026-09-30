// The menu list canvas-ux's context menu and board menu render (docs/EXCALIDRAW-CONTRACTS.md §3 `contextMenu`,
// `mainMenu`): every feature's MenuEntrySpec, resolved for the context and the target, grouped in
// MENU_GROUPS order with a separator between non-empty groups. An entry that names a command shows the
// command's label and first key and runs it (its `enabled` and read-only rules decide `disabled`).
//
// Keyboard (WAI-ARIA menu): ArrowUp/ArrowDown move, Home/End jump, Enter/Space choose, ArrowRight (or
// Enter) opens a submenu, ArrowLeft/Escape close it, Escape closes the menu; a press outside closes it.
// Test ids keep the tldraw page's: `<prefix>.<entry id>`, `<prefix>-sub.<id>-button` / `-content`.
//
// Export control: while exporting is off for this person, the `export` group and the clipboard's copy
// entries give way to one line saying so (./export-gate.ts); choosing it repeats the reason.
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type {
  CanvasFeatureContext,
  CommandSource,
  MenuEntrySpec,
  MenuGroup,
  MenuTarget,
} from '../../../canvas/api/index.ts'
import { currentPlatform, formatChord, MENU_GROUPS } from '../../../canvas/api/index.ts'
import { CheckIcon, ChevronRightIcon } from './icons.tsx'

export interface MenuRow {
  readonly id: string
  readonly label: string
  readonly kbd?: string
  readonly disabled: boolean
  readonly checked?: boolean
  readonly run?: () => void | Promise<void>
  readonly submenu?: readonly (readonly MenuRow[])[]
  readonly custom?: ReactNode
}

/** Entries whose copying or exporting the export gate replaces (the clipboard's). */
export const EXPORTING_ENTRIES: ReadonlySet<string> = new Set(['copy', 'cut'])

/** Resolves one entry (null when it is not visible). */
export function resolveEntry(
  e: MenuEntrySpec,
  ctx: CanvasFeatureContext,
  target: MenuTarget,
  source: CommandSource,
): MenuRow | null {
  if (e.visible && !e.visible(ctx, target)) return null
  const cmd = e.command ? ctx.registries.commands.get(e.command) : undefined
  if (e.command && !cmd) return null
  const label = typeof e.label === 'function' ? e.label(ctx, target) : e.label || cmd?.label || e.id
  const kbd = e.kbdHint ?? cmd?.kbd?.[0]
  const cmdOff =
    !!cmd && ((ctx.canvas.readOnly() && !cmd.readOnlyAllowed) || (cmd.enabled ? !cmd.enabled(ctx) : false))
  const disabled = e.disabled ? e.disabled(ctx, target) : cmdOff
  if (e.submenu) {
    const rows = groupRows(e.submenu, ctx, target, source)
    if (!rows.length) return null
    return { id: e.id, label, disabled, submenu: rows }
  }
  if (e.component) {
    const C = e.component
    return { id: e.id, label, disabled, custom: <C ctx={ctx} target={target} /> }
  }
  const run = e.run ? () => e.run?.(ctx, target) : cmd ? () => cmd.run(ctx, source) : undefined
  return { id: e.id, label, ...(kbd ? { kbd } : {}), disabled, checked: e.checked?.(ctx, target), run }
}

/** Entries resolved and grouped (MENU_GROUPS order, then `order`, then id), empty groups left out. */
export function groupRows(
  entries: readonly MenuEntrySpec[],
  ctx: CanvasFeatureContext,
  target: MenuTarget,
  source: CommandSource,
  groups: readonly MenuGroup[] = MENU_GROUPS,
): MenuRow[][] {
  const out: MenuRow[][] = []
  for (const g of groups) {
    const rows = entries
      .filter((e) => e.group === g)
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => resolveEntry(e, ctx, target, source))
      .filter((r): r is MenuRow => r !== null)
    if (rows.length) out.push(rows)
  }
  return out
}

const items = (el: HTMLElement | null): HTMLElement[] =>
  el
    ? [
        ...el.querySelectorAll<HTMLElement>(
          ':scope > [role^="menuitem"], :scope > .cux-menu__subwrap > [role^="menuitem"]',
        ),
      ].filter((b) => b.getAttribute('aria-disabled') !== 'true')
    : []

function moveFocus(list: HTMLElement | null, key: string, from: Element | null) {
  const all = items(list)
  if (!all.length) return false
  const i = from ? all.indexOf(from as HTMLElement) : -1
  const next =
    key === 'ArrowDown'
      ? all[(i + 1) % all.length]
      : key === 'ArrowUp'
        ? all[(i - 1 + all.length) % all.length]
        : key === 'Home'
          ? all[0]
          : key === 'End'
            ? all[all.length - 1]
            : undefined
  if (!next) return false
  next.focus()
  return true
}

export interface MenuListProps {
  readonly rows: readonly (readonly MenuRow[])[]
  readonly prefix: string
  readonly label: string
  /** the list's own test id (the top list: `<prefix>`) */
  readonly testId?: string
  readonly autoFocus: 'first' | 'list' | 'none'
  /** a row ran (the whole menu closes) */
  onDone(): void
  /** Escape on this list (a submenu closes itself; the top list closes the menu) */
  onEscape(): void
  /** ArrowLeft on a submenu */
  onBack?(): void
}

export function MenuList(props: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [focusSub, setFocusSub] = useState(false)
  useEffect(() => {
    if (props.autoFocus === 'first') {
      const first = items(ref.current)[0]
      first?.focus()
    } else if (props.autoFocus === 'list') ref.current?.focus()
  }, [props.autoFocus])
  const onKey = (e: ReactKeyboardEvent) => {
    const k = e.key
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      e.preventDefault()
      e.stopPropagation()
      moveFocus(ref.current, k, e.target as Element)
    } else if (k === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onEscape()
    } else if (k === 'ArrowLeft' && props.onBack) {
      e.preventDefault()
      e.stopPropagation()
      props.onBack()
    } else if (k === 'Tab') {
      e.preventDefault()
      props.onEscape()
    }
  }
  return (
    <div
      ref={ref}
      className="cux-menu__list"
      role="menu"
      aria-label={props.label}
      tabIndex={-1}
      data-testid={props.testId}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.rows.map((group, gi) => [
        gi > 0 ? <hr key={`sep-${group[0]?.id ?? gi}`} className="cux-menu__sep" /> : null,
        ...group.map((row) => (
          <MenuItem
            key={row.id}
            row={row}
            prefix={props.prefix}
            open={open === row.id}
            focusSub={focusSub}
            setOpen={(v, focus = false) => {
              setOpen(v ? row.id : null)
              setFocusSub(focus)
            }}
            onDone={props.onDone}
          />
        )),
      ])}
    </div>
  )
}

function MenuItem({
  row,
  prefix,
  open,
  focusSub,
  setOpen,
  onDone,
}: {
  row: MenuRow
  prefix: string
  open: boolean
  focusSub: boolean
  setOpen(open: boolean, focus?: boolean): void
  onDone(): void
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const platform = currentPlatform()
  if (row.custom) {
    return (
      <div className="cux-menu__custom" data-testid={`${prefix}.${row.id}`}>
        {row.custom}
      </div>
    )
  }
  if (row.submenu) {
    return (
      <div className="cux-menu__subwrap" onPointerLeave={() => setOpen(false)}>
        <button
          ref={btn}
          type="button"
          role="menuitem"
          className="cux-menu__item"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-disabled={row.disabled || undefined}
          data-testid={`${prefix}-sub.${row.id}-button`}
          onMouseDown={(e) => e.preventDefault()}
          onPointerEnter={() => setOpen(true)}
          onClick={() => setOpen(!open, true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              setOpen(true, true)
            }
          }}
        >
          <span className="cux-menu__label">{row.label}</span>
          <ChevronRightIcon />
        </button>
        {open && (
          <div className="cux-menu cux-menu--sub" data-testid={`${prefix}-sub.${row.id}-content`}>
            <MenuList
              rows={row.submenu}
              prefix={prefix}
              label={row.label}
              autoFocus={focusSub ? 'first' : 'none'}
              onDone={onDone}
              onEscape={() => {
                setOpen(false)
                btn.current?.focus()
              }}
              onBack={() => {
                setOpen(false)
                btn.current?.focus()
              }}
            />
          </div>
        )}
      </div>
    )
  }
  const content = (
    <>
      <span className="cux-menu__check" aria-hidden="true">
        {row.checked ? <CheckIcon /> : null}
      </span>
      <span className="cux-menu__label">{row.label}</span>
      {row.kbd && <kbd className="cux-menu__kbd">{formatChord(row.kbd, platform)}</kbd>}
    </>
  )
  const choose = () => {
    if (row.disabled || !row.run) return
    onDone()
    void row.run()
  }
  if (row.checked !== undefined) {
    return (
      <button
        type="button"
        role="menuitemcheckbox"
        className="cux-menu__item"
        aria-checked={row.checked}
        aria-disabled={row.disabled || undefined}
        data-testid={`${prefix}.${row.id}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={choose}
      >
        {content}
      </button>
    )
  }
  return (
    <button
      type="button"
      role="menuitem"
      className="cux-menu__item"
      aria-disabled={row.disabled || undefined}
      data-testid={`${prefix}.${row.id}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={choose}
    >
      {content}
    </button>
  )
}
