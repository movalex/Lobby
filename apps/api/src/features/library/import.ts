// POST /api/workspaces/:wid/library/import (OWNER: WS2, wave Q; docs/WAVE-Q-CONTRACTS.md §2.1, §6): the items of an
// `.excalidrawlib` the web normalised (apps/web/src/canvas/library, the only reader of the file format). The api
// trusts none of it: every item goes through the same serializer as a save (elements.ts), and an item that shows a
// file is left out (no board can vouch for one; the web drops images first). An item that fails is skipped and
// counted, never echoed: the answer's warnings are counts. Items past the library's limit are skipped too; with no
// room at all the answer is 409 LIBRARY_FULL. The licence note (LIBRARY_DEFAULT_LICENCE when the file states none),
// the file name and the author are stored per item as its source. One transaction under the workspace row; one audit
// row with the counts. Body ≤ 5 MB, ≤ 500 items, 5 imports a minute per person. Lobby never fetches a library.

import {
  ImportLibraryInput,
  type ImportLibraryResponse,
  LIBRARY_LIMITS,
  LIBRARY_ROUTES,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireCreatingRoleLocked } from '../../access.ts'
import { audit } from '../../audit.ts'
import type { Params } from '../../context.ts'
import { parse } from '../../errors.ts'
import type { KeyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { isTooLarge, type PreparedItem, serializeReceived, withoutFiles } from './elements.ts'
import { insertItem } from './items.ts'
import {
  isLiveLibraryRoute,
  itemCap,
  libraryCaller,
  libraryFull,
  liveItemCount,
  newLibraryId,
  requireFolderIn,
  requireScopeWriter,
} from './model.ts'

const R = LIBRARY_ROUTES

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function registerLibraryImport(
  app: FastifyInstance,
  ctx: FeatureContext,
  limits: { import: KeyedLimit },
): void {
  const { db } = ctx
  if (!isLiveLibraryRoute(`POST ${R.import}`)) return

  app.route({
    method: 'POST',
    url: R.import,
    bodyLimit: LIBRARY_LIMITS.importBytes,
    handler: async (req): Promise<ImportLibraryResponse> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      limits.import.take(user.id)
      const input = parse(ImportLibraryInput, req.body)
      const caller = await libraryCaller(ctx, db, wid, user)
      await requireScopeWriter(ctx, db, caller, input.scope, req.routeOptions.url ?? '')
      const ready: { name: string; item: PreparedItem }[] = []
      const skipped = { invalid: 0, tooLarge: 0, files: 0, full: 0 }
      for (const it of input.items) {
        const result = await serializeReceived(it.elements)
        if (!result.ok) {
          if (isTooLarge(result.problem)) skipped.tooLarge++
          else skipped.invalid++
        } else if (result.item.files.length) skipped.files++
        else ready.push({ name: it.name, item: withoutFiles(result.item) })
      }
      const created = await db.transaction(async (tx) => {
        await requireCreatingRoleLocked(tx, wid, user.id)
        await requireFolderIn(tx, caller, input.folderId, input.scope)
        const room = itemCap(input.scope) - (await liveItemCount(tx, caller, input.scope))
        if (ready.length && room <= 0) throw libraryFull('items', input.scope)
        const taken = ready.slice(0, Math.max(0, room))
        skipped.full = ready.length - taken.length
        const source = {
          kind: 'excalidrawlib',
          fileName: input.fileName,
          licence: input.licence,
          author: input.author,
        }
        const at = ctx.now()
        for (const { name, item } of taken)
          await insertItem(tx, {
            id: newLibraryId('lbi'),
            caller,
            scope: input.scope,
            folderId: input.folderId,
            name,
            tags: [],
            item,
            source,
            internalOnly: false,
            at,
          })
        await audit(tx, {
          workspaceId: wid,
          actorId: user.id,
          action: 'library.import',
          target: input.scope,
          detail: {
            scope: input.scope,
            created: taken.length,
            skipped: skipped.invalid + skipped.tooLarge + skipped.files + skipped.full,
          },
          at,
        })
        return taken.length
      })
      const warnings: string[] = []
      if (skipped.invalid)
        warnings.push(`${plural(skipped.invalid, 'item was', 'items were')} not valid and left out.`)
      if (skipped.tooLarge)
        warnings.push(`${plural(skipped.tooLarge, 'item was', 'items were')} too large and left out.`)
      if (skipped.files)
        warnings.push(
          `${plural(skipped.files, 'item shows', 'items show')} files, which an imported library cannot carry: left out.`,
        )
      if (skipped.full)
        warnings.push(`${plural(skipped.full, 'item was', 'items were')} left out: the library is full.`)
      return {
        created,
        skipped: skipped.invalid + skipped.tooLarge + skipped.files + skipped.full,
        warnings,
      }
    },
  })
}
