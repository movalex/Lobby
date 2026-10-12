// Wave O (WO-PAN): the engine edits of Lobby's pan speed-ups, applied to the copies `pnpm patch` extracts, so the patch
// can be redone after an @excalidraw bump. Every edit is anchored on the pinned nightly (0.18.0-1118751): an anchor that
// is not found exactly once fails the run, and so does an in-place edit that changes the file's line count (the engine
// probes and Lobby's docs cite dist/dev line numbers; new code goes after the last line of the module).
//
//   pnpm patch @excalidraw/element@0.18.0-1118751 --edit-dir <E>
//   pnpm patch @excalidraw/excalidraw@0.18.0-1118751 --edit-dir <X>
//   node pan-patch.mjs --part=o1 --element=<E> --excalidraw=<X>      (O-1: A1-A4, C, E; no pixel change)
//   pnpm patch-commit <E>; pnpm patch-commit <X>; then restore pnpm-workspace.yaml (patch-commit rewrites it: it
//   sorts the catalog, drops the comments and `allowBuilds`) and add the patchedDependencies entry by hand
//
// `pnpm patch` applies the existing patch to the copy it extracts: after a bump, extract with --ignore-existing (the
// element copy then needs W5-53's edits first: apps/web/src/canvas/engine/arrow-geometry.test.ts lists them). The
// excalidraw patch-commit also lists the package's CHANGELOG.md and history.ts as deleted (they are outside its `files`):
// drop those two stanzas from the patch, then `pnpm install` so the lockfile takes the patch's new hash.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const part = arg('part')
const dirs = { element: arg('element'), excalidraw: arg('excalidraw') }
if (part !== 'o1') throw new Error('--part=o1')

const files = new Map()
const file = (pkg, rel) => {
  const dir = dirs[pkg]
  if (!dir) return null
  const path = join(dir, rel)
  if (!files.has(path)) files.set(path, { path, src: readFileSync(path, 'utf8'), lines: null, appended: [] })
  const f = files.get(path)
  f.lines ??= f.src.split('\n').length
  return f
}

/** Replaces the one occurrence of `from` with `to`; with `sameLines`, `to` keeps `from`'s line count. */
const edit = (f, from, to, { sameLines = true } = {}) => {
  if (!f) return
  const n = f.src.split(from).length - 1
  if (n !== 1) throw new Error(`${f.path}: anchor found ${n} times:\n${from.slice(0, 300)}`)
  if (sameLines && from.split('\n').length !== to.split('\n').length)
    throw new Error(`${f.path}: the edit changes the line count:\n${from.slice(0, 300)}`)
  f.src = f.src.replace(from, () => to)
}

/** Code added after the module's last statement (before a dev build's sourceMappingURL comment). */
const append = (f, code) => {
  if (f) f.appended.push(code)
}

const EL_DEV = 'dist/dev/index.js'
const EL_PROD = 'dist/prod/index.js'
const X_DEV = 'dist/dev/index.js'
const X_PROD = 'dist/prod/index.js'

// ------------------------------------------------------------------------------------------------------------------
// O-1, @excalidraw/element
// ------------------------------------------------------------------------------------------------------------------
if (part === 'o1') {
  const dev = file('element', EL_DEV)
  const prod = file('element', EL_PROD)

  // A2: a bound text's bounds are cached too, while it, its container (the same object) and the container's version
  // hold. The engine skips its cache for every bound text ("Fix TBA": a container's change moves its label without
  // bumping the label's version), so the 4,400 note labels of the 10k board ran calculateBounds on every pan frame.
  edit(
    dev,
    `    if (cachedBounds?.version && cachedBounds.version === element.version && // we don't invalidate cache when we update containers and not labels,
    // which is causing problems down the line. Fix TBA.
    !isBoundToContainer(element)) {`,
    `    if (cachedBounds?.version && cachedBounds.version === element.version && // we don't invalidate cache when we update containers and not labels,
    // which is causing problems down the line. Fix TBA. (Lobby patch, wave O A2: a label's entry names its container)
    (!isBoundToContainer(element) || lobbyBoundTextCacheHit(cachedBounds, element, elementsMap))) {`,
  )
  edit(
    dev,
    `    const bounds = _ElementBounds.calculateBounds(element, elementsMap);
    _ElementBounds.boundsCache.set(element, {
      version: element.version,
      bounds
    });`,
    `    const bounds = _ElementBounds.calculateBounds(element, elementsMap), lobbyContainer = lobbyContainerOf(element, elementsMap);
    _ElementBounds.boundsCache.set(element, {
      version: element.version,
      bounds, lobbyContainer, lobbyContainerVersion: lobbyContainer?.version
    });`,
  )
  edit(
    prod,
    'if(o?.version&&o.version===t.version&&!ye(t))return o.bounds;',
    'if(o?.version&&o.version===t.version&&(!ye(t)||lobbyBoundTextCacheHit(o,t,n)))return o.bounds;',
  )
  edit(
    prod,
    'let r=e.calculateBounds(t,n);return e.boundsCache.set(t,{version:t.version,bounds:r}),r}',
    'let r=e.calculateBounds(t,n),lobbyContainer=lobbyContainerOf(t,n);return e.boundsCache.set(t,{version:t.version,bounds:r,lobbyContainer,lobbyContainerVersion:lobbyContainer?.version}),r}',
  )

  // C: shouldApplyFrameClip's bounding-box fast path.
  edit(
    dev,
    '  const shouldClipElementItself = isElementIntersectingFrame(element, frame, elementsMap) || isElementContainingFrame(element, frame, elementsMap);',
    '  if (lobbyFrameClipNotNeeded(element, frame, elementsMap)) return false; /* Lobby patch, wave O C */ const shouldClipElementItself = isElementIntersectingFrame(element, frame, elementsMap) || isElementContainingFrame(element, frame, elementsMap);',
  )
  edit(
    prod,
    'KM=(e,t,n,i,o)=>{if(!n.frameRendering||!n.frameRendering.clip)return!1;let r=Li(e,t,i)||Pa(e,t,i);',
    'KM=(e,t,n,i,o)=>{if(!n.frameRendering||!n.frameRendering.clip)return!1;if(lobbyFrameClipNotNeeded(e,t,i))return!1;let r=Li(e,t,i)||Pa(e,t,i);',
  )

  // A1 / A4: isElementInViewport's test with the view given as scalars (exported; the renderer's two passes call it).
  edit(
    dev,
    `  getArrowheadStrokeScale,
  getOrbitBindingGap,`,
    `  getArrowheadStrokeScale,
  getOrbitBindingGap,
  isElementInViewportAt,`,
    { sameLines: false },
  )
  edit(prod, ',Lt as wrapText};', ',Lt as wrapText,isElementInViewportAt};')

  const helpers = (getElementBounds, isBoundToContainer, elementsAreInFrameBounds) => `
// ---- Lobby patch (wave O, O-1; patches/@excalidraw__element@0.18.0-1118751.patch) --------------------------------
// A1 / A4: isElementInViewport's answer with the view given as scalars. The same arithmetic as viewportCoordsToSceneCoords
// and the same four comparisons, so the same answer to the bit, without the two scene points per call (and, in the
// renderer's offset pass, without a spread of the viewport per element).
function isElementInViewportAt(element, width, height, zoom, offsetLeft, offsetTop, scrollX, scrollY, elementsMap) {
  const bounds = ${getElementBounds}(element, elementsMap);
  return (offsetLeft - offsetLeft) / zoom.value - scrollX <= bounds[2] && (offsetTop - offsetTop) / zoom.value - scrollY <= bounds[3] && (offsetLeft + width - offsetLeft) / zoom.value - scrollX >= bounds[0] && (offsetTop + height - offsetTop) / zoom.value - scrollY >= bounds[1];
}
// A2: the container a bound text's cached bounds were computed against (null for every other element).
function lobbyContainerOf(element, elementsMap) {
  return ${isBoundToContainer}(element) ? elementsMap?.get(element.containerId) ?? null : null;
}
// A2: a bound text's cache entry still holds while its container is the same object at the same version (its own version
// is checked by the caller). A label's bounds read only itself and its container: an arrow's label sits where the
// arrow's path puts it (getBoundTextElementPosition, itself cached on the two versions), any other label at its own x/y.
function lobbyBoundTextCacheHit(cached, element, elementsMap) {
  const container = cached.lobbyContainer;
  return !!container && elementsMap?.get(element.containerId) === container && container.version === cached.lobbyContainerVersion;
}
// C: shouldApplyFrameClip's three tests are all false for an element whose bounds lie inside an unrotated frame's
// rectangle, clear of its edges: its outline (inside its bounds) cannot cross the frame's, its bounds cannot contain the
// frame's, and in a group it is in the frame's bounds (asked as the original asks). Then the answer was false anyway and
// the segment test (both outlines, rounded corners bezier-sampled) is skipped. The margin keeps float noise out of it.
function lobbyFrameClipNotNeeded(element, frame, elementsMap) {
  if (frame.angle) return false;
  const b = ${getElementBounds}(element, elementsMap);
  const m = 1e-6 * (1 + Math.abs(frame.x) + Math.abs(frame.y) + Math.abs(frame.width) + Math.abs(frame.height));
  if (!(b[0] > frame.x + m && b[1] > frame.y + m && b[2] < frame.x + frame.width - m && b[3] < frame.y + frame.height - m)) return false;
  return element.groupIds.length === 0 || ${elementsAreInFrameBounds}([element], frame, elementsMap);
}
`
  append(dev, helpers('getElementBounds', 'isBoundToContainer', 'elementsAreInFrameBounds'))
  append(prod, helpers('ae', 'ye', 'Un'))

  // the declaration, next to isElementInViewport's
  const types = file('element', 'dist/types/element/src/sizeHelpers.d.ts')
  if (types) {
    const at = types.src.indexOf('export declare const isElementCompletelyInViewport')
    if (at < 0) throw new Error(`${types.path}: no isElementCompletelyInViewport declaration`)
    types.src = `${types.src.slice(0, at)}/** Lobby patch (wave O, O-1): isElementInViewport's answer with the view as scalars (no allocation per call). */
export declare const isElementInViewportAt: (element: ExcalidrawElement, width: number, height: number, zoom: Zoom, offsetLeft: number, offsetTop: number, scrollX: number, scrollY: number, elementsMap: ElementsMap) => boolean;
${types.src.slice(at)}`
  }
}

// ------------------------------------------------------------------------------------------------------------------
// O-1, @excalidraw/excalidraw
// ------------------------------------------------------------------------------------------------------------------
if (part === 'o1') {
  const dev = file('excalidraw', X_DEV)
  const prod = file('excalidraw', X_PROD)

  // the renderer's import of the element package gains the scalar viewport test
  edit(
    dev,
    `  getContainerElement as getContainerElement3,
  isElementInViewport as isElementInViewport2,`,
    `  getContainerElement as getContainerElement3,
  isElementInViewport as isElementInViewport2, isElementInViewportAt,`,
  )
  edit(
    prod,
    'isElementInViewport as Lk,isTextElement as gU}from"@excalidraw/element"',
    'isElementInViewport as Lk,isElementInViewportAt as lobbyInViewAt,isTextElement as gU}from"@excalidraw/element"',
  )

  // A4: the render-offset pass (LOD's 4,850 culled ids at fit) tests each offset element without spreading the viewport
  edit(
    dev,
    `        const isVisible = (element, offset) => isElementInViewport2(
          element,
          viewport.width,
          viewport.height,
          {
            ...viewport,
            scrollX: viewport.scrollX + offset.x,
            scrollY: viewport.scrollY + offset.y
          },
          elementsMap
        );`,
    `        const isVisible = (element, offset) => isElementInViewportAt(
          element,
          viewport.width,
          viewport.height,
          viewport.zoom,
          viewport.offsetLeft,
          viewport.offsetTop,
          viewport.scrollX + offset.x,
          viewport.scrollY + offset.y,
          elementsMap
        ); // Lobby patch (wave O, A4): no spread of the viewport per offset element`,
  )
  edit(
    prod,
    'let s=(E,h)=>Lk(E,a.width,a.height,{...a,scrollX:a.scrollX+h.x,scrollY:a.scrollY+h.y},n)',
    'let s=(E,h)=>lobbyInViewAt(E,a.width,a.height,a.zoom,a.offsetLeft,a.offsetTop,a.scrollX+h.x,a.scrollY+h.y,n)',
  )

  // A3: the renderable map (every non-deleted element but the edited text and the new element) is kept across camera
  // moves: it depends only on the scene (its nonce and its element array), the edited text and the new element
  edit(
    dev,
    `        const elements = this.scene.getNonDeletedElements();
        const { elementsMap, newElementCanvasElement } = this.getRenderableElementsMap({
          elements,
          editingTextElement,
          newElement: newElement9
        });`,
    `        const elements = this.scene.getNonDeletedElements();
        const { elementsMap, newElementCanvasElement } = lobbyKeptRenderableElementsMap(
          this,
          canvasNonce,
          elements,
          editingTextElement, newElement9); // Lobby patch (wave O, A3): kept across camera moves`,
  )
  edit(
    prod,
    'let p=this.scene.getNonDeletedElements(),{elementsMap:m,newElementCanvasElement:u}=this.getRenderableElementsMap({elements:p,editingTextElement:d,newElement:c})',
    'let p=this.scene.getNonDeletedElements(),{elementsMap:m,newElementCanvasElement:u}=lobbyKeptRenderableElementsMap(this,t,p,d,c)',
  )

  // A1: the viewport test over the renderable map with the view as scalars
  edit(
    dev,
    `    const visibleElements = [];
    for (const element of elementsMap.values()) {
      if (isElementInViewport2(
        element,
        width,
        height,
        {
          zoom,
          offsetLeft,
          offsetTop,
          scrollX,
          scrollY
        },
        elementsMap
      )) {`,
    `    const visibleElements = [];
    // Lobby patch (wave O, A1): isElementInViewport's test with the view as scalars (no two scene points per element):
    // the same arithmetic, the same answer
    for (const element of elementsMap.values()) {
      if (isElementInViewportAt(
        element,
        width,
        height,
        zoom,
        offsetLeft,
        offsetTop,
        scrollX,
        scrollY,
        elementsMap
      )) {`,
  )
  edit(
    prod,
    'for(let c of t.values())Lk(c,l,s,{zoom:n,offsetLeft:o,offsetTop:r,scrollX:i,scrollY:a},t)&&d.push(c);return d}',
    'for(let c of t.values())lobbyInViewAt(c,l,s,n,o,r,i,a,t)&&d.push(c);return d}',
  )

  // E: the two embeddable scans of every update (componentDidUpdate's updateEmbeddables, render's renderEmbeddables)
  edit(
    dev,
    `    __publicField(this, "updateEmbedValidationStatus", (element, status) => {
      this.embedsValidationStatus.set(element.id, status);`,
    `    __publicField(this, "updateEmbedValidationStatus", (element, status) => {
      this.embedsValidationStatus.set(element.id, status); this.lobbyEmbedsRev = (this.lobbyEmbedsRev ?? 0) + 1; // Lobby patch (wave O, E)`,
  )
  edit(
    dev,
    `    __publicField(this, "updateEmbeddables", () => {
      const iframeLikes = /* @__PURE__ */ new Set();`,
    `    __publicField(this, "updateEmbeddables", () => {
      if (lobbyEmbeddablesUnchanged(this)) return; const iframeLikes = /* @__PURE__ */ new Set(); // Lobby patch (wave O, E)`,
  )
  edit(
    dev,
    `    const embeddableElements = this.scene.getNonDeletedElements().filter(
      (el) => isEmbeddableElement4(el) && this.embedsValidationStatus.get(el.id) === true || isIframeElement2(el)
    );`,
    `    const embeddableElements = lobbyEmbeddablesToRender(this, () => this.scene.getNonDeletedElements().filter(
      (el) => isEmbeddableElement4(el) && this.embedsValidationStatus.get(el.id) === true || isIframeElement2(el)
    )); // Lobby patch (wave O, E): the filter kept while the scene and the validation statuses hold`,
  )
  edit(
    prod,
    'T(this,"updateEmbedValidationStatus",(n,o)=>{this.embedsValidationStatus.set(n.id,o),pd.delete(n)});',
    'T(this,"updateEmbedValidationStatus",(n,o)=>{this.embedsValidationStatus.set(n.id,o),this.lobbyEmbedsRev=(this.lobbyEmbedsRev??0)+1,pd.delete(n)});',
  )
  edit(
    prod,
    'T(this,"updateEmbeddables",()=>{let n=new Set,o=!1;',
    'T(this,"updateEmbeddables",()=>{if(lobbyEmbeddablesUnchanged(this))return;let n=new Set,o=!1;',
  )
  edit(
    prod,
    'i=this.scene.getNonDeletedElements().filter(a=>sr(a)&&this.embedsValidationStatus.get(a.id)===!0||js(a));',
    'i=lobbyEmbeddablesToRender(this,()=>this.scene.getNonDeletedElements().filter(a=>sr(a)&&this.embedsValidationStatus.get(a.id)===!0||js(a)));',
  )

  const helpers = `
// ---- Lobby patch (wave O, O-1; patches/@excalidraw__excalidraw@0.18.0-1118751.patch) -----------------------------
// A3: Renderer._getRenderableElements is memoized on the camera too, so every pan frame rebuilt the renderable map (a
// fresh Map of every element). The map reads only the scene's element array, the edited text and the new element; the
// canvas nonce changes with every scene update (and with the new element's frame). Kept while all four hold.
function lobbyKeptRenderableElementsMap(renderer, canvasNonce, elements, editingTextElement, newElement) {
  const kept = renderer.lobbyKeptRenderable;
  if (kept && kept.canvasNonce === canvasNonce && kept.elements === elements && kept.editingTextElement === editingTextElement && kept.newElement === newElement) {
    return kept.result;
  }
  const result = renderer.getRenderableElementsMap({ elements, editingTextElement, newElement });
  renderer.lobbyKeptRenderable = { canvasNonce, elements, editingTextElement, newElement, result };
  return result;
}
// E: updateEmbeddables (every componentDidUpdate) does new work only for an embeddable without a validation status, and
// gives every embeddable of the array it walks one. None can appear while the scene's element array, its nonce and
// validateEmbeddable are the ones it last walked; its iFrameRefs cleanup has nothing to remove then either (a ref is
// only ever added for an element of that array).
function lobbyEmbeddablesUnchanged(app) {
  const els = app.scene.getNonDeletedElements();
  const nonce = app.scene.getSceneNonce();
  const validate = app.props.validateEmbeddable;
  const last = app.lobbyEmbeddablesWalked;
  if (last && last.els === els && last.nonce === nonce && last.validate === validate) return true;
  app.lobbyEmbeddablesWalked = { els, nonce, validate };
  return false;
}
// E: renderEmbeddables' filter (every render) reads the element array and the validation statuses: kept while the
// array, the scene nonce and the statuses' revision (updateEmbedValidationStatus is their one writer) hold.
function lobbyEmbeddablesToRender(app, filter) {
  const els = app.scene.getNonDeletedElements();
  const nonce = app.scene.getSceneNonce();
  const rev = app.lobbyEmbedsRev ?? 0;
  const last = app.lobbyEmbeddablesRendered;
  if (last && last.els === els && last.nonce === nonce && last.rev === rev) return last.list;
  const list = filter();
  app.lobbyEmbeddablesRendered = { els, nonce, rev, list };
  return list;
}
`
  append(dev, helpers)
  append(prod, helpers)
}

// ------------------------------------------------------------------------------------------------------------------
for (const f of files.values()) {
  if (f.appended.length) {
    const code = f.appended.join('')
    const map = f.src.lastIndexOf('\n//# sourceMappingURL=')
    f.src = map >= 0 ? `${f.src.slice(0, map)}\n${code}${f.src.slice(map + 1)}` : `${f.src}${code}`
  }
  writeFileSync(f.path, f.src)
  console.log(`${f.path}: ${f.lines} -> ${f.src.split('\n').length} lines`)
}
