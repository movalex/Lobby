// O3's spike B harness (types: ./types.ts). STUB written by the lead at the contracts step C0; O3 owns
// e2e/spike-b/support/** except types.ts and ports.ts from C0 on. Every owner's spec imports `harness`
// from here.

import type { SpikeBHarness } from './types.ts'

const missing = (name: string) => () => {
  throw new Error(`not implemented (O3): e2e/spike-b/support/harness.ts ${name}`)
}

export const harness: SpikeBHarness = {
  startStack: missing('startStack'),
  launchBrowser: missing('launchBrowser'),
  devUser: missing('devUser'),
  createBarrier: missing('createBarrier'),
  forgeSocket: missing('forgeSocket'),
  readSnapshot: missing('readSnapshot'),
  checkInvariants: missing('checkInvariants'),
  converged: missing('converged'),
  recordPushes: missing('recordPushes'),
  testHooks: missing('testHooks'),
}
