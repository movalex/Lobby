// OWNER: WS2 (wave R, notifications to Slack and Teams; the stubs landed with the wave R foundation). The chat hook routes
// (@draftroom/contracts chat-hooks.ts; migration 0036_chat_hooks; docs/WAVE-R-CONTRACTS.md §4; AGENTS.md "Server egress
// exception: chat notifications"):
//
//   routes.ts   hooks CRUD by owners/admins who are creators, the test message          R2-1, R2-2
//   prefs.ts    a person's own choices                                                    R2-3
//   outbox.ts   enqueueChatDeliveries, called at the three notification insert sites, in their transactions
//   deliver.ts  the delivery loop: claim, re-check, caps and roll-ups, post, retry, dead-letter, purge
//   render.ts   the message from current rows (the contracts' slackPayload / teamsPayload)
//   send.ts     one POST through the egress module (the URL a RedactedSecret while it is in play)
//   policy.ts   what an answer means (retry, Retry-After, failed, hook switched off)
//   urls.ts     checkChatHookUrl, plus the local-dev seam for the fake receiver
//
// The URL is sealed with the secret box (../../crypto/sealed.ts createSecretBox(ctx.config.webhookSecret), AAD
// chatHookAad): with no DRAFTROOM_WEBHOOK_SECRET the box is null, every route answers 404 CHAT_HOOKS_OFF and the loop
// sends nothing (fail closed). The guard rows: a name-only guest is refused every route (guests/guard.ts); listing, adding,
// changing and testing a hook need a creator ('always', purpose share: domain-access/guard.ts), and the route also
// requires a workspace owner or admin.

import type { FastifyInstance } from 'fastify'
import { createSecretBox } from '../../crypto/sealed.ts'
import { errorFacts } from '../../egress/index.ts'
import type { FeatureContext } from '../context.ts'
import { type ChatDelivery, type ChatDeliveryOptions, createChatDelivery } from './deliver.ts'
import { registerPrefRoutes } from './prefs.ts'
import { registerHookRoutes } from './routes.ts'
import { createPoster } from './send.ts'

export { enqueueChatDeliveries } from './outbox.ts'

const deliveries = new WeakMap<FastifyInstance, ChatDelivery>()
/** The app's delivery loop (tests drive its passes and stop its timer). */
export function chatDeliveryOf(app: FastifyInstance): ChatDelivery | undefined {
  return deliveries.get(app)
}

export async function registerChatHooks(
  app: FastifyInstance,
  ctx: FeatureContext,
  opts: Partial<ChatDeliveryOptions> = {},
): Promise<void> {
  const box = createSecretBox(ctx.config.webhookSecret)
  const post = opts.post ?? createPoster(ctx.config.chatHookTestOrigins)
  const delivery = createChatDelivery(ctx, box, app.log, { ...opts, post })
  deliveries.set(app, delivery)
  const env = { app, ctx, box, post }
  registerHookRoutes(env)
  registerPrefRoutes(env)

  app.addHook('onReady', async () => {
    // rows sealed under the key being rotated away from are sealed again (DRAFTROOM_WEBHOOK_SECRET_PREVIOUS)
    await delivery
      .reseal()
      .catch((e) => app.log.warn({ feature: 'chat-hooks', err: errorFacts(e) }, 'chat hook reseal failed'))
    delivery.start()
  })
  app.addHook('onClose', async () => {
    await delivery.close()
  })
}
