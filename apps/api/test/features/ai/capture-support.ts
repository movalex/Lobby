// Wave N (WS5, N5-1): shared setup for the Capture the room api tests. The ai world (support.ts) with the capture
// routes registered (index.ts aiSettings.capturePending: none pending, while the api's own list still holds them),
// DRAFTROOM_AI_VISION=on unless a test says otherwise, every JSON log line kept, and helpers for the three routes.
// OpenAI is the local fake (fake-openai.ts); nothing calls the real API.

import { EventHub } from '../../../src/events/hub.ts'
import { aiSettings } from '../../../src/features/ai/index.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../../helpers.ts'
import { png } from '../thumbnails/images.ts'
import { type FakeOpenAi, startFakeOpenAi } from './fake-openai.ts'
import { type AiSync, aiSync, grant, TEST_KEY } from './support.ts'

export interface CaptureWorld {
  api: TestApi
  sync: AiSync
  openai: FakeOpenAi
  /** Every JSON log line of the api (`logs.length = 0` to start again). */
  logs: Record<string, unknown>[]
  /** Dev Studio owner. */
  alice: Client
  /** Editor grant on `board`. */
  bob: Client
  /** Commenter grant on `board`. */
  carol: Client
  /** Viewer grant on `board`. */
  dave: Client
  board: string
  /** Another Dev Studio board, alice's. */
  other: string
  close(): Promise<void>
}

export async function captureWorld(
  opts: {
    env?: Record<string, string>
    key?: string | null
    vision?: boolean
    inFlight?: typeof aiSettings.inFlight
  } = {},
): Promise<CaptureWorld> {
  const openai = await startFakeOpenAi()
  const sync = aiSync()
  const logs: Record<string, unknown>[] = []
  const saved = { inFlight: structuredClone(aiSettings.inFlight), pending: aiSettings.capturePending }
  if (opts.inFlight) aiSettings.inFlight = opts.inFlight
  aiSettings.capturePending = {}
  const env: Record<string, string> = {
    OPENAI_BASE_URL: openai.url,
    OPENAI_MODEL: 'gpt-5.4-mini',
    ...(opts.key === null ? {} : { OPENAI_API_KEY: opts.key ?? TEST_KEY }),
    ...(opts.vision === false ? {} : { DRAFTROOM_AI_VISION: 'on' }),
    ...opts.env,
  }
  let api: TestApi
  try {
    api = await createTestApi({
      deps: {
        syncInternal: sync,
        events: new EventHub(),
        logger: { level: 'info', stream: { write: (l: string) => void logs.push(JSON.parse(l)) } },
      },
      env,
    })
  } finally {
    aiSettings.inFlight = saved.inFlight
    aiSettings.capturePending = saved.pending
  }
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const dave = await api.login('dave')
  const board = await createBoard(alice, DEV_STUDIO, 'Workshop wall')
  const other = await createBoard(alice, DEV_STUDIO, 'Another board')
  await grant(alice, board, bob, 'editor')
  await grant(alice, board, carol, 'commenter')
  await grant(alice, board, dave, 'viewer')
  return {
    api,
    sync,
    openai,
    logs,
    alice,
    bob,
    carol,
    dave,
    board,
    other,
    async close() {
      await api.close()
      await openai.close()
    },
  }
}

export const photoUrl = (board: string, mode = 'notes') =>
  `/api/boards/${board}/ai/capture/photo?mode=${mode}`
export const boardImageUrl = (board: string) => `/api/boards/${board}/ai/capture/board-image`
export const transcriptUrl = (board: string) => `/api/boards/${board}/ai/capture/transcript`

/** A small real PNG (the api reads only its header). */
export const PHOTO = png(64, 48)

/** POSTs `bytes` as a raw image body with `cookie`'s session. */
export function postPhoto(
  w: Pick<CaptureWorld, 'api'>,
  cookie: string,
  board: string,
  bytes: Buffer = PHOTO,
  opts: { mode?: string; contentType?: string } = {},
) {
  return w.api.app.inject({
    method: 'POST',
    url: photoUrl(board, opts.mode ?? 'notes'),
    payload: bytes,
    headers: { origin: ORIGIN, cookie, 'content-type': opts.contentType ?? 'image/png' },
  })
}

export const transcript = (c: Pick<Client, 'req'>, board: string, body: Record<string, unknown>) =>
  c.req('POST', transcriptUrl(board), body)

export const boardImage = (c: Pick<Client, 'req'>, board: string, body: Record<string, unknown>) =>
  c.req('POST', boardImageUrl(board), body)

/** Every capture row of the ledger, oldest first. */
export async function captureRows(api: TestApi) {
  return (
    await api.db.query<{
      user_id: string
      board_id: string
      action: string
      status: string
      reserved_tokens: number
      charged_tokens: number
      input_tokens: number | null
      output_tokens: number | null
    }>(
      `SELECT user_id, board_id, action, status, reserved_tokens::float8 AS reserved_tokens,
              charged_tokens::float8 AS charged_tokens, input_tokens, output_tokens
         FROM ai_usage WHERE action LIKE 'capture-%' ORDER BY id`,
    )
  ).rows
}

/** Adds `n` capture ledger rows for `userId` today (as earlier captures would have). */
export async function seedCaptureRows(
  w: Pick<CaptureWorld, 'api'>,
  userId: string,
  board: string,
  action: 'capture-photo' | 'capture-transcript',
  n: number,
) {
  const now = w.api.clock.now()
  const day = now.toISOString().slice(0, 10)
  for (let i = 0; i < n; i++)
    await w.api.db.query(
      `INSERT INTO ai_usage (workspace_id, board_id, user_id, action, day, status, reserved_tokens,
                             charged_tokens, created_at)
       VALUES ($1, $2, $3, $4, $5::date, 'done', 10, 10, $6)`,
      [DEV_STUDIO, board, userId, action, day, new Date(now.getTime() - 2 * 3_600_000)],
    )
}

/** A stored image version of `board` with a display copy in the blob store (what the worker leaves). */
export async function storedImage(
  w: Pick<CaptureWorld, 'api'>,
  board: string,
  bytes: Buffer,
  opts: { kind?: string; display?: boolean; suffix?: string } = {},
): Promise<{ assetId: string; versionId: string }> {
  const s = opts.suffix ?? Math.random().toString(36).slice(2, 12).padEnd(10, '0')
  const assetId = `ast_capture${s}`
  const versionId = `ver_capture${s}`
  const alice = (await w.api.db.one<{ id: string }>("SELECT id FROM users WHERE handle = 'alice'")).id
  await w.api.db.query(
    `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                 size_bytes, sha256, uploaded_by, status)
     VALUES ($1, $2, $3, $4, 'wall.png', 'image/png', 'image/png', $5, $6, $7, $8, 'ready')`,
    [versionId, assetId, DEV_STUDIO, board, opts.kind ?? 'image', bytes.length, 'a'.repeat(64), alice],
  )
  if (opts.display !== false) {
    const drv = `drv_capture${s}`
    const key = `assets/${assetId}/${versionId}/d/${drv}.png`
    await w.api.blobs.put(key, bytes, { contentType: 'image/png', contentLength: bytes.length })
    await w.api.db.query(
      `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key)
       VALUES ($1, $2, 0, 'display', NULL, 64, 48, 'image/png', $3, $4)`,
      [drv, versionId, bytes.length, key],
    )
  }
  return { assetId, versionId }
}

/** An image element showing `versionId` (as the sync stores it). */
export const imageElement = (id: string, versionId: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 320,
  height: 240,
  angle: 0,
  isDeleted: false,
  frameId: null,
  fileId: versionId,
  status: 'saved',
  customData: {},
  ...extra,
})
