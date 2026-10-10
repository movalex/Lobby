// Wave M (W2, M2-1): feeds ./toast-expiry.ts. The toast host (board/Notices.tsx, rendered by the board page) owns the
// toasts' state and gives the board no list of them, so this reads what is on screen: the `.dr-notices` region's
// `.dr-notice` boxes, and the one with a "Undo" action button is an undo toast. It takes one down the way a person
// would, with its own close button (which tells the host: its timer and its state go with it).
//
// What it reacts to: a toast coming or changing its words (the region's DOM changing), a popover or menu opening
// (`registries.menusOpen`, answered by canvas-ux for its menus and popovers, read reactively), and
// the clock (a second's tick, only while an undo toast is there). It never reads or sends anything else.

import { type ToastRecord, toastsToExpire, UNDO_LABEL } from './toast-expiry.ts'

export interface ToastWatchOptions {
  readonly doc: Document
  /** whether a popover or menu is open now (registries.menusOpen.call) */
  readonly menusOpen: () => boolean
  /** told when the answer of `menusOpen` may have changed (a reactive read of it); returns the removal */
  readonly onMenusChange: (listener: () => void) => () => void
  readonly now?: () => number
}

const REGION = '.dr-notices'
const TICK_MS = 1_000

interface Tracked {
  readonly el: Element
  record: ToastRecord
  text: string
}

const isUndo = (el: Element): boolean =>
  [...el.querySelectorAll('.dr-notice__action')].some((b) => (b.textContent ?? '').trim() === UNDO_LABEL)

/** Starts watching; returns the stop. */
export function watchUndoToasts(o: ToastWatchOptions): () => void {
  const clock = o.now ?? (() => Date.now())
  const tracked = new Map<Element, Tracked>()
  let seq = 0
  let region: Element | null = null
  let observer: MutationObserver | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  let menus = false
  let stopped = false

  const records = () => [...tracked.values()].map((t) => t.record)
  const close = (ids: readonly string[]) => {
    for (const t of [...tracked.values()]) {
      if (!ids.includes(t.record.id)) continue
      tracked.delete(t.el)
      // the toast's own close button: the host drops it and clears its timer (a click on a button that is gone is nothing)
      t.el.querySelector<HTMLElement>('.dr-notice__close')?.click()
    }
  }

  /** Notices the toasts that came, changed their words or went; reacts to a new undo toast. */
  const scan = () => {
    if (stopped) return
    const root = o.doc.querySelector(REGION)
    if (root !== region) {
      observer?.disconnect()
      region = root
      if (root) {
        observer ??= new MutationObserver(scan)
        observer.observe(root, { childList: true, subtree: true, characterData: true })
      }
    }
    const now = clock()
    const here = new Set<Element>()
    let arrived: string | null = null
    for (const el of root ? [...root.querySelectorAll(':scope > .dr-notice')] : []) {
      here.add(el)
      const text = (el.textContent ?? '').trim()
      const known = tracked.get(el)
      if (!isUndo(el)) {
        tracked.delete(el)
        continue
      }
      if (!known) {
        const record = { id: `undo-${++seq}`, undoable: true, shownAt: now }
        tracked.set(el, { el, record, text })
        arrived = record.id
      } else if (known.text !== text) {
        // the same box with new words: a new toast under the same key
        known.text = text
        known.record = { ...known.record, shownAt: now }
        arrived = known.record.id
      }
    }
    for (const el of tracked.keys()) if (!here.has(el)) tracked.delete(el)
    if (arrived) close(toastsToExpire(records(), { kind: 'toast', id: arrived, now }))
    arm()
  }

  /** The clock runs only while there is an undo toast to age. */
  const arm = () => {
    if (tracked.size && ticker === null)
      ticker = setInterval(() => {
        close(toastsToExpire(records(), { kind: 'tick', now: clock() }))
        if (!tracked.size && ticker !== null) {
          clearInterval(ticker)
          ticker = null
        }
      }, TICK_MS)
    else if (!tracked.size && ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }

  const onMenus = () => {
    const open = o.menusOpen()
    if (open && !menus) close(toastsToExpire(records(), { kind: 'popover', now: clock() }))
    menus = open
  }

  const offMenus = o.onMenusChange(onMenus)
  menus = o.menusOpen()
  scan()
  // the page renders the region in the same commit as the board's overlay; if it is not there yet, look once more
  const retry = region ? null : setTimeout(scan, 500)
  return () => {
    stopped = true
    offMenus()
    observer?.disconnect()
    if (retry !== null) clearTimeout(retry)
    if (ticker !== null) clearInterval(ticker)
    tracked.clear()
  }
}
