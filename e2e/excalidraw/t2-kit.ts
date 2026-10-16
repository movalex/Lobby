// Wave T, WS3 (the animatic and the storyboard exports): what the t2-* specs share. Storyboards are seeded as WS2 makes
// them (docs/WAVE-T-CONTRACTS.md §2): a head text with `sb:head`, panel frames with `sb:of`/`sb:pos`/`sb:dur`, fields as
// labelled boxes marked by `kind` (sb-camera, sb-action, sb-dialogue, …: sticky notes here, whose label is bound like
// a box's), a picture drawn in the panel. Every write goes through `canvas.transact` and the room, so the run's sync
// must take planning keys: DRAFTROOM_PLANNING=on (`PLANNING_SYNC_ENV`) and WS1's rules (until they land, the
// foundation's room refuses every planning write INVALID: the specs fail at their seed, by design).
//
// The web switches are a dev-auth page's localStorage overrides (features/planning/flags.ts PLANNING_FLAG_KEYS), set
// with an init script before the board loads (`planningSwitches`).
import type { BrowserContext, Page, Request } from '@playwright/test'
import { expect, expectSaved, waitForCanvas } from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import type { Users } from '../tests/support/users.ts'

export const PLANNING_SYNC_ENV = { DRAFTROOM_PLANNING: 'on' } as const

/** features/planning/flags.ts PLANNING_FLAG_KEYS */
const FLAG_KEYS = {
  animatic: 'lobby.planAnimatic',
  storyboardExports: 'lobby.planStoryboardExports',
} as const

/** Turns WS3's switches on for this page (and its reloads), then reloads it. */
export async function planningSwitches(
  page: Page,
  on: readonly (keyof typeof FLAG_KEYS)[] = ['animatic', 'storyboardExports'],
) {
  await page.addInitScript(
    (keys: string[]) => {
      try {
        for (const k of keys) localStorage.setItem(k, '1')
      } catch {}
    },
    on.map((k) => FLAG_KEYS[k]),
  )
  await page.reload()
  await waitForCanvas(page)
}

export interface PanelSeed {
  readonly id: string
  readonly pos: string
  readonly dur: number
  readonly x: number
  readonly name?: string
  /** the picture: a filled rectangle of this colour */
  readonly color: string
  readonly fields?: Partial<Record<'camera' | 'action' | 'dialogue' | 'sfx' | 'music', string>>
}

export interface StoryboardSeed {
  readonly head: string
  readonly title: string
  readonly settings: Record<string, unknown>
  readonly panels: readonly PanelSeed[]
}

export const PANEL = { w: 480, h: 420, pic: { x: 20, y: 20, w: 440, h: 248 } } as const

type Tx = {
  create(kind: string, props: Record<string, unknown>): string
  setFrame(ids: string[], frameId: string | null): void
  update(id: string, patch: Record<string, unknown>): void
}
type BoardWindow = { __lobbyBoard?: { canvas: { transact<T>(label: string, fn: (tx: Tx) => T): T } } }

/** Seeds a storyboard: the head and the panels, then their pictures and fields (two steps, as frames need). */
export async function seedStoryboard(page: Page, sb: StoryboardSeed): Promise<void> {
  await page.evaluate((s) => {
    const b = (window as unknown as BoardWindow).__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page, or no dev-auth build)')
    b.canvas.transact('e2e storyboard', (tx) => {
      tx.create('text', {
        id: s.head,
        x: 0,
        y: -120,
        text: s.title,
        customData: { lobby: { 'sb:head': s.settings } },
      })
      for (const p of s.panels)
        tx.create('frame', {
          id: p.id,
          x: p.x,
          y: 0,
          width: 480,
          height: 420,
          name: p.name ?? '',
          customData: { lobby: { 'sb:of': s.head, 'sb:pos': p.pos, 'sb:dur': p.dur } },
        })
    })
  }, sb)
  await expectSaved(page)
  await page.evaluate((s) => {
    const b = (window as unknown as BoardWindow).__lobbyBoard
    if (!b) throw new Error('no board')
    const kinds: Record<string, string> = {
      camera: 'sb-camera',
      action: 'sb-action',
      dialogue: 'sb-dialogue',
      sfx: 'sb-sfx',
      music: 'sb-music',
    }
    const made: { id: string; frame: string }[] = []
    b.canvas.transact('e2e storyboard content', (tx) => {
      for (const p of s.panels) {
        const pic = `${p.id}-pic`
        tx.create('rectangle', {
          id: pic,
          x: p.x + 20,
          y: 20,
          width: 440,
          height: 248,
          backgroundColor: p.color,
          fillStyle: 'solid',
          strokeColor: p.color,
        })
        made.push({ id: pic, frame: p.id })
        let fy = 280
        let fx = p.x + 20
        for (const [f, words] of Object.entries(p.fields ?? {})) {
          const id = `${p.id}-${f}`
          tx.create('note', {
            id,
            x: fx,
            y: fy,
            size: 120,
            text: words,
            customData: { lobby: { kind: kinds[f] } },
          })
          made.push({ id, frame: p.id })
          fx += 140
          if (fx > p.x + 400) {
            fx = p.x + 20
            fy += 130
          }
        }
      }
    })
    b.canvas.transact('e2e storyboard frames', (tx) => {
      for (const m of made) tx.setFrame([m.id], m.frame)
    })
  }, sb)
  await expectSaved(page)
}

/** The panels' durations as a storyboard of `durations`, laid out right to left (reading order ≠ storyboard order). */
export function sixPanels(
  head: string,
  durations: readonly number[],
  opts: { reversed?: boolean } = {},
): PanelSeed[] {
  const colors = ['#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#495057', '#c2255c']
  const n = durations.length
  return durations.map((dur, i) => ({
    id: `${head}-p${i + 1}`,
    pos: `a${i}`,
    dur,
    x: (opts.reversed ? n - 1 - i : i) * 560,
    name: `Panel ${i + 1}`,
    color: colors[i % colors.length] as string,
    fields: {
      camera: `Camera ${i + 1} wide`,
      action: `Action ${i + 1} she turns`,
      dialogue: `Dialogue ${i + 1} hello`,
      sfx: `Sfx ${i + 1} door`,
      music: `Music ${i + 1} strings`,
    },
  }))
}

export interface Swap {
  readonly i: number
  readonly at: number
  readonly pos: number
  readonly a?: number
}

export const player = (page: Page) => page.getByTestId('animatic-player')
export const stage = (page: Page) => page.getByTestId('animatic-stage')

/** Opens the player on the storyboard of `panelId` through the selection bar's "Play animatic". */
export async function openAnimatic(page: Page, panelId: string): Promise<void> {
  await page.evaluate(
    (id) => (window as unknown as { lobbyCanvas: { select(ids: string[]): void } }).lobbyCanvas.select([id]),
    panelId,
  )
  await page.getByTestId('animatic-open').click()
  await expect(player(page)).toBeVisible()
  await expect(stage(page)).toHaveAttribute('data-prepared', 'true', { timeout: 30_000 })
}

export async function swapsOf(page: Page): Promise<Swap[]> {
  return JSON.parse((await stage(page).getAttribute('data-swaps')) ?? '[]') as Swap[]
}

/** Plays from the start to the end (looping off) and returns the swaps of that run. */
export async function playThrough(page: Page, totalMs: number): Promise<Swap[]> {
  await page.keyboard.press('Home')
  const before = (await swapsOf(page)).length
  await page.getByTestId('animatic-play').click()
  await expect(stage(page)).toHaveAttribute('data-state', 'ended', { timeout: totalMs + 15_000 })
  const all = await swapsOf(page)
  return all.slice(before)
}

/** Panel starts (ms) of back-to-back durations. */
export const startsOf = (durations: readonly number[]) => {
  let at = 0
  return durations.map((d) => {
    const s = at
    at += d
    return s
  })
}

/** Every request of the context that left Lobby's own origins (the e2e network assertion: none may). */
export function foreignRequests(context: BrowserContext) {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  context.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

/** Counts File System Access picker calls (a download the download events never see) and refuses them. */
export async function countPickers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    const counts: Record<string, number> = {}
    Object.defineProperty(window, '__t2Pickers', { value: counts })
    for (const name of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
      counts[name] = 0
      w[name] = () => {
        counts[name] = (counts[name] ?? 0) + 1
        return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
      }
    }
  })
  return async () =>
    Object.values(
      await page.evaluate(() => ({
        ...((window as unknown as { __t2Pickers?: Record<string, number> }).__t2Pickers ?? {}),
      })),
    ).reduce((a, b) => a + b, 0)
}

/** A mono 16-bit PCM WAV of `ms` of a quiet tone (a real file the browser decodes and plays). */
export function makeWav(ms: number, rate = 8000): Buffer {
  const samples = Math.round((ms / 1000) * rate)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 2000), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8, 'latin1')
  head.write('fmt ', 12, 'latin1')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'latin1')
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

export interface UploadedFile {
  readonly assetId: string
  readonly versionId: string
  readonly kind: string
  readonly mimeType: string
  readonly name: string
  readonly sizeBytes: number
}

/** Uploads bytes to the board through the api as alice (as a file drop does). */
export async function upload(
  users: Users,
  board: string,
  name: string,
  type: string,
  bytes: Buffer,
): Promise<UploadedFile> {
  const alice = await users.api('alice')
  const up = await alice.request.post(`${WEB_URL}/api/boards/${board}/assets`, {
    headers: { origin: WEB_URL, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
    data: bytes,
  })
  expect(up.status(), await up.text()).toBeLessThan(300)
  return (await up.json()) as UploadedFile
}

/** Places an uploaded file as its card (one `image` element with the file's facts), as placeFile does. */
export async function placeFileCard(
  page: Page,
  id: string,
  file: UploadedFile,
  at: { x: number; y: number },
) {
  await page.evaluate(
    ({ id, file, at }) => {
      const b = (window as unknown as BoardWindow).__lobbyBoard
      if (!b) throw new Error('no board')
      b.canvas.transact('e2e file card', (tx) =>
        tx.create('image', {
          id,
          x: at.x,
          y: at.y,
          width: 320,
          height: 200,
          fileId: file.versionId,
          status: 'saved',
          customData: {
            lobby: {
              file: {
                assetId: file.assetId,
                versionId: file.versionId,
                kind: file.kind,
                name: file.name,
                mimeType: file.mimeType,
                sizeBytes: file.sizeBytes,
              },
            },
          },
        }),
      )
    },
    { id, file, at },
  )
  await expectSaved(page)
}

/** Sets the head's `sb:head` (an audio track, an offset). */
export async function setHead(page: Page, head: string, settings: Record<string, unknown>) {
  await page.evaluate(
    ({ head, settings }) => {
      const b = (window as unknown as BoardWindow).__lobbyBoard
      if (!b) throw new Error('no board')
      b.canvas.transact('e2e head', (tx) =>
        tx.update(head, { customData: { lobby: { 'sb:head': settings } } }),
      )
    },
    { head, settings },
  )
  await expectSaved(page)
}
