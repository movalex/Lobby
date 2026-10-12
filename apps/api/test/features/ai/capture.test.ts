// Wave N (WS5, N5-1): Capture the room, POST /api/boards/:bid/ai/capture/{photo,board-image,transcript}, with the
// fake OpenAI (fake-openai.ts): who may capture (guests refused before any read, viewers and commenters refused, AI
// off and vision off hidden as 404), the photo's limits (magic bytes 415, 5 MiB 413, 5000 px 413), the board image
// read from the board's own display copy only, the per-day caps counted from the ledger (429 with the ledger as it
// was), a failed call that keeps its row, the image sent only as a data URL to the configured base URL, logs without
// image bytes, transcript text or answers, and a long transcript read in 4 parts plus the reduce within the budgets.

import {
  CAPTURE_ERROR_CODES,
  CAPTURE_PHOTO_MAX_BYTES,
  CaptureResponse,
  type CaptureResult,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { PHOTO_TOO_MUCH, TRANSCRIPT_TOO_MUCH } from '../../../src/features/ai/capture.ts'
import { ORIGIN } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { jpeg, png, webpLossy } from '../thumbnails/images.ts'
import {
  boardImage,
  type CaptureWorld,
  captureRows,
  captureWorld,
  imageElement,
  PHOTO,
  postPhoto,
  seedCaptureRows,
  seedSpentTokens,
  storedImage,
  transcript,
} from './capture-support.ts'
import { FAKE_IMAGE_TOKENS, imagePartsOf, userTextOf } from './fake-openai.ts'
import { expectError, run } from './support.ts'

let w: CaptureWorld | null = null
afterEach(async () => {
  await w?.close()
  w = null
})
const world = async (opts: Parameters<typeof captureWorld>[0] = {}) => {
  w = await captureWorld(opts)
  return w
}

const MEETING = [
  'Ana: We should move the shoot to the 14th.',
  'Bo: Agreed, the studio is free then.',
  'Ana: Bo will send the revised budget by Friday.',
  'Sam: Travel is over budget by ten percent.',
].join('\n')

describe('who may capture', () => {
  it('a guest gets 403 GUEST_ACCOUNT_REQUIRED before anything of the board is read', async () => {
    const x = await world()
    const link = await guestLink(x.alice, x.board, { role: 'editor' })
    const guest = await joinAsGuest(x.api, link.url, 'Sam')
    // the query spy: every statement from here on
    const seen: string[] = []
    const db = x.api.db as unknown as Record<string, (...a: unknown[]) => unknown>
    for (const m of ['query', 'one', 'maybeOne']) {
      const orig = db[m]?.bind(x.api.db)
      if (!orig) continue
      db[m] = (sql: unknown, ...rest: unknown[]) => {
        seen.push(String(sql))
        return orig(sql, ...rest)
      }
    }
    const photo = await x.api.app.inject({
      method: 'POST',
      url: `/api/boards/${x.board}/ai/capture/photo?mode=notes`,
      payload: PHOTO,
      headers: { origin: ORIGIN, cookie: guest.cookie, 'content-type': 'image/png' },
    })
    expectError(photo, 403, 'GUEST_ACCOUNT_REQUIRED')
    expectError(
      await guest.req('POST', `/api/boards/${x.board}/ai/capture/board-image`, { elementId: 'img-1' }),
      403,
      'GUEST_ACCOUNT_REQUIRED',
    )
    expectError(
      await guest.req('POST', `/api/boards/${x.board}/ai/capture/transcript`, { text: MEETING }),
      403,
      'GUEST_ACCOUNT_REQUIRED',
    )
    const touched = seen.filter((s) => /\b(boards|board_members|ai_usage|asset_|ai_board|ai_notice)/.test(s))
    expect(touched).toEqual([])
    expect(x.sync.snapshots).toEqual([])
    expect(x.openai.requests).toEqual([])
  })

  it('a viewer and a commenter get 403; someone who cannot see the board gets 404; editors and owners may', async () => {
    const x = await world()
    for (const c of [x.dave, x.carol]) {
      expectError(await postPhoto(x, c.cookie, x.board), 403, 'FORBIDDEN')
      expectError(await transcript(c, x.board, { text: MEETING }), 403, 'FORBIDDEN')
    }
    const erin = await x.api.login('erin')
    expectError(await postPhoto(x, erin.cookie, x.other), 404, 'NOT_FOUND')
    expectError(await transcript(erin, x.other, { text: MEETING }), 404, 'NOT_FOUND')
    expect(x.openai.requests).toEqual([])
    expect((await postPhoto(x, x.bob.cookie, x.board)).statusCode).toBe(200)
    expect((await transcript(x.alice, x.board, { text: MEETING })).statusCode).toBe(200)
  })

  it('AI off for Lobby, or no key, hides every capture route (404); the board’s own switch says why (403)', async () => {
    for (const opts of [{ env: { DRAFTROOM_AI: 'off' } }, { key: null }]) {
      const x = await world(opts)
      expectError(await postPhoto(x, x.alice.cookie, x.board), 404, 'NOT_FOUND')
      expectError(await transcript(x.alice, x.board, { text: MEETING }), 404, 'NOT_FOUND')
      expectError(await boardImage(x.alice, x.board, { elementId: 'img-1' }), 404, 'NOT_FOUND')
      expect(x.openai.requests).toEqual([])
      await x.close()
      w = null
    }
    const x = await world()
    const off = await x.alice.req('PUT', `/api/boards/${x.board}/ai/settings`, { enabled: false })
    expect(off.statusCode, off.body).toBe(200)
    expectError(await postPhoto(x, x.alice.cookie, x.board), 403, 'AI_BOARD_OFF')
    expectError(await transcript(x.alice, x.board, { text: MEETING }), 403, 'AI_BOARD_OFF')
    expect(x.openai.requests).toEqual([])
  })

  it('vision off makes the photo routes 404 while the transcript route works', async () => {
    const x = await world({ vision: false })
    expectError(await postPhoto(x, x.alice.cookie, x.board), 404, 'NOT_FOUND')
    expectError(await boardImage(x.alice, x.board, { elementId: 'img-1' }), 404, 'NOT_FOUND')
    const res = await transcript(x.alice, x.board, { text: MEETING })
    expect(res.statusCode, res.body).toBe(200)
    const body = CaptureResponse.parse(res.json())
    expect(body.result.kind).toBe('transcript')
    // no cap applies to photos that cannot be sent
    expect(body.quota).toEqual({ photosLeftToday: null, transcriptsLeftToday: 9 })
    expect(x.openai.requests).toHaveLength(1)
    expect(imagePartsOf(x.openai.requests[0] as never)).toEqual([])
  })
})

describe('the photo', () => {
  it('a JPEG, PNG or WebP by its bytes becomes notes (mode notes), a diagram (diagram), or what the model saw (auto)', async () => {
    const x = await world()
    const notes = await postPhoto(x, x.alice.cookie, x.board, PHOTO, { mode: 'notes' })
    expect(notes.statusCode, notes.body).toBe(200)
    const n = CaptureResponse.parse(notes.json())
    expect(n.runId).toMatch(/^air_[0-9A-Za-z]{20}$/)
    expect(n.result).toEqual({
      kind: 'notes',
      notes: [
        { text: 'Keep the demo', color: 'yellow', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
        { text: 'Shorter stand-ups', color: 'light-red', box: { x: 0.1, y: 0.4, w: 0.2, h: 0.2 } },
        { text: 'Slow builds', color: 'orange', box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 } },
      ],
      groups: [
        { name: 'Keep', notes: [0, 1] },
        { name: 'Change', notes: [2] },
      ],
    })
    expect(n.quota).toEqual({ photosLeftToday: 9, transcriptsLeftToday: 10 })
    const d = CaptureResponse.parse(
      (
        await postPhoto(x, x.alice.cookie, x.board, jpeg(800, 600), {
          mode: 'diagram',
          contentType: 'image/jpeg',
        })
      ).json(),
    )
    expect(d.result).toEqual({
      kind: 'diagram',
      nodes: [
        { id: 'n1', label: 'Brief', shape: 'ellipse', box: { x: 0.05, y: 0.4, w: 0.15, h: 0.1 } },
        { id: 'n2', label: 'Sketch', shape: 'rect', box: { x: 0.4, y: 0.4, w: 0.15, h: 0.1 } },
        { id: 'n3', label: 'Happy?', shape: 'diamond' },
      ],
      edges: [
        { from: 'n1', to: 'n2', kind: 'arrow' },
        { from: 'n2', to: 'n3', kind: 'line', label: 'review' },
      ],
    })
    expect(d.quota.photosLeftToday).toBe(8)
    const a = await postPhoto(x, x.alice.cookie, x.board, webpLossy(300, 200), {
      mode: 'auto',
      contentType: 'image/webp',
    })
    expect(CaptureResponse.parse(a.json()).result.kind).toBe('notes')
    expect(x.openai.requests.map((r) => r.body.response_format?.json_schema?.name)).toEqual([
      'lobby_capture_notes',
      'lobby_capture_diagram',
      'lobby_capture_auto',
    ])
    // one ledger row per capture
    const rows = await captureRows(x.api)
    expect(rows.map((r) => [r.action, r.status])).toEqual([
      ['capture-photo', 'done'],
      ['capture-photo', 'done'],
      ['capture-photo', 'done'],
    ])
  })

  it('refuses what is not a JPEG, PNG or WebP (415), past 4 MiB (413) or past 4096 px (413), before any call', async () => {
    const x = await world()
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)])
    expectError(await postPhoto(x, x.alice.cookie, x.board, gif), 415, CAPTURE_ERROR_CODES.badImage)
    // a PNG that says it is a JPEG, and a body that is no image type at all
    expectError(
      await postPhoto(x, x.alice.cookie, x.board, PHOTO, { contentType: 'image/jpeg' }),
      415,
      CAPTURE_ERROR_CODES.badImage,
    )
    expectError(
      await postPhoto(x, x.alice.cookie, x.board, Buffer.from('{}'), { contentType: 'application/json' }),
      415,
      CAPTURE_ERROR_CODES.badImage,
    )
    const big = webpLossy(1000, 800, 5 * 1024 * 1024)
    expect(big.length).toBeGreaterThan(CAPTURE_PHOTO_MAX_BYTES)
    expectError(
      await postPhoto(x, x.alice.cookie, x.board, big, { contentType: 'image/webp' }),
      413,
      CAPTURE_ERROR_CODES.imageTooLarge,
    )
    expectError(
      await postPhoto(x, x.alice.cookie, x.board, png(5000, 8)),
      413,
      CAPTURE_ERROR_CODES.imageTooLarge,
    )
    expectError(
      await postPhoto(x, x.alice.cookie, x.board, png(8, 4097)),
      413,
      CAPTURE_ERROR_CODES.imageTooLarge,
    )
    expectError(await postPhoto(x, x.alice.cookie, x.board, PHOTO, { mode: 'sketch' }), 400, 'BAD_REQUEST')
    expect(x.openai.requests).toEqual([])
    expect(await captureRows(x.api)).toEqual([])
    // exactly at the limits is fine
    expect((await postPhoto(x, x.alice.cookie, x.board, png(4096, 4))).statusCode).toBe(200)
  })

  it('the image goes only as a data URL (detail high) in the body of the request to the configured base URL', async () => {
    const x = await world({ env: { DRAFTROOM_AI_VISION_MODEL: 'gpt-5.4-vision-test' } })
    const bytes = png(120, 90, [200, 30, 30])
    expect((await postPhoto(x, x.alice.cookie, x.board, bytes)).statusCode).toBe(200)
    expect(x.openai.requests).toHaveLength(1)
    const req = x.openai.requests[0] as (typeof x.openai.requests)[number]
    // the fake is the configured OPENAI_BASE_URL: the request reached it, as POST /v1/chat/completions
    expect(req.headers.authorization).toMatch(/^Bearer sk-test-/)
    expect(req.body.model).toBe('gpt-5.4-vision-test')
    expect(req.body.store).toBe(false)
    expect(imagePartsOf(req)).toEqual([
      { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' },
    ])
    // nowhere else: no link to Lobby, no blob or file URL, and the instructions' text carries no image
    const withoutImage = req.raw.replace(bytes.toString('base64'), '')
    expect(withoutImage).not.toMatch(/https?:\/\/|blob:|file:|\/api\/|base64,[A-Za-z0-9+/]{20}/)
    expect(userTextOf(req)).toMatch(/sticky notes/)
  })

  it('logs carry counts and the run id only: no image bytes, transcript text, title or model output', async () => {
    const x = await world()
    const bytes = png(100, 70, [10, 200, 10])
    x.logs.length = 0
    const p = CaptureResponse.parse((await postPhoto(x, x.alice.cookie, x.board, bytes)).json())
    const t = CaptureResponse.parse(
      (await transcript(x.alice, x.board, { text: MEETING, title: 'Secret Launch Sync' })).json(),
    )
    const text = JSON.stringify(x.logs)
    for (const s of [
      bytes.toString('base64').slice(0, 40),
      'Keep the demo',
      'Slow builds',
      'Theme 1',
      'Decision 1',
      'move the shoot',
      'revised budget',
      'Secret Launch Sync',
    ])
      expect(text, s).not.toContain(s)
    const lines = x.logs.filter((l) => l.msg === 'ai capture')
    expect(lines.map((l) => (l.ai as { action: string; runId: string }).action)).toEqual([
      'capture-photo',
      'capture-transcript',
    ])
    expect(lines.map((l) => (l.ai as { runId: string }).runId)).toEqual([p.runId, t.runId])
  })

  it('a failed model call keeps its ledger row (502, charged as reserved when its cost is unknown, 0 for a 4xx)', async () => {
    const x = await world()
    x.openai.next({ kind: 'status', status: 500 })
    expectError(await postPhoto(x, x.alice.cookie, x.board), 502, 'AI_UPSTREAM')
    x.openai.next({ kind: 'status', status: 400 })
    expectError(await postPhoto(x, x.alice.cookie, x.board), 502, 'AI_UPSTREAM')
    x.openai.next({ kind: 'content', content: { nope: true } })
    expectError(await postPhoto(x, x.alice.cookie, x.board), 502, 'AI_BAD_OUTPUT')
    const rows = await captureRows(x.api)
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed'])
    expect(rows[0]?.charged_tokens).toBe(rows[0]?.reserved_tokens)
    expect(rows[1]?.charged_tokens).toBe(0)
    expect(rows[2]?.charged_tokens).toBeGreaterThan(FAKE_IMAGE_TOKENS)
    // and they count toward the day's cap (10 a person)
    const ok = CaptureResponse.parse((await postPhoto(x, x.alice.cookie, x.board)).json())
    expect(ok.quota.photosLeftToday).toBe(6)
  })

  it('the model’s answer is validated: boxes clamped into the photo, unknown nodes and empty notes dropped', async () => {
    const x = await world()
    x.openai.next({
      kind: 'content',
      content: {
        notes: [
          { text: '  **Bold** idea‮  ', color: 'ultraviolet', box: { x: 0.9, y: -3, w: 0.5, h: 2 } },
          { text: '   ', color: 'yellow', box: { x: 0, y: 0, w: 0.1, h: 0.1 } },
          { text: 'Second', color: 'green', box: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } },
        ],
        groups: [
          { name: 'G', notes: [1, 2, 2, 99] },
          { name: 'Empty', notes: [] },
        ],
      },
    })
    const r = CaptureResponse.parse((await postPhoto(x, x.alice.cookie, x.board)).json()).result as Extract<
      CaptureResult,
      { kind: 'notes' }
    >
    expect(r.notes).toEqual([
      { text: 'Bold idea', color: 'yellow', box: { x: 0.9, y: 0, w: 0.1, h: 1 } },
      { text: 'Second', color: 'green', box: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } },
    ])
    expect(r.groups).toEqual([{ name: 'G', notes: [1] }])
  })
})

describe('an image already on the board', () => {
  it('is read from the board’s own display copy and sent like a photo', async () => {
    const x = await world()
    const bytes = png(64, 48, [1, 2, 3])
    const { versionId } = await storedImage(x, x.board, bytes)
    x.sync.setElements(x.board, [imageElement('img-1', versionId)])
    const res = await boardImage(x.alice, x.board, { elementId: 'img-1', mode: 'diagram' })
    expect(res.statusCode, res.body).toBe(200)
    expect(CaptureResponse.parse(res.json()).result.kind).toBe('diagram')
    expect(imagePartsOf(x.openai.requests[0] as never)).toEqual([
      { url: `data:image/png;base64,${bytes.toString('base64')}`, detail: 'high' },
    ])
    expect((await captureRows(x.api)).map((r) => r.action)).toEqual(['capture-photo'])
  })

  it('an element on another board, a missing one, a non-image, a PDF page or another board’s file is 404', async () => {
    const x = await world()
    const mine = await storedImage(x, x.board, PHOTO)
    const theirs = await storedImage(x, x.other, PHOTO)
    const pdf = await storedImage(x, x.board, PHOTO, { kind: 'pdf' })
    const noCopy = await storedImage(x, x.board, PHOTO, { display: false })
    x.sync.setElements(x.other, [imageElement('img-other', theirs.versionId)])
    x.sync.setElements(x.board, [
      { id: 'note-1', type: 'stickynote', x: 0, y: 0, width: 200, height: 200, isDeleted: false },
      imageElement('img-theirs', theirs.versionId),
      imageElement('img-pdf', pdf.versionId),
      imageElement('img-page', mine.versionId, { fileId: `${mine.versionId}.p2` }),
      imageElement('img-gone', mine.versionId, { isDeleted: true }),
      imageElement('img-nocopy', noCopy.versionId),
    ])
    for (const elementId of [
      'img-other',
      'note-1',
      'nope',
      'img-theirs',
      'img-pdf',
      'img-page',
      'img-gone',
      'img-nocopy',
    ]) {
      const res = await boardImage(x.alice, x.board, { elementId })
      expectError(res, 404, 'NOT_FOUND')
      // words of its own, never the unknown route's "Not found." (the web reads that one as "capture is not here")
      expect((res.json() as { error: { message: string } }).error.message, elementId).not.toBe('Not found.')
    }
    expect(x.openai.requests).toEqual([])
    expect(await captureRows(x.api)).toEqual([])
  })
})

/** Token budgets far above anything a test spends: only the per-day capture caps can refuse. */
const UNLIMITED_TOKENS = {
  DRAFTROOM_AI_USER_DAILY_TOKENS: '100000000',
  DRAFTROOM_AI_DAILY_TOKENS: '100000000',
  DRAFTROOM_AI_GLOBAL_DAILY_TOKENS: '1000000000',
}

describe('the per-day caps', () => {
  it('over the person’s photo cap: 429 AI_CAPTURE_DAILY_CAP, the ledger as it was, nothing sent', async () => {
    const x = await world({ env: { DRAFTROOM_AI_VISION_USER_DAILY: '2' } })
    const left: (number | null)[] = []
    for (let i = 0; i < 2; i++)
      left.push(
        CaptureResponse.parse((await postPhoto(x, x.alice.cookie, x.board)).json()).quota.photosLeftToday,
      )
    expect(left).toEqual([1, 0])
    const sent = x.openai.requests.length
    const res = await postPhoto(x, x.alice.cookie, x.board)
    expectError(res, 429, CAPTURE_ERROR_CODES.dailyCap)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(x.openai.requests).toHaveLength(sent)
    expect((await captureRows(x.api)).map((r) => [r.user_id, r.action])).toEqual([
      [x.alice.userId, 'capture-photo'],
      [x.alice.userId, 'capture-photo'],
    ])
    // the board image counts as a photo too
    expectError(await boardImage(x.alice, x.board, { elementId: 'img-1' }), 429, CAPTURE_ERROR_CODES.dailyCap)
    // another person still may
    expect((await postPhoto(x, x.bob.cookie, x.board)).statusCode).toBe(200)
  })

  it('over the global photo cap (rows of the day from earlier captures): 429 for everyone', async () => {
    const x = await world({ env: { DRAFTROOM_AI_VISION_GLOBAL_DAILY: '3' } })
    await seedCaptureRows(x, x.alice.userId, x.board, 'capture-photo', 2)
    const ok = CaptureResponse.parse((await postPhoto(x, x.bob.cookie, x.board)).json())
    expect(ok.quota.photosLeftToday).toBe(0)
    expectError(await postPhoto(x, x.bob.cookie, x.board), 429, CAPTURE_ERROR_CODES.dailyCap)
    expectError(await postPhoto(x, x.alice.cookie, x.board), 429, CAPTURE_ERROR_CODES.dailyCap)
    expect(x.openai.requests).toHaveLength(1)
    // transcripts have their own cap
    expect((await transcript(x.bob, x.board, { text: MEETING })).statusCode).toBe(200)
  })

  it('over the person’s transcript cap: 429, and the photo cap is untouched', async () => {
    const x = await world({ env: { DRAFTROOM_AI_TRANSCRIPT_USER_DAILY: '1' } })
    const first = CaptureResponse.parse((await transcript(x.alice, x.board, { text: MEETING })).json())
    expect(first.quota).toEqual({ photosLeftToday: 10, transcriptsLeftToday: 0 })
    expectError(await transcript(x.alice, x.board, { text: MEETING }), 429, CAPTURE_ERROR_CODES.dailyCap)
    expect((await postPhoto(x, x.alice.cookie, x.board)).statusCode).toBe(200)
    expect((await captureRows(x.api)).map((r) => r.action)).toEqual(['capture-transcript', 'capture-photo'])
  })

  it('12 photos at once from one person: exactly 10 are accepted (the cap holds under concurrency)', async () => {
    // the token budgets lifted out of the way (UNLIMITED_TOKENS), so only the day's cap can refuse: without its check in
    // the reservation's transaction all 12 would pass the earlier read-only precheck together
    const x = await world({ inFlight: { user: 20, workspace: 20, total: 20 }, env: UNLIMITED_TOKENS })
    const res = await Promise.all(Array.from({ length: 12 }, () => postPhoto(x, x.alice.cookie, x.board)))
    const codes = res.map((r) => r.statusCode).sort()
    expect(codes.filter((c) => c === 200)).toHaveLength(10)
    expect(codes.filter((c) => c === 429)).toHaveLength(2)
    for (const r of res.filter((r) => r.statusCode === 429)) expectError(r, 429, CAPTURE_ERROR_CODES.dailyCap)
    expect(await captureRows(x.api)).toHaveLength(10)
  })
})

describe('the transcript', () => {
  it('becomes themes, decisions and actions; an owner the transcript never names is dropped', async () => {
    const x = await world()
    x.openai.next({
      kind: 'content',
      content: {
        themes: [{ name: 'Schedule', notes: ['Shoot moves to the 14th', 'Shoot moves to the 14th.'] }],
        decisions: ['We shoot on the 14th', 'we shoot on the 14th!'],
        actions: [
          { text: 'Send the revised budget', owner: 'Bo' },
          { text: 'Call the client', owner: 'Mallory' },
        ],
      },
    })
    const res = await transcript(x.alice, x.board, { text: MEETING, title: 'Launch sync' })
    expect(res.statusCode, res.body).toBe(200)
    expect(CaptureResponse.parse(res.json()).result).toEqual({
      kind: 'transcript',
      themes: [{ name: 'Schedule', notes: ['Shoot moves to the 14th'] }],
      decisions: ['We shoot on the 14th'],
      actions: [{ text: 'Send the revised budget', owner: 'Bo' }, { text: 'Call the client' }],
    })
    // one part: no reduce call
    expect(x.openai.requests).toHaveLength(1)
    expect(userTextOf(x.openai.requests[0] as never)).toContain('"Launch sync"')
    expect(userTextOf(x.openai.requests[0] as never)).toContain(MEETING)
  })

  it('a long transcript: 4 map calls of at most the input cap, then the reduce, within the reservation and the budgets', async () => {
    const x = await world({ env: { DRAFTROOM_AI_MAX_INPUT_TOKENS: '1500' } })
    const line = (i: number) =>
      `Speaker ${i % 3}: point number ${i} about the launch plan and the schedule we keep.`
    const text = Array.from({ length: 400 }, (_, i) => line(i)).join('\n')
    const res = await transcript(x.alice, x.board, { text })
    expect(res.statusCode, res.body).toBe(200)
    const names = x.openai.requests.map((r) => r.body.response_format?.json_schema?.name)
    expect(names).toEqual([
      'lobby_capture_meeting',
      'lobby_capture_meeting',
      'lobby_capture_meeting',
      'lobby_capture_meeting',
      'lobby_capture_themes',
    ])
    // every map prompt within the input cap (the api's own estimate: a token per 3 UTF-8 bytes)
    for (const r of x.openai.requests.slice(0, 4)) {
      const bytes =
        Buffer.byteLength(userTextOf(r), 'utf8') +
        Buffer.byteLength(String(r.body.messages?.[0]?.content ?? ''), 'utf8') +
        Buffer.byteLength(JSON.stringify(r.body.response_format?.json_schema?.schema), 'utf8')
      expect(Math.ceil(bytes / 3) + 64).toBeLessThanOrEqual(1500)
      expect(userTextOf(r)).toMatch(/part [1-4] of 4/)
    }
    // the reduce named every note of the parts into one theme (the fake's answer)
    const result = CaptureResponse.parse(res.json()).result as Extract<CaptureResult, { kind: 'transcript' }>
    expect(result.themes.map((t) => t.name)).toEqual(['Whole meeting'])
    expect(result.decisions).toEqual(['Decision 1', 'Decision 2', 'Decision 3', 'Decision 4'])
    // one ledger row for the five calls, charged what they cost, never more than reserved
    const [row, ...more] = await captureRows(x.api)
    expect(more).toEqual([])
    expect(row?.status).toBe('done')
    expect(row?.charged_tokens).toBeLessThanOrEqual(row?.reserved_tokens ?? 0)
    expect(row?.input_tokens).toBeGreaterThan(0)
    const log = x.logs.find((l) => l.msg === 'ai capture') as {
      ai: { calls: number; parts: number; truncated: boolean }
    }
    expect(log.ai).toMatchObject({ calls: 5, parts: 4, truncated: true })
  })

  it('a transcript whose worst case does not fit the person’s token budget is refused before any call', async () => {
    const x = await world({ env: { DRAFTROOM_AI_USER_DAILY_TOKENS: '4000' } })
    const text = 'Ana: '.concat('a long point about the plan '.repeat(400))
    expectError(await transcript(x.alice, x.board, { text }), 429, 'AI_USER_BUDGET')
    expect(x.openai.requests).toEqual([])
    expect(await captureRows(x.api)).toEqual([])
  })

  it('refuses an empty or over-long transcript (400) before any call', async () => {
    const x = await world()
    expectError(await transcript(x.alice, x.board, { text: '   ' }), 400, 'BAD_REQUEST')
    expectError(await transcript(x.alice, x.board, { text: 'x'.repeat(60_001) }), 400, 'BAD_REQUEST')
    expectError(await transcript(x.alice, x.board, { text: MEETING, extra: 1 }), 400, 'BAD_REQUEST')
    expect(x.openai.requests).toEqual([])
  })

  it('a map call that fails fails the capture and keeps its row; a failed reduce keeps the parts’ themes', async () => {
    const x = await world({ env: { DRAFTROOM_AI_MAX_INPUT_TOKENS: '1500' } })
    const text = Array.from(
      { length: 60 },
      (_, i) => `Bo: item ${i} of the meeting that we discussed at length today.`,
    ).join('\n')
    x.openai.next({ kind: 'status', status: 503 })
    expectError(await transcript(x.alice, x.board, { text }), 502, 'AI_UPSTREAM')
    // every part was asked (in parallel), and no reduce after a failed part
    const parts = x.openai.requests.length
    expect(parts).toBeGreaterThan(1)
    expect(x.openai.requests.map((r) => r.body.response_format?.json_schema?.name)).toEqual(
      Array.from({ length: parts }, () => 'lobby_capture_meeting'),
    )
    expect((await captureRows(x.api)).map((r) => r.status)).toEqual(['failed'])
    x.openai.requests.length = 0
    const answer = (i: number) => ({
      kind: 'content' as const,
      content: { themes: [{ name: `Part ${i}`, notes: [`Note ${i}`] }], decisions: [], actions: [] },
    })
    x.openai.next(...Array.from({ length: parts }, (_, i) => answer(i)), {
      kind: 'content',
      content: { nope: 1 },
    })
    const ok = await transcript(x.alice, x.board, { text })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(x.openai.requests).toHaveLength(parts + 1)
    const result = CaptureResponse.parse(ok.json()).result as Extract<CaptureResult, { kind: 'transcript' }>
    expect(result.themes.map((t) => t.name).sort()).toEqual(
      Array.from({ length: parts }, (_, i) => `Part ${i}`).sort(),
    )
    expect((await captureRows(x.api)).map((r) => r.status)).toEqual(['failed', 'done'])
  })
})

describe('the capture’s own output cap (DRAFTROOM_AI_CAPTURE_MAX_OUTPUT_TOKENS)', () => {
  it('every capture call may answer at length (6,000 tokens by default), and reserves that; the board’s AI keeps its own cap', async () => {
    const x = await world({ env: { DRAFTROOM_AI_MAX_OUTPUT_TOKENS: '1000' } })
    expect((await postPhoto(x, x.alice.cookie, x.board)).statusCode).toBe(200)
    expect((await transcript(x.alice, x.board, { text: MEETING })).statusCode).toBe(200)
    expect(x.openai.requests.map((r) => r.body.max_completion_tokens)).toEqual([6_000, 6_000])
    // what a photo reserves: its prompt, the image and the whole answer it may give
    const [photo] = await captureRows(x.api)
    expect(photo?.reserved_tokens).toBeGreaterThan(6_000 + 10_000)
    // the board's own AI (here Diagram from words) is not raised by it
    const run_ = await run(x.bob, x.board, {
      action: 'diagram',
      shapeIds: [],
      direction: 'down',
      prompt: 'a flow',
    })
    expect(run_.statusCode, run_.body).toBe(200)
    expect(x.openai.requests.at(-1)?.body.max_completion_tokens).toBe(1_000)
  })

  it('the operator’s value goes on every call of a long transcript (the parts and the themes call) and on photos', async () => {
    const x = await world({
      env: { DRAFTROOM_AI_CAPTURE_MAX_OUTPUT_TOKENS: '9000', DRAFTROOM_AI_MAX_INPUT_TOKENS: '1500' },
    })
    const text = Array.from({ length: 120 }, (_, i) => `Speaker ${i % 3}: point ${i} about the plan.`).join(
      '\n',
    )
    expect((await transcript(x.alice, x.board, { text })).statusCode).toBe(200)
    expect((await postPhoto(x, x.alice.cookie, x.board)).statusCode).toBe(200)
    const caps = x.openai.requests.map((r) => r.body.max_completion_tokens)
    expect(caps.length).toBeGreaterThan(2)
    expect(new Set(caps)).toEqual(new Set([9_000]))
  })

  it('a wall too big for one answer (cut off at the cap): 502 that says to photograph part of it; the row is kept', async () => {
    const x = await world()
    const cut = { kind: 'content' as const, content: '{"notes":[{"text":"Shorter', finish: 'length' }
    x.openai.next(cut)
    const notes = await postPhoto(x, x.alice.cookie, x.board, PHOTO, { mode: 'notes' })
    expectError(notes, 502, 'AI_BAD_OUTPUT')
    expect(notes.json().error.message).toBe(PHOTO_TOO_MUCH.notes)
    x.openai.next(cut)
    const diagram = await postPhoto(x, x.alice.cookie, x.board, PHOTO, { mode: 'diagram' })
    expect(diagram.json().error.message).toBe(PHOTO_TOO_MUCH.diagram)
    x.openai.next(cut)
    expect((await postPhoto(x, x.alice.cookie, x.board, PHOTO, { mode: 'auto' })).json().error.message).toBe(
      PHOTO_TOO_MUCH.auto,
    )
    x.openai.next(cut)
    const meeting = await transcript(x.alice, x.board, { text: MEETING })
    expectError(meeting, 502, 'AI_BAD_OUTPUT')
    expect(meeting.json().error.message).toBe(TRANSCRIPT_TOO_MUCH)
    // the calls were made and cost what they cost: their rows stay, failed
    expect((await captureRows(x.api)).map((r) => [r.action, r.status])).toEqual([
      ['capture-photo', 'failed'],
      ['capture-photo', 'failed'],
      ['capture-photo', 'failed'],
      ['capture-transcript', 'failed'],
    ])
    // any other unusable answer keeps the general words
    x.openai.next({ kind: 'content', content: 'not json' })
    expect((await postPhoto(x, x.alice.cookie, x.board)).json().error.message).toBe(
      'The AI’s answer couldn’t be used. Try again.',
    )
  })

  it('asks for boxes with at most two decimals (a shorter answer for a wall of notes)', async () => {
    const x = await world()
    for (const mode of ['notes', 'diagram', 'auto'])
      expect((await postPhoto(x, x.alice.cookie, x.board, PHOTO, { mode })).statusCode).toBe(200)
    for (const r of x.openai.requests) expect(userTextOf(r)).toContain('at most two decimals (such as 0.25)')
  })
})

describe('what a capture reserves, and the budgets’ refusals', () => {
  it('a 60,000-character meeting reserves a token per 3 bytes and the answers, not a token per byte: it runs for someone who used 80,000 tokens today', async () => {
    const x = await world()
    await seedSpentTokens(x, x.alice.userId, x.board, 80_000)
    let text = ''
    for (let i = 0; text.length < 60_000; i++)
      text += `Speaker ${i % 4}: we went through point ${i} of the launch plan and agreed on the next step.\n`
    text = text.slice(0, 60_000).trim()
    const res = await transcript(x.alice, x.board, { text })
    expect(res.statusCode, res.body).toBe(200)
    const [row, ...more] = await captureRows(x.api)
    expect(more).toEqual([])
    // two parts of about 12,000 tokens, their answers and the themes call: about 54,000 (a token a byte: about 124,000)
    expect(x.openai.requests.length).toBe(3)
    expect(row?.reserved_tokens).toBeGreaterThan(60_000 / 3)
    expect(row?.reserved_tokens).toBeLessThan(60_000)
    expect(row?.charged_tokens).toBeLessThanOrEqual(row?.reserved_tokens ?? 0)
  })

  it('too little left for this capture is said as such (not “you’ve used your allowance”); a shorter transcript may still fit', async () => {
    const x = await world({ env: { DRAFTROOM_AI_USER_DAILY_TOKENS: '10000' } })
    const photo = await postPhoto(x, x.alice.cookie, x.board)
    expectError(photo, 429, 'AI_USER_BUDGET')
    expect(photo.json().error.message).toBe(
      'There isn’t enough of your AI allowance left today for a photo capture. It resets at midnight UTC.',
    )
    expect(Number(photo.headers['retry-after'])).toBeGreaterThan(0)
    const long = await transcript(x.alice, x.board, {
      text: 'Ana: '.concat('a long point about the plan '.repeat(800)),
    })
    expectError(long, 429, 'AI_USER_BUDGET')
    expect(long.json().error.message).toBe(
      'There isn’t enough of your AI allowance left today for a transcript this long. A shorter one may fit; the allowance resets at midnight UTC.',
    )
    expect(x.openai.requests).toEqual([])
    expect(await captureRows(x.api)).toEqual([])
    // nothing was used: a short meeting fits what is left
    expect((await transcript(x.alice, x.board, { text: MEETING })).statusCode).toBe(200)
  })

  it('the workspace’s and Lobby’s budgets say the same of this capture', async () => {
    const ws = await world({ env: { DRAFTROOM_AI_DAILY_TOKENS: '10000' } })
    const a = await postPhoto(ws, ws.alice.cookie, ws.board)
    expectError(a, 429, 'AI_BUDGET_EXHAUSTED')
    expect(a.json().error.message).toBe(
      'There isn’t enough of this workspace’s AI budget left today for this capture. It resets at midnight UTC.',
    )
    await ws.close()
    w = null
    const all = await world({ env: { DRAFTROOM_AI_GLOBAL_DAILY_TOKENS: '10000' } })
    const b = await postPhoto(all, all.alice.cookie, all.board)
    expectError(b, 429, 'AI_GLOBAL_BUDGET')
    expect(b.json().error.message).toBe(
      'There isn’t enough of Lobby’s AI budget left today for this capture. It resets at midnight UTC.',
    )
  })
})
