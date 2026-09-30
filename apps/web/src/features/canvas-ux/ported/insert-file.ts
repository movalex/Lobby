// Insert file (the toolbar's button and Ctrl/Cmd+U): the file picker, then the canvas's file placement
// (`canvas.files.insert`, 3g's part: the upload and the layout of a drop). Files land where the board is
// looking. Only opens the picker, so it may run from Lobby's chrome too.
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { geometry, NotImplementedError } from '../../../canvas/api/index.ts'

export function pickFiles(ctx: CanvasFeatureContext): Promise<void> {
  if (ctx.canvas.readOnly()) return Promise.resolve()
  const doc = ctx.canvas.container()?.ownerDocument ?? document
  const input = doc.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.hidden = true
  input.setAttribute('data-testid', 'insert-file-input')
  doc.body.append(input)
  return new Promise<void>((resolve) => {
    const done = () => {
      input.remove()
      resolve()
    }
    input.addEventListener('cancel', done, { once: true })
    input.addEventListener(
      'change',
      () => {
        const files = [...(input.files ?? [])]
        input.remove()
        if (!files.length) return resolve()
        void insertFiles(ctx, files).then(resolve)
      },
      { once: true },
    )
    input.click()
  })
}

/** Places `files` in the middle of the view through the canvas's file placement. */
export async function insertFiles(ctx: CanvasFeatureContext, files: readonly File[]): Promise<void> {
  const at = geometry.center(ctx.canvas.viewport.get())
  try {
    await ctx.canvas.files.insert(files, at)
  } catch (e) {
    console.error('canvas-ux: files could not be inserted', e)
    ctx.notify({
      key: 'insert-file',
      tone: 'error',
      text:
        e instanceof NotImplementedError
          ? 'Adding files is not available on this canvas yet.'
          : 'The files could not be added to this board.',
      testId: 'insert-file-error',
    })
  }
}
