// The client side of the test hooks (docs/EXCALIDRAW-MIGRATION.md §2.4.6, §8.6.2 TestHooks):
//
//  - leaseGrant(board, mode) → POST <sync>/internal/test/boards/:bid/lease-hook (L12): the next grants on
//    the board are delayed, held, released or normal again;
//  - failNextCommits(board, n) → POST …/fail-commit (D4): the room's next n COMMITs throw;
//  - withLatency(page, ms), cutSocket(page), restoreSocket(page): the page's socket relay (relay.ts; no
//    server involved).
//
// The two server hooks are no-ops when the stack runs without DRAFTROOM_TEST_HOOKS=1 (as the frozen type
// says); with the flag, any answer but 204 throws (a 404 there means O1's room registered no hooks).
import type { Page } from '@playwright/test'
import { type LeaseHookRequest, TEST_HOOK_PATHS } from '../../../packages/canvas-schema/src/protocol.ts'
import { type CutMode, cut, restore, setLatency } from './relay.ts'
import type { LeaseGrantMode, SpikeBStack, TestHooks } from './types.ts'

/** O3's TestHooks: the frozen ones, with the relay's options for D5/L7 and the refused-reconnect mode. */
export interface O3TestHooks extends TestHooks {
  /** `mode: 'hold'` (default): reconnects are accepted and never answered; `'refuse'`: closed at once */
  cutSocket(page: Page, opts?: { mode?: CutMode }): Promise<void>
  /** `release: false` keeps held sockets held until the page unloads (D5); default: they are closed now */
  restoreSocket(page: Page, opts?: { release?: boolean }): Promise<void>
}

/** The request body a `LeaseGrantMode` becomes. */
export function leaseHookBody(mode: LeaseGrantMode): LeaseHookRequest {
  if ('delayMs' in mode) return { mode: 'delay', ms: mode.delayMs }
  if ('hold' in mode) return { mode: 'hold' }
  if ('release' in mode) return { mode: 'release' }
  return { mode: 'off' }
}

async function post(stack: SpikeBStack, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${stack.ports.syncUrl}${path}`, {
    method: 'POST',
    headers: { 'x-draftroom-internal': stack.internalSecret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status !== 204) {
    const text = (await res.text()).slice(0, 200)
    throw new Error(`test hook ${path.split('/').pop()}: HTTP ${res.status} ${text}`)
  }
}

export function testHooksFor(stack: SpikeBStack & { readonly testHooks?: boolean }): O3TestHooks {
  const enabled = stack.testHooks !== false
  return {
    async leaseGrant(board, mode) {
      if (!enabled) return
      await post(stack, TEST_HOOK_PATHS.leaseHook(board), leaseHookBody(mode))
    },
    async failNextCommits(board, n) {
      if (!enabled) return
      await post(stack, TEST_HOOK_PATHS.failCommit(board), { count: n })
    },
    async withLatency(page, ms) {
      return setLatency(page, ms)
    },
    async cutSocket(page, opts) {
      await cut(page, opts)
    },
    async restoreSocket(page, opts) {
      await restore(page, opts)
    },
  }
}
