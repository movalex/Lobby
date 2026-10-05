// Copying to the clipboard from the Share dialog, without ever waiting on it forever (G2).
//
// `navigator.clipboard.writeText` can reject (no permission, insecure context) but also never settle at
// all: the document is not focused (the person clicked Create and switched windows), or a permission
// prompt is open. The dialog used to await it before showing the link it had just created, so the Create
// button stayed on "Creating…" although the api had answered in milliseconds. Nothing in the dialog
// waits on this any more except the one sentence that says whether the copy worked.

import { copyText } from '../lib/clipboard.ts'

/** How long a copy may take before the dialog says "Couldn't copy" (the link is shown either way). */
export const COPY_TIMEOUT_MS = 1500

/**
 * `copy(text)`, but always settles: true when it copied, false when the browser refused, threw or did
 * not answer within `timeoutMs`. A copy that succeeds after the timeout is ignored (the caller has
 * already shown "Couldn't copy", and the Copy button is one click away).
 */
export function copyBounded(
  text: string,
  timeoutMs: number = COPY_TIMEOUT_MS,
  copy: (text: string) => Promise<boolean> = copyText,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    Promise.resolve()
      .then(() => copy(text))
      .then(
        (ok) => {
          clearTimeout(timer)
          resolve(ok === true)
        },
        () => {
          clearTimeout(timer)
          resolve(false)
        },
      )
  })
}
