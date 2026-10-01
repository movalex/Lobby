/**
 * O2's pure engine core (docs/EXCALIDRAW-MIGRATION.md §2.5), the implementation of `EngineCore`
 * (`../types.ts`, frozen at C0). O2 owns `canvas/sync/**` except `types.ts`. Node-safe (CONTRACTS.md): O1's
 * protocol tests and O3's load generator run it in Node through `../headless/index.ts`.
 */
import type { CreateEngineCore } from '../types.ts'
import { LobbyEngineCore } from './engine.ts'

export { type CoreEvent, gestureActive, LobbyEngineCore } from './engine.ts'
export type { GroupKey } from './fields.ts'
export { createMemoryOfflineStore } from './offline-memory.ts'
export { computeSaveStatus, RETRYING_AFTER_MS, type SaveInputs } from './saved.ts'

export const createEngineCore: CreateEngineCore = (options) => new LobbyEngineCore(options)
