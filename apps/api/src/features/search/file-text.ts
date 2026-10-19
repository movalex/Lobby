// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): the extracted text of file versions (migration 0039 file_text_pages,
// file_text_state), written by the extract-text op's kind (./file-text-kind.ts) and read by search (./store.ts's file
// CTE, ./index.ts) and Ask across boards (../ai/workspace-ask.ts). Nothing here decides who may see what: every read
// that reaches a person goes through the file CTE's board and version checks first.
//
// The text is untrusted (it comes from a file anyone with edit access uploaded, parsed by the worker): it is cleaned
// again here (cleanIndexText: no control characters, which are the snippet markers), capped per page
// (FILE_TEXT_LIMITS.maxPageChars), per version (maxVersionBytes, UTF-8 bytes) and per workspace (maxWorkspaceBytes of
// body; past it an extraction stores nothing and its state says `skipped`).
//
// Pages arrive in batches (`/text`, each page an upsert). The runner (apps/worker/src/ops/extract-text.ts) sends them in
// ascending page order and starts every run with page 1 (its body empty when the page has no text), so a batch that
// holds page 1 starts the version's text afresh (an earlier attempt's pages go), and a batch whose lowest page is m
// makes every stored page >= m that it does not carry stale; the completer then turns what is stored into the
// version's state (done, empty or skipped). That is hygiene, never access: no page is searchable before its version's
// state says `done`.

import {
  ExtractTextParams,
  ExtractTextResult,
  FILE_TEXT_LIMITS,
  type WorkerOpTextInput,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { OFFICE_FORMATS } from '@draftroom/dev-assets'
import type { z } from 'zod'
import { OpRefused } from '../../worker/ops-kinds.ts'
import { cleanIndexText, simpleIndexText } from './query.ts'

/** The confirmed types whose text the worker reads: PDFs, and Office documents (converted to PDF first). */
export const FILE_TEXT_MIME_TYPES: readonly string[] = [
  'application/pdf',
  ...OFFICE_FORMATS.map((f) => f.mime),
]

export type FileTextStatus = 'done' | 'empty' | 'failed' | 'skipped'

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8')

/** The op's page limit (its params; the contract's cap when they do not parse, which the api never writes). */
export function maxPagesOf(params: Record<string, unknown>): number {
  const p = ExtractTextParams.safeParse(params)
  return p.success ? p.data.maxPages : FILE_TEXT_LIMITS.maxPages
}

/** Body bytes of the workspace's stored file text, other versions than `exceptVersionId` (their state rows). */
async function workspaceBytes(q: Queryable, workspaceId: string, exceptVersionId: string): Promise<number> {
  const r = await q.one<{ n: number }>(
    `SELECT COALESCE(sum(bytes), 0)::float8 AS n FROM file_text_state
      WHERE workspace_id = $1 AND version_id <> $2 AND status = 'done'`,
    [workspaceId, exceptVersionId],
  )
  return Number(r.n)
}

/**
 * Stores one `/text` batch of an op's pages (inside the op's transaction, under its lease). Refuses a page past the
 * op's range, a page given twice, or pages out of order; a page whose text is empty once cleaned stores nothing; pages
 * past the version's byte cap, or the workspace's, are not stored (the completer reports the version truncated or
 * skipped). Returns how many pages were stored.
 */
export async function storeTextPages(
  tx: Queryable,
  op: { workspaceId: string; sourceVersionId: string; params: Record<string, unknown> },
  input: Pick<WorkerOpTextInput, 'pages'>,
): Promise<number> {
  const maxPages = maxPagesOf(op.params)
  let last = 0
  for (const p of input.pages) {
    if (p.page > maxPages)
      throw new OpRefused(400, 'PAGE_OUT_OF_RANGE', 'A page is outside the range this op extracts.')
    if (p.page <= last)
      throw new OpRefused(400, 'PAGES_OUT_OF_ORDER', 'Pages are sent once each, in ascending order.')
    last = p.page
  }
  const versionId = op.sourceVersionId
  const sent = input.pages.map((p) => p.page)
  const lowest = sent[0] as number
  // page 1 starts a run: whatever an earlier attempt stored goes; otherwise an earlier attempt's pages from here on
  // that this batch does not carry are stale
  await tx.query(
    'DELETE FROM file_text_pages WHERE version_id = $1 AND page >= $2 AND NOT (page = ANY($3::int[]))',
    [versionId, lowest === 1 ? 0 : lowest, lowest === 1 ? [] : sent],
  )
  const kept = await tx.query<{ page: number; bytes: number }>(
    `SELECT page, octet_length(body)::int AS bytes FROM file_text_pages
      WHERE version_id = $1 AND NOT (page = ANY($2::int[]))`,
    [versionId, sent],
  )
  let total = kept.rows.reduce((n, r) => n + Number(r.bytes), 0)
  const budget = FILE_TEXT_LIMITS.maxWorkspaceBytes - (await workspaceBytes(tx, op.workspaceId, versionId))
  const rows: { page: number; body: string }[] = []
  const empty: number[] = []
  for (const p of input.pages) {
    const body = cleanIndexText(p.body, FILE_TEXT_LIMITS.maxPageChars)
    if (!body) {
      empty.push(p.page)
      continue
    }
    const size = utf8(body)
    // the version's cap and the workspace's: pages past either are left out (never half a page)
    if (total + size > FILE_TEXT_LIMITS.maxVersionBytes || total + size > budget) {
      empty.push(p.page)
      continue
    }
    total += size
    rows.push({ page: p.page, body })
  }
  if (empty.length)
    await tx.query('DELETE FROM file_text_pages WHERE version_id = $1 AND page = ANY($2::int[])', [
      versionId,
      empty,
    ])
  if (rows.length)
    await tx.query(
      `INSERT INTO file_text_pages (version_id, workspace_id, page, body, tsv)
       SELECT $1, $2, p.page, p.body, to_tsvector('english', p.body) || to_tsvector('simple', p.folded)
         FROM unnest($3::int[], $4::text[], $5::text[]) AS p(page, body, folded)
       ON CONFLICT (version_id, page) DO UPDATE SET body = EXCLUDED.body, tsv = EXCLUDED.tsv`,
      [
        versionId,
        op.workspaceId,
        rows.map((r) => r.page),
        rows.map((r) => r.body),
        rows.map((r) => simpleIndexText(r.body)),
      ],
    )
  return rows.length
}

export interface FileTextOutcome {
  status: Exclude<FileTextStatus, 'failed'>
  pages: number
  bytes: number
  truncated: boolean
}

/**
 * The completer's part (inside the op's complete transaction): checks the worker's result (strict), and writes the
 * version's state from the pages actually stored:
 * - `empty`: no page held text (a scan: OCR is out of scope), or none was stored;
 * - `skipped`: the workspace's file text budget has no room for this version: its pages are removed;
 * - `done`: the stored pages; `truncated` when the worker cut the file (past 300 pages, past its own byte cap) or the
 *   api left pages out (the version's cap). `result.pages` is how many pages with text the worker sent.
 */
export async function completeFileText(
  tx: Queryable,
  op: { workspaceId: string; sourceVersionId: string },
  rawResult: Record<string, unknown>,
  now: Date,
): Promise<{ result: z.infer<typeof ExtractTextResult>; outcome: FileTextOutcome }> {
  const parsed = ExtractTextResult.safeParse(rawResult)
  if (!parsed.success) throw new OpRefused(400, 'INVALID_RESULT', 'The extract-text result is not valid.')
  const result = parsed.data
  const versionId = op.sourceVersionId
  // no page with text: nothing an earlier attempt stored stays
  if (result.pages === 0) await tx.query('DELETE FROM file_text_pages WHERE version_id = $1', [versionId])
  const stored = await tx.one<{ pages: number; bytes: number }>(
    `SELECT count(*)::int AS pages, COALESCE(sum(octet_length(body)), 0)::int AS bytes
       FROM file_text_pages WHERE version_id = $1`,
    [versionId],
  )
  const room = FILE_TEXT_LIMITS.maxWorkspaceBytes - (await workspaceBytes(tx, op.workspaceId, versionId))
  // what this version holds, or (nothing stored for a file with text) what the worker found, within the version's cap
  const wanted = stored.pages > 0 ? stored.bytes : Math.min(result.bytes, FILE_TEXT_LIMITS.maxVersionBytes)
  let outcome: FileTextOutcome
  if (result.pages > 0 && wanted > room) {
    await tx.query('DELETE FROM file_text_pages WHERE version_id = $1', [versionId])
    outcome = { status: 'skipped', pages: 0, bytes: 0, truncated: false }
  } else if (stored.pages === 0) {
    outcome = { status: 'empty', pages: 0, bytes: 0, truncated: false }
  } else {
    outcome = {
      status: 'done',
      pages: stored.pages,
      bytes: stored.bytes,
      truncated: result.truncated || stored.pages < result.pages,
    }
  }
  await tx.query(
    `INSERT INTO file_text_state (version_id, workspace_id, status, pages, bytes, truncated, extractor, extracted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (version_id) DO UPDATE SET status = EXCLUDED.status, pages = EXCLUDED.pages, bytes = EXCLUDED.bytes,
       truncated = EXCLUDED.truncated, extractor = EXCLUDED.extractor, extracted_at = EXCLUDED.extracted_at`,
    [
      versionId,
      op.workspaceId,
      outcome.status,
      outcome.pages,
      outcome.bytes,
      outcome.truncated,
      result.extractor,
      now,
    ],
  )
  return { result, outcome }
}

export interface FilePageKey {
  boardId: string
  versionId: string
  page: number
}

export interface FilePageText {
  body: string
  name: string
}

/**
 * The stored text and the file's display name of chosen file pages, by index into `keys` (for Ask: the pages its
 * ranking chose, which already passed the file CTE's checks). `workspaceId` keeps the read inside the asker's
 * workspace whatever the keys say; a page whose version's text is no longer `done` is missing.
 */
export async function filePageBodies(
  q: Queryable,
  workspaceId: string,
  keys: readonly FilePageKey[],
): Promise<Map<number, FilePageText>> {
  const out = new Map<number, FilePageText>()
  if (!keys.length) return out
  const r = await q.query<{ i: number; body: string; name: string }>(
    `SELECT k.i::int AS i, p.body, v.name
       FROM unnest($2::text[], $3::int[]) WITH ORDINALITY AS k(version_id, page, i)
       JOIN file_text_pages p ON p.version_id = k.version_id AND p.page = k.page AND p.workspace_id = $1
       JOIN file_text_state s ON s.version_id = p.version_id AND s.status = 'done'
       JOIN asset_versions v ON v.id = p.version_id AND v.workspace_id = $1`,
    [workspaceId, keys.map((k) => k.versionId), keys.map((k) => k.page)],
  )
  for (const row of r.rows) out.set(row.i - 1, { body: row.body, name: row.name })
  return out
}
