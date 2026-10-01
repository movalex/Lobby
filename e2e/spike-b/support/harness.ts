// O3's spike B harness (docs/EXCALIDRAW-MIGRATION.md §8.1, §8.6.2; types: ./types.ts, frozen at C0).
// Every owner's spec imports `harness` from here:
//
//   const stack = await harness.startStack()                    // api + sync (+ worker) on SPIKE_B_PORT_BASE
//   const a = await harness.launchBrowser(stack, harness.devUser('A'), { name: 'A' })   // its own process
//   const { boardId } = await stack.createBoard({ owner: a.user, members: [{ user: b.user, role: 'editor' }] })
//   await a.openBoard(boardId)                                  // facade installed, welcome applied
//   const snap = await harness.readSnapshot(stack, boardId)     // live + tombstones, hash.ts digest
//   const report = await harness.converged(stack, boardId, [a, b], { horizonAtStart: snap.horizon })
//   expect(harness.checkInvariants(report.snapshot).ok).toBe(true)
//
// A name-only guest (A3): `launchBrowser(stack, harness.devUser('Sam'), { name: 'G', guest: true })` starts
// with no session; its `openBoard(boardId)` joins through the product's invite page with the DevUser's name,
// on a guest link the board's owner makes (`stack.createBoard` boards only). A limited (read-only, viewer)
// guest by default; `guestRole: 'editor'` (a workshop link) or `'commenter'` for the others.
//
// The modules behind it (all O3's): stack.ts (launcher on e2e/tests/support/stack.ts), browsers.ts
// (separate Chromium processes, dev sign-in), relay.ts (latency relay and socket cut), barrier.ts,
// forge.ts (raw sockets with the page's own ticket), snapshot.ts (test snapshot, hash, invariants,
// convergence), pushes.ts (B10 recorder and evidence), hooks.ts (lease and COMMIT hooks), facade.ts
// (typed facade calls). Import those directly for their extras.
import './env.ts'
import { createBarrier } from './barrier.ts'
import { launchSpikeBrowser, type O3BrowserOptions, type O3BrowserProcess } from './browsers.ts'
import { forgeSocket, type O3ForgeSocket } from './forge.ts'
import { type O3TestHooks, testHooksFor } from './hooks.ts'
import { recordPushes } from './pushes.ts'
import { checkInvariants, converged, readSnapshot } from './snapshot.ts'
import { type O3Stack, startSpikeStack } from './stack.ts'
import type { DevUser, SpikeBHarness, SpikeBStack, StackOptions } from './types.ts'
import { devUser } from './users.ts'

/** The frozen harness, with O3's richer return types (every extra is optional to use). */
export interface O3Harness extends SpikeBHarness {
  startStack(opts?: StackOptions): Promise<O3Stack>
  launchBrowser(stack: SpikeBStack, user: DevUser, opts: O3BrowserOptions): Promise<O3BrowserProcess>
  forgeSocket(page: import('@playwright/test').Page, boardId: string): Promise<O3ForgeSocket>
  testHooks(stack: SpikeBStack): O3TestHooks
}

export const harness: O3Harness = {
  startStack: startSpikeStack,
  launchBrowser: launchSpikeBrowser,
  devUser,
  createBarrier: (parties) => createBarrier(parties),
  forgeSocket,
  readSnapshot,
  checkInvariants,
  converged: (stack, boardId, targets, opts) => converged(stack, boardId, targets, opts),
  recordPushes,
  testHooks: testHooksFor,
}

export { createBarrier, releaseTogether, runTogether } from './barrier.ts'
export { closeAllBrowsers, joinBoardAsGuest, waitBoardReady } from './browsers.ts'
export { canvasOf, waitElement, waitSaved } from './facade.ts'
export { forgeSession, freshHello } from './forge.ts'
export { writePushEvidence } from './pushes.ts'
export { divergence, explainDivergence } from './snapshot.ts'
