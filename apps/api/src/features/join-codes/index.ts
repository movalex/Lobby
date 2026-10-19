// OWNER: WS3 (wave V, join codes). The routes (@draftroom/contracts join-codes.ts; migration 0038_live_sessions
// invitations.join_code_*; docs/WAVE-V-CONTRACTS.md §3):
//
//   POST /api/boards/:bid/review-links/:id/code   a workshop link's code (made on first ask; idempotent)   creator  V2-1
//   GET  /api/join/:code                          the link's token for /invite/:token (no session)        anyone   V2-2
//
// Both are behind DRAFTROOM_JOIN_CODES (../live/switch.ts liveRoute: while it is off they answer as an unknown route,
// for every caller, before the body and the root guards). The guard rows: a name-only guest is refused the create
// route (guests/guard.ts, the INVITE message) and it needs a creator (domain-access/guard.ts: share, always); both are
// checked here again, under the locks, as creating and extending a link are. Resolving has no row: anyone with the code.
//
// Resolving is a bearer-secret lookup, so it is no oracle: an unknown, a malformed, an expired, a revoked or swept code
// (and a code of a rotated ticket secret) all answer the same 404 NOT_FOUND as an unknown route. Limits: every lookup
// counts against JOIN_CODE_LOOKUPS_GLOBAL; a lookup that resolves nothing counts against the client address's
// JOIN_CODE_LOOKUPS_PER_ADDRESS (an IPv6 client by its /64), and an address at its limit is refused every lookup (429)
// whether its code is good or not, so the answer never says which. A room of people behind one office address
// resolving the same good code is not held to the 30 (each of them would be refused by the 31st otherwise). The code
// is compared in constant time against its derivation, never logged (the api logs route patterns only), never put in
// an audit row or an error message.

import {
  InvitationId,
  JOIN_CODE_LOOKUPS_GLOBAL,
  JOIN_CODE_LOOKUPS_PER_ADDRESS,
  JOIN_CODE_ROUTE_KEYS,
  JOIN_CODE_ROUTES,
  type JoinCodeResponse,
  normalizeJoinCode,
  type ResolvedJoinCode,
} from '@draftroom/contracts'
import { isUniqueViolation } from '@draftroom/db'
import type { FastifyInstance, RouteHandlerMethod } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import { audit } from '../../audit.ts'
import { sha256hex } from '../../auth/session.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { notFound } from '../../errors.ts'
import { keyedLimit } from '../../rate-limit.ts'
import { guestAccountRequired } from '../../routes/invitations.ts'
import type { FeatureContext } from '../context.ts'
import { assertLinksAllowed, lockBoardWorkspace } from '../dashboard/outside.ts'
import { reviewLinkToken } from '../dashboard/review-links.ts'
import { publishSharingChanged } from '../dashboard/shared.ts'
import { clientAddressKey } from '../guests/limits.ts'
import { liveRoute } from '../live/switch.ts'
import { PENDING_ROUTES, type PendingMethod, type PendingRoute } from '../pending-routes.ts'
import {
  assignJoinCode,
  type CodeColumns,
  deriveJoinCode,
  isWorkshopLink,
  joinCodeBody,
  joinCodeHash,
  sameCode,
} from './code.ts'

export const LOOKUP_RATE_MESSAGE =
  'Too many join codes were tried from this network. Wait a few minutes and try again.'

/** Test seam (as guests/link-caps.ts guestLinkCapSettings): the lookup windows, read when the routes register. */
export const joinCodeLookupSettings: Record<'perAddress' | 'global', { max: number; windowMs: number }> = {
  perAddress: { ...JOIN_CODE_LOOKUPS_PER_ADDRESS },
  global: { ...JOIN_CODE_LOOKUPS_GLOBAL },
}

interface LinkRow extends CodeColumns {
  workspace_id: string
  board_id: string | null
  role: string
  multi_use: boolean
  token_hash: string
  expires_at: Date
  revoked_at: Date | null
  swept_at: Date | null
}
const LINK_COLUMNS =
  'id, workspace_id, board_id, role, multi_use, token_hash, expires_at, revoked_at, swept_at, join_code_hash, join_code_n'

const isOpen = (row: LinkRow, at: Date) =>
  row.revoked_at === null && row.swept_at === null && row.expires_at.getTime() > at.getTime()

export async function registerJoinCodes(
  app: FastifyInstance,
  ctx: FeatureContext,
  pending: Readonly<Record<string, PendingRoute>> = PENDING_ROUTES,
): Promise<void> {
  const { db, now, config } = ctx
  const perAddress = keyedLimit(
    {
      max: joinCodeLookupSettings.perAddress.max,
      timeWindow: joinCodeLookupSettings.perAddress.windowMs,
    },
    now,
    LOOKUP_RATE_MESSAGE,
  )
  const global = keyedLimit(
    { max: joinCodeLookupSettings.global.max, timeWindow: joinCodeLookupSettings.global.windowMs },
    now,
  )

  // V2-1: a workshop link's code, made on first ask. Creator-only (it hands out the link's access, like "+1 h").
  const create: RouteHandlerMethod = async (req): Promise<JoinCodeResponse> => {
    const user = await ctx.requireUser(req)
    const { bid = '', id = '' } = req.params as Params
    const run = () =>
      db.transaction(async (tx) => {
        // The workspace row (IO-5), the board row, then the link: the lock order of creating and extending a link.
        // The unlocked check first, so only a manager of the board takes the workspace row.
        await requireBoardAction(tx, bid, user.id, 'manage_access')
        await lockBoardWorkspace(tx, bid)
        const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
        if ((await userKind(tx, user.id)) === 'guest')
          throw guestAccountRequired('Sign in with an account to create links.')
        await ctx.identity.requireCreator(tx, user.id, 'share', {
          route: req.routeOptions.url ?? '',
          by: 'route',
        })
        // Not while the board's workspace or project is internal only (409 INTERNAL_ONLY), as "+1 h".
        await assertLinksAllowed(tx, bid)
        if (!InvitationId.safeParse(id).success) throw notFound()
        const link = await tx.maybeOne<LinkRow>(
          `SELECT ${LINK_COLUMNS} FROM invitations WHERE id = $1 AND board_id = $2 AND multi_use FOR UPDATE`,
          [id, access.board.id],
        )
        const at = now()
        // One 404 for an unknown, a closed and a review (non-workshop) link.
        if (!link || !isWorkshopLink(link) || !isOpen(link, at)) throw notFound()
        const had = link.join_code_hash !== null
        const code = await assignJoinCode(tx, config.ticketSecret, link)
        const made = !had || joinCodeHash(code) !== link.join_code_hash
        if (made)
          await audit(tx, {
            workspaceId: link.workspace_id,
            actorId: user.id,
            action: 'invitation.update',
            target: link.id,
            // never the code itself
            detail: { boardId: bid, multiUse: true, joinCode: true },
            at,
          })
        return { joinCode: joinCodeBody(config.publicOrigin, code, link.expires_at), made }
      })
    let out: Awaited<ReturnType<typeof run>>
    try {
      out = await run()
    } catch (e) {
      // A concurrent first ask for the same link (its row lock orders them, so this is another link taking the
      // same code between the check and the update, ≈2^-40): once more, from the start.
      if (!isUniqueViolation(e)) throw e
      out = await run()
    }
    if (out.made) publishSharingChanged(ctx, bid, 'review-link-updated')
    return { joinCode: out.joinCode }
  }

  // V2-2: a code to the link's token, for /invite/:token. No session needed.
  const resolve: RouteHandlerMethod = async (req, reply): Promise<ResolvedJoinCode> => {
    reply.header('cache-control', 'no-store')
    const address = clientAddressKey(req.ip)
    global.take('all')
    perAddress.check(address)
    const miss = () => {
      perAddress.record(address)
      return notFound()
    }
    const { code: raw = '' } = req.params as Params
    const code = normalizeJoinCode(raw)
    if (code === null) throw miss()
    const link = await db.maybeOne<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM invitations WHERE join_code_hash = $1`,
      [joinCodeHash(code)],
    )
    if (!link || !isWorkshopLink(link) || !isOpen(link, now())) throw miss()
    // The stored hash must still be this link's derivation (a rotated ticket secret ends every code), compared in
    // constant time; and the token must still rebuild (the same rotation ends the link's URL).
    if (!sameCode(deriveJoinCode(config.ticketSecret, link.id, link.join_code_n), code)) throw miss()
    const token = reviewLinkToken(config.ticketSecret, link.id)
    if (!sameCode(sha256hex(token), link.token_hash)) throw miss()
    return { token }
  }

  const handlers: Record<string, RouteHandlerMethod> = {
    [`POST ${JOIN_CODE_ROUTES.create}`]: create,
    [`GET ${JOIN_CODE_ROUTES.resolve}`]: resolve,
  }
  for (const key of JOIN_CODE_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    const handler = handlers[key]
    if (!handler) throw new Error(`join codes: no handler for ${key}`)
    liveRoute(app, ctx, 'joinCodes', method, url, handler, pending)
  }
}
