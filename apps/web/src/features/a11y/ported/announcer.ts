// OWNER: 3i. The live region's message (docs/EXCALIDRAW-MIGRATION.md §4.8 (1)): tldraw's A11yProvider
// (`a11y.announce`) and `useSelectedShapesAnnouncer`, on the Excalidraw board page. One announcer per canvas;
// the `liveRegion` host slot (./LiveRegion.tsx) renders its message.
//
// When it speaks (as tldraw did): the selection changed while the select tool is at rest (a click, a box
// selection once the pointer is up, Alt+Arrow, the content list, an api select); Alt+R repeats it; the
// keyboard entering the canvas (F6, "Skip to canvas") says what is selected. It stays quiet while a text
// editor is open (the typed words are the editor's) and when the selection empties.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { type Atom, atom, react, untracked } from '../../../lib/signals.ts'
import { describeSelection } from './describe.ts'
import { selectionLevel } from './traversal.ts'

export interface Announcer {
  /** the region's current words ('' between two announcements of the same words) */
  readonly message: Atom<string>
  /** says `words` now (again, if they are the same as the last) */
  say(words: string): void
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

function createAnnouncer(canvas: LobbyCanvas): Announcer {
  const message = atom('a11y.announcement', '')
  let pending: number | null = null
  const say = (words: string) => {
    if (!words) return
    if (pending !== null) cancelAnimationFrame(pending)
    // the same words twice in a row are only heard again after a change: empty the region first, then
    // speak a frame later (tldraw's repeat-shape action did the same)
    message.set('')
    pending = requestAnimationFrame(() => {
      pending = null
      message.set(words)
    })
  }
  // the selection as last seen at rest (a pointer move re-runs the effect without a new selection)
  let last = ''
  const stop = react('a11y.announce-selection', () => {
    const gesture = canvas.gesture()
    const editing = canvas.editingId()
    const key = canvas.selection.join('\n')
    if (gesture !== 'idle' || editing !== null) return
    if (key === last) return
    last = key
    if (!key) return
    const words = untracked(() => selectionWords(canvas))
    if (words) say(words)
  })
  return {
    message,
    say,
    saySelection: () => say(selectionWords(canvas)),
    dispose() {
      stop()
      if (pending !== null) cancelAnimationFrame(pending)
      pending = null
    },
  }
}
