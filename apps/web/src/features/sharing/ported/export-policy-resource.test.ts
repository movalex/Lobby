// K1-4 (wave K): the board's export policy is ONE shared, invalidatable resource that every gate reads
// (export-policy.ts). Before, the sharing feature, canvas-ux's copy gate, the mind-map outline and the file
// cards each read GET /api/boards/:bid/export-policy (about 4 reads per open on staging). Concurrent first
// callers share one read; a sharing change, a policy event and a stream resync each read again exactly once;
// another board id is its own entry; a board nobody keeps current any more is read again by the next session.
import type { ExportPolicyState } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../../api/client.ts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { downloadsAllowed, syncExportPolicy as syncMediaPolicy } from '../../../file-card/ported/downloads.ts'
import { exportAllowedOnBoard, syncExportGate } from '../../canvas-ux/ported/export-gate.ts'
import type { BoardEvents } from '../../events.ts'
import { useExportAllowed as _historyHook } from '../../history/ported/export-allowed.ts'
import { watchExportPolicy } from '../../mindmap/ported/export-gate.ts'
import {
  exportStateOf,
  getExportPolicy,
  HELLO_WAIT_MS,
  invalidateExportPolicy,
  refreshExportPolicy,
  syncExportPolicy,
} from './export-policy.ts'

void _historyHook // imported to prove the module loads on the resource (its hook needs React)

/** A board event stream: `connected` streams answer onResync at once, as the real one does. */
function fakeEvents(connected: boolean) {
  const handlers = new Map<string, Set<(data: unknown) => void>>()
  const resyncs = new Set<() => void>()
  let isConnected = connected
  const events = {
    on(name: string, fn: (data: unknown) => void) {
      const set = handlers.get(name) ?? new Set()
      handlers.set(name, set)
      set.add(fn)
      return () => void set.delete(fn)
    },
    onResync(fn: () => void) {
      resyncs.add(fn)
      if (isConnected) fn()
      return () => void resyncs.delete(fn)
    },
  } as unknown as BoardEvents
  return {
    events,
    emit: (name: string, data: unknown) => {
      for (const f of handlers.get(name) ?? []) f(data)
    },
    /** the stream (re)connects: every resync listener runs */
    hello: () => {
      isConnected = true
      for (const f of resyncs) f()
    },
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) + resyncs.size,
  }
}

/** An api that counts export-policy reads and answers them by hand (or at once with `auto`). */
function fakeApi(auto?: Partial<ExportPolicyState>) {
  const reads: { path: string; resolve: (s: ExportPolicyState) => void; reject: (e: unknown) => void }[] = []
  const api = {
    request: (method: string, path: string) => {
      if (method !== 'GET' || !path.endsWith('/export-policy'))
        throw new Error(`unexpected ${method} ${path}`)
      return new Promise<ExportPolicyState>((resolve, reject) => {
        reads.push({ path, resolve, reject })
        if (auto) resolve({ exportPolicy: 'everyone', canExport: true, policySet: false, ...auto })
      })
    },
  } as unknown as ApiClient
  return {
    api,
    reads,
    count: (boardId: string) => reads.filter((r) => r.path === `/api/boards/${boardId}/export-policy`).length,
    answer: (i: number, s: Partial<ExportPolicyState> = {}) =>
      reads[i]?.resolve({ exportPolicy: 'everyone', canExport: true, policySet: false, ...s }),
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function featureCtx(
  boardId: string,
  api: ApiClient,
  events: BoardEvents,
  role: 'viewer' | 'editor' = 'viewer',
) {
  return {
    board: { id: boardId, title: 'Board' },
    role,
    me: { user: { id: 'usr_resource_test', name: 'Test' } },
    api,
    events,
    notify: () => {},
  } as unknown as CanvasFeatureContext
}

describe('the shared export-policy resource', () => {
  it('concurrent first callers share one read: the board session’s four gates read the policy once', async () => {
    const boardId = 'b-res-first'
    const { events } = fakeEvents(true)
    const { api, count, answer } = fakeApi()
    const ctx = featureCtx(boardId, api, events)
    // the four readers of a board open: sharing's sync, canvas-ux's copy gate, the mind map, the file cards
    const stops = [
      syncExportPolicy({ boardId, api, events }),
      syncExportGate(ctx),
      watchExportPolicy(ctx).dispose,
      syncMediaPolicy(ctx),
    ]
    expect(count(boardId)).toBe(1)
    // and callers of the getter meanwhile wait for that same read
    const waits = [getExportPolicy(api, boardId), getExportPolicy(api, boardId)]
    expect(count(boardId)).toBe(1)
    answer(0, { exportPolicy: 'editors', canExport: false, policySet: true })
    const answers = await Promise.all(waits)
    expect(answers.map((a) => a.exportPolicy)).toEqual(['editors', 'editors'])
    // every reader sees it
    expect(exportStateOf(boardId).policy.get()).toBe('editors')
    expect(exportStateOf(boardId).stored.get()).toBe(true)
    expect(exportStateOf(boardId).canExport.get()).toBe(false)
    expect(exportAllowedOnBoard(boardId, 'viewer', false)).toBe(false)
    expect(downloadsAllowed(ctx)).toBe(false)
    // a fresh answer is answered from the resource: no read
    expect((await getExportPolicy(api, boardId)).exportPolicy).toBe('editors')
    expect(count(boardId)).toBe(1)
    for (const stop of stops) stop()
  })

  it('getter callers with no session share one read too (the dashboard’s Share dialog)', async () => {
    const boardId = 'b-res-getter'
    const { api, count, answer } = fakeApi()
    const a = getExportPolicy(api, boardId)
    const b = getExportPolicy(api, boardId)
    const c = getExportPolicy(api, boardId)
    expect(count(boardId)).toBe(1)
    answer(0, { exportPolicy: 'everyone-including-guests' })
    expect((await Promise.all([a, b, c])).map((s) => s.exportPolicy)).toEqual([
      'everyone-including-guests',
      'everyone-including-guests',
      'everyone-including-guests',
    ])
  })

  it('a stream still connecting: one read at once and one after its hello, however many readers attach', async () => {
    const boardId = 'b-res-connecting'
    const { events, hello } = fakeEvents(false)
    const { api, count, answer } = fakeApi()
    const ctx = featureCtx(boardId, api, events)
    const stops = [syncExportPolicy({ boardId, api, events }), syncExportGate(ctx), syncMediaPolicy(ctx)]
    expect(count(boardId)).toBe(1)
    hello()
    expect(count(boardId)).toBe(2)
    answer(0, { exportPolicy: 'everyone' })
    answer(1, { exportPolicy: 'editors' })
    await tick()
    expect(exportStateOf(boardId).policy.get()).toBe('editors')
    for (const stop of stops) stop()
  })

  it('the gates first, on a stream still connecting: no read until its hello, which is the one read', async () => {
    const boardId = 'b-res-patient'
    const { events, hello } = fakeEvents(false)
    const { api, count, answer } = fakeApi()
    const ctx = featureCtx(boardId, api, events)
    // the board's features install first (their gates), then the sharing feature's overlay mounts
    const stops = [
      syncExportGate(ctx),
      watchExportPolicy(ctx).dispose,
      syncMediaPolicy(ctx),
      syncExportPolicy({ boardId, api, events }),
    ]
    expect(count(boardId)).toBe(0)
    hello()
    expect(count(boardId)).toBe(1)
    answer(0, { exportPolicy: 'editors', canExport: false })
    await tick()
    expect(exportStateOf(boardId).policy.get()).toBe('editors')
    expect(exportAllowedOnBoard(boardId, 'viewer', false)).toBe(false)
    for (const stop of stops) stop()
  })

  it('the gates first, and the hello is late: one read after HELLO_WAIT_MS, and the hello reads again', async () => {
    vi.useFakeTimers()
    try {
      const boardId = 'b-res-late'
      const { events, hello } = fakeEvents(false)
      const { api, count, answer } = fakeApi()
      const ctx = featureCtx(boardId, api, events)
      const stop = syncExportGate(ctx)
      vi.advanceTimersByTime(HELLO_WAIT_MS - 1)
      expect(count(boardId)).toBe(0)
      vi.advanceTimersByTime(1)
      expect(count(boardId)).toBe(1)
      answer(0, { exportPolicy: 'editors' })
      await vi.advanceTimersByTimeAsync(0)
      expect(exportStateOf(boardId).policy.get()).toBe('editors')
      hello()
      expect(count(boardId)).toBe(2)
      // detached before its timer: nothing is read
      const other = fakeEvents(false)
      const stopOther = syncExportGate(featureCtx('b-res-gone', api, other.events))
      stopOther()
      vi.advanceTimersByTime(HELLO_WAIT_MS * 2)
      expect(count('b-res-gone')).toBe(0)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidation reads again exactly once: a sharing change, a policy event, a stream resync', async () => {
    const boardId = 'b-res-invalidate'
    const { events, emit, hello } = fakeEvents(true)
    const { api, count, answer } = fakeApi()
    const ctx = featureCtx(boardId, api, events, 'editor')
    const stops = [
      syncExportPolicy({ boardId, api, events }),
      syncExportGate(ctx),
      watchExportPolicy(ctx).dispose,
    ]
    expect(count(boardId)).toBe(1)
    answer(0)
    await tick()

    // a sharing change in this tab (the Share dialog): one read, shared with the dialog's own wait
    const refreshed = refreshExportPolicy(api, boardId)
    expect(count(boardId)).toBe(2)
    answer(1, { exportPolicy: 'editors', policySet: true })
    await refreshed
    expect(exportStateOf(boardId).policy.get()).toBe('editors')
    invalidateExportPolicy(boardId)
    expect(count(boardId)).toBe(3)
    answer(2, { exportPolicy: 'editors', policySet: true })
    await tick()

    // a policy event: applied at once (before any answer), then one read for canExport and policySet
    emit('export-control.policy', { exportPolicy: 'everyone-including-guests' })
    expect(exportStateOf(boardId).policy.get()).toBe('everyone-including-guests')
    expect(exportStateOf(boardId).stored.get()).toBe(true)
    expect(count(boardId)).toBe(4)
    answer(3, { exportPolicy: 'everyone-including-guests', canExport: true, policySet: true })
    await tick()
    expect(exportStateOf(boardId).canExport.get()).toBe(true)

    // a stream reconnect: one read (a single listener per stream, however many readers)
    hello()
    expect(count(boardId)).toBe(5)
    answer(4, { exportPolicy: 'everyone-including-guests', policySet: true })
    await tick()
    // a malformed event changes nothing and reads nothing
    emit('export-control.policy', { exportPolicy: 'nobody' })
    expect(count(boardId)).toBe(5)
    expect(exportStateOf(boardId).policy.get()).toBe('everyone-including-guests')
    for (const stop of stops) stop()
  })

  it('an answer to a read asked before a policy event never overwrites the event', async () => {
    const boardId = 'b-res-order'
    const { events, emit } = fakeEvents(true)
    const { api, answer } = fakeApi()
    const stop = syncExportPolicy({ boardId, api, events })
    emit('export-control.policy', { exportPolicy: 'editors' }) // read 1, asked after the event
    answer(0, { exportPolicy: 'everyone' }) // read 0 was asked before: dropped
    await tick()
    expect(exportStateOf(boardId).policy.get()).toBe('editors')
    answer(1, { exportPolicy: 'editors', canExport: false, policySet: true })
    await tick()
    expect(exportStateOf(boardId).canExport.get()).toBe(false)
    stop()
  })

  it('another board id gets its own entry', async () => {
    const one = 'b-res-one'
    const two = 'b-res-two'
    const { events: e1 } = fakeEvents(true)
    const { events: e2 } = fakeEvents(true)
    const { api, count, answer } = fakeApi()
    const s1 = syncExportPolicy({ boardId: one, api, events: e1 })
    const s2 = syncExportPolicy({ boardId: two, api, events: e2 })
    expect(count(one)).toBe(1)
    expect(count(two)).toBe(1)
    answer(0, { exportPolicy: 'editors' })
    answer(1, { exportPolicy: 'everyone-including-guests' })
    await tick()
    expect(exportStateOf(one).policy.get()).toBe('editors')
    expect(exportStateOf(two).policy.get()).toBe('everyone-including-guests')
    invalidateExportPolicy(one)
    expect(count(one)).toBe(2)
    expect(count(two)).toBe(1)
    s1()
    s2()
  })

  it('the last reader leaving: listeners removed, the answer kept for display, the next session reads again', async () => {
    const boardId = 'b-res-leave'
    const first = fakeEvents(true)
    const { api, count, answer } = fakeApi()
    const ctx = featureCtx(boardId, api, first.events)
    const stops = [syncExportPolicy({ boardId, api, events: first.events }), syncMediaPolicy(ctx)]
    answer(0, { exportPolicy: 'editors' })
    await tick()
    expect(first.listeners()).toBe(2) // one policy listener and one resync listener for the stream
    stops[0]?.()
    stops[0]?.() // a second call of the same detach changes nothing
    expect(first.listeners()).toBe(2)
    stops[1]?.()
    expect(first.listeners()).toBe(0)
    expect(exportStateOf(boardId).policy.get()).toBe('editors')
    // a later session (a new stream): read again, once
    const again = fakeEvents(true)
    const stop = syncExportPolicy({ boardId, api, events: again.events })
    expect(count(boardId)).toBe(2)
    answer(1, { exportPolicy: 'editors' })
    await tick()
    // no session at all: the getter reads too, because nothing kept the answer current
    stop()
    void getExportPolicy(api, boardId).catch(() => {})
    expect(count(boardId)).toBe(3)
  })

  it('a failed read keeps what the board had, and the next invalidation reads again', async () => {
    const boardId = 'b-res-fail'
    const { events } = fakeEvents(true)
    const { api, reads, count, answer } = fakeApi()
    const stop = syncExportPolicy({ boardId, api, events })
    answer(0, { exportPolicy: 'editors' })
    await tick()
    invalidateExportPolicy(boardId)
    reads[1]?.reject(new Error('offline'))
    await tick()
    expect(exportStateOf(boardId).policy.get()).toBe('editors')
    // not fresh after the failure: the getter asks again
    const p = getExportPolicy(api, boardId)
    expect(count(boardId)).toBe(3)
    answer(2, { exportPolicy: 'everyone' })
    expect((await p).exportPolicy).toBe('everyone')
    stop()
  })

  it('without a board session an answer is never kept as current: the next getter asks again', async () => {
    const boardId = 'b-res-nosession'
    const { api, count, answer } = fakeApi()
    const first = getExportPolicy(api, boardId)
    answer(0, { exportPolicy: 'editors' })
    expect((await first).exportPolicy).toBe('editors')
    // an hour later on the dashboard: nothing kept it current (no events), so it is read again
    const later = getExportPolicy(api, boardId)
    expect(count(boardId)).toBe(2)
    answer(1, { exportPolicy: 'everyone' })
    expect((await later).exportPolicy).toBe('everyone')
  })

  it('a caller’s abort stops its own wait only', async () => {
    const boardId = 'b-res-abort'
    const { api, count, answer } = fakeApi()
    const controller = new AbortController()
    const mine = getExportPolicy(api, boardId, controller.signal)
    const other = getExportPolicy(api, boardId)
    controller.abort()
    await expect(mine).rejects.toBeDefined()
    answer(0, { exportPolicy: 'editors' })
    expect((await other).exportPolicy).toBe('editors')
    expect(count(boardId)).toBe(1)
  })
})
