// Wave 3e: the Excalidraw page's export policy store (export-policy.ts): unknown counts as allowed, the
// role, the guest flag and the policy decide, a board event always wins over an answer to an earlier
// request, and a resync refetches.
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../api/client.ts'
import type { BoardEvents } from '../../events.ts'
import {
  exportAllowedOn,
  exportCertainOn,
  exportStateOf,
  guardExportOn,
  syncExportPolicy,
} from './export-policy.ts'

function fakeEvents() {
  const handlers = new Map<string, ((data: unknown) => void)[]>()
  const resyncs: (() => void)[] = []
  const events = {
    on(name: string, fn: (data: unknown) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn])
      return () => {}
    },
    onResync(fn: () => void) {
      resyncs.push(fn)
      return () => {}
    },
  } as unknown as BoardEvents
  return {
    events,
    emit: (name: string, data: unknown) => {
      for (const f of handlers.get(name) ?? []) f(data)
    },
    resync: () => {
      for (const f of resyncs) f()
    },
  }
}

/** An api whose export-policy answers are released by hand, in any order. */
function fakeApi() {
  const pending: ((v: unknown) => void)[] = []
  const api = {
    request: () =>
      new Promise((resolve) => {
        pending.push(resolve)
      }),
  } as unknown as ApiClient
  return {
    api,
    answer: (i: number, exportPolicy: string, policySet = true) => pending[i]?.({ exportPolicy, policySet }),
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the ported export policy store', () => {
  it('unknown is allowed; editors-only limits viewers and name-only guests, never editors', () => {
    const s = exportStateOf('b-rules')
    expect(exportAllowedOn('b-rules')).toBe(true)
    expect(exportCertainOn('b-rules')).toBe(false)
    s.policy.set('editors')
    s.role.set('viewer')
    expect(exportAllowedOn('b-rules')).toBe(false)
    const notices: string[] = []
    expect(guardExportOn('b-rules', (n) => notices.push(n.testId ?? ''))).toBe(false)
    expect(notices).toEqual(['export-off-notice'])
    s.role.set('editor')
    s.guest.set(true)
    expect(exportAllowedOn('b-rules')).toBe(false)
    s.guest.set(false)
    expect(exportAllowedOn('b-rules')).toBe(true)
    expect(exportCertainOn('b-rules')).toBe(true)
  })

  it('a board event wins over an older answer; a resync asks again', async () => {
    const { events, emit, resync } = fakeEvents()
    const { api, answer } = fakeApi()
    const stop = syncExportPolicy({ boardId: 'b-order', api, events })
    // request 0: the first answer, asked at once
    emit('export-control.policy', { boardId: 'b-order', exportPolicy: 'editors' })
    answer(0, 'everyone') // read before the change: dropped
    await tick()
    expect(exportStateOf('b-order').policy.get()).toBe('editors')
    resync() // request 1 (after the event): applies
    answer(1, 'everyone', false)
    await tick()
    expect(exportStateOf('b-order').policy.get()).toBe('everyone')
    expect(exportStateOf('b-order').stored.get()).toBe(false)
    stop()
  })
})
