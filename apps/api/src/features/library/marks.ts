// Favourites and recents of every source of the Elements panel (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.1,
// §4): GET and PUT /api/workspaces/:wid/library/marks, per person and workspace (library_marks). A mark grants
// nothing: an item's key is accepted only for an item the caller reads now, and keys of items they cannot read (gone,
// deleted, internal only, someone else's personal one) are left out of the answer. Members only, as the library.
// Unstarred marks beyond the newest LIBRARY_KEPT_USES uses are pruned, so the table stays small.

import {
  LIBRARY_LIMITS,
  LIBRARY_ROUTES,
  type LibraryMark,
  type ListLibraryMarksResponse,
  parseLibraryMarkKey,
  PutLibraryMarkInput,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import type { Params } from '../../context.ts'
import { ApiError, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import {
  findItem,
  ITEM_FROM,
  isLiveLibraryRoute,
  type LibraryCaller,
  libraryCaller,
  visibleItems,
} from './model.ts'

const R = LIBRARY_ROUTES
/** Uses kept per person and workspace besides the favourites (the panel shows the last LIBRARY_LIMITS.recents). */
export const LIBRARY_KEPT_USES = 50

const favouritesFull = () =>
  new ApiError(
    409,
    'LIBRARY_FULL',
    `You can keep at most ${LIBRARY_LIMITS.favourites} favourites in a workspace. Unstar some first.`,
  )

interface MarkRow {
  key: string
  favourite: boolean
  used_at: Date | null
}

const toMark = (r: MarkRow): LibraryMark => ({
  key: r.key,
  favourite: r.favourite,
  usedAt: r.used_at ? r.used_at.toISOString() : null,
})

/** Records a use of `key` (an insert of a built-in; a place of an item) and prunes old unstarred uses. */
export async function stampUse(q: Queryable, caller: LibraryCaller, key: string, at: Date): Promise<void> {
  await q.query(
    `INSERT INTO library_marks (user_id, workspace_id, key, favourite, used_at) VALUES ($1, $2, $3, false, $4)
     ON CONFLICT (user_id, workspace_id, key) DO UPDATE SET used_at = EXCLUDED.used_at`,
    [caller.userId, caller.workspaceId, key, at],
  )
  await q.query(
    `DELETE FROM library_marks m
      WHERE m.user_id = $1 AND m.workspace_id = $2 AND NOT m.favourite
        AND m.key NOT IN (SELECT k.key FROM library_marks k
                           WHERE k.user_id = $1 AND k.workspace_id = $2 AND NOT k.favourite
                             AND k.used_at IS NOT NULL
                           ORDER BY k.used_at DESC, k.key LIMIT ${LIBRARY_KEPT_USES})`,
    [caller.userId, caller.workspaceId],
  )
}

/** The ids among `ids` of live items the caller reads now. */
async function readableItems(
  q: Queryable,
  caller: LibraryCaller,
  ids: readonly string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const params: unknown[] = [ids]
  const ws = visibleItems('workspace', caller, params)
  const mine = visibleItems('personal', caller, params)
  const rows = await q.query<{ id: string }>(
    `SELECT i.id ${ITEM_FROM}
      WHERE i.id = ANY($1::text[]) AND i.deleted_at IS NULL AND ((${ws}) OR (${mine}))`,
    params,
  )
  return new Set(rows.rows.map((r) => r.id))
}

export function registerLibraryMarks(app: FastifyInstance, ctx: FeatureContext): void {
  const { db } = ctx

  if (isLiveLibraryRoute(`GET ${R.marks}`))
    app.get(R.marks, async (req): Promise<ListLibraryMarksResponse> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const caller = await libraryCaller(ctx, db, wid, user)
      const favourites = (
        await db.query<MarkRow>(
          `SELECT key, favourite, used_at FROM library_marks
            WHERE user_id = $1 AND workspace_id = $2 AND favourite
            ORDER BY key LIMIT ${LIBRARY_LIMITS.favourites}`,
          [user.id, wid],
        )
      ).rows
      const recents = (
        await db.query<MarkRow>(
          `SELECT key, favourite, used_at FROM library_marks
            WHERE user_id = $1 AND workspace_id = $2 AND used_at IS NOT NULL
            ORDER BY used_at DESC, key LIMIT ${LIBRARY_KEPT_USES}`,
          [user.id, wid],
        )
      ).rows
      const itemIds = [...favourites, ...recents].flatMap((m) => {
        const t = parseLibraryMarkKey(m.key)
        return t?.source === 'item' ? [t.id] : []
      })
      const readable = await readableItems(db, caller, [...new Set(itemIds)])
      const shown = (m: MarkRow) => {
        const t = parseLibraryMarkKey(m.key)
        return t !== null && (t.source !== 'item' || readable.has(t.id))
      }
      return {
        favourites: favourites.filter(shown).map(toMark),
        recents: recents.filter(shown).slice(0, LIBRARY_LIMITS.recents).map(toMark),
      }
    })

  if (isLiveLibraryRoute(`PUT ${R.marks}`))
    app.put(R.marks, async (req): Promise<LibraryMark> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const input = parse(PutLibraryMarkInput, req.body)
      const caller = await libraryCaller(ctx, db, wid, user)
      const target = parseLibraryMarkKey(input.key)
      if (!target) throw notFound()
      if (
        target.source === 'item' &&
        !(await findItem(db, caller, target.id, { state: 'live', now: ctx.now() }))
      )
        throw notFound()
      return db.transaction(async (tx) => {
        const at = ctx.now()
        if (input.used) await stampUse(tx, caller, input.key, at)
        if (input.favourite !== undefined) {
          const was = await tx.maybeOne<{ favourite: boolean }>(
            'SELECT favourite FROM library_marks WHERE user_id = $1 AND workspace_id = $2 AND key = $3 FOR UPDATE',
            [user.id, wid, input.key],
          )
          if (input.favourite && !was?.favourite) {
            const { n } = await tx.one<{ n: number }>(
              'SELECT count(*)::int AS n FROM library_marks WHERE user_id = $1 AND workspace_id = $2 AND favourite',
              [user.id, wid],
            )
            if (n >= LIBRARY_LIMITS.favourites) throw favouritesFull()
          }
          await tx.query(
            `INSERT INTO library_marks (user_id, workspace_id, key, favourite, used_at) VALUES ($1, $2, $3, $4, NULL)
             ON CONFLICT (user_id, workspace_id, key) DO UPDATE SET favourite = EXCLUDED.favourite`,
            [user.id, wid, input.key, input.favourite],
          )
        }
        const row = await tx.maybeOne<MarkRow>(
          'SELECT key, favourite, used_at FROM library_marks WHERE user_id = $1 AND workspace_id = $2 AND key = $3',
          [user.id, wid, input.key],
        )
        const mark = row ?? { key: input.key, favourite: false, used_at: null }
        // a mark that is neither a favourite nor a use holds nothing
        if (row && !row.favourite && !row.used_at)
          await tx.query('DELETE FROM library_marks WHERE user_id = $1 AND workspace_id = $2 AND key = $3', [
            user.id,
            wid,
            input.key,
          ])
        return toMark(mark)
      })
    })
}
