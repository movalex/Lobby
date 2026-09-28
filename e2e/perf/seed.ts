// Builds the heavy board (PRF-02) through the real client, in a signed-in board tab:
//  - `images` photo-like JPEGs are rendered in the page (OffscreenCanvas; no fixture files), uploaded
//    through the board's upload route like a drop, and the harness waits for the worker's previews;
//  - `frames` frames, each a 15-column grid of sticky notes (`notes` in total) plus a column of the
//    images, are created with editor.createShapes in batches, and the save indicator must say Saved;
//  - what later waves put on such a board: tags on every 8th note (chips, the board's tag list) and
//    `comments` comment threads pinned to notes all over the board.
// Deterministic: the same arguments give the same board (ids, text, positions, colours, pixels).
import type { Page } from '@playwright/test'
import type { PerfEditor } from './lib.ts'

export interface HeavySpec {
  frames: number
  notes: number
  images: number
  comments: number
}

export interface HeavyBoard {
  boardId: string
  spec: HeavySpec
  shapes: number
  /** Note ids in frame 0 (the 100% view), in creation order. */
  frame0Notes: string[]
  seedMs: { images: number; previews: number; shapes: number; comments: number }
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

/** Creates frames, notes, image assets + shapes and the board's tags, in batches, from the page. */
async function createShapes(page: Page, spec: HeavySpec, uploaded: Uploaded[]) {
  return page.evaluate(
    async ({ spec, uploaded }) => {
      const ed = (window as unknown as { editor: PerfEditor }).editor
      let seed = 99
      const rand = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647
      }
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
      const SUBJECTS = ['Hero shot', 'Opening title', 'Tagline', 'Moodboard', 'Casting note', 'Colour grade']
      const SUBJECTS2 = ['Location idea', 'Social cutdown', 'Packaging', 'Type pairing', 'Music bed', 'Risk']
      const DETAILS = [
        'golden hour rooftop, wide lens',
        'warm analog grain, teal shadows',
        'keep the logo small in the first 3 seconds',
        'slower push-in on the product before the reveal',
        'more contrast in the night exteriors',
        'two-word headline, lowercase',
        'shoot vertical-safe for 9:16 cutdowns',
        'legal needs the disclaimer for 2 seconds',
        'music drops out right before the tagline',
        'crop tighter so the product reads on a phone',
      ]
      const COLORS = ['yellow', 'yellow', 'light-blue', 'light-green', 'light-violet', 'orange', 'light-red']
      const TAGS = [
        { key: 'research', name: 'Research', color: 'violet' },
        { key: 'client', name: 'Client', color: 'orange' },
        { key: 'blocker', name: 'Blocker', color: 'red' },
        { key: 'idea', name: 'Idea', color: 'light-green' },
        { key: 'shoot-day', name: 'Shoot day', color: 'light-blue' },
        { key: 'copy', name: 'Copy', color: 'grey' },
      ]
      const text = (t: string) => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
      })

      const NW = 200
      const GAP = 24
      const COLS = 15
      const perFrame = Math.ceil(spec.notes / spec.frames)
      const imgsPerFrame = Math.ceil(uploaded.length / spec.frames)
      const rows = Math.ceil(perFrame / COLS)
      const FW = COLS * (NW + GAP) + GAP + 520
      const FH = Math.max(60 + rows * (NW + GAP) + GAP, 60 + imgsPerFrame * 340 + 20)
      const PER_ROW = Math.ceil(Math.sqrt(spec.frames * 1.25))

      ed.createAssets(
        uploaded.map((u, i) => ({
          id: `asset:perf-${i}`,
          typeName: 'asset',
          type: 'image',
          props: {
            name: u.name,
            src: `/files/${u.assetId}/${u.versionId}/original`,
            w: u.w,
            h: u.h,
            mimeType: 'image/jpeg',
            isAnimated: false,
            fileSize: u.bytes,
          },
          meta: {},
        })),
      )
      // The board's tag list (document meta), as the Tags panel writes it.
      const docMeta: Record<string, unknown> = {}
      for (const t of TAGS) docMeta[`drTagList:${t.key}`] = { name: t.name, color: t.color }
      ed.updateDocumentSettings({ meta: docMeta })

      const shapes: Record<string, unknown>[] = []
      const frame0Notes: string[] = []
      let notesLeft = spec.notes
      let img = 0
      for (let f = 0; f < spec.frames; f++) {
        const fid = `shape:perf-f${f}`
        shapes.push({
          id: fid,
          type: 'frame',
          x: (f % PER_ROW) * (FW + 400),
          y: Math.floor(f / PER_ROW) * (FH + 400),
          props: { w: FW, h: FH, name: `Workstream ${f + 1}` },
        })
        const n = Math.min(perFrame, notesLeft)
        notesLeft -= n
        for (let k = 0; k < n; k++) {
          const id = `shape:perf-n${f}-${k}`
          if (f === 0) frame0Notes.push(id)
          const meta: Record<string, unknown> = {}
          if (k % 8 === 3) {
            const a = TAGS[(f + k) % TAGS.length]
            const b = TAGS[(f + k + 2) % TAGS.length]
            for (const t of k % 16 === 3 && b ? [a, b] : [a])
              if (t) meta[`drTags:${t.key}`] = { name: t.name, color: t.color }
          }
          shapes.push({
            id,
            type: 'note',
            parentId: fid,
            x: GAP + (k % COLS) * (NW + GAP),
            y: 60 + Math.floor(k / COLS) * (NW + GAP),
            props: {
              color: pick(COLORS),
              font: 'sans',
              richText: text(`${pick(rand() < 0.5 ? SUBJECTS : SUBJECTS2)}: ${pick(DETAILS)}`),
            },
            meta,
          })
        }
        for (let k = 0; k < imgsPerFrame && img < uploaded.length; k++, img++) {
          const u = uploaded[img]
          if (!u) continue
          const w = 480
          shapes.push({
            id: `shape:perf-i${f}-${k}`,
            type: 'image',
            parentId: fid,
            x: FW - 500,
            y: 60 + k * 340,
            props: { w, h: Math.min(320, Math.round((w * u.h) / u.w)), assetId: `asset:perf-${img}` },
          })
        }
      }
      for (let i = 0; i < shapes.length; i += 250) {
        ed.run(() => ed.createShapes(shapes.slice(i, i + 250)))
        await new Promise((r) => setTimeout(r, 50))
      }
      return { shapes: shapes.length, frame0Notes }
    },
    { spec, uploaded },
  )
}

async function waitSaved(page: Page, timeoutMs = 120_000) {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') === 'saved',
    null,
    { timeout: timeoutMs, polling: 250 },
  )
}

/** Comment threads on notes spread over the board (the pins every viewer sees). */
async function createComments(page: Page, boardId: string, spec: HeavySpec) {
  await page.evaluate(
    async ({ boardId, spec }) => {
      const perFrame = Math.ceil(spec.notes / spec.frames)
      for (let t = 0; t < spec.comments; t++) {
        const f = t % spec.frames
        const k = (t * 37) % perFrame
        const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/threads`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            anchor: { kind: 'shape', shapeId: `shape:perf-n${f}-${k}`, u: 0.85, v: 0.15 },
            body: `Perf thread ${t + 1}: can we tighten this crop before the client review?`,
          }),
        })
        if (!res.ok) throw new Error(`thread ${t}: ${res.status} ${await res.text()}`)
      }
    },
    { boardId, spec },
  )
}

/** Fills `boardId` (open in `page`, signed in as an editor) with the heavy board. */
export async function seedHeavyBoard(
  page: Page,
  boardId: string,
  spec: HeavySpec,
  log: (s: string) => void,
): Promise<HeavyBoard> {
  const t0 = Date.now()
  const up = await uploadImages(page, boardId, spec.images)
  log(
    `uploaded ${up.uploaded.length} images in ${Math.round(up.uploadedMs)} ms, previews ready ${Math.round(up.previewsMs)} ms later`,
  )
  const t1 = Date.now()
  const made = await createShapes(page, spec, up.uploaded)
  await waitSaved(page)
  const shapesMs = Date.now() - t1
  log(`created ${made.shapes} shapes in ${shapesMs} ms (saved)`)
  const t2 = Date.now()
  await createComments(page, boardId, spec)
  const commentsMs = Date.now() - t2
  log(`created ${spec.comments} comment threads in ${commentsMs} ms; seeding took ${Date.now() - t0} ms`)
  return {
    boardId,
    spec,
    shapes: made.shapes,
    frame0Notes: made.frame0Notes,
    seedMs: {
      images: Math.round(up.uploadedMs),
      previews: Math.round(up.previewsMs),
      shapes: shapesMs,
      comments: commentsMs,
    },
  }
}
