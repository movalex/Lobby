// F10 (wave L, L6-5) through the real server process: after a scripted push burst (two editors, a note with
// words, a reconnect and a laser stroke), GET /internal/metrics has the realtime-quality histograms with their
// buckets and counts, and the new lines carry no board id, user id or note text. User ids and note text are
// nowhere in the output; the board id only in the per-board gauges that were there before (lobby_board_*,
// docs/EXCALIDRAW-MIGRATION.md §2.4.6), which are unchanged.

import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import { label, note, rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const NEW_HISTOGRAMS = [
  'lobby_push_to_commit_ms',
  'lobby_commit_to_fanout_ms',
  'lobby_outbound_queue_bytes',
  'lobby_ack_send_ms',
  'lobby_reconnects_per_minute',
] as const

const metricValue = (text: string, line: string) => {
  const hit = text.split('\n').find((l) => l.startsWith(`${line} `))
  return hit ? Number(hit.slice(line.length + 1)) : Number.NaN
}

describe('F10: realtime-quality histograms in /internal/metrics', () => {
  it('appear with buckets after a push burst, and name no board, user or content', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const words = 'Quarterly pricing idea for Halden'
    const alice = await st.client({ boardId: b, user: 'usr_metrics_alice' })
    const bob = await st.client({ boardId: b, user: 'usr_metrics_bob' })
    // a burst: 30 pushes from two editors at once, one of them a note with words
    const acks = []
    for (let i = 0; i < 15; i++) {
      acks.push(alice.create([rect(`ra${i}`, { x: i * 30 })]))
      acks.push(bob.create([rect(`rb${i}`, { x: i * 30, y: 500 })]))
    }
    acks.push(
      alice.create([
        note('n1', { x: 2000, boundElements: [{ id: 'n1t', type: 'text' }] }),
        label('n1t', 'n1', { text: words, originalText: words }),
      ]),
    )
    const done = await Promise.all(acks)
    expect(done.every((a) => a.r.every((r) => r.ok))).toBe(true)
    // a reconnect: bob comes back with the board state he holds
    const again = await st.client({
      boardId: b,
      user: 'usr_metrics_bob',
      tab: 'tab-2',
      since: bob.clock,
      epoch: bob.welcome?.epoch ?? null,
    })
    expect(again.welcome).not.toBeNull()
    // a laser stroke (CONTRACTS_REV 12): counted, never named
    alice.send({
      type: 'presence',
      pointer: { x: 10, y: 10 },
      button: 'down',
      sel: [],
      view: null,
      idle: false,
      editing: null,
      f: null,
      t: 'laser',
      trail: [{ x: 5, y: 10 }],
    })
    await sleep(200)

    const res = await callInternal(st.server.url, 'GET', '/internal/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const name of NEW_HISTOGRAMS) {
      expect(text, name).toContain(`# TYPE ${name} histogram`)
      expect(text.split('\n').filter((l) => l.startsWith(`${name}_bucket{le=`)).length).toBeGreaterThan(5)
    }
    expect(metricValue(text, 'lobby_push_to_commit_ms_count')).toBeGreaterThanOrEqual(31)
    expect(metricValue(text, 'lobby_commit_to_fanout_ms_count')).toBeGreaterThan(0)
    expect(metricValue(text, 'lobby_outbound_queue_bytes_count')).toBeGreaterThan(0)
    expect(metricValue(text, 'lobby_ack_send_ms_count')).toBeGreaterThanOrEqual(31)
    expect(metricValue(text, 'lobby_reconnects_total')).toBeGreaterThanOrEqual(1)
    expect(metricValue(text, 'lobby_presence_laser_in_total')).toBeGreaterThanOrEqual(1)
    // wave M (M7-3): the laser frames under their wave M name (the same count)
    expect(metricValue(text, 'lobby_laser_frames_in_total')).toBe(
      metricValue(text, 'lobby_presence_laser_in_total'),
    )
    // wave M (M7-5): the process-wide outbound queue and its budget (DRAFTROOM_OUTBOUND_BUDGET_MB, 64 MiB since wave N.1)
    expect(metricValue(text, 'lobby_outbound_bytes_queued')).toBeGreaterThanOrEqual(0)
    expect(metricValue(text, 'lobby_outbound_budget_bytes')).toBe(64 * 1024 * 1024)
    expect(metricValue(text, 'lobby_outbound_over_budget')).toBe(0)
    // for the record: a group commit's mean (BEGIN to COMMIT, which the hooks are not inside) and the new means
    const mean = (n: string) => metricValue(text, `${n}_sum`) / metricValue(text, `${n}_count`)
    console.log(
      `[F10] burst: commit ${mean('lobby_commit_ms').toFixed(2)} ms, push to COMMIT ${mean('lobby_push_to_commit_ms').toFixed(2)} ms, fan-out ${mean('lobby_commit_to_fanout_ms').toFixed(3)} ms, ack written ${mean('lobby_ack_send_ms').toFixed(2)} ms`,
    )
    // the push-to-COMMIT of every push is at most its receive-to-ack (the ack is sent after the COMMIT)
    expect(metricValue(text, 'lobby_push_to_commit_ms_sum')).toBeLessThanOrEqual(
      metricValue(text, 'lobby_receive_to_ack_ms_sum') + 1,
    )

    // nothing that names a board, a person or what they wrote
    const lines = text.split('\n')
    const newLines = lines.filter((l) =>
      [
        ...NEW_HISTOGRAMS,
        'lobby_reconnects_total',
        'lobby_presence_laser_in_total',
        'lobby_laser_frames_in_total',
      ].some((n) => l.replace(/^# (TYPE|HELP) /, '').startsWith(n)),
    )
    expect(newLines.length).toBeGreaterThan(40)
    for (const l of newLines) {
      expect(l).not.toContain(b)
      expect(l).not.toContain('usr_metrics')
      expect(l).not.toContain('Halden')
    }
    for (const needle of [
      'usr_metrics_alice',
      'usr_metrics_bob',
      'metrics_alice',
      words,
      'Halden',
      'pricing',
    ])
      expect(text, needle).not.toContain(needle)
    // the board id is only in the per-board gauges that were there before (lobby_board_*)
    for (const l of lines.filter((x) => x.includes(b))) expect(l).toMatch(/^lobby_board_[a-z_]+\{board="/)
  })
})
