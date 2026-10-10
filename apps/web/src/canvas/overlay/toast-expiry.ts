// Wave M (W2, M2-1, FTU-6): when an "Undo" toast goes (pure, Node-tested; ./toast-watch.ts feeds it).
//
// A toast whose button undoes something ("Grouped 8 notes into 3 themes. Undo") is only true for a moment: it is the
// last thing that happened. It stayed on screen through the Ask flow and later popovers, its button still offering to
// undo something that was no longer the last step. It goes
//  - after its timeout (the toast host's own timer; here a backstop for a timer that was lost or throttled: an undo
//    toast on screen for longer than UNDO_TOAST_MAX_MS goes whatever the host's timer says),
//  - when a newer undo toast comes (the older one no longer offers the last step), and
//  - when a popover or menu opens (the person has moved on), unless the toast is younger than POPOVER_GRACE_MS (it
//    came from the very gesture that opened the popover, or just before it).
// A toast without an undo button is never touched here.

/** What an undo toast says on its button. */
export const UNDO_LABEL = 'Undo'
/**
 * The longest an undo toast is kept (ms): the longest timeout any of them is given (the AI result's, 7 s) and a
 * second and a half for the host's own timer to run first.
 */
export const UNDO_TOAST_MAX_MS = 8_500
/** A popover opening within this long of an undo toast coming does not take it away. */
export const POPOVER_GRACE_MS = 400

/** One toast on screen, as the watcher sees it. */
export interface ToastRecord {
  readonly id: string
  /** it has an "Undo" button */
  readonly undoable: boolean
  /** when it came, or last changed what it says (this browser's clock, ms) */
  readonly shownAt: number
}

export type ExpiryEvent =
  /** time has passed */
  | { readonly kind: 'tick'; readonly now: number }
  /** the toast `id` has just come (or replaced itself with new words) */
  | { readonly kind: 'toast'; readonly id: string; readonly now: number }
  /** a popover or menu has just opened */
  | { readonly kind: 'popover'; readonly now: number }

/** The ids of the toasts to take down after `event`. */
export function toastsToExpire(toasts: readonly ToastRecord[], event: ExpiryEvent): string[] {
  const undo = toasts.filter((t) => t.undoable)
  switch (event.kind) {
    case 'tick':
      return undo.filter((t) => event.now - t.shownAt >= UNDO_TOAST_MAX_MS).map((t) => t.id)
    case 'toast': {
      const fresh = undo.find((t) => t.id === event.id)
      return fresh ? undo.filter((t) => t.id !== event.id).map((t) => t.id) : []
    }
    case 'popover':
      return undo.filter((t) => event.now - t.shownAt >= POPOVER_GRACE_MS).map((t) => t.id)
  }
}
