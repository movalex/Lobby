// OWNER: 3i. The live region's message (docs/EXCALIDRAW-MIGRATION.md §4.8 (1)): tldraw's A11yProvider
// (`a11y.announce`) and `useSelectedShapesAnnouncer`, on the Excalidraw board page. One announcer per canvas;
// the `liveRegion` host slot (./LiveRegion.tsx) renders its messages.
//
// When it speaks (as tldraw did): the selection changed while the select tool is at rest (a click, a box
// selection once the pointer is up, Alt+Arrow, the content list, an api select); Alt+R repeats it; the
// keyboard entering the canvas (F6, "Skip to canvas") says what is selected. It stays quiet while a text
// editor is open (the typed words are the editor's) and when the selection empties.
//
// Since the early wave-5 review:
//  - W5-43: when a text edit ends (Escape, a click away) the selection is said again, with the words just
//    typed ("Sticky note: Faster builds. 2 of 5"); a tool change is said politely ("Note tool"), in a second
//    region, so it never cuts off what the selection said;
//  - W5-58: a selection is said only if it is still the selection when its words are due (a beat later): a
//    selection that comes and goes at once (a template insert selects what it placed, then the first view
//    clears it) is never heard, and a selection that empties cancels what was about to be said.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom, react, untracked } from '../../../lib/signals.ts'
import { describeSelection } from './describe.ts'
import { selectionLevel } from './traversal.ts'

/** How long a new selection must stay before it is said (ms): long enough for code that selects and clears. */
export const SETTLE_MS = 120

export interface Announcer {
  /** the assertive region's current words ('' between two announcements of the same words) */
  readonly message: Atom<string>
  /** the polite region's current words (tool changes) */
  readonly polite: Atom<string>
  /** says `words` now (again, if they are the same as the last) */
  say(words: string): void
  /** says `words` in the polite region (a tool change) */
  sayPolitely(words: string): void
  /** says what is selected (nothing when nothing is) */
  saySelection(): void
  /** stops following the canvas */
  dispose(): void
}

const announcers = new WeakMap<LobbyCanvas, Announcer>()

/** The announcer of `canvas` (created on first use). */
export function announcerFor(canvas: LobbyCanvas): Announcer {
  let a = announcers.get(canvas)
  if (!a) {
    a = createAnnouncer(canvas)
    announcers.set(canvas, a)
  }
  return a
}

/** Stops and forgets `canvas`'s announcer (the feature's cleanup). */
export function releaseAnnouncer(canvas: LobbyCanvas): void {
  announcers.get(canvas)?.dispose()
  announcers.delete(canvas)
}

/** The words for the current selection ('' for none). */
export function selectionWords(canvas: LobbyCanvas): string {
  const selection = canvas.selection
  if (!selection.length) return ''
  const { frame, order } = selectionLevel(canvas)
  return describeSelection(selection, {
    get: (id) => canvas.get(id),
    order,
    frame: frame ? (canvas.get(frame) ?? null) : null,
  })
}

/** One live region's words: the same words twice in a row are heard again (emptied first, set a frame later). */
function region(name: string) {
  const message = atom(name, '')
  let pending: number | null = null
  return {
    message,
    say(words: string) {
      if (!words) return
      if (pending !== null) cancelAnimationFrame(pending)
      // the same words twice in a row are only heard again after a change: empty the region first, then
      // speak a frame later (tldraw's repeat-shape action did the same)
      message.set('')
      pending = requestAnimationFrame(() => {
        pending = null
        message.set(words)
      })
    },
    dispose() {
      if (pending !== null) cancelAnimationFrame(pending)
      pending = null
    },
  }
}

function createAnnouncer(canvas: LobbyCanvas): Announcer {
  const loud = region('a11y.announcement')
  const soft = region('a11y.announcement-polite')
  const selectionKey = () => canvas.selection.join('\n')

  // a selection's words, said once the selection has stayed for SETTLE_MS (W5-58)
  let due: ReturnType<typeof setTimeout> | null = null
  const cancelDue = () => {
    if (due !== null) clearTimeout(due)
    due = null
  }
  const sayWhenSettled = (key: string) => {
    cancelDue()
    due = setTimeout(() => {
      due = null
      if (selectionKey() !== key || canvas.editingId() !== null) return
      const words = selectionWords(canvas)
      if (words) loud.say(words)
    }, SETTLE_MS)
  }

  // the selection as last seen at rest (a pointer move re-runs the effect without a new selection)
  let last = ''
  let wasEditing = false
  const stop = react('a11y.announce-selection', () => {
    const gesture = canvas.gesture()
    const editing = canvas.editingId() !== null
    const key = canvas.selection.join('\n')
    const editEnded = wasEditing && !editing
    wasEditing = editing
    if (editing) {
      // the editor has the words now: nothing about the selection is said meanwhile
      cancelDue()
      return
    }
    if (gesture !== 'idle') return
    if (key === last && !editEnded) return
    last = key
    if (!key) {
      cancelDue()
      return
    }
    untracked(() => sayWhenSettled(key))
  })
  return {
    message: loud.message,
    polite: soft.message,
    say: loud.say,
    sayPolitely: soft.say,
    saySelection: () => {
      cancelDue()
      loud.say(selectionWords(canvas))
    },
    dispose() {
      stop()
      cancelDue()
      loud.dispose()
      soft.dispose()
    },
  }
}
