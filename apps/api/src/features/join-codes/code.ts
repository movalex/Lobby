// OWNER: WS3 (wave V, join codes; docs/WAVE-V-CONTRACTS.md §3.1). A workshop link's short join code: derived, so it can
// be shown again, and stored only as its sha256 (invitations.join_code_hash, unique over every link; 0038).
//
//   code = joinCodeFromBytes(HMAC(HMAC(ticketSecret, JOIN_CODE_HMAC_LABEL), `${invitationId}:${n}`))   (first 40 bits)
//
// `n` (invitations.join_code_n, 0..JOIN_CODE_BUMP_MAX) is bumped when another link already holds the code (≈2^-40 per
// pair of links). Rotating the ticket secret changes every code, as it does every link token: a stored hash that no
// longer matches its derivation is treated as no code (the list shows none; the code route makes a new one; resolving
// the old code answers the one 404). A code is a bearer secret: it never reaches a log line, an audit row, an error
// message or the board.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  formatJoinCode,
  JOIN_CODE_BUMP_MAX,
  JOIN_CODE_HMAC_LABEL,
  type JoinCode,
  joinCodeFromBytes,
  joinCodeWebPath,
} from '@draftroom/contracts'
import { type Db, isUniqueViolation, type Queryable } from '@draftroom/db'
import { lockBoardRow } from '../../access.ts'
import { ApiError } from '../../errors.ts'

/** The link's code at bump `n` (canonical: 8 alphabet characters). */
export function deriveJoinCode(secret: string, invitationId: string, n: number): string {
  const key = createHmac('sha256', secret).update(JOIN_CODE_HMAC_LABEL).digest()
  const mac = createHmac('sha256', key).update(`${invitationId}:${n}`).digest()
  return joinCodeFromBytes(mac.subarray(0, 5))
}

/** What invitations.join_code_hash holds for a code (sha256, lower-case hex). */
export const joinCodeHash = (code: string) => createHash('sha256').update(code).digest('hex')

/** Constant-time equality of two canonical codes (or of any two short strings). */
export function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A workshop link: a board's multi-use editor link (0038's invitations_join_code_scope_check). */
export interface WorkshopShape {
  multi_use: boolean
  role: string
  board_id: string | null
}
export const isWorkshopLink = (row: WorkshopShape) =>
  row.multi_use && row.role === 'editor' && row.board_id !== null

/** The columns a code needs from an invitation row. */
export interface CodeColumns {
  id: string
  join_code_hash: string | null
  join_code_n: number
}

/**
 * The link's current code, or null when it has none (or the ticket secret rotated since it was made: the stored hash
 * no longer matches the derivation). Compared in constant time.
 */
export function storedJoinCode(secret: string, row: CodeColumns): string | null {
  if (!row.join_code_hash) return null
  const code = deriveJoinCode(secret, row.id, row.join_code_n)
  return sameCode(joinCodeHash(code), row.join_code_hash) ? code : null
}

/** The response shape of a code (contracts JoinCode). */
export function joinCodeBody(publicOrigin: string, code: string, expiresAt: Date): JoinCode {
  return {
    code,
    display: formatJoinCode(code),
    joinUrl: `${publicOrigin}${joinCodeWebPath(code)}`,
    expiresAt: expiresAt.toISOString(),
  }
}

/**
 * A new workshop link's code, made right after the link's own transaction committed (POST …/review-links with role
 * editor while DRAFTROOM_JOIN_CODES is on), in a transaction of its own: the board row, then the link (the lock order
 * of every link route). Best effort: null when the link is gone meanwhile or the code could not be made (the creator
 * still gets the link; the code route makes it on the next ask).
 */
export async function codeForNewLink(
  db: Db,
  secret: string,
  boardId: string,
  linkId: string,
): Promise<string | null> {
  try {
    return await db.transaction(async (tx) => {
      await lockBoardRow(tx, boardId)
      // an archived board gets no join code (the §6.2 matrix; the code route refuses it too: review n1)
      const board = await tx.maybeOne<{ status: string }>('SELECT status FROM boards WHERE id = $1', [
        boardId,
      ])
      if (board?.status !== 'active') return null
      const row = await tx.maybeOne<CodeColumns & WorkshopShape>(
        `SELECT id, multi_use, role, board_id, join_code_hash, join_code_n FROM invitations
          WHERE id = $1 AND board_id = $2 AND multi_use AND revoked_at IS NULL FOR UPDATE`,
        [linkId, boardId],
      )
      if (!row || !isWorkshopLink(row)) return null
      return assignJoinCode(tx, secret, row)
    })
  } catch {
    return null
  }
}

let savepointSeq = 0

/**
 * Gives the (locked) workshop link `row` a code, unless it has a valid one; returns the code. Inside the caller's
 * transaction, with the link row locked FOR UPDATE: tries n = 0, 1, … until no other link holds the code. Each
 * UPDATE runs in a SAVEPOINT, so a concurrent link taking the same code meanwhile (the unique index) only moves on
 * to the next n instead of failing the transaction.
 */
export async function assignJoinCode(tx: Queryable, secret: string, row: CodeColumns): Promise<string> {
  const current = storedJoinCode(secret, row)
  if (current) return current
  for (let n = 0; n <= JOIN_CODE_BUMP_MAX; n++) {
    const code = deriveJoinCode(secret, row.id, n)
    const hash = joinCodeHash(code)
    const taken = await tx.maybeOne<{ id: string }>(
      'SELECT id FROM invitations WHERE join_code_hash = $1 AND id <> $2',
      [hash, row.id],
    )
    if (taken) continue
    const name = `dr_join_code_${++savepointSeq}`
    await tx.query(`SAVEPOINT ${name}`)
    try {
      await tx.query('UPDATE invitations SET join_code_hash = $2, join_code_n = $3 WHERE id = $1', [
        row.id,
        hash,
        n,
      ])
      await tx.query(`RELEASE SAVEPOINT ${name}`)
      return code
    } catch (e) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${name}`)
      if (!isUniqueViolation(e)) throw e
    }
  }
  // 16 collisions in a row: not something 40 bits do; say so without the code.
  throw new ApiError(503, 'JOIN_CODE_UNAVAILABLE', 'A join code could not be made for this link. Try again.')
}
