// Seeding a board through the real protocol with raw frames (no engine core): `hello`, then creates in
// pushes of at most 500 ops and 512 KiB (the §2.4.2 limits), each acknowledged before the next. Every
// element goes through the server's real accept path (schema, limits, invariants, file-refs, index
// keys), so a seeded board is exactly what the room stores. Used by the load runs (`--seed push`, Node
// sockets) and by the browser specs (through a forge socket in a page: e2e/spike-b/support/seed.ts).
import type { WireElement } from '../../packages/canvas-schema/src/elements.ts'
import {
  type Ack,
  type ClientMessage,
  decodeSnapshotFrame,
  ELEMENT_SCHEMA_VERSION,
  PROTO,
  type ServerMessage,
  type SnapshotFrame,
  type Welcome,
} from '../../packages/canvas-schema/src/protocol.ts'

export const SEED_MAX_OPS = 500
/** under the 512 KiB push limit, with room for the envelope */
export const SEED_MAX_BYTES = 500 * 1024

/** Splits creates into pushes within the op and byte limits (a label stays with its container). */
export function chunkCreates(
  elements: readonly WireElement[],
  maxOps = SEED_MAX_OPS,
  maxBytes = SEED_MAX_BYTES,
): WireElement[][] {
  const chunks: WireElement[][] = []
  let cur: WireElement[] = []
  let bytes = 0
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as WireElement
    const next = elements[i + 1]
    // keep a container and its label in the same push (the label names the container)
    const pair = next && next.type === 'text' && next.containerId === el.id ? [el, next] : [el]
    const size = pair.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)) + 12, 0)
    if (cur.length + pair.length > maxOps || bytes + size > maxBytes) {
      if (cur.length) chunks.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(...pair)
    bytes += size
    if (pair.length === 2) i++
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** What seeding needs from a socket: send a message, and wait for the next message of a type. */
export interface SeedIo {
  send(m: ClientMessage): Promise<void> | void
  next<T extends ServerMessage['type']>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { type: T }>>
}

export interface SeedResult {
  readonly pushes: number
  readonly ops: number
  readonly ok: number
  readonly rejected: Record<string, number>
  /** ids of rejected ops (for the error message; never content) */
  readonly rejectedIds: string[]
  readonly clock: number
  readonly ms: number
}

/** Pushes `elements` as creates on a socket that has had its `welcome`. */
/**
 * Pushes `elements` as creates on a socket that has had its `welcome`. Tombstones (`isDeleted: true`)
 * are created live first and deleted afterwards with a `life` patch, as a user's delete stores them.
 */
export async function seedElements(
  io: SeedIo,
  elements: readonly WireElement[],
  base: number,
): Promise<SeedResult> {
  const t0 = Date.now()
  let seq = 0
  let clock = base
  let ok = 0
  let pushes = 0
  const rejected: Record<string, number> = {}
  const rejectedIds: string[] = []
  const versions = new Map<string, number>()
  const send = async (ops: unknown[]) => {
    const push = { type: 'push' as const, seq: ++seq, base: clock, ops }
    pushes++
    await io.send(push as ClientMessage)
    let ack: Ack
    for (;;) {
      ack = (await io.next('ack', 60_000)) as Ack
      if (ack.seq === push.seq) break
    }
    clock = Math.max(clock, ack.clock)
    return ack
  }
  // frames first: the room refuses a `frameId` naming an element that does not exist yet (INVALID), and a
  // generated board lists each frame after its children (paint order), so a push boundary between them
  // made ≥ 60 INVALID ops and the abuse close (lead, M1/M2). `index` is explicit, so the order is kept.
  const doomed = new Set(elements.filter((el) => el.isDeleted).map((el) => el.id))
  const live = [
    ...elements.filter((el) => el.type === 'frame'),
    ...elements.filter((el) => el.type !== 'frame'),
  ].map((el) => (el.isDeleted ? ({ ...el, isDeleted: false } as WireElement) : el))
  // a chunk's tombstones are deleted right after it lands, so they never count as live items together:
  // the room caps live items at MAX_ITEMS (20,000), which "10,000 notes + 10,000 deleted" would pass if
  // every tombstone were live at once (perf-client's 20k + 10k deleted board: 45 ELEMENT_LIMIT rejects)
  const kill = async (ids: readonly string[]) => {
    for (let i = 0; i < ids.length; i += SEED_MAX_OPS) {
      const ack = await send(
        ids.slice(i, i + SEED_MAX_OPS).map((id) => ({
          k: 'p' as const,
          id,
          pv: versions.get(id) as number,
          g: { life: { isDeleted: true } },
        })),
      )
      for (const r of ack.r)
        if (!r.ok) {
          ok--
          rejected[`delete:${r.code}`] = (rejected[`delete:${r.code}`] ?? 0) + 1
          if (rejectedIds.length < 20) rejectedIds.push(r.id)
        }
    }
  }
  for (const chunk of chunkCreates(live)) {
    const ack = await send(chunk.map((el) => ({ k: 'c' as const, el })))
    for (const r of ack.r) {
      if (r.ok) {
        ok++
        versions.set(r.id, r.v)
      } else {
        rejected[r.code] = (rejected[r.code] ?? 0) + 1
        if (rejectedIds.length < 20) rejectedIds.push(r.id)
      }
    }
    const dead = chunk.filter((el) => doomed.has(el.id) && versions.has(el.id)).map((el) => el.id)
    if (dead.length) await kill(dead)
  }
  return { pushes, ops: elements.length, ok, rejected, rejectedIds, clock, ms: Date.now() - t0 }
}

/** A Node WebSocket as a SeedIo (validation is the caller's: the seeder reads acks only). */
export async function openNodeSocket(
  syncHttpUrl: string,
  boardId: string,
  ticket: string,
  tab: string,
  welcomeTimeoutMs = 30_000,
): Promise<
  SeedIo & { welcome: Welcome; snapshot(timeoutMs?: number): Promise<SnapshotFrame>; close(): void }
> {
  const url = `${syncHttpUrl.replace(/^http/, 'ws')}/connect/${encodeURIComponent(boardId)}?${new URLSearchParams({ sessionId: tab, ticket })}`
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const inbox: ServerMessage[] = []
  const frames: ArrayBuffer[] = []
  const waiters: (() => void)[] = []
  let closed: string | null = null
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') inbox.push(JSON.parse(e.data) as ServerMessage)
    else frames.push(e.data as ArrayBuffer)
    for (const w of waiters.splice(0)) w()
  })
  ws.addEventListener('close', (e) => {
    closed = `${e.code} ${e.reason}`
    for (const w of waiters.splice(0)) w()
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('seed socket: connection failed')), { once: true })
  })
  let cursor = 0
  const next: SeedIo['next'] = async (type, timeoutMs = 30_000) => {
    const end = Date.now() + timeoutMs
    for (;;) {
      while (cursor < inbox.length) {
        const m = inbox[cursor++] as ServerMessage
        if (m.type === type) return m as never
      }
      if (closed) throw new Error(`seed socket closed (${closed}) before a "${type}"`)
      const left = end - Date.now()
      if (left <= 0) throw new Error(`seed socket: no "${type}" within ${timeoutMs} ms`)
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, Math.min(left, 1_000))
      })
    }
  }
  const io = { send: (m: ClientMessage) => ws.send(JSON.stringify(m)), next }
  io.send({ type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since: 0, epoch: null, tab })
  const welcome = (await next('welcome', welcomeTimeoutMs)) as Welcome
  const snapshot = async (timeoutMs = 60_000): Promise<SnapshotFrame> => {
    const end = Date.now() + timeoutMs
    while (frames.length === 0) {
      if (closed) throw new Error(`seed socket closed (${closed}) before the snapshot frame`)
      if (Date.now() > end) throw new Error('seed socket: no snapshot frame')
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 1_000)
      })
    }
    return decodeSnapshotFrame(new Uint8Array(frames[0] as ArrayBuffer))
  }
  return { ...io, welcome, snapshot, close: () => ws.close(1000, 'seeded') }
}
