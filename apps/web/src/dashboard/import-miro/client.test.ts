// WS1 (wave R): the live import job and Miro clients, with fetch mocked. Each call goes to its contract path with the
// right method, the session cookie and the client revision header; the Miro token travels only in the JSON body
// (never in a URL or a header); every answer is parsed with its schema; the reads never throw (a 404, a refusal, an
// unreadable body, no network: null or []); the writes reject ImportRequestError with the api's code or 'unavailable'.
import {
  IMPORT_ROUTES,
  importCancelPath,
  importJobPath,
  importListPath,
  importPausePath,
  importResumePath,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  miroBoardsPath,
  miroImportPath,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelImport,
  getImportJob,
  ImportRequestError,
  importErrorOf,
  importReportHref,
  importsAvailable,
  listImportJobs,
  pauseImport,
  resumeImport,
} from '../imports/client.ts'
import { listMiroBoards, startMiroImport } from './client.ts'
import { BOARDS, IMP, jobView, TOKEN, W } from './test-kit.ts'

interface Sent {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  credentials: string | undefined
}

const fetchSpy = vi.fn()
let answers: (() => Response | Promise<Response>)[] = []
const sent: Sent[] = []

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refusal = (status: number, code: string) =>
  json({ error: { code, message: `refused ${code}` } }, status)

beforeEach(() => {
  answers = []
  sent.length = 0
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(async (url: string, init: RequestInit = {}) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      credentials: init.credentials,
    })
    const next = answers.shift()
    if (!next) throw new TypeError('no answer queued')
    return next()
  })
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => vi.unstubAllGlobals())

const rejection = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(ImportRequestError)
  return e as ImportRequestError
}

/** Nothing sent anywhere but the body carries the token: not the URL, not a header. */
const tokenOnlyInBody = (s: Sent) => {
  expect(s.url).not.toContain(TOKEN)
  expect(JSON.stringify(s.headers)).not.toContain(TOKEN)
  expect((s.body as { token?: string }).token).toBe(TOKEN)
}

describe('the import job client (live)', () => {
  it('is available, and the CSV is a same-origin path', () => {
    expect(importsAvailable()).toBe(true)
    expect(importReportHref(IMP)).toBe(`/api/imports/${IMP}/report.csv`)
    expect(IMPORT_ROUTES.report).toBe('/api/imports/:id/report.csv')
  })

  it('reads a job: GET its path, same origin, the client revision, parsed with ImportJobView', async () => {
    answers.push(() => json(jobView()))
    const view = await getImportJob(IMP)
    expect(view?.importId).toBe(IMP)
    expect(view?.boards[0]?.progress.items).toEqual({ read: 1200, total: 2000 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ url: importJobPath(IMP), method: 'GET', credentials: 'same-origin' })
    expect(sent[0]?.headers[LOBBY_CLIENT_HEADER]).toBe(String(LOBBY_CLIENT_REV))
    expect(sent[0]?.body).toBeUndefined()
  })

  it('a read never throws: 404, refusal, unreadable body, network all answer null', async () => {
    answers.push(() => refusal(404, 'NOT_FOUND'))
    expect(await getImportJob(IMP)).toBeNull()
    answers.push(() => refusal(403, 'FORBIDDEN'))
    expect(await getImportJob(IMP)).toBeNull()
    answers.push(() => json({ importId: 'not an id' }))
    expect(await getImportJob(IMP)).toBeNull()
    answers.push(() => new Response('<html>', { status: 200 }))
    expect(await getImportJob(IMP)).toBeNull()
    answers.push(() => Promise.reject(new TypeError('offline')))
    expect(await getImportJob(IMP)).toBeNull()
  })

  it('lists the caller’s jobs with ?mine=1, parsed; [] on any failure', async () => {
    answers.push(() => json({ imports: [jobView()] }))
    const list = await listImportJobs(W, { mine: true })
    expect(list.map((j) => j.importId)).toEqual([IMP])
    expect(sent[0]).toMatchObject({ url: importListPath(W, true), method: 'GET' })
    expect(sent[0]?.url).toBe(`/api/workspaces/${W}/imports?mine=1`)
    answers.push(() => json({ imports: [] }))
    await listImportJobs(W)
    expect(sent[1]?.url).toBe(`/api/workspaces/${W}/imports`)
    answers.push(() => refusal(404, 'NOT_FOUND'))
    expect(await listImportJobs(W, { mine: true })).toEqual([])
    answers.push(() => json({ imports: [{ importId: IMP }] }))
    expect(await listImportJobs(W, { mine: true })).toEqual([])
    answers.push(() => Promise.reject(new TypeError('offline')))
    expect(await listImportJobs(W, { mine: true })).toEqual([])
  })

  it('cancel and pause: POST with no body, the 202 view parsed', async () => {
    answers.push(() => json(jobView({ status: 'cancelled' }), 202))
    expect((await cancelImport(IMP)).status).toBe('cancelled')
    answers.push(() => json(jobView({ status: 'running' }), 202))
    expect((await pauseImport(IMP)).status).toBe('running')
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ['POST', importCancelPath(IMP), undefined],
      ['POST', importPausePath(IMP), undefined],
    ])
    expect(sent[0]?.headers['content-type']).toBeUndefined()
  })

  it('resume sends { token } in the body only when given', async () => {
    answers.push(() => json(jobView({ status: 'queued' }), 202))
    await resumeImport(IMP)
    expect(sent[0]).toMatchObject({ method: 'POST', url: importResumePath(IMP), body: undefined })
    answers.push(() => json(jobView({ status: 'queued' }), 202))
    await resumeImport(IMP, TOKEN)
    expect(sent[1]?.body).toEqual({ token: TOKEN })
    expect(sent[1]?.headers['content-type']).toBe('application/json')
    tokenOnlyInBody(sent[1] as Sent)
  })

  it('a write rejects with the api’s code, or unavailable; never with the server’s words', async () => {
    answers.push(() => refusal(400, 'IMPORT_SECRET_REQUIRED'))
    const e1 = await rejection(resumeImport(IMP))
    expect([e1.code, e1.status]).toEqual(['IMPORT_SECRET_REQUIRED', 400])
    expect(e1.message).not.toContain('refused')
    answers.push(() => refusal(409, 'IMPORT_WRONG_STATE'))
    expect((await rejection(pauseImport(IMP))).code).toBe('IMPORT_WRONG_STATE')
    answers.push(() => new Response('gateway', { status: 502 }))
    expect((await rejection(cancelImport(IMP))).code).toBe('unavailable')
    answers.push(() => Promise.reject(new TypeError('offline')))
    expect((await rejection(cancelImport(IMP))).code).toBe('unavailable')
    answers.push(() => json({ nope: true }, 202))
    expect((await rejection(cancelImport(IMP))).code).toBe('unavailable')
    expect(importErrorOf(new Error('x')).code).toBe('unavailable')
  })
})

describe('the Miro client (live)', () => {
  it('lists boards: POST the boards path, { token, ...input } in the body, parsed', async () => {
    answers.push(() => json(BOARDS))
    const r = await listMiroBoards(W, TOKEN, { query: 'road', offset: 50 })
    expect(r.team.name).toBe(BOARDS.team.name)
    expect(r.boards.map((b) => b.id)).toEqual(['uXjVOD1Ab2c=', 'uXjVOD9Zz9z='])
    expect(sent[0]).toMatchObject({ url: miroBoardsPath(W), method: 'POST', credentials: 'same-origin' })
    expect(sent[0]?.body).toEqual({ token: TOKEN, query: 'road', offset: 50 })
    expect(sent[0]?.headers[LOBBY_CLIENT_HEADER]).toBe(String(LOBBY_CLIENT_REV))
    tokenOnlyInBody(sent[0] as Sent)
    answers.push(() => json(BOARDS))
    await listMiroBoards(W, TOKEN)
    expect(sent[1]?.body).toEqual({ token: TOKEN })
  })

  it('starts an import: POST the start path, the 202 StartImportResponse', async () => {
    answers.push(() => json({ importId: IMP, location: importJobPath(IMP) }, 202))
    const input = {
      boards: [{ miroBoardId: 'uXjVOD1Ab2c=', title: 'Q4 roadmap' }],
      projectId: 'prj_0123456789ab',
    }
    const r = await startMiroImport(W, TOKEN, input)
    expect(r).toEqual({ importId: IMP, location: importJobPath(IMP) })
    expect(sent[0]).toMatchObject({ url: miroImportPath(W), method: 'POST' })
    expect(sent[0]?.body).toEqual({ token: TOKEN, ...input })
    expect(sent[0]?.body).not.toHaveProperty('referencePdf')
    tokenOnlyInBody(sent[0] as Sent)
  })

  it('rejects with the Miro and job codes, or unavailable; the token is in no error', async () => {
    for (const [status, code] of [
      [400, 'MIRO_TOKEN_INVALID'],
      [403, 'MIRO_SCOPE_MISSING'],
      [404, 'MIRO_BOARD_NOT_VISIBLE'],
      [429, 'MIRO_RATE_LIMITED'],
      [502, 'MIRO_UNAVAILABLE'],
      [403, 'CREATOR_REQUIRED'],
    ] as const) {
      answers.push(() => refusal(status, code))
      const e = await rejection(listMiroBoards(W, TOKEN))
      expect([e.code, e.status]).toEqual([code, status])
      expect(`${e.message} ${e.stack ?? ''}`).not.toContain(TOKEN)
    }
    for (const [status, code] of [
      [409, 'IMPORT_BUSY'],
      [429, 'IMPORT_DAILY_LIMIT'],
      [413, 'IMPORT_TOO_LARGE'],
    ] as const) {
      answers.push(() => refusal(status, code))
      const e = await rejection(startMiroImport(W, TOKEN, { boards: [{ miroBoardId: 'uXjVOD1Ab2c=' }] }))
      expect(e.code).toBe(code)
    }
    answers.push(() => Promise.reject(new TypeError('offline')))
    expect((await rejection(listMiroBoards(W, TOKEN))).code).toBe('unavailable')
    answers.push(() => json({ team: {} }))
    expect((await rejection(listMiroBoards(W, TOKEN))).code).toBe('unavailable')
    answers.push(() => json({ importId: IMP }, 202))
    const e = await rejection(startMiroImport(W, TOKEN, { boards: [{ miroBoardId: 'uXjVOD1Ab2c=' }] }))
    expect(e.code).toBe('unavailable')
  })
})
