// Feature module: "Send feedback" (wave J5, the pilot's feedback channel; migration 0026).
//
//   POST  /api/feedback         {text, expected?, context}  ->  201 {id, createdAt}
//   GET   /api/feedback/access                              ->  {admin}
//   GET   /api/feedback?status=open|done|all&limit&cursor   ->  {items, next}       (inbox readers only)
//   PATCH /api/feedback/:id     {status}                    ->  the updated item    (inbox readers only)
//   GET   /internal/feedback?status&limit&cursor            ->  {items, next}       (the internal secret)
//
// Who sends: anyone with a session, an account or a name-only guest (a guest is the person at the other end
// of a review link: they are the pilot's clients). Authorship (user id, display name, account or guest) is
// read from the session, never from the body. The text is plain text: control, bidi and invisible tag
// characters are stripped, each field is capped at 4,000 characters, the context block is parsed field by field
// (./sanitize.ts). Limits: ten messages an hour per person, and a backstop per client address (a guest
// identity costs nothing but a name, so the per-person budget alone would multiply by the guests one
// person can create); both in process memory (one api instance, docs/DEPLOY.md).
//
// Who reads: only accounts whose STORED VERIFIED address is in DRAFTROOM_FEEDBACK_ADMINS (./admin.ts), checked
// on the server on every call; everybody else, guests included, gets the same 404 as for a route that does
// not exist, so the inbox is not even visible. The lead's triage tooling reads /internal/feedback instead
// (app.ts registerInternalSecretGuard checks the secret before anything here runs): ids, text and context.
//
// Nothing here logs the text, the context or a name: the request log names the route pattern only, and the
// one line this module writes carries the new id, the kind and the length.
import {
  FEEDBACK_ACCESS_ROUTE,
  FEEDBACK_CODES,
  FEEDBACK_INTERNAL_ROUTE,
  FEEDBACK_ITEM_ROUTE,
  FEEDBACK_PER_PERSON,
  FEEDBACK_ROUTE,
  FEEDBACK_TEXT_MAX,
  type FeedbackAccess,
  FeedbackId,
  FeedbackInput,
  type FeedbackInternalList,
  FeedbackInternalQuery,
  type FeedbackItem,
  type FeedbackList,
  FeedbackListQuery,
  FeedbackPatch,
  type FeedbackSent,
} from '@draftroom/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionUser } from '../../auth/session.ts'
import type { AppContext, Params } from '../../context.ts'
import { ApiError, notFound, parse } from '../../errors.ts'
import { keyedLimit, type RouteRateLimit } from '../../rate-limit.ts'
import { createAdminCheck } from './admin.ts'
import { cleanContext, cleanLine, cleanText, codePoints, truncate } from './sanitize.ts'
import { insertFeedback, listFeedback, newFeedbackId, setFeedbackStatus, toInternalItem } from './store.ts'

export { FEEDBACK_ROUTE }

/** A message is two fields of at most 4,000 characters (a few bytes each) and a small context. */
const BODY_LIMIT = 64 * 1024

/**
 * Read when the feature registers (tests change them before building the app, like the guest sweep's
 * settings). `perPerson`: per user id; `perIp`: per client address (TRUST_PROXY decides what that is).
 */
export const feedbackSettings: { perPerson: RouteRateLimit; perIp: RouteRateLimit } = {
  perPerson: { max: FEEDBACK_PER_PERSON.max, timeWindow: FEEDBACK_PER_PERSON.windowMs },
  // An office behind one address sends rarely: 100 an hour is far above a pilot's use.
  perIp: { max: 100, timeWindow: FEEDBACK_PER_PERSON.windowMs },
}

const TOO_MANY = 'You have sent a lot of feedback in the last hour. Try again a bit later.'
const invalid = (message: string) => new ApiError(400, FEEDBACK_CODES.invalid, message)

export async function registerFeedback(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db } = ctx
  const isAdmin = createAdminCheck(ctx)
  const perPerson = keyedLimit(feedbackSettings.perPerson, ctx.now, TOO_MANY)
  const perIp = keyedLimit(feedbackSettings.perIp, ctx.now, TOO_MANY)

  /** The signed-in inbox reader, or the 404 everybody else gets (401 without a session). */
  async function requireAdmin(req: FastifyRequest): Promise<SessionUser> {
    const user = await ctx.requireUser(req)
    if (!(await isAdmin(req, user))) throw notFound()
    return user
  }

  app.post(FEEDBACK_ROUTE, { bodyLimit: BODY_LIMIT }, async (req, reply): Promise<FeedbackSent> => {
    const user = await ctx.requireUser(req)
    const input = parse(FeedbackInput, req.body)
    const text = cleanText(input.text)
    const expected = cleanText(input.expected ?? '')
    if (!text) throw invalid('Tell us what happened: this can’t be empty.')
    if (codePoints(text) > FEEDBACK_TEXT_MAX)
      throw invalid(
        `“What happened?” is too long: at most ${FEEDBACK_TEXT_MAX.toLocaleString('en-US')} characters.`,
      )
    if (codePoints(expected) > FEEDBACK_TEXT_MAX)
      throw invalid(
        `“What did you expect?” is too long: at most ${FEEDBACK_TEXT_MAX.toLocaleString('en-US')} characters.`,
      )
    // Counted once the message is valid, so a typo costs nothing; before the insert, so a flood stores nothing
    // (taken after the insert, a burst of requests in flight together would all pass the check: a failed insert
    // costing one of ten hourly messages is the smaller harm).
    perIp.check(req.ip)
    perPerson.take(user.id)
    perIp.take(req.ip)

    const now = ctx.now()
    const id = newFeedbackId()
    const kind = user.kind === 'guest' ? 'guest' : 'account'
    await insertFeedback(db, {
      id,
      createdAt: now,
      userId: user.id,
      userName: truncate(cleanLine(user.name), 200) || '(no name)',
      userKind: kind,
      context: cleanContext(input.context, now.toISOString()),
      text,
      expected: expected || null,
    })
    // Ids and sizes only, never the text.
    req.log.info(
      { evt: 'feedback.received', id, kind, chars: codePoints(text), hasExpected: expected !== '' },
      'feedback received',
    )
    return reply.code(201).send({ id, createdAt: now.toISOString() })
  })

  app.get(FEEDBACK_ACCESS_ROUTE, async (req): Promise<FeedbackAccess> => {
    const user = await ctx.requireUser(req)
    return { admin: await isAdmin(req, user) }
  })

  app.get(FEEDBACK_ROUTE, async (req): Promise<FeedbackList> => {
    await requireAdmin(req)
    const q = parse(FeedbackListQuery, req.query)
    return listFeedback(db, q)
  })

  app.patch(FEEDBACK_ITEM_ROUTE, async (req): Promise<FeedbackItem> => {
    const admin = await requireAdmin(req)
    const { id = '' } = req.params as Params
    if (!FeedbackId.safeParse(id).success) throw notFound()
    const { status } = parse(FeedbackPatch, req.body)
    const item = await setFeedbackStatus(db, id, status, admin.id, ctx.now())
    if (!item) throw notFound()
    return item
  })

  // The internal secret is checked by the root guard in app.ts before this runs (a route under /internal).
  app.get(FEEDBACK_INTERNAL_ROUTE, async (req): Promise<FeedbackInternalList> => {
    const q = parse(FeedbackInternalQuery, req.query)
    const page = await listFeedback(db, q)
    return { items: page.items.map(toInternalItem), next: page.next }
  })
}
