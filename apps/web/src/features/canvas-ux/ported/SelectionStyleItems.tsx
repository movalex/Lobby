// Wave M (M1-4, UXD-09 full): the selection toolbar's tier one, drawn at the end of the selection bar's main row
// (./style-items.ts has the model and the writes). On a wide canvas each control is one button showing the
// selection's value (a colour dot, S/M/L/XL, an alignment); pressing it opens its options as a row under the bar (a
// "tray": one at a time, the bar wraps around it). On a compact bar (a phone, or a bar folded because it fit nowhere)
// one Style button opens every control's options at once. "More styles" opens the style panel itself: the phone's
// sheet, or on a wide canvas the panel already shown (pointed out; from the keyboard, the keyboard moves into it).
//
// Keys (no new claim: the bar's own A11Y-04 keys): Alt+F10 reaches the bar, arrows move along every button in it,
// the tray's included (the swatch row is reached by the arrow keys); a tray opened from the keyboard takes the
// keyboard, and Escape in it closes it and gives the keyboard back to its button.
import { type ReactNode, useContext, useEffect, useId, useRef } from 'react'
import type { CanvasFeatureContext, SelectionBarItemSpec } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { countUsage } from '../../../lib/usage.ts'
import { STYLE_PANEL_SELECTOR } from './obstacles.ts'
import { SelectionBarCompact } from './selection-bar-context.ts'
import { uxState } from './state.ts'
import {
  pickTier,
  SELECTION_TOOLBAR_TIER1,
  type TierControl,
  type TierOption,
  type TierRow,
  tierModel,
} from './style-items.ts'
import { THEME_FILTER } from './style-vocabulary.ts'
import { stylesFold } from './toolbar-layout.ts'

/** The compact bar's one tray: every control's options. */
export const ALL_STYLES_TRAY = 'all'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

const ALIGN_ICON: Readonly<Record<string, ReactNode>> = {
  left: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  center: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  right: <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
}
const WIDTH_PX: Readonly<Record<string, number>> = { s: 1, m: 2, l: 3.5, xl: 5.5 }
const DASH_ICON: Readonly<Record<string, ReactNode>> = {
  draw: <path d="M3 14c3-4 5 2 8-1s5-3 10 0" />,
  solid: <path d="M3 12h18" />,
  dashed: <path d="M3 12h4M10 12h4M17 12h4" />,
  dotted: <path d="M4 12h.01M8 12h.01M12 12h.01M16 12h.01M20 12h.01" strokeWidth="2.6" />,
}
const HEAD_ICON: Readonly<Record<string, ReactNode>> = {
  none: <path d="M4 12h16" />,
  arrow: (
    <>
      <path d="M4 12h12" />
      <path d="M14 7l5 5-5 5" />
    </>
  ),
  triangle: (
    <>
      <path d="M4 12h9" />
      <path d="M13 7l7 5-7 5z" fill="currentColor" />
    </>
  ),
  bar: <path d="M4 12h15M19 6v12" />,
  dot: (
    <>
      <path d="M4 12h10" />
      <circle cx="17" cy="12" r="3" fill="currentColor" />
    </>
  ),
  diamond: (
    <>
      <path d="M4 12h8" />
      <path d="M16 8l4 4-4 4-4-4z" fill="currentColor" />
    </>
  ),
}
const FILL_ICON: Readonly<Record<string, ReactNode>> = {
  none: <rect x="5" y="5" width="14" height="14" rx="2" />,
  semi: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" fillOpacity="0.15" />,
  solid: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" fillOpacity="0.55" />,
  pattern: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M5 12l7-7M5 19l14-14M12 19l7-7" />
    </>
  ),
}

/** A colour as the canvas draws it: the stored (light) colour, through Excalidraw's filter in dark mode. */
function Dot({ color, mixed, dark }: { color?: string | undefined; mixed?: boolean; dark: boolean }) {
  return (
    <span
      className="cux-selstyle__dot"
      data-mixed={mixed ? 'true' : undefined}
      aria-hidden="true"
      style={mixed || !color ? undefined : { background: color, filter: dark ? THEME_FILTER : undefined }}
    />
  )
}

/** What an option (or a control showing that option) looks like. */
function face(control: TierControl['id'], row: TierRow, o: TierOption | null, dark: boolean): ReactNode {
  const mixed = o === null
  switch (control) {
    case 'note-colour':
      return mixed ? (
        <Dot mixed dark={dark} />
      ) : (
        <span
          className="cux-selstyle__note"
          aria-hidden="true"
          style={{ background: o.color, color: o.ink, filter: dark ? THEME_FILTER : undefined }}
        >
          Aa
        </span>
      )
    case 'stroke-colour':
    case 'text-colour':
      return <Dot color={o?.color} mixed={mixed} dark={dark} />
    case 'font-size':
      return (
        <span className="cux-selstyle__text" aria-hidden="true">
          {mixed ? '–' : o.value.toUpperCase()}
        </span>
      )
    case 'text-align':
      return <Icon>{ALIGN_ICON[o?.value ?? 'center']}</Icon>
    case 'fill':
      return <Icon>{FILL_ICON[o?.value ?? 'semi']}</Icon>
    case 'stroke-width':
      return (
        <Icon>
          <path d="M4 12h16" strokeWidth={WIDTH_PX[o?.value ?? 'm']} />
        </Icon>
      )
    case 'stroke-style':
      return <Icon>{DASH_ICON[o?.value ?? 'solid']}</Icon>
    case 'opacity':
      return (
        <span className="cux-selstyle__text" aria-hidden="true">
          {mixed ? '–' : `${o.value}`}
        </span>
      )
    case 'arrowheads':
      return (
        <span style={row.id === 'start' ? { transform: 'scaleX(-1)', display: 'grid' } : { display: 'grid' }}>
          <Icon>{HEAD_ICON[o?.value ?? 'arrow']}</Icon>
        </span>
      )
  }
}

/** The option a row's value names (null: mixed or none of them). */
const chosen = (row: TierRow) => row.options.find((o) => o.value === row.value) ?? null

/** A control's button label with its value: "Note color: Butter", "Size: mixed". */
function controlLabel(c: TierControl): string {
  const values = c.rows.map((r) =>
    r.value === 'mixed' ? 'mixed' : (chosen(r)?.label ?? (r.value === null ? 'none' : r.value)),
  )
  return `${c.label}: ${values.join(', ')}`
}

function TrayRow({
  control,
  row,
  legend,
  dark,
  onPick,
}: {
  control: TierControl
  row: TierRow
  legend: boolean
  dark: boolean
  onPick(control: TierControl, row: TierRow, value: string): void
}) {
  return (
    <fieldset
      className="cux-selstyle__row"
      aria-label={row.legend}
      data-testid={`selection-style-row.${row.id}`}
    >
      {legend && (
        <span className="cux-selstyle__legend" aria-hidden="true">
          {row.legend}
          {row.value === 'mixed' ? ' (mixed)' : ''}
        </span>
      )}
      {row.options.map((o) => {
        const on = row.value === o.value
        return (
          <button
            key={o.value}
            type="button"
            className="dr-cux-selbar__btn cux-selstyle__opt"
            data-testid={`selection-style.${row.id}.${o.value}`}
            aria-pressed={on}
            aria-label={`${row.legend}: ${o.label}`}
            title={o.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(control, row, o.value)}
          >
            {face(control.id, row, o, dark)}
          </button>
        )
      })}
    </fieldset>
  )
}

/** "More styles": the style panel (the phone's sheet; on a wide canvas the panel shown, pointed out). */
function moreStyles(ctx: CanvasFeatureContext, fromKeyboard: boolean) {
  const { canvas } = ctx
  const state = uxState(canvas)
  countUsage('selectionbar.style:more-styles')
  state.selectionTray.set(null)
  state.stylePanelYield.set(false)
  const box = canvas.container()?.getBoundingClientRect()
  if (box && stylesFold({ width: box.width, height: box.height })) {
    state.moreOpen.set(false)
    state.stylesOpen.set(true)
    return
  }
  const doc = canvas.container()?.ownerDocument ?? document
  requestAnimationFrame(() => {
    const panel = doc.querySelector<HTMLElement>(STYLE_PANEL_SELECTOR)
    if (!panel) return
    panel.dataset.attention = 'true'
    setTimeout(() => delete panel.dataset.attention, 1200)
    // a mouse click never takes the keyboard from the board; Enter or Space on the button moves it into the panel
    if (fromKeyboard) panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  })
}

function StylesIcon() {
  return (
    <Icon>
      <path d="M12 4a8 8 0 1 0 0 16c1.2 0 1.6-.9 1.2-1.8-.5-1 .2-2.2 1.4-2.2H17a3 3 0 0 0 3-3c0-5-3.6-9-8-9z" />
      <circle cx="8" cy="11" r="1" fill="currentColor" />
      <circle cx="11" cy="7.5" r="1" fill="currentColor" />
      <circle cx="15.5" cy="8.5" r="1" fill="currentColor" />
    </Icon>
  )
}

/** Tier one: the controls (or the compact bar's Style button), More styles, the open tray. */
export function SelectionStyleItems({ ctx }: { ctx: CanvasFeatureContext; selection: readonly string[] }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const compact = useContext(SelectionBarCompact)
  const model = useValue('cux-tier1', () => tierModel(canvas), [canvas])
  const tray = useValue(state.selectionTray)
  const dark = useValue('cux-theme', () => canvas.theme(), [canvas]) === 'dark'
  const trayId = useId()
  const trayRef = useRef<HTMLDivElement>(null)
  /** the tray was opened from the keyboard: it takes the keyboard once drawn */
  const focusTray = useRef(false)
  useEffect(() => {
    if (!tray || !focusTray.current) return
    focusTray.current = false
    const el = trayRef.current
    ;(
      el?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
      el?.querySelector<HTMLButtonElement>('button')
    )?.focus()
  }, [tray])
  if (!model) return null
  const controls = model.controls
  const open = tray === ALL_STYLES_TRAY ? null : (controls.find((c) => c.id === tray) ?? null)
  const toggle = (id: string, e: { detail: number }) => {
    focusTray.current = tray !== id && e.detail === 0
    state.selectionTray.set(tray === id ? null : id)
  }
  const onPick = (control: TierControl, row: TierRow, value: string) => {
    pickTier(canvas, control.id, row.id, value)
  }
  // Escape in an open tray is the bar's (./SelectionBar.tsx closeStyleTray): it closes the tray first
  const trayBody = (rows: ReactNode) => (
    <div
      ref={trayRef}
      id={trayId}
      className="cux-selstyle__tray"
      data-testid="selection-style-tray"
      data-tray={tray ?? undefined}
    >
      {rows}
    </div>
  )
  const more = (
    <button
      type="button"
      className="dr-cux-selbar__btn"
      data-testid="selection-style-more"
      aria-label="More styles"
      title="More styles"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => moreStyles(ctx, e.detail === 0)}
    >
      <StylesIcon />
    </button>
  )
  if (compact) {
    const first = controls[0]
    const firstRow = first?.rows[0]
    // a control's tray opened before the bar folded is the compact bar's one tray
    const allOpen = tray !== null
    return (
      <>
        <span className="dr-cux-selbar__sep" aria-hidden="true" />
        <button
          type="button"
          className="dr-cux-selbar__btn"
          data-testid="selection-style"
          data-inflow=""
          aria-label={`Style${first ? ` (${controlLabel(first)})` : ''}`}
          title="Style"
          aria-expanded={allOpen}
          aria-controls={allOpen ? trayId : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            focusTray.current = !allOpen && e.detail === 0
            state.selectionTray.set(allOpen ? null : ALL_STYLES_TRAY)
          }}
        >
          {first && firstRow ? face(first.id, firstRow, chosen(firstRow), dark) : <StylesIcon />}
        </button>
        {allOpen &&
          trayBody(
            <>
              {controls.flatMap((c) =>
                c.rows.map((r) => (
                  <TrayRow key={r.id} control={c} row={r} legend dark={dark} onPick={onPick} />
                )),
              )}
              <div className="cux-selstyle__row">{more}</div>
            </>,
          )}
      </>
    )
  }
  return (
    <>
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      {controls.map((c) => {
        const row = c.rows[0] as TierRow
        return (
          <button
            key={c.id}
            type="button"
            className="dr-cux-selbar__btn cux-selstyle__control"
            data-testid={`selection-style-${c.id}`}
            data-inflow=""
            aria-label={controlLabel(c)}
            title={controlLabel(c)}
            aria-expanded={tray === c.id}
            aria-controls={tray === c.id ? trayId : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => toggle(c.id, e)}
          >
            {face(c.id, row, chosen(row), dark)}
          </button>
        )
      })}
      {more}
      {open &&
        trayBody(
          open.rows.map((r) => (
            <TrayRow
              key={r.id}
              control={open}
              row={r}
              legend={open.rows.length > 1}
              dark={dark}
              onPick={onPick}
            />
          )),
        )}
    </>
  )
}

/**
 * Tier one's place in the bar: the main row's last items, after copy link (10), lock (20), tags (50), the spotlight
 * (70) and AI (80), before the arrange row (100). Alt+F10 still lands on Copy link, as it always has.
 */
export const TIER1_ORDER = 90

export const TIER1_ITEMS: readonly SelectionBarItemSpec[] = SELECTION_TOOLBAR_TIER1
  ? [
      {
        id: 'canvas-ux.style',
        order: TIER1_ORDER,
        visible: (ctx) => tierModel(ctx.canvas) !== null,
        component: SelectionStyleItems,
      },
    ]
  : []
