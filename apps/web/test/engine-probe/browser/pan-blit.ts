/**
 * Wave O (WO-PAN, O-2) probe, in a mounted <Excalidraw> of the pinned build: the pan blit (the engine patch's
 * `setPanBlit`) draws what a full render draws. A scene of every element kind (rotated, rounded, rough, labelled notes
 * and arrows, elbow arrows, lines, freedraw, big text, frames with children, links, images) is panned along a path of
 * fractional steps at five zooms with the blit on; the static canvas is then compared, pixel by pixel, with the render
 * at rest (the blit's own full render, LOBBY_PAN_BLIT_REST_MS later) and with a full render of the same camera with the
 * blit off. The same with grid mode on, at 0.5, 1 and 2 (the grid's dash pattern follows the scroll: no blit then). Then the inputs that must end a blit, each mid-pan: a scene change, a selection change, a theme switch, an
 * image that finishes loading and a lost canvas context; each must give a full render at once, and the pan's last frame
 * must again equal a full render.
 * The canvas is read through a copy (drawImage into a canvas of the probe's own): Chrome moves a canvas read back often
 * to another rasterizer, whose anti-aliasing differs (the wave O scout's finding).
 */
import {
  newArrowElement,
  newElement,
  newFrameElement,
  newFreeDrawElement,
  newImageElement,
  newLinearElement,
  newTextElement,
} from '@excalidraw/element'
import { CaptureUpdateAction, getPanBlitStats, resetPanBlitStats, setPanBlit } from '@excalidraw/excalidraw'
import { generateKeyBetween, generateNKeysBetween } from '@excalidraw/fractional-indexing'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's own objects (elements, app state)
type Any = any

type Api = {
  updateScene: (data: { elements?: readonly unknown[]; appState?: unknown; captureUpdate: unknown }) => void
  getSceneElements: () => readonly Any[]
  getAppState: () => Any
  addFiles: (files: Any[]) => void
}

const STYLE = {
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  link: null,
  locked: false,
} as const

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let left = n
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const rng = (seed: number) => {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const IMAGE_FILE = 'probe-image-file'
const LATE_FILE = 'probe-late-file'

/** A small PNG, drawn here (the probe fetches nothing). */
function pngDataURL(hue: number): string {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 48
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = `hsl(${hue} 70% 55%)`
  ctx.fillRect(0, 0, 64, 48)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(8, 8, 20, 14)
  return c.toDataURL('image/png')
}

/** Every element kind the static canvas draws, over about 5,000 x 3,600 scene px. */
function scene(): Any[] {
  const r = rng(42)
  const out: Any[] = []
  const add = (el: Any) => {
    out.push(el)
    return el
  }
  const kinds = ['rectangle', 'ellipse', 'diamond'] as const
  for (let i = 0; i < 150; i++)
    add(
      newElement({
        ...STYLE,
        type: kinds[i % 3] as string,
        x: r() * 5000 - 2500,
        y: r() * 3600 - 1800,
        width: 30 + r() * 300,
        height: 30 + r() * 220,
        angle: i % 5 === 0 ? r() * 6.28 : 0,
        roundness: i % 2 ? { type: 3 } : null,
        roughness: i % 7 === 0 ? 1 : 0,
        strokeWidth: [1, 2, 4][i % 3] as number,
        backgroundColor: ['transparent', '#a5d8ff', '#ffec99', '#ffc9c9'][i % 4] as string,
        link: i % 23 === 0 ? 'https://example.com/a' : null,
      } as never),
    )
  for (let i = 0; i < 24; i++) {
    const note = newElement({
      ...STYLE,
      type: 'rectangle',
      x: -2400 + (i % 6) * 260,
      y: 1900 + Math.floor(i / 6) * 220,
      width: 220,
      height: 180,
      backgroundColor: '#fff3bf',
      roundness: { type: 3 },
    } as never) as Any
    const label = newTextElement({
      ...STYLE,
      x: note.x + 10,
      y: note.y + 70,
      text: `note ${i} with a label`,
      containerId: note.id,
      fontSize: 20,
    } as never) as Any
    add({ ...note, boundElements: [{ id: label.id, type: 'text' }] })
    add(label)
  }
  for (let i = 0; i < 30; i++) {
    const elbowed = i % 4 === 0
    const arrow = newArrowElement({
      ...STYLE,
      type: 'arrow',
      x: r() * 4600 - 2300,
      y: r() * 3200 - 1600,
      points: [
        [0, 0],
        [120 + r() * 200, (r() - 0.5) * 300],
        [260 + r() * 300, (r() - 0.5) * 200],
      ],
      elbowed,
      roundness: elbowed ? null : { type: 2 },
      startArrowhead: i % 3 === 0 ? 'triangle' : null,
      endArrowhead: 'arrow',
      strokeWidth: [1, 2, 4][i % 3] as number,
    } as never) as Any
    if (i % 2) {
      const label = newTextElement({
        ...STYLE,
        x: 0,
        y: 0,
        text: `arrow ${i}, a wide label`,
        containerId: arrow.id,
        fontSize: 16,
      } as never) as Any
      add({ ...arrow, boundElements: [{ id: label.id, type: 'text' }] })
      add(label)
    } else add(arrow)
  }
  for (let i = 0; i < 8; i++)
    add(
      newLinearElement({
        ...STYLE,
        type: 'line',
        x: r() * 4000 - 2000,
        y: r() * 3000 - 1500,
        points: [
          [0, 0],
          [r() * 300, r() * 300 - 150],
          [r() * 300 - 150, r() * 300],
        ],
        angle: i % 2 ? 0.6 : 0,
      } as never),
    )
  for (let i = 0; i < 6; i++)
    add(
      newFreeDrawElement({
        ...STYLE,
        type: 'freedraw',
        x: r() * 4000 - 2000,
        y: r() * 3000 - 1500,
        points: Array.from({ length: 40 }, (_, k) => [k * 6, Math.sin(k / 4) * 50]),
        pressures: [],
        simulatePressure: true,
        strokeWidth: [1, 2, 4][i % 3] as number,
      } as never),
    )
  for (let i = 0; i < 4; i++)
    add(
      newTextElement({
        ...STYLE,
        x: r() * 4000 - 2000,
        y: r() * 3000 - 1500,
        text: i % 2 ? 'Big title' : 'Tilted\ntext',
        fontSize: i % 2 ? 96 : 36,
        angle: i % 2 ? 0 : 0.35,
      } as never),
    )
  const frame = add({
    ...newFrameElement({ x: 600, y: -1700, width: 1400, height: 1000 }),
    name: 'Probe frame',
  })
  for (let i = 0; i < 12; i++)
    add(
      newElement({
        ...STYLE,
        type: 'rectangle',
        x: 560 + (i % 4) * 380,
        y: -1660 + Math.floor(i / 4) * 330,
        width: 300,
        height: 240,
        backgroundColor: '#d0bfff',
        frameId: frame.id,
      } as never),
    )
  for (let i = 0; i < 6; i++)
    add(
      newImageElement({
        ...STYLE,
        type: 'image',
        x: -1800 + i * 420,
        y: -1900,
        width: 320,
        height: 240,
        fileId: IMAGE_FILE,
        status: 'saved',
      } as never),
    )
  // mirrored images (element patch T: a mirror's transform carries the centre, scroll included, twice) and a turned one
  for (const [i, scale] of ([[-1, 1], [1, -1], [-1, -1], [1, 1]] as const).entries())
    add(
      newImageElement({
        ...STYLE,
        type: 'image',
        x: -1800 + i * 420,
        y: -1500.37,
        width: 320.123,
        height: 240.217,
        angle: i === 3 ? Math.PI / 2 : 0,
        fileId: IMAGE_FILE,
        status: 'saved',
        scale: [...scale],
      } as never),
    )
  const keys = generateNKeysBetween(null, null, out.length)
  return out.map((el, i) => ({ ...el, index: keys[i] }))
}

interface Diff {
  pixels: number
  max: number
  /** where they are: up to 8 cells of 64 device px with their counts (x, y, pixels) */
  cells: [number, number, number][]
}

const STATIC = 'canvas.excalidraw__canvas.static'

/** The static canvas's pixels, through a copy (never the live canvas). */
function grab(): Uint8ClampedArray {
  const c = document.querySelector(STATIC) as HTMLCanvasElement
  const copy = document.createElement('canvas')
  copy.width = c.width
  copy.height = c.height
  const cx = copy.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
  cx.drawImage(c, 0, 0)
  return cx.getImageData(0, 0, c.width, c.height).data
}

function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): Diff {
  const W = (document.querySelector(STATIC) as HTMLCanvasElement).width
  let pixels = 0
  let max = 0
  const cells = new Map<string, number>()
  for (let i = 0; i < a.length; i += 4) {
    let m = 0
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs((a[i + k] as number) - (b[i + k] as number)))
    if (!m) continue
    pixels++
    if (m > max) max = m
    const p = i / 4
    const key = `${Math.floor((p % W) / 64) * 64},${Math.floor(p / W / 64) * 64}`
    cells.set(key, (cells.get(key) ?? 0) + 1)
  }
  const top = [...cells.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
  return { pixels, max, cells: top.map(([k, n]) => [...(k.split(',').map(Number) as [number, number]), n]) }
}

/** `b` drawn (dx, dy) device px further than `a`: their overlap compared. */
function overlap(a: Uint8ClampedArray, b: Uint8ClampedArray, dx: number, dy: number): Diff {
  const c = document.querySelector(STATIC) as HTMLCanvasElement
  const W = c.width
  const H = c.height
  let pixels = 0
  let max = 0
  const cells = new Map<string, number>()
  for (let y = Math.max(0, -dy); y < Math.min(H, H - dy); y++)
    for (let x = Math.max(0, -dx); x < Math.min(W, W - dx); x++) {
      const i = (y * W + x) * 4
      const j = ((y + dy) * W + (x + dx)) * 4
      let m = 0
      for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs((a[i + k] as number) - (b[j + k] as number)))
      if (!m) continue
      pixels++
      if (m > max) max = m
      if (m > 8) {
        const key = `${Math.floor(x / 64) * 64},${Math.floor(y / 64) * 64}`
        cells.set(key, (cells.get(key) ?? 0) + 1)
      }
    }
  // where it differs by more than 8 levels: up to 4 cells of 64 device px (x, y, pixels)
  const top = [...cells.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4)
  return { pixels, max, cells: top.map(([k, n]) => [...(k.split(',').map(Number) as [number, number]), n]) }
}

/** Ink that is not the background: the view shows something. */
function inked(a: Uint8ClampedArray): number {
  let n = 0
  for (let i = 0; i < a.length; i += 4) if (a[i] !== a[0] || a[i + 1] !== a[1] || a[i + 2] !== a[2]) n++
  return n
}

export interface PanBlitView {
  zoom: number
  /**
   * grid mode on (the control is then taken with it off: two full renders at other scrolls draw its dashes at another
   * phase, so with it on they are not the raster's floor)
   */
  grid: boolean
  /** two full renders whole device pixels apart, their overlap: the raster's own floor */
  control: Diff
  blits: number
  fullsDuringPan: number
  inked: number
  restVsBlit: Diff
  fullVsBlit: Diff
  /** the render at rest against a full render with the blit off: both full renders of one camera, so equal */
  restVsFull: Diff
}

export interface PanBlitStale {
  name: string
  /** a full render came at the first frame after the change */
  fullAtOnce: boolean
  /** blits went on after it */
  blitsAfter: number
  fullVsBlit: Diff
  /** the control in the state the change left */
  control: Diff
  /** what is drawn where they differ most (type, angle, link) */
  near: string[]
}

export interface PanBlitScratch {
  /** the scratch canvas was seen (a canvas of the static canvas's size made during a pan) */
  seen: boolean
  /** its size at the render at rest (0 x 0: freed) */
  atRest: [number, number]
  /** the next pan sized it again and went on blitting */
  sizedAgain: boolean
  blitsAgain: number
  fullVsBlit: Diff
  control: Diff
  /** what is drawn where the control differs most */
  near: string[]
}

export async function checkPanBlit(apiIn: unknown): Promise<{
  ok: boolean
  views: PanBlitView[]
  stale: PanBlitStale[]
  scratch: PanBlitScratch
  detail: string[]
}> {
  const api = apiIn as Api
  const detail: string[] = []
  api.addFiles([{ id: IMAGE_FILE, dataURL: pngDataURL(200), mimeType: 'image/png', created: Date.now() }])
  const els = scene()
  api.updateScene({
    elements: els,
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff', theme: 'light' },
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(4)
  await sleep(300)
  const camera = () => {
    const st = api.getAppState()
    return { x: st.scrollX as number, y: st.scrollY as number, zoom: st.zoom.value as number }
  }
  const move = async (scrollX: number, scrollY: number) => {
    api.updateScene({ appState: { scrollX, scrollY }, captureUpdate: CaptureUpdateAction.NEVER })
    await frames(1)
  }
  /** a pan of `n` frames along a varied path of fractional css px steps; `at(i)` runs before step i */
  const pan = async (n: number, at?: (i: number) => Promise<void> | void) => {
    for (let i = 0; i < n; i++) {
      await at?.(i)
      const c = camera()
      const dx = 23.3 * Math.sin(i / 4) + 3.7
      const dy = -11.9 * Math.cos(i / 5) + 1.3
      await move(c.x + dx / c.zoom, c.y + dy / c.zoom)
    }
    await frames(1)
  }
  /** the same camera rendered in full: the blit off, nudged away and back */
  const fullRender = async () => {
    setPanBlit(false)
    const c = camera()
    await move(c.x + 5 / c.zoom, c.y + 3 / c.zoom)
    await move(c.x, c.y)
    await frames(2)
    const full = grab()
    setPanBlit(true)
    return full
  }

  /** the elements drawn in a diff's top cells (device px), for the report */
  const near = (d: Diff) => {
    const st = api.getAppState()
    const k = st.zoom.value * window.devicePixelRatio
    const out = new Set<string>()
    for (const [cx, cy] of d.cells.slice(0, 4))
      for (const e of api.getSceneElements()) {
        const x1 = (e.x + st.scrollX) * k
        const y1 = (e.y + st.scrollY) * k
        const x2 = x1 + Math.abs(e.width) * k
        const y2 = y1 + Math.abs(e.height) * k
        if (x2 < cx - 8 || x1 > cx + 72 || y2 < cy - 8 || y1 > cy + 72) continue
        const kind = `${e.type}${e.angle ? `@${e.angle.toFixed(2)}` : ''}`
        out.add(`${kind}${e.link ? '+link' : ''}${e.containerId ? '(label)' : ''}`)
      }
    return [...out]
  }
  /**
   * The control here: full renders whole device pixels apart, each overlap with the first compared (the raster's own
   * floor: an element drawn off the pixel grid, rotated or a path, can land a few levels apart at another scroll); the
   * most pixels and the most levels of three moves. The camera is put back.
   */
  const controlHere = async () => {
    const snapped = () => {
      const c = camera()
      const k = c.zoom * window.devicePixelRatio
      return { x: Math.round(c.x * k), y: Math.round(c.y * k) }
    }
    const start = camera()
    const c0 = await fullRender()
    const s0 = snapped()
    const floor: Diff = { pixels: 0, max: 0, cells: [] }
    for (const [dx, dy] of [
      [8, 4],
      [3, 11],
      [13, 2],
    ] as const) {
      await move(start.x - dx / start.zoom, start.y - dy / start.zoom)
      const c1 = await fullRender()
      const s1 = snapped()
      const d = overlap(c0, c1, s1.x - s0.x, s1.y - s0.y)
      floor.pixels = Math.max(floor.pixels, d.pixels)
      if (d.max > floor.max) floor.cells = d.cells
      floor.max = Math.max(floor.max, d.max)
    }
    await move(start.x, start.y)
    return floor
  }

  const setGrid = async (on: boolean) => {
    api.updateScene({ appState: { gridModeEnabled: on }, captureUpdate: CaptureUpdateAction.NEVER })
    await frames(2)
  }
  /** a pan of 40 frames at `zoom` with the blit on: its last frame against the render at rest and a full render */
  const view = async (zoom: number, grid: boolean): Promise<PanBlitView> => {
    api.updateScene({
      appState: { zoom: { value: zoom }, scrollX: 1400 / zoom / 2, scrollY: 900 / zoom / 2 },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    await frames(3)
    if (grid) await setGrid(false)
    const control = await controlHere()
    if (grid) await setGrid(true)
    resetPanBlitStats()
    await pan(40)
    const s = getPanBlitStats()
    const blit = grab()
    const at = `zoom ${zoom}${grid ? ' (grid)' : ''}`
    if (!grid && s.last !== 'blit') detail.push(`${at}: the pan's last render was ${s.last}, not a blit`)
    await sleep(300)
    const restStats = getPanBlitStats()
    if (!grid && restStats.last !== 'rest') detail.push(`${at}: no render at rest (${restStats.last})`)
    const rest = grab()
    const full = await fullRender()
    if (grid) await setGrid(false)
    return {
      zoom,
      grid,
      control,
      blits: s.blit,
      fullsDuringPan: s.full,
      inked: inked(blit),
      restVsBlit: diff(rest, blit),
      fullVsBlit: diff(full, blit),
      restVsFull: diff(rest, full),
    }
  }

  setPanBlit(true)
  const views: PanBlitView[] = []
  for (const zoom of [0.1, 0.25, 0.5, 1, 2]) views.push(await view(zoom, false))
  // grid mode on: strokeGrid starts each dashed line's pattern at the scroll modulo the grid size, so the dashes of a
  // shifted frame and of a band drawn at a later scroll disagree once the scroll crosses a grid line; every frame of
  // the pan must still be a full render's (0.5: the grid's smallest zoom with dashed lines; 1; 2)
  for (const zoom of [0.5, 1, 2]) views.push(await view(zoom, true))

  // the inputs that must end a blit, each in the middle of a pan at zoom 0.5
  const stale: PanBlitStale[] = []
  const staleCase = async (name: string, change: () => void | Promise<void>, settle = 0) => {
    api.updateScene({
      appState: { zoom: { value: 0.5 }, scrollX: 1400, scrollY: 900, theme: 'light', selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    await frames(3)
    resetPanBlitStats()
    let fullsBefore = 0
    let fullAtOnce = false
    let blitsAt = 0
    await pan(30, async (i) => {
      if (i === 12) {
        fullsBefore = getPanBlitStats().full
        await change()
        if (settle) await sleep(settle)
      }
      if (i === 13) {
        fullAtOnce = getPanBlitStats().full > fullsBefore
        blitsAt = getPanBlitStats().blit
      }
    })
    const s = getPanBlitStats()
    const blit = grab()
    const full = await fullRender()
    // the control in the state the change left (another theme draws other colours)
    const control = await controlHere()
    const d = diff(full, blit)
    stale.push({ name, fullAtOnce, blitsAfter: s.blit - blitsAt, fullVsBlit: d, control, near: near(d) })
  }
  const inView = () => {
    const st = api.getAppState()
    const z = st.zoom.value
    const x1 = -st.scrollX
    const y1 = -st.scrollY
    return api
      .getSceneElements()
      .filter(
        (e) =>
          e.type === 'rectangle' &&
          !e.containerId &&
          e.x > x1 + 100 &&
          e.y > y1 + 100 &&
          e.x < x1 + st.width / z - 300 &&
          e.y < y1 + st.height / z - 300,
      )
  }
  await staleCase('a scene change (an element in view moved)', () => {
    const target = inView()[0]
    if (!target) detail.push('scene change: no element in view')
    api.updateScene({
      elements: api
        .getSceneElements()
        .map((e) => (e === target ? { ...e, x: e.x + 60, version: e.version + 1, versionNonce: 99 } : e)),
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  })
  await staleCase('a selection change (a linked element: its link icon goes)', () => {
    const st = api.getAppState()
    const z = st.zoom.value
    const linked = api
      .getSceneElements()
      .find(
        (e) =>
          e.link &&
          e.x > -st.scrollX &&
          e.y > -st.scrollY &&
          e.x + e.width < -st.scrollX + st.width / z &&
          e.y + e.height < -st.scrollY + st.height / z,
      )
    if (!linked) detail.push('selection change: no linked element in view')
    api.updateScene({
      appState: { selectedElementIds: linked ? { [linked.id]: true } : {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  })
  await staleCase('a theme switch', () => {
    api.updateScene({ appState: { theme: 'dark' }, captureUpdate: CaptureUpdateAction.NEVER })
  })
  await staleCase(
    'an image that finishes loading',
    () => {
      const target = inView()[1]
      const base = api.getSceneElements()
      api.updateScene({
        elements: [
          ...base,
          {
            ...newImageElement({
              ...STYLE,
              type: 'image',
              x: (target?.x ?? 0) + 20,
              y: (target?.y ?? 0) + 20,
              width: 200,
              height: 150,
              fileId: LATE_FILE,
              status: 'saved',
            } as never),
            index: generateKeyBetween(base.at(-1)?.index ?? null, null),
          },
        ],
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      api.addFiles([{ id: LATE_FILE, dataURL: pngDataURL(20), mimeType: 'image/png', created: Date.now() }])
    },
    150,
  )
  await staleCase('a lost canvas context', () => {
    document.querySelector(STATIC)?.dispatchEvent(new Event('contextlost'))
  })
  const lost = getPanBlitStats().lost

  // The scratch canvas the shifted frame waits in (W x H x 4 bytes and a GPU texture): freed at the render at rest (its
  // size 0) and sized again by the next blit. A lost scratch context, by its contextlost event or by isContextLost()
  // before the event comes (a lost context draws nothing), must give a full render at once. The probe finds the scratch
  // canvas among the canvases made while it pans: the one of the static canvas's size.
  const made: HTMLCanvasElement[] = []
  const create = document.createElement
  Object.defineProperty(document, 'createElement', {
    configurable: true,
    value(this: Document, tag: string, options?: ElementCreationOptions) {
      const el = create.call(this, tag, options)
      if (String(tag).toLowerCase() === 'canvas') made.push(el as HTMLCanvasElement)
      return el
    },
  })
  const scratchNow = () => {
    const c = document.querySelector(STATIC) as HTMLCanvasElement
    return made.findLast((m) => m.width === c.width && m.height === c.height) ?? null
  }
  let scratch: PanBlitScratch
  try {
    api.updateScene({
      appState: { zoom: { value: 0.5 }, scrollX: 1400, scrollY: 900, theme: 'light', selectedElementIds: {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    await frames(3)
    resetPanBlitStats()
    await pan(8)
    const seen = scratchNow()
    await sleep(300)
    const atRest: [number, number] = seen ? [seen.width, seen.height] : [-1, -1]
    const restLast = getPanBlitStats().last
    if (restLast !== 'rest') detail.push(`scratch: no render at rest (${restLast})`)
    resetPanBlitStats()
    await pan(20)
    const sizedAgain = scratchNow() !== null
    const blitsAgain = getPanBlitStats().blit
    const blit = grab()
    const full = await fullRender()
    const control = await controlHere()
    scratch = {
      seen: !!seen,
      atRest,
      sizedAgain,
      blitsAgain,
      fullVsBlit: diff(full, blit),
      control,
      near: near(control),
    }
    await staleCase('a lost scratch context (its contextlost event)', () => {
      const s = scratchNow()
      if (!s) detail.push('scratch contextlost: no scratch canvas in the pan')
      s?.dispatchEvent(new Event('contextlost'))
    })
    await staleCase('a lost scratch context (isContextLost before the event; it draws nothing)', () => {
      const ctx = scratchNow()?.getContext('2d')
      if (!ctx) detail.push('scratch isContextLost: no scratch canvas in the pan')
      else {
        Object.defineProperty(ctx, 'isContextLost', { configurable: true, value: () => true })
        Object.defineProperty(ctx, 'drawImage', { configurable: true, value: () => {} })
      }
    })
  } finally {
    delete (document as unknown as { createElement?: unknown }).createElement
  }

  setPanBlit(false)
  api.updateScene({
    elements: [],
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, theme: 'light', selectedElementIds: {} },
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(2)

  // the verdict: the blit's frame is a full render's within the raster's own floor: on about as many pixels as the
  // control, none more than 16 levels apart (an off-grid draw, a rotated element's anti-aliased edge or a path, lands
  // that far apart at another scroll: one rotated edge pixel 6 levels apart in dark mode; the wave O scout's GPU control
  // at fit, 16); stale content (a placeholder, a moved note, a link icon, the other theme) is far more
  const within = (d: Diff, floor: Diff) =>
    d.max <= Math.max(16, floor.max) && d.pixels <= 2 * floor.pixels + 200
  let ok = detail.length === 0
  for (const v of views) {
    // with the grid on the blit stays off: the pan's frames are full renders (strokeGrid's dash phase follows the scroll)
    const blitsOk = v.grid ? v.blits === 0 : v.blits >= 30
    if (!blitsOk || v.inked < 1000 || v.restVsFull.pixels || !within(v.fullVsBlit, v.control)) {
      ok = false
      detail.push(
        `zoom ${v.zoom}${v.grid ? ' (grid)' : ''}: ${v.blits} blits, ${JSON.stringify(v.fullVsBlit)}, the control ${JSON.stringify(v.control)}`,
      )
    }
  }
  for (const c of stale)
    if (!c.fullAtOnce || c.blitsAfter < 5 || !within(c.fullVsBlit, c.control)) {
      ok = false
      detail.push(`${c.name}: ${JSON.stringify(c.fullVsBlit)}`)
    }
  if (lost < 1) {
    ok = false
    detail.push('the lost context was not seen')
  }
  if (
    !scratch.seen ||
    scratch.atRest[0] !== 0 ||
    scratch.atRest[1] !== 0 ||
    !scratch.sizedAgain ||
    scratch.blitsAgain < 15 ||
    !within(scratch.fullVsBlit, scratch.control)
  ) {
    ok = false
    detail.push(`the scratch canvas: ${JSON.stringify(scratch)}`)
  }
  return { ok, views, stale, scratch, detail }
}
