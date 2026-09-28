// Skip links (A11Y-09): the first Tab stop of a page, hidden until it has the keyboard focus. The
// dashboard's "Skip to boards" jumps past the sidebar to the board list's heading; the board's "Skip to
// canvas" jumps past the top bar and the panel rail to the canvas, the way tldraw's own "Move focus to
// canvas" does (which stays where tldraw puts it, about 20 Tab stops in).
import type { Editor } from 'tldraw'
import './skip-link.css'

export function SkipLink({ label, testId, onSkip }: { label: string; testId: string; onSkip(): void }) {
  return (
    <button type="button" className="dr-skip" data-testid={testId} onClick={onSkip}>
      {label}
    </button>
  )
}

/**
 * The canvas gets the keyboard: tldraw's own skip button when the page has shapes (it selects the
 * first shape in reading order and brings it into view, so arrow keys and Enter work at once), else
 * the editor's container (an empty board: N, R, T... start drawing).
 */
export function skipToCanvas(editor: Editor) {
  const native = editor.getContainer().querySelector<HTMLElement>('.tl-skip-to-main-content')
  if (native && editor.getCurrentPageShapesInReadingOrder().length) {
    native.click()
    return
  }
  // editor.focus() alone does nothing while tldraw already counts itself focused (it does from mount).
  editor.focus()
  editor.getContainer().focus()
}

/** "Skip to canvas", once the board's editor exists (before that there is no canvas to go to). */
export function BoardSkipLink({ editor }: { editor: Editor | null }) {
  if (!editor) return null
  return <SkipLink label="Skip to canvas" testId="skip-to-canvas" onSkip={() => skipToCanvas(editor)} />
}
