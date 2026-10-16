// Shared setup of the review tests (wave S, WS1): the guests world (alice owns Dev Studio, bob owns the private
// board `board`, carol is a member without access, erin an account outside the workspace), people on review links,
// asset versions as rows, and the review routes' paths.

import {
  GetReviewResponse,
  LOBBY_CLIENT_HEADER,
  type ReviewItem,
  ReviewItemResponse,
  reviewItemsPath,
  reviewPath,
  reviewStatusPath,
} from '@draftroom/contracts'
import { SUPERSEDES_HEADER } from '@draftroom/dev-assets'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import type { Client } from '../../helpers.ts'
import { DEV_STUDIO, ORIGIN } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest, setupWorld, type World } from '../guests/support.ts'

export { DEV_STUDIO }

export type Caller = { req: Client['req'] | GuestClient['req'] }

export interface ReviewWorld extends World {
  /** a name-only guest on a commenter link of `board` */
  ana: GuestClient
  /** a name-only guest on a viewer link */
  vic: GuestClient
  /** a name-only guest on a workshop (editor) link */
  ed: GuestClient
}

export async function reviewWorld(opts: Parameters<typeof setupWorld>[0] = {}): Promise<ReviewWorld> {
  const w = await setupWorld(opts)
  const commenter = await guestLink(w.bob, w.board, { role: 'commenter' })
  const viewer = await guestLink(w.bob, w.board, { role: 'viewer' })
  const editor = await guestLink(w.bob, w.board, { role: 'editor' })
  const ana = await joinAsGuest(w.api, commenter.url, 'Ana')
  const vic = await joinAsGuest(w.api, viewer.url, 'Vic')
  const ed = await joinAsGuest(w.api, editor.url, 'Ed')
  return { ...w, ana, vic, ed }
}

/** A direct board grant (an account's role on the board). */
export async function grant(w: World, userId: string, role: 'editor' | 'commenter' | 'viewer') {
  await w.api.db.query(
    `INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [w.board, userId, role],
  )
}

let seq = 0
const pad = (n: number) => String(n).padStart(16, '0')

/** An asset version row uploaded to `boardId` (no bytes: the review routes only read the rows). */
export async function versionRow(
  w: World,
  boardId: string,
  opts: { assetId?: string; createdAt?: Date; kind?: 'image' | 'video' | 'pdf' | 'other' } = {},
): Promise<{ assetId: string; versionId: string }> {
  seq++
  const assetId = opts.assetId ?? `ast_test${pad(seq)}`
  const versionId = `ver_test${pad(seq)}`
  await w.api.db.query(
    `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                 size_bytes, sha256, uploaded_by, status, created_at)
     VALUES ($1, $2, $3, $4, 'Key art.png', 'image/png', 'image/png', $5, 10, $6, $7, 'ready', $8)`,
    [
      versionId,
      assetId,
      DEV_STUDIO,
      boardId,
      opts.kind ?? 'image',
      'a'.repeat(64),
      w.bob.userId,
      opts.createdAt ?? new Date(Date.now() + seq * 1000),
    ],
  )
  return { assetId, versionId }
}

export const rev3 = { [LOBBY_CLIENT_HEADER]: '3' }

export async function getReview(c: Caller, boardId: string) {
  const res = await c.req('GET', reviewPath(boardId))
  expect(res.statusCode, res.body).toBe(200)
  return GetReviewResponse.parse(res.json())
}

export async function mark(
  c: Caller,
  boardId: string,
  body: { elementId: string; kind: 'frame' | 'file'; assetId?: string; label: string },
): Promise<ReviewItem> {
  const res = await c.req('POST', reviewItemsPath(boardId), body)
  expect(res.statusCode, res.body).toBe(201)
  return ReviewItemResponse.parse(res.json()).item
}

export function setStatus(
  c: Caller,
  boardId: string,
  itemId: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return c.req('POST', reviewStatusPath(boardId, itemId), body)
}

export const codeOf = (res: LightMyRequestResponse) =>
  (res.json() as { error?: { code?: string } }).error?.code

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** "Upload new version": a PNG uploaded to `boardId` with X-Lobby-Supersedes naming `versionId`. */
export function supersede(
  w: World,
  c: Client,
  boardId: string,
  versionId: string,
  name = 'cut-2.png',
): Promise<LightMyRequestResponse> {
  return w.api.app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/assets`,
    payload: PNG,
    headers: {
      origin: ORIGIN,
      'content-type': 'image/png',
      'x-file-name': name,
      cookie: c.cookie,
      [SUPERSEDES_HEADER]: versionId,
    },
  })
}
