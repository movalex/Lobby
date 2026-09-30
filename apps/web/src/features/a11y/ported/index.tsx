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
//  - the phone sheet (`phoneSheet` slot, ./PhoneSheet.tsx).
import type { CanvasFeature, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { isTextEntry } from '../../../ui/focus.ts'
import { SKIP_TO_CANVAS_EVENT } from '../../../ui/SkipLink.tsx'
import { announcerFor, releaseAnnouncer } from './announcer.ts'
import { ContentsPanel } from './ContentsPanel.tsx'
import { CANVAS_HINT_ID, LiveRegion } from './LiveRegion.tsx'
import { PhoneSheet } from './PhoneSheet.tsx'
import { enterCanvas, selectAdjacent, selectFirstChild, selectionLevel, selectParent } from './traversal.ts'
import './a11y.css'

const hasItems = (ctx: CanvasFeatureContext) => selectionLevel(ctx.canvas).order.length > 0

/** The keyboard enters the canvas (F6, "Skip to canvas"), then the live region says where it is. */
function enter(ctx: CanvasFeatureContext): void {
  const announcer = announcerFor(ctx.canvas)
  if (enterCanvas(ctx.canvas)) announcer.saySelection()
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
  onMount(ctx) {
    const canvas = ctx.canvas
    announcerFor(canvas)
    const offs = [nameTheCanvas(canvas), enterFromAnywhere(ctx)]
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
 * holding the drawing surface) is named after the board and has the application role, as tldraw's
 * container had; the board page names the canvas region, and this copies that name onto the focus target
 * and keeps it in step with a rename. Found when it takes the keyboard, so no engine class is assumed.
 */
function nameTheCanvas(canvas: LobbyCanvas): () => void {
  const root = canvas.container()
  if (!root) return () => {}
  const named = new Set<HTMLElement>()
  const apply = (el: HTMLElement) => {
    const name = root.getAttribute('aria-label')
    if (name && el.getAttribute('aria-label') !== name) el.setAttribute('aria-label', name)
    if (el.getAttribute('role') !== 'application') el.setAttribute('role', 'application')
    if (el.getAttribute('aria-describedby') !== CANVAS_HINT_ID)
      el.setAttribute('aria-describedby', CANVAS_HINT_ID)
    named.add(el)
  }
  const consider = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement) || target === root || !root.contains(target)) return
    if (isTextEntry(target) || !target.querySelector('canvas')) return
    apply(target)
  }
  const onFocusIn = (e: FocusEvent) => consider(e.target)
  document.addEventListener('focusin', onFocusIn, true)
  consider(document.activeElement)
  // a rename: the page updates the region's name, the focus target follows
  const watch = new MutationObserver(() => {
    for (const el of named) if (el.isConnected) apply(el)
  })
  watch.observe(root, { attributes: true, attributeFilter: ['aria-label'] })
  return () => {
    document.removeEventListener('focusin', onFocusIn, true)
    watch.disconnect()
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
