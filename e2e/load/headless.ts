// Loads O2's headless client (apps/web/src/canvas/sync/headless; Node-safe by CONTRACTS.md) and wraps it
// with the meter. Until O2 fills the C0 stub, creating a client throws "not implemented (O2)", and the
// load run stops at its first join with that message.
import type { HeadlessClientOptions } from '../../apps/web/src/canvas/sync/types.ts'
import { type ClientFactory, realClientFactory } from './session.ts'

export async function loadHeadlessFactory(): Promise<ClientFactory> {
  const mod = (await import('../../apps/web/src/canvas/sync/headless/index.ts')) as {
    createHeadlessClient: (o: HeadlessClientOptions) => ReturnType<ClientFactory>
  }
  return realClientFactory(mod.createHeadlessClient)
}
