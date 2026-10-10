// Feature module: privacy-safe usage counters (wave M, S3 / M5-5). OWNER: W5.
//
//   POST /api/usage            UsageBatch → 204 (a signed-in account or a name-only guest; the web's sendBeacon or
//                              keepalive fetch, same origin, JSON). Each event's count is capped (USAGE_COUNT_CAP, a
//                              guest at USAGE_GUEST_COUNT_CAP); one batch a minute per session (a guest's too), else
//                              429; any unknown event refuses the whole batch with 400 and nothing is stored.
//   GET  /internal/usage?days= → 200 InternalUsageResponse (the internal secret: app.ts registerInternalSecretGuard
//                              refuses every /internal route without it, before this handler).
//
// What is kept: usage_daily(day, event, role_class, count) (migration 0029_usage_daily): the UTC day, the event's
// fixed name, whether the person is a creator, another account or a guest, and the sum. Never a user id, session,
// board id, element id, text or a time finer than the day. Nothing about a batch is logged (the request log line
// names the route and status only, app.ts).

import {
  INTERNAL_USAGE_ROUTE,
  InternalUsageQuery,
  type InternalUsageResponse,
  USAGE_BATCH_MIN_INTERVAL_MS,
  USAGE_COUNT_CAP,
  USAGE_GUEST_COUNT_CAP,
  USAGE_ROUTE,
  UsageBatch,
  type UsageDailyRow,
  type UsageRoleClass,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { FastifyInstance } from 'fastify'
import type { SessionUser } from '../../auth/session.ts'
import { parse, unauthenticated } from '../../errors.ts'
import { rateLimited, SlidingWindowLimiter } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'

/** Sessions remembered by the batch limit at most (the least recently used is forgotten first). */
const LIMITER_KEYS = 20_000

/** Who counted, as stored: a guest, a creator account, or any other account. Never the person. */
export function roleClassOf(user: Pick<SessionUser, 'kind' | 'creator'>): UsageRoleClass {
  if (user.kind === 'guest') return 'guest'
  return user.creator ? 'creator' : 'member'
}

/** The UTC day of `at`, YYYY-MM-DD. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10)

/** Adds a (capped) batch to the day's counters, in one statement. */
export async function addUsage(
  q: Queryable,
  day: string,
  roleClass: UsageRoleClass,
  events: Readonly<Record<string, number>>,
): Promise<void> {
  const cap = roleClass === 'guest' ? USAGE_GUEST_COUNT_CAP : USAGE_COUNT_CAP
  const names = Object.keys(events)
  if (!names.length) return
  const counts = names.map((n) => Math.max(0, Math.min(cap, Math.floor(events[n] ?? 0))))
  await q.query(
    `INSERT INTO usage_daily (day, event, role_class, count)
     SELECT $1::date, u.event, $2::text, u.n FROM unnest($3::text[], $4::int[]) AS u(event, n)
     ON CONFLICT (day, event, role_class) DO UPDATE SET count = usage_daily.count + EXCLUDED.count`,
    [day, roleClass, names, counts],
  )
}

export async function registerUsage(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, now, sessions } = ctx
  const batches = new SlidingWindowLimiter(1, USAGE_BATCH_MIN_INTERVAL_MS, LIMITER_KEYS)

  app.post(USAGE_ROUTE, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const session = sessions.idOf(req)
    if (!session) throw unauthenticated()
    // the whole batch or nothing: an unknown event (or a count out of range, or too many events) is a 400
    const batch = parse(UsageBatch, req.body)
    const t = now().getTime()
    if (!batches.take(session, t)) throw rateLimited(batches.retryAfterMs(session, t))
    await addUsage(db, utcDay(now()), roleClassOf(user), batch.events)
    return reply.code(204).send()
  })

  app.get(INTERNAL_USAGE_ROUTE, async (req): Promise<InternalUsageResponse> => {
    const { days } = parse(InternalUsageQuery, req.query)
    // the last `days` UTC days, today included
    const today = now()
    const from = utcDay(new Date(today.getTime() - (days - 1) * 86_400_000))
    const rows = await db.query<{ day: string; event: string; role_class: UsageRoleClass; count: number }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, event, role_class, count
         FROM usage_daily WHERE day >= $1::date
        ORDER BY day DESC, event, role_class`,
      [from],
    )
    return {
      rows: rows.rows.map(
        (r): UsageDailyRow => ({
          day: r.day,
          event: r.event,
          roleClass: r.role_class,
          count: Number(r.count),
        }),
      ),
    }
  })
}
