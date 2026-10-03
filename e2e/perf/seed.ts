// The heavy board (PRF-02) on Lobby's board page (docs/EXCALIDRAW-MIGRATION.md §6.4), built through the real
// client and protocol in a signed-in board tab:
//  - `images` photo-like JPEGs are rendered in the page (OffscreenCanvas; no fixture files), uploaded
//    through the board's upload route like a drop, and the harness waits for the worker's previews;
//  - `frames` frames, each a 15-column grid of sticky notes (`notes` in total, each with its bound label)
//    plus a column of the images (e2e/load/boards.ts `generateBoard` kind 'heavy'), pushed as creates on a
//    raw socket that carries the page's own ticket; every image carries the upload's
//    `customData.lobby.file` as a drop writes it (W5-34: without it the client never loads the bytes);
//  - what later waves put on such a board: tags on every 8th note (with their tag definitions) and
//    `comments` comment threads pinned to notes all over the board.
// Deterministic: the same arguments give the same board (ids, text, positions, colours, pixels).
// The tldraw seed (editor.createShapes) left with the tldraw board page (docs/EXCALIDRAW-CUTOVER.md G10).
import type { Page } from '@playwright/test'

export interface HeavySpec {
  frames: number
  notes: number
  images: number
  comments: number
}

export const HEAVY: HeavySpec = { frames: 20, notes: 4_500, images: 200, comments: 40 }

interface Uploaded {
  assetId: string
  versionId: string
  w: number
  h: number
  bytes: number
  name: string
}

/** Uploads the images from the page and waits (up to 10 min) for their previews to be ready. */
async function uploadImages(page: Page, boardId: string, count: number) {
  return page.evaluate(
    async ({ boardId, count }) => {
      const SIZES: [number, number][] = [
        [1600, 1067],
        [1067, 1600],
        [1600, 1200],
        [1600, 900],
        [1400, 1400],
        [1080, 1350],
      ]
      let seed = 4242
      const rand = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
      }
      const make = async (i: number) => {
        const [w, h] = SIZES[i % SIZES.length] ?? [1600, 1200]
        const canvas = new OffscreenCanvas(w, h)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        const g = ctx.createLinearGradient(0, 0, w, h)
        g.addColorStop(0, `hsl(${(i * 47) % 360} 55% 40%)`)
        g.addColorStop(1, `hsl(${(i * 47 + 140) % 360} 65% 72%)`)
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
        for (let k = 0; k < 7; k++) {
          ctx.fillStyle = `hsl(${(i * 31 + k * 53) % 360} 70% 55% / 0.7)`
          ctx.beginPath()
          ctx.arc(rand() * w, rand() * h, (0.05 + rand() * 0.2) * Math.min(w, h), 0, Math.PI * 2)
          ctx.fill()
        }
        for (let k = 0; k < 1500; k++) {
          ctx.fillStyle = `rgb(${rand() * 255} ${rand() * 255} ${rand() * 255} / 0.5)`
          ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 5, 1 + rand() * 5)
        }
        ctx.fillStyle = '#fff'
        ctx.font = `bold ${Math.round(Math.min(w, h) / 9)}px sans-serif`
        ctx.fillText(`ref ${i + 1}`, w / 14, h - h / 14)
        return { blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }), w, h }
      }
      const out: Uploaded[] = []
      let next = 0
      const worker = async () => {
        while (next < count) {
          const i = next++
          const { blob, w, h } = await make(i)
          const name = `perf-ref-${String(i + 1).padStart(3, '0')}.jpg`
          let res: Response
          for (let attempt = 1; ; attempt++) {
            res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/assets`, {
              method: 'POST',
              body: blob,
              credentials: 'same-origin',
              headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent(name) },
            })
            // The api allows 120 uploads per user per minute (FC-1): wait as it says, like a person
            // would. It refuses before reading the body, so the dev proxy sometimes reports that as a
            // 502 instead of the 429: wait and retry those too.
            if (![429, 502, 503].includes(res.status) || attempt >= 20) break
            const wait = Number(res.headers.get('retry-after') ?? '5')
            await new Promise((r) => setTimeout(r, Math.min(65, Math.max(1, wait)) * 1000))
          }
          if (!res.ok) throw new Error(`upload ${name}: ${res.status} ${await res.text()}`)
          const meta = (await res.json()) as { assetId: string; versionId: string }
          out[i] = { assetId: meta.assetId, versionId: meta.versionId, w, h, bytes: blob.size, name }
        }
      }
      const t0 = performance.now()
      await Promise.all([worker(), worker(), worker(), worker()])
      const uploadedMs = performance.now() - t0
      // Previews: the viewer shows a loading tile until they exist (F4), so wait like a real session.
      const pending = new Set(out.map((_, i) => i))
      const deadline = performance.now() + 600_000
      while (pending.size) {
        for (const i of [...pending]) {
          const u = out[i]
          if (!u) continue
          const r = await fetch(
            `/api/boards/${encodeURIComponent(boardId)}/assets/${u.assetId}/${u.versionId}`,
            { credentials: 'same-origin' },
          )
          const meta = (await r.json()) as { status?: string }
          if (meta.status === 'ready') pending.delete(i)
          else if (meta.status === 'failed') throw new Error(`preview failed for ${u.name}`)
        }
        if (performance.now() > deadline) throw new Error(`${pending.size} previews not ready in 10 min`)
        if (pending.size) await new Promise((r) => setTimeout(r, 500))
      }
      return { uploaded: out, uploadedMs, previewsMs: performance.now() - t0 - uploadedMs }
    },
    { boardId, count },
  )
}

// ---- the board -------------------------------------------------------------------------------------------
//
// Made through the real protocol: images uploaded by the page like a drop (`uploadImages`), then every
// element pushed as creates on a raw socket that carries the page's own ticket (≤ 500 ops and 512 KiB per
// push, each acked: e2e/load/seed.ts), so the room stores exactly what a user's pushes would (schema, limits,
// invariants, file-refs against the real api, index keys). The tag definitions go in first as one doc write.
// The engine code (canvas-schema's engine wrappers, which the generator lays notes out with) is loaded only
// when the seed runs.

export interface HeavyExcalidrawBoard {
  boardId: string
  spec: HeavySpec
  /** elements stored (a note and its label are two) */
  elements: number
  /** items (a note with its label is one): frames + notes + images */
  items: number
  /** note ids in frame 0 (the 100% view), in creation order */
  frame0Notes: string[]
  /** frame ids, frame 0 first */
  frameIds: string[]
  /** the image elements' ids, and the upload (asset, version) each one shows */
  images: { id: string; assetId: string; versionId: string }[]
  seedMs: { images: number; previews: number; elements: number; comments: number }
}

/** The heavy board's tags, as `tagDef:<key>` doc entries. */
const HEAVY_TAGS = [
  { key: 'research', name: 'Research', color: 'violet' },
  { key: 'client', name: 'Client', color: 'orange' },
  { key: 'blocker', name: 'Blocker', color: 'red' },
  { key: 'idea', name: 'Idea', color: 'light-green' },
  { key: 'shoot-day', name: 'Shoot day', color: 'light-blue' },
  { key: 'copy', name: 'Copy', color: 'grey' },
] as const

/** Fills `boardId` (open in `page` on Lobby's board page, signed in as an editor) with the heavy board. */
export async function seedHeavyExcalidrawBoard(
  page: Page,
  boardId: string,
  spec: HeavySpec,
  log: (s: string) => void,
): Promise<HeavyExcalidrawBoard> {
  const [{ generateBoard }, { seedElements }, { forgeSession }] = await Promise.all([
    import('../load/boards.ts'),
    import('../load/seed.ts'),
    import('../tests/support/excalidraw.ts'),
  ])
  const t0 = Date.now()
  const up = await uploadImages(page, boardId, spec.images)
  log(
    `uploaded ${up.uploaded.length} images in ${Math.round(up.uploadedMs)} ms, previews ready ${Math.round(up.previewsMs)} ms later`,
  )
  const board = generateBoard({
    id: boardId,
    kind: 'heavy',
    frames: spec.frames,
    notes: spec.notes,
    images: spec.images,
    arrows: 0,
    // each image's customData.lobby.file is its upload's, as a drop writes it (canvas/files/place.ts factsOf)
    fileFacts: up.uploaded.map((u) => ({
      assetId: u.assetId,
      versionId: u.versionId,
      kind: 'image' as const,
      name: u.name,
      mimeType: 'image/jpeg',
      sizeBytes: u.bytes,
    })),
  })
  // tags on every 8th note (two on every 16th), on the note (not its label)
  const perFrame = Math.ceil(spec.notes / spec.frames)
  const tagged = new Map<string, Record<string, { name: string; color: string }>>()
  board.noteIds.forEach((id, n) => {
    const f = Math.floor(n / perFrame)
    const k = n % perFrame
    if (k % 8 !== 3) return
    const a = HEAVY_TAGS[(f + k) % HEAVY_TAGS.length]
    const b = HEAVY_TAGS[(f + k + 2) % HEAVY_TAGS.length]
    const tags: Record<string, { name: string; color: string }> = {}
    for (const t of k % 16 === 3 && b ? [a, b] : [a])
      if (t) tags[`tag:${t.key}`] = { name: t.name, color: t.color }
    tagged.set(id, tags)
  })
  const elements = board.elements.map((el) => {
    const tags = tagged.get(el.id)
    if (!tags) return el
    const lobby = {
      ...((el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}),
      ...tags,
    }
    return { ...el, customData: { ...(el.customData ?? {}), lobby } } as typeof el
  })

  const t1 = Date.now()
  // the tag definitions first, on a socket of their own (a tag needs its tagDef in lb_doc, §3.3)
  const docs = await forgeSession(page, boardId)
  try {
    await docs.socket.send({
      type: 'push',
      seq: 1,
      base: docs.welcome.clock,
      ops: [],
      doc: {
        set: Object.fromEntries(HEAVY_TAGS.map((t) => [`tagDef:${t.key}`, { name: t.name, color: t.color }])),
      },
    })
    const docAck = await docs.socket.next('ack', 60_000)
    if (docAck.docDenied)
      throw new Error(`the tag definitions were refused: ${JSON.stringify(docAck.docDenied)}`)
  } finally {
    await docs.socket.close()
  }
  const { socket, welcome } = await forgeSession(page, boardId)
  let pushed: Awaited<ReturnType<typeof seedElements>>
  try {
    pushed = await seedElements(socket, elements, welcome.clock)
  } finally {
    await socket.close()
  }
  if (pushed.ok !== pushed.ops)
    throw new Error(
      `seeding ${boardId}: ${pushed.ops - pushed.ok} of ${pushed.ops} creates refused ${JSON.stringify(pushed.rejected)} (${pushed.rejectedIds.join(', ')})`,
    )
  // the page has the whole board and nothing of its own waits
  await page.waitForFunction(
    (n) => {
      const f = (
        window as unknown as { lobbyCanvas?: { items(): unknown[]; saveState(): { state: string } } }
      ).lobbyCanvas
      return !!f && f.items().length >= n && f.saveState().state === 'saved'
    },
    elements.length,
    { timeout: 180_000, polling: 250 },
  )
  const elementsMs = Date.now() - t1
  log(`pushed ${elements.length} elements in ${pushed.pushes} pushes, ${elementsMs} ms (on the page, saved)`)

  const t2 = Date.now()
  await page.evaluate(
    async ({ boardId, notes, comments }) => {
      for (let t = 0; t < comments; t++) {
        const id = notes[(t * 37) % notes.length]
        const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/threads`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            anchor: { kind: 'shape', shapeId: `shape:${id}`, u: 0.85, v: 0.15 },
            body: `Perf thread ${t + 1}: can we tighten this crop before the client review?`,
          }),
        })
        if (!res.ok) throw new Error(`thread ${t}: ${res.status} ${await res.text()}`)
      }
    },
    { boardId, notes: board.noteIds, comments: spec.comments },
  )
  const commentsMs = Date.now() - t2
  log(`created ${spec.comments} comment threads in ${commentsMs} ms; seeding took ${Date.now() - t0} ms`)
  return {
    boardId,
    spec,
    elements: elements.length,
    items: board.frameIds.length + board.noteIds.length + board.files.length,
    frame0Notes: board.frame0Notes,
    frameIds: [...board.frameIds],
    images: board.elements
      .filter((e) => e.type === 'image')
      .map((e) => {
        const versionId = (e as { fileId: string }).fileId
        const assetId = up.uploaded.find((u) => u.versionId === versionId)?.assetId ?? ''
        return { id: e.id, assetId, versionId }
      }),
    seedMs: {
      images: Math.round(up.uploadedMs),
      previews: Math.round(up.previewsMs),
      elements: elementsMs,
      comments: commentsMs,
    },
  }
}
