// OWNER: 3i (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'a11y' feature on the Excalidraw board page:
// accessibility and phone (docs/EXCALIDRAW-MIGRATION.md §4.8).
//
//  - the live region (`liveRegion` slot, ./LiveRegion.tsx, ./announcer.ts): what is selected, as tldraw's
//    announcer said it; Alt+R says it again;
//  - keyboard traversal (./traversal.ts): F6 moves the keyboard to the board from anywhere on the page (the
//    first element in reading order is selected when nothing is); Alt+→/↓ and Alt+←/↑ move to the next or
//    previous element in reading order; Ctrl/Cmd+Shift+↓ goes inside the selected frame and Ctrl/Cmd+Shift+↑
//    back out; Enter then edits through the lease (the board's own Enter);
//  - the canvas the keyboard lands on carries the board's name ("<title> board", A11Y2-09) and the
//    application role, as tldraw's container did, and a short description of those keys;
//  - "Skip to canvas" (ui/SkipLink.tsx) enters the canvas the same way F6 does;
//  - the accessible content list (dock panel "Contents", ./ContentsPanel.tsx);
//  - the phone sheet (`phoneSheet` slot, ./PhoneSheet.tsx);
//  - since the early wave-5 review: a tool change is said politely and a text edit that ends says the
//    selection again (W5-43); the board shows a focus ring while the keyboard is on it (W5-45,
//    ./FocusRing.tsx); the engine's text editor is named after what it edits (W5-59); camera moves honour
//    reduced motion (W5-21, ./motion.ts).
import type { CanvasFeature, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { isTextEntry } from '../../../ui/focus.ts'
import { boardRegionName, SKIP_TO_CANVAS_EVENT } from '../../../ui/SkipLink.tsx'
import { announcerFor, releaseAnnouncer } from './announcer.ts'
import { ContentsPanel } from './ContentsPanel.tsx'
import { FocusRing, keyboardFocus } from './FocusRing.tsx'
import {
  isRealMove,
  nextRing,
  type PointerAt,
  RING_START,
  type RingInput,
  type RingState,
} from './focus-ring.ts'
import { CANVAS_HINT_ID, LiveRegion } from './LiveRegion.tsx'
import { PhoneSheet } from './PhoneSheet.tsx'
import { toolWords } from './tools.ts'
import { enterCanvas, selectAdjacent, selectFirstChild, selectionLevel, selectParent } from './traversal.ts'
import './a11y.css'

const hasItems = (ctx: CanvasFeatureContext) => selectionLevel(ctx.canvas).order.length > 0

/** K2-1: each board's focus-ring state (./focus-ring.ts), fed by `nameTheCanvas` and `enter`. */
const rings = new WeakMap<object, { state: RingState }>()

function feedRing(canvas: object, input: RingInput): void {
  let r = rings.get(canvas)
  if (!r) {
    r = { state: RING_START }
    rings.set(canvas, r)
  }
  r.state = nextRing(r.state, input)
  if (keyboardFocus.get() !== r.state.ring) keyboardFocus.set(r.state.ring)
}

/** The board's focusable canvas (the element holding the drawing surface, not its text editor) has the focus. */
function boardFocused(root: HTMLElement | null): boolean {
  const a = root?.ownerDocument.activeElement
  return (
    !!root &&
    a instanceof HTMLElement &&
    a !== root &&
    root.contains(a) &&
    !isTextEntry(a) &&
    !!a.querySelector('canvas')
  )
}

/** The keyboard enters the canvas (F6, "Skip to canvas"), then the live region says where it is. */
function enter(ctx: CanvasFeatureContext): void {
  const announcer = announcerFor(ctx.canvas)
  const entered = enterCanvas(ctx.canvas)
  // K2-1: an entry on purpose shows the ring, also when the board already had the focus (no focusin then)
  feedRing(ctx.canvas, { type: 'enter', onBoard: boardFocused(ctx.canvas.container()) })
  if (entered) announcer.saySelection()
  else announcer.say(EMPTY_BOARD)
}

/** What the live region says when the keyboard enters a board with nothing on it. */
export const EMPTY_BOARD = 'Nothing on this board yet.'

function ContentsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M5 6h2M5 12h2M5 18h2M10 6h9M10 12h9M10 18h9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

export const feature: CanvasFeature = {
  id: 'a11y',
  panels: [
    {
      id: 'contents',
      label: 'Contents',
      icon: ContentsIcon,
      order: 900,
      component: ContentsPanel,
    },
  ],
  commands: [
    {
      id: 'a11y.enter-canvas',
      label: 'Move the keyboard to the board (selects the first item)',
      kbd: ['f6'],
      readOnlyAllowed: true,
      run: (ctx) => enter(ctx),
    },
    {
      id: 'a11y.next',
      label: 'Select the next item (reading order)',
      kbd: ['alt+right', 'alt+down'],
      readOnlyAllowed: true,
      enabled: hasItems,
      run: (ctx) => void selectAdjacent(ctx.canvas, 'next'),
    },
    {
      id: 'a11y.previous',
      label: 'Select the previous item (reading order)',
      kbd: ['alt+left', 'alt+up'],
      readOnlyAllowed: true,
      enabled: hasItems,
      run: (ctx) => void selectAdjacent(ctx.canvas, 'prev'),
    },
    {
      id: 'a11y.into-frame',
      label: 'Go inside the selected frame',
      kbd: ['mod+shift+down'],
      readOnlyAllowed: true,
      enabled: (ctx) => ctx.canvas.selection.length > 0,
      run: (ctx) => void selectFirstChild(ctx.canvas),
    },
    {
      id: 'a11y.out-of-frame',
      label: 'Go back out to the frame',
      kbd: ['mod+shift+up'],
      readOnlyAllowed: true,
      enabled: (ctx) => ctx.canvas.selection.length > 0,
      run: (ctx) => void selectParent(ctx.canvas),
    },
    {
      id: 'a11y.repeat',
      label: 'Say what is selected again',
      kbd: ['alt+r'],
      readOnlyAllowed: true,
      enabled: (ctx) => ctx.canvas.selection.length > 0,
      run: (ctx) => announcerFor(ctx.canvas).saySelection(),
    },
  ],
  slots: {
    liveRegion: LiveRegion,
    phoneSheet: PhoneSheet,
  },
  // W5-45: the ring is drawn above the engine's canvases (an outline on the engine's container is not)
  overlays: [{ id: 'a11y-focus-ring', layer: 'screen', order: 1, pointer: 'none', component: FocusRing }],
  onMount(ctx) {
    const canvas = ctx.canvas
    announcerFor(canvas)
    const offs = [nameTheCanvas(ctx), quietEngineFooter(ctx), enterFromAnywhere(ctx), announceTools(ctx)]
    const onSkip = () => enter(ctx)
    document.addEventListener(SKIP_TO_CANVAS_EVENT, onSkip)
    return () => {
      document.removeEventListener(SKIP_TO_CANVAS_EVENT, onSkip)
      for (const off of offs) off()
      releaseAnnouncer(canvas)
    }
  },
}

/**
 * A11Y2-09: the element that takes the keyboard on the board (the engine's focusable container, the one
 * holding the drawing surface) is named after the board ("<title> board") and has the application role, as
 * tldraw's container had, and keeps the name through a rename (the board page re-labels its canvas region
 * on a rename; that is the cue). The name comes from the board's title, not from the region's label, so the
 * region may be named differently (W5-57: the two shared one name). Found when it takes the keyboard, so no
 * engine class is assumed.
 *
 * Two more things happen on that focus:
 *  - W5-45, K2-1: the keyboard arriving there (Tab, F6, "Skip to canvas", and Escape out of an editor the
 *    keyboard got to) turns the board's focus ring on (./FocusRing.tsx); a press or a real move of the pointer,
 *    or the focus leaving the board, turns it off. A focus that follows a click or the page opening shows no
 *    ring, as `:focus-visible` would not, and neither does Escape out of a note a pointer opened: typing and
 *    Escape are not keys that move the focus (./focus-ring.ts has the rule).
 *  - W5-59: the engine's text editor (a textarea inside the board) is NOT named here: canvas-ux names it
 *    as it opens (../../canvas-ux/ported/canvas-events.ts editorName), and two writers gave it two names in
 *    turn (the wave-5 integration).
 */
function nameTheCanvas(ctx: CanvasFeatureContext): () => void {
  const canvas = ctx.canvas
  const root = canvas.container()
  if (!root) return () => {}
  const named = new Set<HTMLElement>()
  const apply = (el: HTMLElement) => {
    const name = boardRegionName(ctx.board.title)
    if (el.getAttribute('aria-label') !== name) el.setAttribute('aria-label', name)
    if (el.getAttribute('role') !== 'application') el.setAttribute('role', 'application')
    if (el.getAttribute('aria-describedby') !== CANVAS_HINT_ID)
      el.setAttribute('aria-describedby', CANVAS_HINT_ID)
    named.add(el)
  }
  // the last input that moved the focus (./focus-ring.ts): the ring shows only for a focus the keyboard brought
  let last: PointerAt | null = null
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.isTrusted) return
    feedRing(canvas, { type: 'key', key: e.key })
  }
  const onPointerDown = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY }
    feedRing(canvas, { type: 'pointerdown' })
  }
  const onPointerMove = (e: PointerEvent) => {
    if (!e.isTrusted) return
    const moved = isRealMove(last, e)
    last = { x: e.clientX, y: e.clientY }
    feedRing(canvas, { type: 'pointermove', moved })
  }
  const consider = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement) || target === root || !root.contains(target)) return false
    if (isTextEntry(target)) return false
    if (!target.querySelector('canvas')) return false
    apply(target)
    return true
  }
  const onFocusIn = (e: FocusEvent) => {
    feedRing(canvas, { type: 'focus', onBoard: consider(e.target) })
  }
  const onFocusOut = (e: FocusEvent) => {
    if (e.target instanceof HTMLElement && named.has(e.target)) feedRing(canvas, { type: 'leave' })
  }
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('focusout', onFocusOut, true)
  consider(document.activeElement)
  // a rename: the page updates the region's name, the focus target follows the board's title
  const watch = new MutationObserver(() => {
    for (const el of named) if (el.isConnected) apply(el)
  })
  watch.observe(root, { attributes: true, attributeFilter: ['aria-label'] })
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('pointermove', onPointerMove, { capture: true })
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('focusout', onFocusOut, true)
    watch.disconnect()
    rings.delete(canvas)
    keyboardFocus.set(false)
  }
}

/**
 * W5-57: the engine renders its bottom menu bar as `<footer role="contentinfo">` (Excalidraw's
 * Footer.tsx), inside the board page's main landmark and empty on Lobby's board (its zoom, undo and help
 * controls are switched off). A contentinfo is the PAGE's footer: one inside main is an axe failure
 * (landmark-contentinfo-is-top-level), and a screen reader lists an empty "content information" landmark
 * on every board. It loses the role (presentation: whatever it holds stays reachable as before), also
 * when the engine renders it again.
 */
function quietEngineFooter(ctx: CanvasFeatureContext): () => void {
  const root = ctx.canvas.container()
  if (!root) return () => {}
  const SELECTOR = '[role="contentinfo"]'
  const apply = () => {
    for (const el of root.querySelectorAll(SELECTOR)) el.setAttribute('role', 'presentation')
  }
  apply()
  const watch = new MutationObserver(() => {
    if (root.querySelector(SELECTOR)) apply()
  })
  watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] })
  return () => watch.disconnect()
}

/** How long a new tool must stay before it is said (ms): placing a note returns to Select as its editor opens. */
export const TOOL_SETTLE_MS = 400

/**
 * W5-43: a tool change is said in the polite region ("Note tool", "Comment tool"), from a key, the toolbar,
 * the phone sheet or code, once it has stayed for TOOL_SETTLE_MS. Nothing is said when a text editor is open
 * by then (placing a note returns the board to Select while the note's editor waits for its lease: that
 * return is not news), for a tool the board does not name, or for the same tool again.
 */
function announceTools(ctx: CanvasFeatureContext): () => void {
  const canvas = ctx.canvas
  // the board's own name for it (`hand` under a viewer's Hand, `highlight` for the highlighter)
  const current = (raw?: string | null) => canvas.tool() ?? raw ?? null
  let said = current()
  let due: ReturnType<typeof setTimeout> | null = null
  const off = canvas.on('toolChanged', (raw) => {
    const tool = current(raw)
    if (due !== null) clearTimeout(due)
    due = setTimeout(() => {
      due = null
      if (current() !== tool || tool === said) return
      // the tool the board is on now, said or not (a later pick of the previous tool is news again)
      said = tool
      if (canvas.editingId() !== null) return
      const words = toolWords(tool, ctx.registries.tools.list())
      if (words) announcerFor(canvas).sayPolitely(words)
    }, TOOL_SETTLE_MS)
  })
  return () => {
    off()
    if (due !== null) clearTimeout(due)
  }
}

/**
 * F6 from anywhere on the board page (the top bar, the dock, a panel, a field): the keyboard goes to the
 * board. Inside the board F6 is the `a11y.enter-canvas` command (the key registry); an open modal dialog
 * keeps its keyboard.
 */
function enterFromAnywhere(ctx: CanvasFeatureContext): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'F6' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.isComposing || ctx.canvas.hasKeyboard()) return
    if (document.querySelector('dialog[open], [aria-modal="true"]')) return
    e.preventDefault()
    enter(ctx)
  }
  document.addEventListener('keydown', onKey)
  return () => document.removeEventListener('keydown', onKey)
}
