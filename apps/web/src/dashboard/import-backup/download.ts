// OWNER: WS4 (wave R). "Download backup (.lobby)" on a board (the board menu's line in features/present-export): a
// ticket same-origin, then the `.lobby` file straight from the api's own origin (the static site's /api rewrite holds
// a response until it ends). The ticket route refuses whatever the download would (the export policy, a guest, the
// size limits), so a refusal is said on the board, never left to the browser's download bar.
import type { NoticeInput } from '../../board/board-context.ts'
import { ImportRequestError } from '../imports/client.ts'
import { backupErrorText, backupTicket } from './client.ts'

const KEY = 'board-backup'

/** Starts the browser's download of `url` (a plain navigation that the answer's Content-Disposition makes a file). */
export function openDownload(url: string, doc: Document = document): void {
  const link = doc.createElement('a')
  link.href = url
  // the same origin (dev): the file name of the answer; another origin ignores it and the header decides
  link.download = ''
  link.rel = 'noopener'
  link.style.display = 'none'
  doc.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
  }
}

/** The board menu's action. Resolves when the download was handed to the browser (or refused, with a notice). */
export async function downloadBoardBackup(
  boardId: string,
  notify: (n: NoticeInput) => void,
  deps: { ticket?: typeof backupTicket; open?: (url: string) => void } = {},
): Promise<boolean> {
  notify({ key: KEY, text: 'Preparing the backup…', testId: 'backup-download-notice', timeoutMs: null })
  try {
    const { url } = await (deps.ticket ?? backupTicket)(boardId)
    ;(deps.open ?? openDownload)(url)
    notify({
      key: KEY,
      text: 'Your backup is downloading. It holds the board and its files; comments and history are not in it.',
      testId: 'backup-download-notice',
    })
    return true
  } catch (e) {
    const code = e instanceof ImportRequestError ? e.code : 'unavailable'
    notify({ key: KEY, text: backupErrorText(code), tone: 'error', testId: 'backup-download-error' })
    return false
  }
}
