/**
 * Wave O (WO-PAN) probe, in a mounted <Excalidraw> of the pinned build: the engine patch's pan speed-ups that live in
 * the app and its renderer (which cannot load in Node; the element-level ones are pan-speed.test.ts).
 *  - A1/A3: after every camera move and scene change the renderer's visible elements are the ones isElementInViewport
 *    picks from the scene, and its renderable map is kept across camera moves and replaced on a scene change;
 *  - E: the two embeddable scans see every scene change: a new embeddable gets its validation status, an iframe added
 *    is mounted and one deleted is unmounted, a status flipped by updateEmbedValidationStatus (its one writer) is
 *    rendered, and a camera move alone reuses both scans;
 *  - O-1b: the typed bounds see an element moved in place (its version bumped, no scene update), and the render-offset
 *    pass answers as the engine's own algorithm with a far offset shared by many elements and a near one.
 * Nothing here fetches: the embeddable's link fails the default validator (example.com) and the one rendered later is
 * out of view (never initialized), the iframe is a srcdoc document.
 */
import { isElementInViewport, mutateElement, newElement } from '@excalidraw/element'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's own objects (the App instance, elements)
type Any = any

type Api = {
  updateScene: (data: { elements?: readonly unknown[]; appState?: unknown; captureUpdate: unknown }) => void
  getSceneElements: () => readonly Any[]
  getSceneElementsIncludingDeleted: () => readonly Any[]
  getAppState: () => Any
}

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    let left = n
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  })

const shape = (id: string, x: number, y: number, index: string, extra: Record<string, unknown> = {}) =>
  ({
    ...newElement({
      type: 'rectangle',
      x,
      y,
      width: 120,
      height: 80,
      strokeColor: '#1e1e1e',
      backgroundColor: '#a5d8ff',
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
    } as never),
    id,
    index,
    ...extra,
  }) as Any

/** The <Excalidraw> App instance (React's fiber of its root element): the probe reads the patch's own fields on it. */
function appInstance(): Any {
  const root = document.querySelector('.excalidraw') as Any
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactFiber$'))
  let fiber = key ? root[key] : null
  while (fiber && !fiber.stateNode?.embedsValidationStatus) fiber = fiber.return
  return fiber?.stateNode ?? null
}

export interface PanEngineReport {
  /** the App instance was found and carries the patch's fields */
  patched: boolean
  /** the renderer's visible elements equal isElementInViewport's pick at every camera */
  visibleAsEngine: boolean
  /** the renderable map is kept across camera moves and replaced on a scene change */
  mapKeptAcrossMoves: boolean
  mapReplacedOnChange: boolean
  /** a new embeddable got its validation status (updateEmbeddables saw the new array) */
  embeddableValidated: boolean
  /** an iframe added is mounted, one deleted is unmounted */
  iframeMounted: boolean
  iframeUnmounted: boolean
  /** a status flipped by updateEmbedValidationStatus reaches the render list */
  statusFlipRendered: boolean
  /** a camera move alone reuses both scans */
  scansReusedOnMove: boolean
  /** O-1b: the render-offset pass answers as the engine's algorithm, a far offset group and a near offset */
  offsetPassAsEngine: boolean
}

export async function checkPanEngine(
  apiIn: unknown,
): Promise<PanEngineReport & { ok: boolean; detail: string[] }> {
  const api = apiIn as Api
  const detail: string[] = []
  const els: Any[] = []
  for (let i = 0; i < 40; i++) els.push(shape(`s${i}`, (i % 8) * 170, Math.floor(i / 8) * 130, `a${i}`))
  api.updateScene({
    elements: els,
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: '#ffffff' },
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(3)
  const app = appInstance()
  const patched = !!app?.renderer && 'lobbyKeptRenderable' in app.renderer && !!app.lobbyEmbeddablesWalked
  if (!patched) detail.push('no App instance with the patch’s fields')

  // A1 / A3: cameras over the scene; the renderer's pick against isElementInViewport's
  const pick = () => {
    const st = api.getAppState()
    const map = new Map(api.getSceneElements().map((e) => [e.id, e]))
    return api
      .getSceneElements()
      .filter((e) =>
        isElementInViewport(
          e,
          st.width,
          st.height,
          {
            zoom: st.zoom,
            offsetLeft: st.offsetLeft,
            offsetTop: st.offsetTop,
            scrollX: st.scrollX,
            scrollY: st.scrollY,
          },
          map as never,
        ),
      )
      .map((e) => e.id)
  }
  let visibleAsEngine = true
  const counts: number[] = []
  let mapKeptAcrossMoves = true
  const map0 = app?.renderer?.lobbyKeptRenderable?.result?.elementsMap
  const cams = [
    { scrollX: 0, scrollY: 0, zoom: 1 },
    { scrollX: -400.5, scrollY: -120.25, zoom: 1 },
    { scrollX: -900, scrollY: -300, zoom: 2 },
    { scrollX: 200, scrollY: 100, zoom: 0.5 },
    { scrollX: -1200, scrollY: -500, zoom: 0.25 },
    { scrollX: -1360, scrollY: 0, zoom: 1 },
  ]
  for (const c of cams) {
    api.updateScene({
      appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: c.zoom } },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    await frames(2)
    const want = pick()
    const got = (app?.visibleElements ?? []).map((e: Any) => e.id)
    counts.push(want.length)
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      visibleAsEngine = false
      detail.push(`camera ${JSON.stringify(c)}: the renderer ${got.length}, the engine test ${want.length}`)
    }
    if (app?.renderer?.lobbyKeptRenderable?.result?.elementsMap !== map0) mapKeptAcrossMoves = false
  }
  // the cameras mean something: some see part of the scene, one sees all of it
  if (!counts.some((n) => n > 0 && n < els.length) || !counts.includes(els.length)) {
    visibleAsEngine = false
    detail.push(`cameras saw ${counts.join(', ')} of ${els.length}`)
  }
  // a scene change: a new map (the moved element is in it), and the pick still agrees
  const moved = { ...els[3], x: -1300, version: els[3].version + 1, versionNonce: 7 }
  api.updateScene({
    elements: [...els.slice(0, 3), moved, ...els.slice(4)],
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(2)
  const map1 = app?.renderer?.lobbyKeptRenderable?.result?.elementsMap
  const mapReplacedOnChange = !!map1 && map1 !== map0 && map1.get('s3')?.x === -1300
  if (JSON.stringify((app?.visibleElements ?? []).map((e: Any) => e.id)) !== JSON.stringify(pick())) {
    visibleAsEngine = false
    detail.push('after the scene change: the pick differs')
  }

  // A5: an element moved in place without a scene update (its version bumped, the scene's nonce not): the typed bounds
  // are computed again from the version, as the bounds cache does, so the next camera move sees it where it is now
  const inPlace = api.getSceneElements().find((e) => e.id === 's5')
  mutateElement(inPlace, new Map(api.getSceneElements().map((e) => [e.id, e])) as never, { x: -1500 })
  api.updateScene({
    appState: { scrollX: 1490, scrollY: 0, zoom: { value: 1 } },
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(2)
  const silentSeen = (app?.visibleElements ?? []).some((e: Any) => e.id === 's5')
  const afterMove = JSON.stringify((app?.visibleElements ?? []).map((e: Any) => e.id))
  if (afterMove !== JSON.stringify(pick()) || !silentSeen) {
    visibleAsEngine = false
    detail.push(`after an in-place move: the pick differs (s5 in view ${silentSeen})`)
  }

  // A4b: the render-offset pass against the engine's own algorithm (written out here), with a far offset shared by many
  // elements (the level-of-detail pass's cull) and a near one (a drag preview) that takes an element in and out of view
  const offsetPassAsEngine = await (async () => {
    const far = { x: 1e9, y: 1e9 }
    const overrides = new Map<string, { offset: { x: number; y: number } }>()
    for (let i = 10; i < 30; i++) overrides.set(`s${i}`, { offset: far })
    overrides.set('s1', { offset: { x: 700, y: 260 } })
    ;(api as Any).setElementRenderOverrides(overrides)
    let ok = true
    for (const c of [
      { scrollX: 0, scrollY: 0, zoom: 1 },
      { scrollX: -500, scrollY: -100, zoom: 1 },
      { scrollX: -900, scrollY: -350, zoom: 1 },
      { scrollX: 300, scrollY: 200, zoom: 0.5 },
      { scrollX: -1e9 + 200, scrollY: -1e9 + 100, zoom: 1 },
    ]) {
      api.updateScene({
        appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: c.zoom } },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      await frames(2)
      const st = api.getAppState()
      const map = new Map(api.getSceneElements().map((e) => [e.id, e]))
      const view = (sx: number, sy: number) => ({
        zoom: st.zoom,
        offsetLeft: st.offsetLeft,
        offsetTop: st.offsetTop,
        scrollX: sx,
        scrollY: sy,
      })
      const inView = (e: Any, sx: number, sy: number) =>
        isElementInViewport(e, st.width, st.height, view(sx, sy), map as never)
      const documentVisible = new Set(api.getSceneElements().filter((e) => inView(e, st.scrollX, st.scrollY)))
      const want = api.getSceneElements().filter((e) => {
        const o = overrides.get(e.id)?.offset
        if (!o || (e.type === 'text' && e.containerId)) return documentVisible.has(e)
        return inView(e, st.scrollX + o.x, st.scrollY + o.y)
      })
      const got = app?.renderer?.lobbyLastOffsetsPass?.result ?? []
      if (JSON.stringify(got.map((e: Any) => e.id)) !== JSON.stringify(want.map((e) => e.id))) {
        ok = false
        detail.push(`offsets at ${JSON.stringify(c)}: the pass ${got.length}, the engine ${want.length}`)
      }
    }
    ;(api as Any).setElementRenderOverrides(null)
    await frames(2)
    return ok
  })()

  // E: an embeddable whose link the default validator refuses (nothing is fetched)
  const base = api.getSceneElements()
  const embeddable = shape('emb', 100, 100, 'b0', { type: 'embeddable', link: 'https://example.com/a' })
  api.updateScene({ elements: [...base, embeddable], captureUpdate: CaptureUpdateAction.NEVER })
  await frames(3)
  const embeddableValidated = app?.embedsValidationStatus?.get('emb') === false

  // a camera move alone: both scans reused (the same records)
  const walked = app?.lobbyEmbeddablesWalked
  const rendered = app?.lobbyEmbeddablesRendered
  for (const dx of [10, 20, 30]) {
    api.updateScene({ appState: { scrollX: -dx }, captureUpdate: CaptureUpdateAction.NEVER })
    await frames(2)
  }
  const scansReusedOnMove =
    !!walked &&
    app.lobbyEmbeddablesWalked === walked &&
    !!rendered &&
    app.lobbyEmbeddablesRendered === rendered

  // an iframe (a srcdoc document) in view: mounted; deleted: unmounted
  const iframe = shape('ifr', 200, 150, 'b1', {
    type: 'iframe',
    width: 300,
    height: 200,
    customData: { generationData: { status: 'done', html: '<p>probe</p>' } },
  })
  const withIframe = [...api.getSceneElements(), iframe]
  api.updateScene({
    elements: withIframe,
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(3)
  const containers = () => document.querySelectorAll('.excalidraw__embeddable-container').length
  const iframeMounted = containers() === 1
  api.updateScene({
    elements: withIframe.map((e) => (e.id === 'ifr' ? { ...e, isDeleted: true, version: e.version + 1 } : e)),
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(3)
  const iframeUnmounted = containers() === 0

  // the status flipped by its one writer (no scene change): the render list follows. The embeddable is moved out of
  // view first, so it is listed but never initialized (no iframe, nothing fetched)
  api.updateScene({
    elements: api
      .getSceneElements()
      .map((e) => (e.id === 'emb' ? { ...e, x: 50_000, y: 50_000, version: e.version + 1 } : e)),
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(2)
  const listed = () => (app?.lobbyEmbeddablesRendered?.list ?? []).some((e: Any) => e.id === 'emb')
  const before = listed()
  const emb = api.getSceneElements().find((e) => e.id === 'emb')
  app?.updateEmbedValidationStatus(emb, true)
  api.updateScene({ appState: { scrollX: -5 }, captureUpdate: CaptureUpdateAction.NEVER })
  await frames(2)
  const statusFlipRendered = !before && listed() && containers() === 0

  const report: PanEngineReport = {
    patched,
    visibleAsEngine,
    mapKeptAcrossMoves,
    mapReplacedOnChange,
    embeddableValidated,
    iframeMounted,
    iframeUnmounted,
    statusFlipRendered,
    scansReusedOnMove,
    offsetPassAsEngine,
  }
  // leave the page as it was for the next probe
  api.updateScene({
    elements: [],
    appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } },
    captureUpdate: CaptureUpdateAction.NEVER,
  })
  await frames(2)
  return { ...report, ok: Object.values(report).every(Boolean), detail }
}
