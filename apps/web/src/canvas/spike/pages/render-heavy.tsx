import type { ExcalidrawElement } from '@excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useEffect, useState } from 'react'
import ExcalidrawHost from '../../engine/ExcalidrawHost.tsx'
import type { LobbyRole } from '../../engine/interaction.ts'
import { ImageLoader } from '../../files/loader.ts'
import { RenderOverrides } from '../../overrides.ts'
import { createSpikeHandle, installSpikeHandle } from '../harness.ts'
import { EchoProbe, fixtureUrl, renderEngine, visibleFileIds } from './render-kit.ts'

/** A literal role prop trips the ARIA-role lint (ExcalidrawHost role is a Lobby role, not ARIA). */
const EDITOR: LobbyRole = 'editor'

/**
 * /spike/render-heavy — check A14: the heavy perf board of e2e/perf/seed.ts (20 frames, 4,500 sticky notes
 * each with a bound label, 200 images), rebuilt as Excalidraw elements.
 *   ?scene=<same-origin url>  fetch that scene JSON on start, apply it (captureUpdate NEVER), load the
 *                             visible images first through Lobby's loader; timings in extra.timing
 *   extra.generate(spec)      builds the scene in the page (convertToExcalidrawElements) and returns its
 *                             JSON (the spec stores it on the fixture server)
 */

export interface HeavySpec {
  frames: number
  notes: number
  images: number
}

// e2e/perf/seed.ts's layout, colours mapped to Lobby note colours.
const NW = 200
const GAP = 24
const COLS = 15
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
const COLORS = ['#ffdf6b', '#ffdf6b', '#9fd4ff', '#b8e994', '#d7b8ff', '#ffb870', '#ff9f9f']

function generate(spec: HeavySpec): ExcalidrawElement[] {
  let seed = 99
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const perFrame = Math.ceil(spec.notes / spec.frames)
  const imgsPerFrame = Math.ceil(spec.images / spec.frames)
  const rows = Math.ceil(perFrame / COLS)
  const FW = COLS * (NW + GAP) + GAP + 520
  const FH = Math.max(60 + rows * (NW + GAP) + GAP, 60 + imgsPerFrame * 340 + 20)
  const PER_ROW = Math.ceil(Math.sqrt(spec.frames * 1.25))
  const skeletons: Record<string, unknown>[] = []
  let notesLeft = spec.notes
  let img = 0
  for (let f = 0; f < spec.frames; f++) {
    const fx = (f % PER_ROW) * (FW + 400)
    const fy = Math.floor(f / PER_ROW) * (FH + 400)
    const children: string[] = []
    const n = Math.min(perFrame, notesLeft)
    notesLeft -= n
    for (let k = 0; k < n; k++) {
      const id = `perf-n${f}-${k}`
      children.push(id)
      skeletons.push({
        type: 'stickynote',
        id,
        x: fx + GAP + (k % COLS) * (NW + GAP),
        y: fy + 60 + Math.floor(k / COLS) * (NW + GAP),
        width: NW,
        height: NW,
        backgroundColor: pick(COLORS),
        label: { text: `${pick(rand() < 0.5 ? SUBJECTS : SUBJECTS2)}: ${pick(DETAILS)}`, fontFamily: 6 },
      })
    }
    for (let k = 0; k < imgsPerFrame && img < spec.images; k++, img++) {
      const id = `perf-i${f}-${k}`
      children.push(id)
      skeletons.push({
        type: 'image',
        id,
        x: fx + FW - 500,
        y: fy + 60 + k * 340,
        width: 480,
        height: 300,
        fileId: `ver_hv${String(img).padStart(14, '0')}`,
        status: 'saved',
      })
    }
    skeletons.push({
      type: 'frame',
      id: `perf-f${f}`,
      x: fx,
      y: fy,
      width: FW,
      height: FH,
      name: `Workstream ${f + 1}`,
      children,
    })
  }
  const els = renderEngine.convertToExcalidrawElements(skeletons as never, { regenerateIds: false })
  // Lobby notes carry created: null (no date footer, plan §2.11); images are stored as 'saved' (E1)
  return els.map((e) =>
    e.type === 'stickynote'
      ? ({ ...e, created: null } as unknown as ExcalidrawElement)
      : e.type === 'image'
        ? { ...e, status: 'saved' }
        : e,
  ) as ExcalidrawElement[]
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r))

export default function RenderHeavyPage() {
  const [spike] = useState(() => createSpikeHandle('editor', 'light'))
  useEffect(() => installSpikeHandle(spike.handle), [spike])

  const onReady = async (api: ExcalidrawImperativeAPI) => {
    const extra = spike.handle.extra
    const timing: Record<string, number> = { ready: performance.now() }
    const probe = new EchoProbe(api)
    const loader = new ImageLoader({ addFiles: (f) => api.addFiles(f), resolveUrl: fixtureUrl })
    const overrides = new RenderOverrides(api, { elements: () => api.getSceneElementsIncludingDeleted() })
    Object.assign(extra, {
      timing,
      probe,
      loader,
      overrides,
      engine: renderEngine,
      generate: (spec: HeavySpec) => {
        const t0 = performance.now()
        const els = generate(spec)
        const json = JSON.stringify(els)
        return { json, count: els.length, ms: Math.round(performance.now() - t0) }
      },
      visibleFileIds: () => [...visibleFileIds(api)],
      syncImages: () => loader.syncScene(api.getSceneElements(), visibleFileIds(api)),
    })
    spike.handle.api = api
    const scene = new URLSearchParams(location.search).get('scene')
    if (scene?.startsWith('/')) {
      const res = await fetch(scene, { credentials: 'same-origin' })
      const text = await res.text()
      timing.fetched = performance.now()
      const elements = JSON.parse(text) as ExcalidrawElement[]
      timing.parsed = performance.now()
      api.updateScene({ elements, captureUpdate: renderEngine.CaptureUpdateAction.NEVER })
      timing.applied = performance.now()
      probe.applied(api.getSceneElementsIncludingDeleted())
      api.setViewport({ target: api.getSceneElements(), fit: 'contain' })
      timing.viewport = performance.now()
      await frame()
      await frame()
      timing.painted = performance.now()
      await document.fonts.ready
      timing.fonts = performance.now()
      loader.syncScene(api.getSceneElements(), visibleFileIds(api))
      extra.sceneBytes = text.length
      extra.sceneCount = elements.length
    }
    spike.resolveReady(api)
  }

  return (
    <div data-testid="spike-render-heavy" style={{ position: 'fixed', inset: 0 }}>
      <ExcalidrawHost role={EDITOR} theme="light" onReady={(api) => void onReady(api)} />
    </div>
  )
}
