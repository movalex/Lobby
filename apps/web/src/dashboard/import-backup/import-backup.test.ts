// The web side of board backups (wave R, WS4): the client's requests and refusals, the board's download action, the
// restore dialog's words, and the board menu's "Download backup (.lobby)" line (shown to whoever may export, never to
// a name-only guest).
import type { ImportJobView } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportRequestError } from '../imports/client.ts'
import { backupErrorText, backupTicket, restoreBackup } from './client.ts'
import { downloadBoardBackup } from './download.ts'
import { ImportBackupDialog, looksLikeBackup, restoreStatusText } from './ImportBackupDialog.tsx'

const W = 'wsp_0123456789abcdefghij'
const BID = 'b-abc1234567'
const IMP = 'imp_0123456789abcdefghij'
const DOWNLOAD_URL = 'https://api.example.test/api/boards/b/backup?ticket=bkt_x'
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fetchSpy = vi.fn<typeof fetch>()
beforeEach(() => {
  fetchSpy.mockReset()
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => vi.unstubAllGlobals())

describe('the backup client', () => {
  it('asks for a ticket same-origin with the client header and parses the answer', async () => {
    fetchSpy.mockResolvedValueOnce(json(200, { url: `/api/boards/${BID}/backup?ticket=bkt_x`, expiresAt: 1 }))
    expect(await backupTicket(BID)).toEqual({ url: `/api/boards/${BID}/backup?ticket=bkt_x`, expiresAt: 1 })
    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`/api/boards/${BID}/backup/ticket`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    expect((init.headers as Record<string, string>)['x-lobby-client']).toBeTruthy()
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })

  it('sends the file itself as the restore body, with the backup type and the query', async () => {
    fetchSpy.mockResolvedValueOnce(json(202, { importId: IMP, location: `/api/imports/${IMP}` }))
    const file = new Blob(['PK'], { type: 'application/zip' })
    const query = { title: 'Pitch & co', projectId: 'prj_0123456789abcdefghij' }
    const started = await restoreBackup(W, file, query)
    expect(started).toEqual({ importId: IMP, location: `/api/imports/${IMP}` })
    const [path, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(`/api/workspaces/${W}/backups?projectId=prj_0123456789abcdefghij&title=Pitch+%26+co`)
    expect(init.body).toBe(file)
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/vnd.lobby.board+zip')
    fetchSpy.mockResolvedValueOnce(json(202, { importId: IMP, location: `/api/imports/${IMP}` }))
    await restoreBackup(W, file)
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe(`/api/workspaces/${W}/backups`)
  })

  it('rejects with the api’s code, or unavailable without an answer, or BAD_RESPONSE', async () => {
    const code = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => null,
        (err: unknown) => err,
      )
      expect(e).toBeInstanceOf(ImportRequestError)
      return (e as ImportRequestError).code
    }
    fetchSpy.mockResolvedValueOnce(json(400, { error: { code: 'BACKUP_INVALID', message: 'x' } }))
    expect(await code(restoreBackup(W, new Blob(['x'])))).toBe('BACKUP_INVALID')
    fetchSpy.mockResolvedValueOnce(json(403, { error: { code: 'EXPORT_DISABLED', message: 'x' } }))
    expect(await code(backupTicket(BID))).toBe('EXPORT_DISABLED')
    fetchSpy.mockResolvedValueOnce(new Response('<html>', { status: 502 }))
    expect(await code(backupTicket(BID))).toBe('HTTP_502')
    fetchSpy.mockRejectedValueOnce(new TypeError('offline'))
    expect(await code(backupTicket(BID))).toBe('unavailable')
    fetchSpy.mockResolvedValueOnce(json(200, { nope: true }))
    expect(await code(backupTicket(BID))).toBe('BAD_RESPONSE')
  })

  it('says every refusal in words', () => {
    const codes = ['BACKUP_INVALID', 'BACKUP_TOO_LARGE', 'BACKUP_FROM_NEWER_LOBBY', 'EXPORT_DISABLED', 'unavailable']
    for (const c of codes) expect(backupErrorText(c), c).not.toBe(backupErrorText('SOMETHING_ELSE'))
    expect(backupErrorText('BACKUP_FROM_NEWER_LOBBY')).toContain('newer version of Lobby')
  })
})

describe('Download backup (.lobby) on a board', () => {
  it('opens the ticket’s URL as a download and says what is in it', async () => {
    const notices: { text: string; tone?: string }[] = []
    const opened: string[] = []
    const ok = await downloadBoardBackup(BID, (n) => notices.push(n), {
      ticket: async () => ({ url: DOWNLOAD_URL, expiresAt: 1 }),
      open: (url) => opened.push(url),
    })
    expect(ok).toBe(true)
    expect(opened).toEqual([DOWNLOAD_URL])
    expect(notices.at(-1)?.text).toContain('comments and history are not in it')
  })

  it('a refusal is said on the board, and nothing is opened', async () => {
    const notices: { text: string; tone?: string }[] = []
    const opened: string[] = []
    const ok = await downloadBoardBackup(BID, (n) => notices.push(n), {
      ticket: () => Promise.reject(new ImportRequestError('BACKUP_TOO_LARGE', 413)),
      open: (url) => opened.push(url),
    })
    expect(ok).toBe(false)
    expect(opened).toEqual([])
    expect(notices.at(-1)).toMatchObject({ tone: 'error', text: backupErrorText('BACKUP_TOO_LARGE') })
  })
})

describe('the restore dialog', () => {
  const job = (board: Partial<ImportJobView['boards'][number]>): ImportJobView => ({
    importId: IMP,
    workspaceId: W,
    projectId: null,
    source: 'lobby-backup',
    status: board.status ?? 'running',
    startedBy: { id: 'usr_0123456789abcdefghij', name: 'Alice' },
    createdAt: '',
    updatedAt: '',
    finishedAt: null,
    resumable: false,
    resumeNeedsToken: false,
    boards: [
      {
        id: 'imb_0123456789abcdefghij',
        sourceRef: null,
        title: 'Pitch',
        status: 'running',
        progress: {
          phase: 'files',
          items: { read: 0, total: null },
          files: { done: 3, failed: 0, total: 12, bytes: 0 },
        },
        boardId: null,
        errorCode: null,
        summary: null,
        finishedAt: null,
        ...board,
      },
    ],
  })

  it('follows the job: progress, done, failed; and without the job routes, an honest line', () => {
    expect(restoreStatusText(null)).toMatchObject({ done: false, failed: false })
    expect(restoreStatusText(null).text).toContain('appears on your dashboard')
    expect(restoreStatusText(job({})).text).toBe('Restoring the files… Files 3 of 12.')
    expect(restoreStatusText(job({ status: 'done', boardId: 'b-new1234567' }))).toMatchObject({ done: true })
    expect(restoreStatusText(job({ status: 'failed', errorCode: 'QUOTA_EXCEEDED' }))).toMatchObject({
      failed: true,
      text: backupErrorText('QUOTA_EXCEEDED'),
    })
  })

  it('takes .lobby files (by name or type) and says what a backup holds', () => {
    expect(looksLikeBackup({ name: 'Pitch.lobby', type: '' })).toBe(true)
    expect(looksLikeBackup({ name: 'x', type: 'application/vnd.lobby.board+zip' })).toBe(true)
    expect(looksLikeBackup({ name: 'Pitch.lobby.json', type: 'application/json' })).toBe(false)
    const html = renderToStaticMarkup(
      createElement(ImportBackupDialog, {
        workspaceId: W,
        workspaceName: 'Dev Studio',
        projects: [],
        defaultProjectId: null,
        onClose: () => {},
      }),
    )
    expect(html).toContain('data-testid="import-backup-dialog"')
    expect(html).toContain('type="file"')
    expect(html).toContain('accept=".lobby,application/vnd.lobby.board+zip"')
    expect(html).toContain('comments and history are not part of a backup')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
