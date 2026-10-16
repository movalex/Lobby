// OWNER: WS1 (wave R, import from Miro). The Miro routes (@draftroom/contracts miro-import.ts; docs/WAVE-R-CONTRACTS.md
// §3; AGENTS.md "Server egress exception: Miro import"):
//
//   POST /api/workspaces/:wid/imports/miro/boards   check the token, list the boards it can see (nothing kept)  R1-1
//   POST /api/workspaces/:wid/imports/miro          start a job (202 StartImportResponse)                        R1-2
//
// Who: a name-only guest is refused first (guests/guard.ts), a non-creator next (domain-access/guard.ts, 'always',
// purpose create); each route checks again itself that the caller is a member who may create boards in the
// workspace and a creator (stored status, failing closed), and that a named project is the workspace's. The job's
// boards are made (and activated) under createBoardFrom's guards again (../finalize.ts).
//
// The token: taken out of the parsed body by hand (splitMiroToken: never a schema, an issue or a message), removed
// from the body object, wrapped as a RedactedSecret (it prints as [redacted] everywhere) and used only through the
// Miro client (./client.ts: the egress module, Bearer only toward Miro's API host). The handler runs inside
// withSecrets, so whatever it throws leaves without it; the job keeps it in the runner's memory only (../runner.ts).
// Nothing here logs; answers carry the team's and boards' display names, ids and Miro's own board links (as text).
//
// The 'miro' source is registered on the import runner here (./source.ts).
import {
  cleanDisplayText,
  IMPORT_TITLE_MAX,
  importJobPath,
  ListMiroBoardsInput,
  type ListMiroBoardsResponse,
  MIRO_BOARD_ID_PATTERN,
  MIRO_IMPORT_LIMITS,
  MIRO_IMPORT_ROUTES,
  type MiroBoardSummary,
  StartMiroImportInput,
} from '@draftroom/contracts'
import { isRecord } from '@draftroom/miro-import/sources'
import { canCreateInWorkspace } from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireProjectInWorkspace, requireWorkspaceRole } from '../../../access.ts'
import type { Params } from '../../../context.ts'
import type { RedactedSecret } from '../../../egress/index.ts'
import { ApiError, badRequest, forbidden, parse } from '../../../errors.ts'
import type { FeatureContext } from '../../context.ts'
import { isPendingRoute } from '../../pending-routes.ts'
import { importRunnerOf } from '../index.ts'
import { MiroClient } from './client.ts'
import { type MiroReach, miroImportSource, miroReachOf } from './source.ts'
import { answering, takeMiroToken, tokenRefusal } from './token.ts'

const CREATE_MEMBERS = 'Only workspace members who can create boards can import boards.'
const LIST_LIMIT = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }
const START_LIMIT = { config: { rateLimit: { max: 12, timeWindow: 60_000 } } }

const cleanName = (v: unknown, max: number) =>
  typeof v === 'string' ? cleanDisplayText(v).trim().slice(0, max) : ''

function summary(raw: unknown): MiroBoardSummary | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !MIRO_BOARD_ID_PATTERN.test(raw.id)) return null
  const link = typeof raw.viewLink === 'string' && raw.viewLink.length <= 2048 ? raw.viewLink : null
  return {
    id: raw.id,
    name: cleanName(raw.name, 200),
    modifiedAt: typeof raw.modifiedAt === 'string' ? raw.modifiedAt.slice(0, 40) : null,
    viewLink: link && /^https:\/\/([a-z0-9-]+\.)*miro\.com\//.test(link) ? link : null,
  }
}

export async function registerMiroImport(
  app: FastifyInstance,
  ctx: FeatureContext,
  reach: MiroReach = miroReachOf(ctx),
): Promise<void> {
  const { db } = ctx
  importRunnerOf(app)?.useSource(miroImportSource(ctx, reach))
  const live = (method: string, url: string) => !isPendingRoute(`${method} ${url}`)

  /** A member who may create boards in `wid`, and a creator (stored status), or the refusal. */
  async function requireCreating(req: FastifyRequest, wid: string, userId: string) {
    const role = await requireWorkspaceRole(db, wid, userId)
    if (!canCreateInWorkspace(role)) throw forbidden(CREATE_MEMBERS)
    await ctx.identity.requireCreator(db, userId, 'create', {
      route: req.routeOptions.url ?? '',
      by: 'route',
    })
  }

  const clientFor = (secret: RedactedSecret) =>
    new MiroClient(reach.egress, secret, {
      apiOrigin: reach.apiOrigin,
      ...(reach.sleep ? { sleep: reach.sleep } : {}),
    })

  if (live('POST', MIRO_IMPORT_ROUTES.boards))
    app.post(MIRO_IMPORT_ROUTES.boards, LIST_LIMIT, async (req): Promise<ListMiroBoardsResponse> => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const { secret, rest } = takeMiroToken(req)
      await requireCreating(req, wid, user.id)
      if (!secret) throw tokenRefusal()
      const input = parse(ListMiroBoardsInput, rest)
      return answering(secret, async () => {
        const client = clientFor(secret)
        const token = await client.tokenContext()
        const page = await client.boards(input)
        const boards = page.data
          .map(summary)
          .filter((b): b is MiroBoardSummary => b !== null)
          .slice(0, MIRO_IMPORT_LIMITS.boardsPageSize)
        return {
          team: { name: cleanName(token.team, 200) },
          boards,
          total: page.total ?? boards.length,
          offset: page.offset ?? input.offset ?? 0,
        }
      })
    })

  if (live('POST', MIRO_IMPORT_ROUTES.start))
    app.post(MIRO_IMPORT_ROUTES.start, START_LIMIT, async (req, reply) => {
      const user = await ctx.requireUser(req)
      const { wid = '' } = req.params as Params
      const { secret, rest } = takeMiroToken(req)
      await requireCreating(req, wid, user.id)
      if (!secret) throw tokenRefusal()
      const input = parse(StartMiroImportInput, rest)
      if (input.referencePdf)
        throw badRequest('referencePdf: a PDF reference cannot be added to a Miro import yet.')
      const projectId = input.projectId ?? null
      if (projectId) await requireProjectInWorkspace(db, projectId, wid)
      const runner = importRunnerOf(app)
      if (!runner) throw new ApiError(503, 'IMPORT_UNAVAILABLE', 'Imports are not available right now.')
      return answering(secret, async () => {
        // the token is checked, and each board is one the token can see, before anything is kept
        const client = clientFor(secret)
        await client.tokenContext()
        const boards: { sourceRef: string; title: string }[] = []
        for (const b of input.boards) {
          const title = b.title ?? cleanName((await client.board(b.miroBoardId)).name, IMPORT_TITLE_MAX)
          if (b.title) await client.board(b.miroBoardId)
          boards.push({ sourceRef: b.miroBoardId, title: title || 'Miro board' })
        }
        const importId = await runner.start(
          { workspaceId: wid, projectId, userId: user.id, source: 'miro', boards },
          [secret],
        )
        reply.code(202)
        return { importId, location: importJobPath(importId) }
      })
    })
}
