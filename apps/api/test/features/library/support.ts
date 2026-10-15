// Wave Q (WS2): the element library's test world. Dev Studio: `owner` owns it (the first login); `admin` is an admin,
// `carol`, `dave` and `vic` members, all creators (dev addresses); `pat` is a member who is not a creator (an address
// outside the creator domains: an outsider); `gina` is a workspace guest (what a board-only collaborator is) with an
// editor grant on `target` and `source`; `erin` is a stranger to Dev Studio; `sam` a name-only guest (a guest link on
// `guestBoard`). Boards (carol's): `source` and `target` are workspace-edit, `viewOnly` is private with a viewer grant
// for vic.

import {
  LIBRARY_ROUTES,
  LibraryItemSummary,
  libraryItemPath,
  libraryItemsPath,
  libraryPlacePath,
} from '@draftroom/contracts'
import type { Db, Queryable } from '@draftroom/db'
import { newId } from '@draftroom/dev-assets'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { derivativeKey } from '../../../src/files/blobs.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest } from '../guests/support.ts'
import { upload } from '../history/helpers.ts'

export const WS = DEV_STUDIO
export const LIB = `/api/workspaces/${WS}/library`
export { LIBRARY_ROUTES }

const base = {
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null,
  roundness: null,
  seed: 7,
  version: 3,
  versionNonce: 11,
  isDeleted: false,
  boundElements: null,
  updated: 1_790_000_000_000,
  created: null,
  link: null as string | null,
  locked: false,
}

export type El = Record<string, unknown>

/** A plain box (valid by the room's element check). */
export const rect = (id: string, x = 0, y = 0, extra: El = {}): El => ({
  ...base,
  id,
  type: 'rectangle',
  index: 'a0',
  x,
  y,
  width: 100,
  height: 60,
  ...extra,
})

/** An image showing a version, with file facts the client made up (the api rewrites them from the version row). */
export const image = (id: string, v: { assetId: string; versionId: string }, extra: El = {}): El => ({
  ...base,
  id,
  type: 'image',
  index: 'a1',
  x: 200,
  y: 0,
  width: 300,
  height: 200,
  fileId: v.versionId,
  status: 'saved',
  scale: [1, 1],
  crop: null,
  customData: {
    lobby: {
      file: {
        assetId: v.assetId,
        versionId: v.versionId,
        kind: 'image',
        name: 'made-up.png',
        mimeType: 'image/png',
        sizeBytes: 1,
      },
    },
  },
  ...extra,
})

export interface LibWorld {
  api: TestApi
  owner: Client
  admin: Client
  carol: Client
  dave: Client
  vic: Client
  pat: Client
  gina: Client
  erin: Client
  sam: GuestClient
  source: string
  target: string
  viewOnly: string
  guestBoard: string
}

export const sql = {
  role: (api: TestApi, userId: string, role: string) =>
    api.db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [WS, userId, role],
    ),
  grant: (api: TestApi, board: string, userId: string, role: string, by: string) =>
    api.db.query(
      `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [board, userId, role, by],
    ),
}

export async function libraryWorld(opts: { api?: TestApi } = {}): Promise<LibWorld> {
  const api = opts.api ?? (await createTestApi())
  const owner = await api.login('owner')
  const admin = await api.login('bob')
  const carol = await api.login('carol')
  const dave = await api.login('dave')
  const vic = await api.login('vic')
  const pat = await api.login('pat', 'Pat', { email: 'pat@client.example.test' })
  const gina = await api.login('gina')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    WS,
  ])
  await sql.role(api, admin.userId, 'admin')
  await sql.role(api, pat.userId, 'member')
  const source = await createBoard(carol, WS, 'Source')
  const target = await createBoard(carol, WS, 'Target')
  const viewOnly = await createBoard(carol, WS, 'View only')
  const guestBoard = await createBoard(carol, WS, 'Guests welcome')
  for (const b of [source, target]) {
    const res = await carol.req('PATCH', `/api/boards/${b}`, { visibility: 'workspace_edit' })
    expect(res.statusCode, res.body).toBe(200)
  }
  await sql.grant(api, viewOnly, vic.userId, 'viewer', carol.userId)
  // gina: a board-only collaborator (a workspace guest with editor grants)
  await sql.role(api, gina.userId, 'guest')
  for (const b of [source, target]) await sql.grant(api, b, gina.userId, 'editor', carol.userId)
  const sam = await joinAsGuest(api, (await guestLink(carol, guestBoard, { role: 'editor' })).url, 'Sam')
  return { api, owner, admin, carol, dave, vic, pat, gina, erin, sam, source, target, viewOnly, guestBoard }
}

type Req = Pick<Client, 'req'>

/** POST …/library/items with a box (or `elements`) from `board`. */
export const save = (c: Req, board: string, over: El = {}) =>
  c.req('POST', libraryItemsPath(WS), {
    scope: 'workspace',
    name: 'Approval flow',
    sourceBoardId: board,
    elements: [rect('r1'), rect('r2', 150, 40)],
    ...over,
  })

/** A save that must work: its summary. */
export async function saved(c: Req, board: string, over: El = {}) {
  const res = await save(c, board, over)
  expect(res.statusCode, res.body).toBe(201)
  return LibraryItemSummary.parse(res.json())
}

export const place = (c: Req, board: string, id: string) => c.req('POST', libraryPlacePath(board, id))
export const itemUrl = (id: string) => libraryItemPath(WS, id)

export const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code

/** A status, and the error code when it is a refusal. */
export const answer = (res: LightMyRequestResponse) =>
  res.statusCode >= 400 ? `${res.statusCode} ${code(res)}` : String(res.statusCode)

export const count = async (api: TestApi, sqlText: string, params: unknown[] = []) =>
  (await api.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sqlText}`, params)).n

/** A real upload (the files route) to `board`. */
export const uploadTo = (w: LibWorld, c: Client, board: string, name = 'photo.png') =>
  upload(w.api, c, board, name)

/** `n` live items of a scope written directly (for the caps), authored by `userId`. */
export async function fillItems(
  api: TestApi,
  n: number,
  opts: { ownerId: string | null; by: string; tag?: string },
) {
  await api.db.query(
    `INSERT INTO library_items (id, workspace_id, owner_id, name, elements, element_count, bytes, width, height,
       source, created_by, updated_by)
     SELECT 'lbi_fill' || $5 || lpad(g::text, 8, '0'), $1, $2, 'Filler', '[{}]'::jsonb, 1, 2, 1, 1,
            '{"kind":"excalidrawlib","fileName":"f","licence":"x"}'::jsonb, $3, $3
       FROM generate_series(1, $4::int) AS g`,
    [WS, opts.ownerId, opts.by, n, opts.tag ?? 'x'],
  )
}

/** A published thumb of a version (a preview derivative and its blob); returns its bytes. */
export async function addThumb(api: TestApi, v: { assetId: string; versionId: string }, bytes = 64) {
  const id = newId('drv')
  const key = derivativeKey(v.assetId, v.versionId, id, 'webp')
  const body = Buffer.alloc(bytes, 7)
  await api.blobs.put(key, body, { contentType: 'image/webp', contentLength: bytes })
  await api.db.query(
    `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key)
     VALUES ($1, $2, 0, 'thumb', NULL, 10, 10, 'image/webp', $3, $4)`,
    [id, v.versionId, bytes, key],
  )
  return body
}

/**
 * A Db whose transactions' statements are recorded, one list per transaction in order (whitespace folded), for the
 * tests of what a route locks and reads inside its transaction (PGlite runs one transaction at a time, so the races
 * themselves are the .pg tests').
 */
export function recordingDb(base: Db): { db: Db; transactions: string[][] } {
  const transactions: string[][] = []
  const wrap = (tx: Queryable, log: string[]): Queryable => {
    const note = (sql: string) => log.push(sql.replace(/\s+/g, ' ').trim())
    return {
      query: (sql, params) => {
        note(sql)
        return tx.query(sql, params)
      },
      one: (sql, params) => {
        note(sql)
        return tx.one(sql, params)
      },
      maybeOne: (sql, params) => {
        note(sql)
        return tx.maybeOne(sql, params)
      },
      exec: (sql) => tx.exec(sql),
    }
  }
  return {
    db: {
      ...base,
      transaction: (fn) =>
        base.transaction((tx) => {
          const log: string[] = []
          transactions.push(log)
          return fn(wrap(tx, log))
        }),
    },
    transactions,
  }
}
