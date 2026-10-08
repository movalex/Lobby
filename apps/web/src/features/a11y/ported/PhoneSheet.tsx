// OWNER: 3i. The `phoneSheet` host slot (docs/EXCALIDRAW-CONTRACTS.md §3; docs/EXCALIDRAW-MIGRATION.md §4.8
// "phone sheet"; spike B's `sheet` slot, B12): on a phone-width board (600 px and less, the dock's own phone
// breakpoint) one "All tools" button opens a bottom sheet with the tools this role may use (Lobby's built-in
// ones and every feature tool with a toolbar entry: comment, vote, …), Undo / Redo and Zoom to fit. Beside
// 3a's phone toolbar (38 px tools, the rest under More) it lists every tool at once, at touch size.
//
// Keyboard and touch: the button and every row are at least 44 px; Escape or Close shuts the sheet and gives
// the keyboard back to the button; a press outside it shuts it too; picking a tool shuts it and hands the
// keyboard to the board. Nothing renders on wider screens. While a workshop card or a docked comment sheet
// is up the button steps aside (a11y.css, W5-07); Zoom to fit honours reduced motion (W5-21).
//
// Wave K:
//  - K5-1: the slot also installs ./edit-zoom.ts (a note being edited on a phone comes to a readable size).
//  - K5-3: on a phone with a touch screen (this breakpoint and (pointer: coarse)) the board rests on the Hand
//    tool, so a one-finger drag pans instead of moving colleagues' notes: after the board loads, and when the
//    sheet closes without a tool being picked, a board on Select goes to Hand (never a tool the person picked:
//    Select picked in the sheet or the toolbar stays). Only through the canvas API's `setTool` (Lobby's tool
//    registry, which sets the engine's appState); never on a desktop. A one-time hint says how to select
//    (PHONE_HAND_HINT, once per browser: PHONE_HINT_KEY, storage in try/catch). The button is "All tools", with
//    its own shapes icon: the board menu (top left) is the other ≡.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasFeatureContext, FeatureToolSpec, LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { installEditZoom } from './edit-zoom.ts'
import { animateCamera } from './motion.ts'
import { EDIT_TOOLS, READONLY_TOOLS, type ToolRow } from './tools.ts'

/** The phone breakpoint (styles.css: the dock rail folds and panels become sheets below it). */
export const PHONE_QUERY = '(max-width: 600px)'
/** A finger is the primary pointer. */
export const COARSE_QUERY = '(pointer: coarse)'

/** The floating button's name (and the sheet's): every tool at once. */
export const ALL_TOOLS_LABEL = 'All tools'

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** The rows of the Tools section for this role: built-in tools, then the features' toolbar tools. */
export function sheetTools(readOnly: boolean, featureTools: readonly FeatureToolSpec[]): ToolRow[] {
  const own = featureTools
    .filter((t) => t.toolbar && (!readOnly || t.readOnlyAllowed))
    .sort(
      (a, b) =>
        (a.toolbar?.group === b.toolbar?.group ? 0 : a.toolbar?.group === 'main' ? -1 : 1) ||
        (a.toolbar?.order ?? 0) - (b.toolbar?.order ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .map((t) => ({ id: t.id, label: t.label }))
  return [...(readOnly ? READONLY_TOOLS : EDIT_TOOLS), ...own]
}

// ---- K5-3: the phone rests on Hand -------------------------------------------------------------------------

/** The tool a phone with a touch screen rests on. */
export const PHONE_REST_TOOL = 'hand'

/** The canvas members the rest rule uses: the canvas API only (a fake one in PhoneSheet.test.ts). */
export type RestCanvas = Pick<LobbyCanvas, 'tool' | 'setTool' | 'editingId'>

/**
 * K5-3: whether this screen rests on Hand. A phone-width board AND a touch screen: a narrow desktop window
 * (a mouse) keeps Select, and so does a tablet or a laptop with a touch screen and a wider board.
 */
export const restsOnHand = (env: { readonly phone: boolean; readonly coarse: boolean }): boolean =>
  env.phone && env.coarse

/**
 * The rest rule for one board: `afterLoad()` when the board has loaded on a phone, `picked(tool)` when the
 * person picks a tool (the sheet, the toolbar), `dismissed()` when the sheet closes without a pick. A board on
 * Select (the engine's default, and where it returns after placing a note) goes to Hand, unless the person's
 * last pick was Select itself, or a text editor is open. Returns whether it moved the board to Hand.
 */
export function createHandRest(canvas: RestCanvas) {
  let chosen: string | null = null
  const rest = (): boolean => {
    if (chosen === 'select') return false
    if (canvas.editingId() !== null) return false
    if (canvas.tool() !== 'select') return false
    return canvas.setTool(PHONE_REST_TOOL)
  }
  return {
    afterLoad: rest,
    dismissed: rest,
    picked(tool: string) {
      chosen = tool
    },
    /** The person's last pick (null: none yet). */
    chosen: () => chosen,
  }
}
export type HandRest = ReturnType<typeof createHandRest>

// ---- K5-3: the one-time hint ---------------------------------------------------------------------------------

/** Where the hint's "shown" mark lives (per browser). */
export const PHONE_HINT_KEY = 'lobby:phone-hand-hint'

/** What the hint says: Hand pans; Select (the arrow) is how to select and move things. */
export const PHONE_HAND_HINT = {
  lead: 'Drag to look around the board.',
  rest: 'To work with notes, tap Select (the arrow): tap to select, drag to move. Double-tap a note to edit it.',
} as const

/** The storage the hint uses (null: none, or it throws on access). */
export type HintStorage = Pick<Storage, 'getItem' | 'setItem'> | null

/** Shown once in this page when there is no storage at all (a private window that refuses it). */
let shownWithoutStorage = false

/**
 * Whether to show the hint now, and if so marks it shown (a reload never shows it again). Every read and write
 * is in try/catch: storage may be missing or throw (private windows, blocked site data); then it is shown once
 * per page.
 */
export function takePhoneHint(storage: HintStorage): boolean {
  try {
    if (storage) {
      if (storage.getItem(PHONE_HINT_KEY) === '1') return false
      storage.setItem(PHONE_HINT_KEY, '1')
      return true
    }
  } catch {
    // falls through to the page's own memory
  }
  if (shownWithoutStorage) return false
  shownWithoutStorage = true
  return true
}

/** Test seam: forget the in-page mark. */
export function resetPhoneHintMemory(): void {
  shownWithoutStorage = false
}

function pageStorage(): HintStorage {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

// ---- the slot ----------------------------------------------------------------------------------------------

export function PhoneSheet({ ctx }: { readonly ctx: CanvasFeatureContext }) {
  const phone = useMedia(PHONE_QUERY)
  const coarse = useMedia(COARSE_QUERY)
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const canvas = ctx.canvas
  // K5-1: editing a note on a phone brings it to a readable size above the keyboard (a local camera move,
  // ./edit-zoom.ts). Mounted with the slot on every width: the rule itself checks the pointer and the canvas.
  useEffect(() => installEditZoom(canvas), [canvas])
  // K5-3: one rule per board; it remembers the person's last pick.
  const rest = useMemo(() => createHandRest(canvas), [canvas])
  const resting = restsOnHand({ phone, coarse })
  useEffect(() => {
    if (!resting) return
    if (rest.afterLoad() && takePhoneHint(pageStorage())) setHint(true)
  }, [resting, rest])
  // a tool the person picks on the toolbar counts as their pick too (Select from the toolbar stays)
  useEffect(() => {
    if (!resting) return
    const onClick = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target.closest('[data-testid^="tools."]') : null
      const id = t?.getAttribute('data-testid')?.slice('tools.'.length)
      if (id && id !== 'more-button') rest.picked(id)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [resting, rest])
  useEffect(() => {
    if (!phone) setOpen(false)
    if (!resting) setHint(false)
  }, [phone, resting])
  if (!phone) return null
  return (
    <>
      <Sheet
        ctx={ctx}
        open={open}
        setOpen={setOpen}
        rest={resting ? rest : null}
        onOpen={() => setHint(false)}
      />
      {hint && <HandHint canvas={canvas} onDone={() => setHint(false)} />}
    </>
  )
}

/**
 * K5-3: the one-time hint, under the board's top-left corner. It goes on "Got it", on any press elsewhere (the
 * person is already using the board), when the tool changes or when the sheet opens.
 */
function HandHint({ canvas, onDone }: { canvas: CanvasFeatureContext['canvas']; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onDone()
    }
    document.addEventListener('pointerdown', onDown, true)
    const off = canvas.on('toolChanged', (t) => {
      if ((canvas.tool() ?? t) !== PHONE_REST_TOOL) onDone()
    })
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      off()
    }
  }, [canvas, onDone])
  return (
    <div ref={ref} className="dr-phone-hint" data-testid="phone-hand-hint" role="status">
      <p className="dr-phone-hint__text">
        <strong>{PHONE_HAND_HINT.lead}</strong> {PHONE_HAND_HINT.rest}
      </p>
      <button type="button" className="dr-btn dr-btn--sm" data-testid="phone-hand-hint-ok" onClick={onDone}>
        Got it
      </button>
    </div>
  )
}

/** "All tools": a square, a circle and a triangle (the board menu at the top left is the ≡). */
function AllToolsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" data-icon="all-tools">
      <rect
        x="3.5"
        y="3.5"
        width="7"
        height="7"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <circle cx="17" cy="7" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M12 13.6l4.6 7.4H7.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Sheet({
  ctx,
  open,
  setOpen,
  rest,
  onOpen,
}: {
  ctx: CanvasFeatureContext
  open: boolean
  setOpen(open: boolean): void
  /** K5-3: the phone's rest rule (null: this screen keeps Select). */
  rest: HandRest | null
  onOpen(): void
}) {
  const canvas = ctx.canvas
  const sheetId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const readOnly = useValue('a11y.sheet-readonly', () => canvas.readOnly(), [canvas])
  const current = useValue('a11y.sheet-tool', () => canvas.tool(), [canvas])
  const canUndo = useValue('a11y.sheet-undo', () => !canvas.readOnly() && canvas.history.canUndo(), [canvas])
  const canRedo = useValue('a11y.sheet-redo', () => !canvas.readOnly() && canvas.history.canRedo(), [canvas])
  const tools = sheetTools(readOnly, ctx.registries.tools.list())

  // opening puts the keyboard on the first row; a press outside the sheet (and its button) shuts it
  useEffect(() => {
    if (!open) return
    sheetRef.current?.querySelector<HTMLElement>('[data-sheet-row]')?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (sheetRef.current?.contains(t) || toggleRef.current?.contains(t)) return
      setOpen(false)
      rest?.dismissed()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, setOpen, rest])

  /** Shuts the sheet; `picked`: the tool picked in it (none: the board goes back to its rest tool). */
  const shut = (to: 'button' | 'board', picked: string | null = null) => {
    setOpen(false)
    if (picked === null) rest?.dismissed()
    if (to === 'board') canvas.focus({ preventScroll: true })
    else toggleRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="dr-a11y-sheet-root">
      <button
        ref={toggleRef}
        type="button"
        className="dr-a11y-sheet__toggle"
        data-testid="phone-sheet-open"
        aria-expanded={open}
        aria-controls={open ? sheetId : undefined}
        aria-label={ALL_TOOLS_LABEL}
        title={ALL_TOOLS_LABEL}
        onClick={() => {
          if (open) shut('button')
          else {
            onOpen()
            setOpen(true)
          }
        }}
      >
        <AllToolsIcon />
      </button>
      {open ? (
        <div
          ref={sheetRef}
          id={sheetId}
          className="dr-a11y-sheet"
          data-testid="phone-sheet"
          role="dialog"
          aria-label={ALL_TOOLS_LABEL}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return
            e.preventDefault()
            e.stopPropagation()
            shut('button')
          }}
        >
          <header className="dr-a11y-sheet__head">
            <h2>{ALL_TOOLS_LABEL}</h2>
            <button
              type="button"
              className="dr-iconbtn dr-a11y-sheet__close"
              data-testid="phone-sheet-close"
              aria-label="Close all tools"
              onClick={() => shut('button')}
            >
              ×
            </button>
          </header>
          <section aria-label="Tools">
            <h3 className="dr-a11y-sheet__caption">Tools</h3>
            <div className="dr-a11y-sheet__grid">
              {tools.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="dr-a11y-sheet__row"
                  data-sheet-row=""
                  data-testid="phone-sheet-tool"
                  data-tool={t.id}
                  aria-pressed={current === t.id}
                  onClick={() => {
                    canvas.setTool(t.id)
                    rest?.picked(t.id)
                    shut('board', t.id)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>
          <section aria-label="Edit and view">
            <h3 className="dr-a11y-sheet__caption">Board</h3>
            <div className="dr-a11y-sheet__grid">
              {readOnly ? null : (
                <>
                  <button
                    type="button"
                    className="dr-a11y-sheet__row"
                    data-sheet-row=""
                    data-testid="phone-sheet-undo"
                    disabled={!canUndo}
                    onClick={() => canvas.history.undo()}
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    className="dr-a11y-sheet__row"
                    data-sheet-row=""
                    data-testid="phone-sheet-redo"
                    disabled={!canRedo}
                    onClick={() => canvas.history.redo()}
                  >
                    Redo
                  </button>
                </>
              )}
              <button
                type="button"
                className="dr-a11y-sheet__row"
                data-sheet-row=""
                data-testid="phone-sheet-fit"
                onClick={() => {
                  canvas.viewport.fit(undefined, { animate: animateCamera() })
                  shut('board')
                }}
              >
                Zoom to fit
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
