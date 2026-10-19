// Identifier generators (docs/M1-CONTRACTS.md §2). Same algorithm and shape as
// @draftroom/dev-assets newId(): `<prefix>_` + 20 base62 characters from crypto.getRandomValues.

// 'air' (wave L, L1-1): an AI run id (contracts ai.ts AiRunId), minted per run and never stored.
// 'imp', 'imb' (wave R, 0035): an import job and one board row of it; 'chk' (0036): a chat hook; 'rsp' (wave R): a
// restore's spooled upload (its job's source_ref, backup/restore.ts). 'rvi', 'rvr', 'rve' (wave S, 0037): a review
// item, round and event. 'act', 'brk' (wave V, 0038): a live activity and a breakout session.
export const ID_PREFIXES = [
  'usr',
  'wsp',
  'prj',
  'inv',
  'thr',
  'cmt',
  'snp',
  'wks',
  'vot',
  'air',
  'imp',
  'imb',
  'chk',
  'rsp',
  'rvi',
  'rvr',
  'rve',
  'act',
  'brk',
] as const
export type IdPrefix = (typeof ID_PREFIXES)[number]

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const ID_BODY = 20
const BOARD_BODY = 10

/** Uniform random string over `alphabet` (rejection sampling avoids modulo bias). */
function randomString(alphabet: string, length: number): string {
  // Largest multiple of the alphabet size that fits in a byte; bytes at or above it are discarded.
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= limit) continue
      out += alphabet[b % alphabet.length]
      if (out.length === length) break
    }
  }
  return out
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomString(BASE62, ID_BODY)}`
}

const ID_RE: Record<IdPrefix, RegExp> = Object.fromEntries(
  ID_PREFIXES.map((p) => [p, new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`)]),
) as Record<IdPrefix, RegExp>

/** Accepts 10-40 body characters, exactly like @draftroom/contracts' prefixed id schemas. */
export function isId(prefix: IdPrefix, value: unknown): value is string {
  return typeof value === 'string' && ID_RE[prefix].test(value)
}

/**
 * Board ids keep the milestone-0 sync format: `b-` + 10 lowercase base36 characters. Lowercase only,
 * because board ids name SQLite files and case-insensitive filesystems would otherwise split rooms.
 */
export function newBoardId(): string {
  return `b-${randomString(BASE36, BOARD_BODY)}`
}
