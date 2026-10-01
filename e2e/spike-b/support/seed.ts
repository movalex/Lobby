// Boards on a REAL spike B stack for the measurements (§8.4) and B9's workstation half: images uploaded
// through the api (fs blob store; their previews made by the real worker), then the board's elements
// created through the real protocol with raw pushes from a Node socket that carries the owner's own api
// ticket (e2e/load/seed.ts: ≤ 500 ops and 512 KiB per push, each acked). Every element goes through the
// room's accept path (schema, limits, invariants, file-refs A1 against the real api, index keys), so the
// board is exactly what a user's pushes would store. No R2, no fixture server.
import './env.ts'
import type { WireElement } from '../../../packages/canvas-schema/src/elements.ts'
import { type GeneratedBoard, generateBoard, heavyBoard } from '../../load/boards.ts'
import { openNodeSocket, type SeedResult, seedElements } from '../../load/seed.ts'
import { makePng } from './png.ts'
import type { O3Stack } from './stack.ts'
import type { DevUser } from './types.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fresh ticket for `user` on `boardId` from the stack's api (60 s valid). */
export async function apiTicket(
  stack: O3Stack,
  user: DevUser,
  boardId: string,
): Promise<{ ticket: string; uid: string; role: string }> {
  const { api } = await stack.api(user)
  const t = await api.ticket(boardId)
  return { ticket: t.ticket, uid: t.user.id, role: t.role }
}

/**
 * Uploads `count` distinct PNGs (w×h) to the board as `owner`, 4 at a time, honouring the api's upload
 * rate limit (Retry-After), and waits until every preview is ready. Returns the version ids in order.
 */
export async function uploadImages(
  stack: O3Stack,
  owner: DevUser,
  boardId: string,
  count: number,
  opts: { width?: number; height?: number; log?: (s: string) => void } = {},
): Promise<string[]> {
  const { api } = await stack.api(owner)
  const out: { assetId: string; versionId: string }[] = []
  let next = 0
  const worker = async () => {
    while (next < count) {
      const i = next++
      const body = makePng(opts.width ?? 480, opts.height ?? 300, i)
      const name = `o3-img-${String(i + 1).padStart(3, '0')}.png`
      for (let attempt = 1; ; attempt++) {
        const res = await api.request.fetch(
          `${stack.ports.webUrl}/api/boards/${encodeURIComponent(boardId)}/assets`,
          {
            method: 'POST',
            headers: {
              origin: stack.ports.webUrl,
              'content-type': 'image/png',
              'x-file-name': encodeURIComponent(name),
            },
            data: body,
          },
        )
        if (res.status() === 200 || res.status() === 201) {
          const meta = (await res.json()) as { assetId: string; versionId: string }
          out[i] = meta
          break
        }
        if (![429, 502, 503].includes(res.status()) || attempt >= 20)
          throw new Error(`upload ${name}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`)
        const wait = Number(res.headers()['retry-after'] ?? '5')
        await sleep(Math.min(65, Math.max(1, wait)) * 1000)
      }
    }
  }
  const t0 = Date.now()
  await Promise.all([worker(), worker(), worker(), worker()])
  opts.log?.(`uploaded ${count} images in ${Date.now() - t0} ms`)
  const pending = new Set(out.map((_, i) => i))
  const deadline = Date.now() + 600_000
  while (pending.size) {
    for (const i of [...pending]) {
      const u = out[i] as { assetId: string; versionId: string }
      const r = await api.request.fetch(
        `${stack.ports.webUrl}/api/boards/${encodeURIComponent(boardId)}/assets/${u.assetId}/${u.versionId}`,
      )
      const meta = (await r.json().catch(() => ({}))) as { status?: string }
      if (meta.status === 'ready') pending.delete(i)
      else if (meta.status === 'failed') throw new Error(`preview failed for image ${i + 1}`)
    }
    if (Date.now() > deadline) throw new Error(`${pending.size} previews not ready in 10 min`)
    if (pending.size) await sleep(500)
  }
  opts.log?.(`previews ready after ${Date.now() - t0} ms`)
  return out.map((u) => u.versionId)
}

/** Creates `elements` on the board through the protocol as `owner`; throws unless every op was accepted. */
export async function seedThroughProtocol(
  stack: O3Stack,
  owner: DevUser,
  boardId: string,
  elements: readonly WireElement[],
): Promise<SeedResult> {
  const { ticket } = await apiTicket(stack, owner, boardId)
  const sock = await openNodeSocket(
    stack.ports.syncUrl,
    boardId,
    ticket,
    `o3-seed-${Date.now().toString(36)}`,
  )
  try {
    const r = await seedElements(sock, elements, sock.welcome.clock)
    if (r.ok !== r.ops)
      throw new Error(
        `seeding ${boardId}: ${r.ops - r.ok} of ${r.ops} ops rejected ${JSON.stringify(r.rejected)} (${r.rejectedIds.join(', ')})`,
      )
    return r
  } finally {
    sock.close()
  }
}

export interface SeededBoard {
  readonly boardId: string
  readonly board: GeneratedBoard
  readonly seed: SeedResult
  readonly uploadMs: number
}

/** The heavy perf board (A14's: 20 frames, 4,500 notes with labels, 200 images) on a real stack. */
export async function seedHeavy(
  stack: O3Stack,
  owner: DevUser,
  opts: {
    members?: Parameters<O3Stack['createBoard']>[0]['members']
    images?: number
    log?: (s: string) => void
  } = {},
): Promise<SeededBoard> {
  const { boardId } = await stack.createBoard({ owner, members: opts.members, title: 'O3 heavy board' })
  const t0 = Date.now()
  const fileIds = await uploadImages(stack, owner, boardId, opts.images ?? 200, { log: opts.log })
  const uploadMs = Date.now() - t0
  const board = heavyBoard(boardId, { fileIds, images: opts.images ?? 200 })
  const seed = await seedThroughProtocol(stack, owner, boardId, board.elements)
  opts.log?.(`seeded ${board.elements.length} elements in ${seed.pushes} pushes, ${seed.ms} ms`)
  return { boardId, board, seed, uploadMs }
}

/** A board of `notes` notes (plus `deleted` tombstones, and optional arrows), no images. */
export async function seedNotes(
  stack: O3Stack,
  owner: DevUser,
  spec: { notes: number; frames?: number; arrows?: number; deleted?: number; title?: string },
  members?: Parameters<O3Stack['createBoard']>[0]['members'],
): Promise<SeededBoard> {
  const { boardId } = await stack.createBoard({ owner, members, title: spec.title ?? 'O3 board' })
  const board = generateBoard({
    id: boardId,
    kind: 'custom',
    frames: spec.frames ?? Math.max(1, Math.round(spec.notes / 225)),
    notes: spec.notes,
    images: 0,
    arrows: spec.arrows ?? 0,
    deleted: spec.deleted ?? 0,
  })
  const seed = await seedThroughProtocol(stack, owner, boardId, board.elements)
  return { boardId, board, seed, uploadMs: 0 }
}
