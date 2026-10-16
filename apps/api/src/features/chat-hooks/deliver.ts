// The delivery loop of chat notifications (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.4, contracts CHAT_DELIVERY). One per
// api process; every 2 s it:
//
//   1. puts rows whose lease ran out (a process that died mid-send) back in the queue;
//   2. claims up to 20 due rows `FOR UPDATE SKIP LOCKED` (two processes never take the same row: the preview_jobs
//      pattern) and works them hook by hook, at most one message a second per hook;
//   3. for each row, re-checks everything at send time, from current rows: the hook is still on, the person is still
//      opted in to the kind, the notification (and its thread and comment) still exists and the person can still see it
//      (the bell's own `visible`), else the row is `dropped`;
//   4. holds a row back when the person already got 30 messages this hour or the workspace 600: it is `coalesced`, and
//      a minute later the hook gets ONE "and N more" message for everything held back;
//   5. renders the message, opens the sealed URL, posts through the egress module, and settles the row by what came
//      back (policy.ts: retry with backoff, Retry-After, failed, or the hook switched off with a reason);
//   6. hourly, purges rows older than 14 days.
//
// Rows, logs and the hook's `last_error_code` hold codes only (an HTTP status as text, `timeout`, `network`): never the
// receiver's words, a URL, a name or a title. With no webhook secret the loop only purges. Nothing here logs a URL.

import { CHAT_DELIVERY, chatRollupSentence } from '@draftroom/contracts'
import type { FastifyBaseLogger } from 'fastify'
import { chatHookAad, type SecretBox } from '../../crypto/sealed.ts'
import { errorFacts } from '../../egress/index.ts'
import { type NotificationRow, selectSql, visible } from '../comments/notifications.ts'
import type { FeatureContext } from '../context.ts'
import { type Decision, decide, type PostOutcome } from './policy.ts'
import {
  boardLink,
  isChatKind,
  messageFor,
  noticePayloadFor,
  payloadFor,
  titleFor,
  workspaceLink,
} from './render.ts'
import type { PostFn } from './send.ts'
import { HOOK_COLUMNS, type HookRow } from './store.ts'

const HOUR_MS = 3_600_000
const PURGE_EVERY_MS = HOUR_MS
/** A held-back message waits this long for the roll-up (one "and N more" per hook per minute). */
const ROLLUP_WAIT_MS = 60_000
const ROLLUP_BATCH = 500

export interface TickResult {
  claimed: number
  sent: number
  retried: number
  failed: number
  dropped: number
  coalesced: number
  /** hooks switched off by an answer */
  disabled: number
  /** roll-up messages posted */
  rollups: number
}

export interface ChatDelivery {
  /** One pass of the loop (tests drive it; `start` runs it every 2 s). */
  tick(): Promise<TickResult>
  start(): void
  /** Stops the timer (a pass in flight still ends). */
  stop(): void
  close(): Promise<void>
  /** Rewrites rows sealed under the previous key; how many. */
  reseal(): Promise<number>
}

export interface ChatDeliveryOptions {
  post: PostFn
  /** waits between two messages to one hook (a test shortens it) */
  sleep?: (ms: number) => Promise<void>
  /** a monotonic millisecond clock for the per-hook pacing */
  monotonic?: () => number
}

interface Claimed {
  id: string
  hook_id: string
  attempts: number
}

interface RolledRow {
  id: string
  notification_id: string | null
  attempts: number
  created_at: Date
}

interface BoardRow {
  id: string
  board_id: string
  board_title: string
  visibility: NotificationRow['visibility']
}

interface Loaded extends HookRow {
  d_id: string
  d_notification_id: string | null
  d_recipient_id: string
  d_attempts: number
  d_queued_at: Date
  workspace_name: string
  recipient_name: string
  pref_kinds: string[] | null
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const emptyTally = (): TickResult => ({
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  dropped: 0,
  coalesced: 0,
  disabled: 0,
  rollups: 0,
})

export function createChatDelivery(
  ctx: FeatureContext,
  box: SecretBox | null,
  log: FastifyBaseLogger,
  opts: ChatDeliveryOptions,
): ChatDelivery {
  const { db } = ctx
  const sleep = opts.sleep ?? sleepFor
  const monotonic = opts.monotonic ?? Date.now
  const origin = ctx.config.publicOrigin
  const pace = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<TickResult> | null = null
  let lastPurge = Number.NEGATIVE_INFINITY
  let closing = false

  /** Waits until this hook may be posted to again (1 a second). */
  async function paced(hookId: string): Promise<void> {
    const gap = 1000 / CHAT_DELIVERY.perHookPerSecond
    const last = pace.get(hookId)
    if (last !== undefined) {
      const wait = last + gap - monotonic()
      if (wait > 0) await sleep(wait)
    }
    pace.set(hookId, monotonic())
    if (pace.size > 2000) for (const k of pace.keys()) if (k !== hookId) pace.delete(k)
  }

  // ---- settling a row -------------------------------------------------------------------------------------------

  async function setDone(id: string, status: 'dropped' | 'failed' | 'sent', code: string, at: Date) {
    await db.query(
      `UPDATE chat_deliveries
          SET status = $2::text, last_code = $3, lease_until = NULL,
              sent_at = CASE WHEN $2::text = 'sent' THEN $4::timestamptz ELSE NULL END
        WHERE id = $1 AND status = 'sending'`,
      [id, status, code, at],
    )
  }

  async function setBack(
    id: string,
    to: 'queued' | 'coalesced',
    code: string,
    nextAt: Date,
    refund: boolean,
  ) {
    await db.query(
      `UPDATE chat_deliveries
          SET status = $2::text, last_code = $3, next_at = $4, lease_until = NULL,
              attempts = GREATEST(attempts - $5::int, 0)
        WHERE id = $1 AND status = 'sending'`,
      [id, to, code, nextAt, refund ? 1 : 0],
    )
  }

  async function hookOk(hookId: string, at: Date) {
    await db.query('UPDATE chat_hooks SET last_ok_at = $2, last_error_code = NULL WHERE id = $1', [
      hookId,
      at,
    ])
  }

  async function hookError(hookId: string, code: string) {
    await db.query('UPDATE chat_hooks SET last_error_code = $2 WHERE id = $1', [hookId, code])
  }

  /** Switches the hook off with a reason and drops what was waiting for it. */
  async function disableHook(hookId: string, reason: string, code: string, at: Date) {
    await db.query(
      `UPDATE chat_hooks SET disabled_at = $2, disabled_reason = $3, last_error_code = $4
        WHERE id = $1 AND disabled_at IS NULL`,
      [hookId, at, reason, code],
    )
    await db.query(
      `UPDATE chat_deliveries SET status = 'dropped', last_code = 'hook-disabled', lease_until = NULL
        WHERE hook_id = $1 AND status IN ('queued', 'coalesced')`,
      [hookId],
    )
  }

  /** Applies a decision to rows that are `sending`; returns what to count. */
  async function settle(
    ids: readonly string[],
    hookId: string,
    d: Decision,
    at: Date,
    back: 'queued' | 'coalesced',
    tally: TickResult,
    sentCode?: string,
  ): Promise<void> {
    switch (d.action) {
      case 'sent':
        for (const id of ids) await setDone(id, 'sent', sentCode ?? d.code, at)
        await hookOk(hookId, at)
        tally.sent += ids.length
        return
      case 'retry': {
        const next = new Date(at.getTime() + d.delayMs)
        for (const id of ids) await setBack(id, back, d.code, next, !d.spendsTry)
        await hookError(hookId, d.code)
        tally.retried += ids.length
        return
      }
      case 'fail':
        for (const id of ids) await setDone(id, 'failed', d.code, at)
        await hookError(hookId, d.code)
        tally.failed += ids.length
        return
      case 'disable':
        for (const id of ids) await setDone(id, 'failed', d.code, at)
        await disableHook(hookId, d.reason, d.code, at)
        log.warn(
          { feature: 'chat-hooks', hook: hookId, code: d.code, reason: d.reason },
          'chat hook switched off',
        )
        tally.failed += ids.length
        tally.disabled += 1
    }
  }

  // ---- the sealed URL ---------------------------------------------------------------------------------------------

  /** The hook's URL, or null when it does not open (the secret changed): the hook then fails every send at once. */
  async function openUrl(h: HookRow): Promise<string | null> {
    if (!box) return null
    try {
      const o = box.open(Buffer.from(h.url_sealed), h.key_id, chatHookAad(h.workspace_id, h.id))
      if (o.stale) await resealOne(h.id, h.workspace_id, h.key_id, o.value)
      return o.value
    } catch {
      return null
    }
  }

  async function resealOne(hookId: string, workspaceId: string, oldKey: string, url: string) {
    if (!box) return
    const sealed = box.seal(url, chatHookAad(workspaceId, hookId))
    await db.query(
      'UPDATE chat_hooks SET url_sealed = $3, key_id = $4, updated_at = now() WHERE id = $1 AND key_id = $2',
      [hookId, oldKey, sealed.sealed, sealed.keyId],
    )
  }

  async function reseal(): Promise<number> {
    if (!box) return 0
    const rows = await db.query<{ id: string; workspace_id: string; url_sealed: Uint8Array; key_id: string }>(
      'SELECT id, workspace_id, url_sealed, key_id FROM chat_hooks WHERE key_id <> $1',
      [box.keyId],
    )
    let n = 0
    for (const r of rows.rows) {
      try {
        const o = box.open(Buffer.from(r.url_sealed), r.key_id, chatHookAad(r.workspace_id, r.id))
        await resealOne(r.id, r.workspace_id, r.key_id, o.value)
        n += 1
      } catch {
        // sealed under a key we no longer have: the admins paste the URL again
      }
    }
    return n
  }

  // ---- one delivery -------------------------------------------------------------------------------------------------

  async function load(id: string): Promise<Loaded | null> {
    return db.maybeOne<Loaded>(
      `SELECT d.id AS d_id, d.notification_id AS d_notification_id, d.recipient_id AS d_recipient_id,
              d.attempts AS d_attempts, d.created_at AS d_queued_at,
              ${HOOK_COLUMNS}, w.name AS workspace_name, ru.name AS recipient_name, pr.kinds AS pref_kinds
         FROM chat_deliveries d
         JOIN chat_hooks h ON h.id = d.hook_id
         LEFT JOIN users cu ON cu.id = h.created_by
         JOIN workspaces w ON w.id = h.workspace_id
         JOIN users ru ON ru.id = d.recipient_id
         LEFT JOIN chat_hook_prefs pr ON pr.user_id = d.recipient_id AND pr.hook_id = d.hook_id
        WHERE d.id = $1`,
      [id],
    )
  }

  async function sentSince(sql: string, key: string, since: Date): Promise<number> {
    const r = await db.one<{ n: number }>(sql, [key, since])
    return Number(r.n)
  }

  const RECIPIENT_SENT = `SELECT count(*)::int AS n FROM chat_deliveries
     WHERE recipient_id = $1 AND status = 'sent' AND sent_at > $2 AND last_code IS DISTINCT FROM 'coalesced'`
  const WORKSPACE_SENT = `SELECT count(*)::int AS n FROM chat_deliveries d JOIN chat_hooks h ON h.id = d.hook_id
     WHERE h.workspace_id = $1 AND d.status = 'sent' AND d.sent_at > $2 AND d.last_code IS DISTINCT FROM 'coalesced'`

  async function deliver(c: Claimed, tally: TickResult): Promise<void> {
    const at = ctx.now()
    const l = await load(c.id)
    if (!l) return // the hook or the person is gone: the row went with it
    const drop = async (code: string) => {
      await setDone(c.id, 'dropped', code, at)
      tally.dropped += 1
    }
    if (l.disabled_at) return drop('hook-disabled')
    if (!l.d_notification_id) return drop('gone')
    // send-time checks: still opted in to this kind, notification still there, person can still see it
    const found = await db.query<NotificationRow>(
      `${selectSql('$2')} WHERE n.id = $1 AND n.user_id = $3 AND n.workspace_id = $4`,
      [l.d_notification_id, ctx.identity.lookup.source, l.d_recipient_id, l.workspace_id],
    )
    const n = found.rows[0]
    if (!n) return drop('gone')
    if (!isChatKind(n.kind)) return drop('kind')
    if (!l.pref_kinds?.includes(n.kind)) return drop('opted-out')
    if (!visible(n, await ctx.identity.isCreatorUser(db, l.d_recipient_id))) return drop('no-access')
    // caps: over one, the message is held for the roll-up
    const since = new Date(at.getTime() - HOUR_MS)
    if (
      (await sentSince(RECIPIENT_SENT, l.d_recipient_id, since)) >= CHAT_DELIVERY.perRecipientPerHour ||
      (await sentSince(WORKSPACE_SENT, l.workspace_id, since)) >= CHAT_DELIVERY.perWorkspacePerHour
    ) {
      await setBack(c.id, 'coalesced', 'over-cap', new Date(at.getTime() + ROLLUP_WAIT_MS), false)
      tally.coalesced += 1
      return
    }
    const message = messageFor({
      row: n,
      recipientName: l.recipient_name,
      workspaceName: l.workspace_name,
      includeText: l.include_snippets,
      origin,
    })
    if (!message) return drop('kind')
    const url = await openUrl(l)
    if (url === null) {
      await settle([c.id], l.id, { action: 'fail', code: 'unsealed' }, at, 'queued', tally)
      return
    }
    await paced(l.id)
    const outcome = await opts.post(url, payloadFor(l.provider, message))
    const age = at.getTime() - l.d_queued_at.getTime()
    await settle([c.id], l.id, decide(outcome, c.attempts, age), ctx.now(), 'queued', tally)
  }

  // ---- the roll-up ----------------------------------------------------------------------------------------------------

  async function rollUp(hookId: string, tally: TickResult): Promise<void> {
    const at = ctx.now()
    const claimed = await db.query<RolledRow>(
      `UPDATE chat_deliveries
          SET status = 'sending', attempts = attempts + 1, lease_until = $3
        WHERE id IN (SELECT id FROM chat_deliveries
                      WHERE hook_id = $1 AND status = 'coalesced' AND next_at <= $2
                      ORDER BY id LIMIT ${ROLLUP_BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, notification_id, attempts, created_at`,
      [hookId, at, new Date(at.getTime() + CHAT_DELIVERY.leaseMs)],
    )
    if (claimed.rows.length === 0) return
    const ids = claimed.rows.map((r) => r.id)
    const hook = await db.maybeOne<HookRow & { workspace_name: string }>(
      `SELECT ${HOOK_COLUMNS}, w.name AS workspace_name
         FROM chat_hooks h LEFT JOIN users cu ON cu.id = h.created_by JOIN workspaces w ON w.id = h.workspace_id
        WHERE h.id = $1`,
      [hookId],
    )
    if (!hook || hook.disabled_at) {
      for (const id of ids) await setDone(id, 'dropped', 'hook-disabled', at)
      tally.dropped += ids.length
      return
    }
    const nids = claimed.rows.flatMap((r) => (r.notification_id ? [r.notification_id] : []))
    const boards = await db.query<BoardRow>(
      `SELECT n.id, n.board_id, b.title AS board_title, b.visibility
         FROM notifications n JOIN boards b ON b.id = n.board_id AND b.workspace_id = n.workspace_id
        WHERE n.id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(nids)],
    )
    const live = new Set(boards.rows.map((b) => b.id))
    const gone = claimed.rows
      .filter((r) => !r.notification_id || !live.has(r.notification_id))
      .map((r) => r.id)
    for (const id of gone) await setDone(id, 'dropped', 'gone', at)
    tally.dropped += gone.length
    const kept = claimed.rows.filter((r) => !gone.includes(r.id))
    if (kept.length === 0) return
    const distinct = new Set(boards.rows.map((b) => b.board_id))
    const first = boards.rows[0]
    const single = distinct.size === 1 && first !== undefined
    const text = chatRollupSentence(kept.length, single ? titleFor(first, hook.include_snippets) : null)
    const url = await openUrl(hook)
    const keptIds = kept.map((r) => r.id)
    if (url === null) {
      await settle(keptIds, hookId, { action: 'fail', code: 'unsealed' }, at, 'coalesced', tally)
      return
    }
    await paced(hookId)
    const outcome: PostOutcome = await opts.post(
      url,
      noticePayloadFor(hook.provider, {
        text,
        link: single
          ? boardLink(origin, first.board_id, null)
          : workspaceLink(origin, hook.workspace_id),
        workspaceName: hook.workspace_name,
      }),
    )
    const attempts = Math.max(...kept.map((r) => r.attempts))
    const oldest = Math.min(...kept.map((r) => r.created_at.getTime()))
    const decision = decide(outcome, attempts, at.getTime() - oldest)
    await settle(keptIds, hookId, decision, ctx.now(), 'coalesced', tally, 'coalesced')
    if (decision.action === 'sent') tally.rollups += 1
  }

  // ---- the pass ---------------------------------------------------------------------------------------------------------

  async function purge(at: Date) {
    const cutoff = new Date(at.getTime() - CHAT_DELIVERY.retentionDays * 86_400_000)
    await db.query('DELETE FROM chat_deliveries WHERE created_at < $1', [cutoff])
  }

  async function runTick(): Promise<TickResult> {
    const tally = emptyTally()
    const at = ctx.now()
    if (monotonic() - lastPurge >= PURGE_EVERY_MS) {
      lastPurge = monotonic()
      await purge(at)
    }
    if (!box) return tally // hooks are off: nothing is sent, the purge above still ages the outbox out
    await db.query(
      `UPDATE chat_deliveries SET status = 'queued', lease_until = NULL, next_at = $1
        WHERE status = 'sending' AND lease_until < $1`,
      [at],
    )
    const claimed = await db.query<Claimed>(
      `UPDATE chat_deliveries
          SET status = 'sending', attempts = attempts + 1, lease_until = $3
        WHERE id IN (SELECT id FROM chat_deliveries
                      WHERE status = 'queued' AND next_at <= $1
                      ORDER BY next_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, hook_id, attempts`,
      [at, CHAT_DELIVERY.batch, new Date(at.getTime() + CHAT_DELIVERY.leaseMs)],
    )
    tally.claimed = claimed.rows.length
    const byHook = new Map<string, Claimed[]>()
    for (const c of claimed.rows) byHook.set(c.hook_id, [...(byHook.get(c.hook_id) ?? []), c])
    const due = await db.query<{ hook_id: string }>(
      `SELECT DISTINCT hook_id FROM chat_deliveries WHERE status = 'coalesced' AND next_at <= $1 LIMIT 50`,
      [at],
    )
    const hooks = new Set([...byHook.keys(), ...due.rows.map((r) => r.hook_id)])
    await Promise.all(
      [...hooks].map(async (hookId) => {
        for (const c of byHook.get(hookId) ?? []) {
          try {
            await deliver(c, tally)
          } catch (e) {
            // a bug or a database error: try again later, like a network failure
            log.warn({ feature: 'chat-hooks', hook: hookId, err: errorFacts(e) }, 'chat delivery failed')
            await settle(
              [c.id],
              hookId,
              decide({ kind: 'error', code: 'network' }, c.attempts, 0),
              ctx.now(),
              'queued',
              tally,
            ).catch(() => {})
          }
        }
        try {
          await rollUp(hookId, tally)
        } catch (e) {
          log.warn({ feature: 'chat-hooks', hook: hookId, err: errorFacts(e) }, 'chat roll-up failed')
        }
      }),
    )
    return tally
  }

  function tick(): Promise<TickResult> {
    // passes never overlap in one process: the next waits for this one
    const next = (running ?? Promise.resolve(emptyTally())).catch(() => emptyTally()).then(runTick)
    running = next
    return next
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => {
        if (closing) return
        tick().catch((e) =>
          log.warn({ feature: 'chat-hooks', err: errorFacts(e) }, 'chat delivery pass failed'),
        )
      }, CHAT_DELIVERY.loopMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    async close() {
      if (timer) clearInterval(timer)
      timer = null
      closing = true
      await (running ?? Promise.resolve()).catch(() => {})
    },
    reseal,
  }
}
