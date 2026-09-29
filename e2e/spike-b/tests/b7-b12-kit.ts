// O5's shared helpers for its spike B specs (b5-r2-*, b7-*, b12-*; docs/EXCALIDRAW-MIGRATION.md §8.3).
// Everything goes through the frozen harness (support/types.ts, O3's support/harness.ts), the facade
// (`window.lobbyCanvas`, O3) and O5's own feature hooks (`window.lobbySpikeFeatures`,
// apps/web/src/canvas/spike/features/test-hooks.ts). Not a spec file (Playwright runs *.spec.ts only).
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type {} from '../../../apps/web/src/canvas/spike/features/hooks.types.ts'
import type {} from '../../../apps/web/src/canvas/test-facade.types.ts'
import type { BrowserProcess, ForgeSocket } from '../support/types.ts'

/** The facade and O5's hooks are there, and the board's first `welcome` is applied. */
export async function featuresReady(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => !!window.lobbyCanvas && !!window.lobbySpikeFeatures && window.lobbySpikeFeatures.me() !== null,
    undefined,
    { timeout },
  )
}

/** Resolves when the tab shows Saved (the facade's saveState), or fails after `timeout`. */
export async function saved(page: Page, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => window.lobbyCanvas?.saveState().state), { timeout })
    .toBe('saved')
}

/** Creates a note through the facade (CanvasPort.transact, then the sync engine) and returns its id. */
export async function createNote(page: Page, x: number, y: number, text = ''): Promise<string> {
  return page.evaluate(
    ({ x, y, text }) => {
      const f = window.lobbyCanvas
      if (!f) throw new Error('no facade')
      return f.create('note', { x, y, ...(text ? { text } : {}) })
    },
    { x, y, text },
  )
}

/** Creates an element of `kind` with `props` through the facade. */
export async function create(page: Page, kind: string, props: Record<string, unknown>): Promise<string> {
  return page.evaluate(
    ({ kind, props }) => {
      const f = window.lobbyCanvas
      if (!f) throw new Error('no facade')
      return f.create(kind as never, props)
    },
    { kind, props },
  )
}

/** The client point of a scene point (the facade's sceneToScreen). */
export async function clientOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ x, y }) => window.lobbyCanvas?.sceneToScreen({ x, y }) ?? { x: 0, y: 0 }, { x, y })
}

/** The centre of an element on screen. */
export async function centreOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const f = window.lobbyCanvas
    const b = f?.bounds(id)
    if (!f || !b) throw new Error(`no bounds for ${id}`)
    return f.sceneToScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
  }, id)
}

/**
 * A client point inside `id`'s box where Excalidraw's interactive canvas itself is the top element, so a
 * press there reaches the canvas and not Lobby's floating UI (the features toolbar sits at the bottom
 * centre: at 1024 x 768 it covers a topic's centre; M1/M2's touch control tapped the toolbar). The centre
 * first, then points over the inner part of the box; throws when every candidate is covered.
 */
export async function canvasPointOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const f = window.lobbyCanvas
    const b = f?.bounds(id)
    if (!f || !b) throw new Error(`no bounds for ${id}`)
    const fractions: [number, number][] = [[0.5, 0.5]]
    for (const fy of [0.35, 0.25, 0.65, 0.75, 0.15, 0.85])
      for (const fx of [0.5, 0.3, 0.7]) fractions.push([fx, fy])
    for (const [fx, fy] of fractions) {
      const p = f.sceneToScreen({ x: b.x + b.width * fx, y: b.y + b.height * fy })
      const top = document.elementFromPoint(p.x, p.y)
      if (top instanceof HTMLCanvasElement && top.classList.contains('interactive')) return p
    }
    throw new Error(`every candidate point of ${id} is covered by UI or off screen`)
  }, id)
}

/** RGBA of Excalidraw's static canvas at a client point (device pixels read, DPR applied). */
export async function staticPixel(page: Page, clientX: number, clientY: number): Promise<number[]> {
  return page.evaluate(
    ({ clientX, clientY }) => {
      const c = document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static')
      if (!c) return [0, 0, 0, 0]
      const r = c.getBoundingClientRect()
      const sx = c.width / r.width
      const sy = c.height / r.height
      const ctx = c.getContext('2d')
      if (!ctx) return [0, 0, 0, 0]
      return [
        ...ctx.getImageData(Math.round((clientX - r.left) * sx), Math.round((clientY - r.top) * sy), 1, 1)
          .data,
      ]
    },
    { clientX, clientY },
  )
}

export const near = (a: readonly number[], b: readonly number[], tol = 24) =>
  a.length >= 3 && b.length >= 3 && [0, 1, 2].every((i) => Math.abs((a[i] ?? 0) - (b[i] ?? 0)) <= tol)

/** A solid-colour PNG, made in the page (base64, no data: prefix). */
export async function solidPng(
  page: Page,
  rgb: readonly [number, number, number],
  w = 64,
  h = 48,
): Promise<string> {
  return page.evaluate(
    ({ rgb, w, h }) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      if (!ctx) throw new Error('2d')
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
      ctx.fillRect(0, 0, w, h)
      return c.toDataURL('image/png').split(',')[1] ?? ''
    },
    { rgb, w, h },
  )
}

/** A PDF of `pages` pages (pdf-lib, e2e's own dependency), base64. */
export async function pdfBase64(pages = 2): Promise<string> {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([400, 520])
    p.drawRectangle({ x: 0, y: 0, width: 400, height: 520, color: rgb(0.2, 0.4, 0.9) })
    p.drawText(`Spike B page ${i}`, { x: 40, y: 460, size: 28, font, color: rgb(1, 1, 1) })
  }
  return Buffer.from(await doc.save()).toString('base64')
}

/**
 * A forge socket that has its `welcome` (the harness may send `hello` itself; if nothing arrived after a
 * second, this sends one).
 */
export async function forgeReady(sock: ForgeSocket, tab = 'forge-o5'): Promise<void> {
  const welcomed = async () => (await sock.messages()).some((m) => m.type === 'welcome')
  if (!(await welcomed())) {
    await new Promise((r) => setTimeout(r, 1_000))
    if (!(await welcomed()))
      await sock.send({ type: 'hello', proto: 1, schema: 1, since: 0, epoch: null, tab } as never)
  }
  await expect.poll(welcomed, { timeout: 15_000 }).toBe(true)
}

/** Waits until every process's facade shows `id` (a remote create arrived). */
export async function seen(procs: readonly BrowserProcess[], id: string, timeout = 15_000): Promise<void> {
  for (const p of procs)
    await expect
      .poll(() => p.page.evaluate((id) => !!window.lobbyCanvas?.get(id), id), { timeout })
      .toBe(true)
}

/** A board-wide vote from `page` (a facilitator). */
export async function startVote(page: Page, votesPerPerson = 5): Promise<void> {
  await page.evaluate((n) => window.lobbySpikeFeatures?.startVote({ votesPerPerson: n }), votesPerPerson)
}

/** The page has no horizontal scroll (a phone layout that fits). */
export async function noSidewaysScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
}

/**
 * Joins `boardId` as a name-only guest in `guest`'s page, through a workshop link `owner` creates (the
 * api's guest flow: POST /api/boards/:bid/review-links, then POST /api/invitations/:token/guest), then
 * opens the board. Returns the guest's uid.
 */
export async function joinAsGuest(
  owner: BrowserProcess,
  guest: BrowserProcess,
  boardId: string,
  name = 'Sam',
): Promise<string> {
  const url = await owner.page.evaluate(async (bid) => {
    const r = await fetch(`/api/boards/${bid}/review-links`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor', allowGuests: true }),
    })
    if (r.status !== 201) throw new Error(`review link: ${r.status}`)
    return ((await r.json()) as { url: string }).url
  }, boardId)
  const token = url.slice(url.lastIndexOf('/') + 1)
  // the guest's page must be on the web origin first (same-origin fetch; the Origin check)
  await guest.page.goto('/')
  const uid = await guest.page.evaluate(
    async ({ token, name }) => {
      // a signed-in account cannot join as a guest (409 SIGNED_IN): leave the harness's dev session first
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => null)
      const r = await fetch(`/api/invitations/${token}/guest`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (r.status !== 201) throw new Error(`guest join: ${r.status}`)
      return ((await r.json()) as { user: { id: string } }).user.id
    },
    { token, name },
  )
  await guest.openBoard(boardId)
  return uid
}

export interface MindMap {
  readonly root: string
  readonly a1: string
  readonly a2: string
  readonly leaves: readonly [string, string]
  /** edge id per child topic id */
  readonly edges: Readonly<Record<string, string>>
}

/**
 * A small mind map through the facade: Root → A1 → (Leaf 1, Leaf 2) and Root → A2, as notes with
 * `customData.lobby.mindmap` and arrows with `mindmapEdge` (§4.7). A2 is created BEFORE the leaves, so
 * it sorts below them: moved over them, the hidden leaves are what Excalidraw's own hit test picks (the
 * B12 "sibling over the hidden branch" case).
 */
export async function buildMindMap(page: Page, origin = { x: 80, y: 120 }): Promise<MindMap> {
  const mm = (parentId: string | null) => (rootId: string) => ({
    lobby: { mindmap: { rootId, parentId, side: 'right', collapsed: false } },
  })
  const note = async (x: number, y: number, text: string, custom: unknown) =>
    create(page, 'note', { x: origin.x + x, y: origin.y + y, text, customData: custom })
  const root = await note(0, 200, 'Root topic', { lobby: {} })
  // the root's own value names itself
  await page.evaluate(
    (id) =>
      window.lobbyCanvas?.update(id, {
        customData: { lobby: { mindmap: { rootId: id, parentId: null, side: 'right', collapsed: false } } },
      }),
    root,
  )
  const a1 = await note(300, 60, 'Topic A1', mm(root)(root))
  const a2 = await note(300, 400, 'Topic A2', mm(root)(root))
  const l1 = await note(600, 0, 'Leaf one', mm(a1)(root))
  const l2 = await note(600, 240, 'Leaf two', mm(a1)(root))
  const edge = async (from: string, to: string, x: number, y: number, dx: number, dy: number) =>
    create(page, 'arrow', {
      x: origin.x + x,
      y: origin.y + y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [
        [0, 0],
        [dx, dy],
      ],
      customData: { lobby: { mindmapEdge: { rootId: root, parentId: from, childId: to } } },
    })
  const edges: Record<string, string> = {
    [a1]: await edge(root, a1, 200, 300, 100, -140),
    [a2]: await edge(root, a2, 200, 300, 100, 200),
    [l1]: await edge(a1, l1, 500, 160, 100, -60),
    [l2]: await edge(a1, l2, 500, 160, 100, 180),
  }
  return { root, a1, a2, leaves: [l1, l2], edges }
}

/** The collapse prototype's hidden set as the features compute it and as the overrides hold it. */
export async function hiddenSets(page: Page): Promise<{ computed: string[]; overrides: string[] }> {
  return page.evaluate(() => window.lobbySpikeFeatures?.hidden() ?? { computed: [], overrides: [] })
}
