/**
 * O2's headless client: the engine core on a Map-backed scene and a WebSocket, for Node (O1's protocol
 * tests, O3's load generator). STUB written by the lead at the spike B contracts step C0; O2 owns it from
 * C0 on. Node-safe (CONTRACTS.md).
 */
import type { CreateHeadlessClient } from '../types.ts'

export const createHeadlessClient: CreateHeadlessClient = (options) => {
  void options
  throw new Error('not implemented (O2): apps/web/src/canvas/sync/headless/index.ts createHeadlessClient')
}
