// Test helper (unit tests only): the mind map's in-memory canvas (../mindmap/test-canvas.ts: creates, updates with
// `customData.lobby` merged per key, deletes, a snapshot undo stack) with what the storyboard reads and writes on top:
// the scene index (by lobby key, by frame), the room's revision, `tx.duplicate` (fresh ids, `sb:of` kept, as the
// duplicate rules say for a panel copied without its head) and `tx.setFrame`.
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { type El, type FakeMapCanvas, fakeMapCanvas } from '../mindmap/test-canvas.ts'

export type { El }

export interface FakeSbCanvas extends FakeMapCanvas {
  setRev(rev: number | null): void
}

export function fakeSbCanvas(seed: El[] = []): FakeSbCanvas {
  const fake = fakeMapCanvas(seed)
  let rev: number | null = 14
  let n = 0
  const c = fake.canvas as unknown as Record<string, unknown>
  const live = () => [...fake.els.values()].filter((e) => !e.isDeleted)
  const lobbyOf = (e: El) => (e.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}
  c.index = {
    withLobbyKey: (key: string) => live().filter((e) => key in lobbyOf(e)),
    withLobbyKeyPrefix: (p: string) =>
      live().filter((e) => Object.keys(lobbyOf(e)).some((k) => k.startsWith(p))),
    byFrame: (frameId: string) => live().filter((e) => e.frameId === frameId),
    byKind: (kind: string) => live().filter((e) => lobbyOf(e).kind === kind),
    byType: (type: string) => live().filter((e) => e.type === type),
    notes: () => live().filter((e) => e.type === 'stickynote'),
    count: () => live().length,
    onChanged: () => () => undefined,
  }
  c.room = { contractsRev: () => rev }
  c.isLocked = (id: string) => fake.els.get(id)?.locked === true
  const inner = c.transact as (
    label: string,
    fn: (tx: Record<string, unknown>) => unknown,
    o?: unknown,
  ) => unknown
  c.transact = (label: string, fn: (tx: Record<string, unknown>) => unknown, o?: unknown) =>
    inner(
      label,
      (tx) => {
        tx.duplicate = (ids: readonly string[], offset: { x: number; y: number } = { x: 0, y: 0 }) => {
          const map = new Map<string, string>()
          for (const id of ids) map.set(id, `${id}-copy${++n}`)
          for (const id of ids) {
            const e = fake.els.get(id)
            if (!e) continue
            const copy = structuredClone(e) as El
            copy.id = map.get(id) as string
            copy.x = e.x + offset.x
            copy.y = e.y + offset.y
            if (typeof e.frameId === 'string' && map.has(e.frameId)) copy.frameId = map.get(e.frameId)
            if (typeof e.containerId === 'string' && map.has(e.containerId))
              copy.containerId = map.get(e.containerId)
            const bound = e.boundElements as { id: string; type: string }[] | null | undefined
            if (bound) copy.boundElements = bound.map((b) => ({ ...b, id: map.get(b.id) ?? b.id }))
            fake.els.set(copy.id, copy)
          }
          return map
        }
        tx.setFrame = (ids: readonly string[], frameId: string | null) => {
          for (const id of ids) {
            const e = fake.els.get(id)
            if (e) fake.els.set(id, { ...e, frameId })
          }
        }
        return fn(tx)
      },
      o,
    )
  return {
    ...fake,
    setRev(v) {
      rev = v
    },
  }
}

export const asCanvas = (f: FakeSbCanvas) => f.canvas as LobbyCanvas
