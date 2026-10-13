// Wave O (WO-PAN): the engine edits of Lobby's pan speed-ups, applied to the copies `pnpm patch` extracts, so the patch
// can be redone after an @excalidraw bump. Every edit is anchored on the pinned nightly (0.18.0-1118751): an anchor that
// is not found exactly once fails the run, and so does an in-place edit that changes the file's line count (the engine
// probes and Lobby's docs cite dist/dev line numbers; new code goes after the last line of the module).
//
//   pnpm patch @excalidraw/element@0.18.0-1118751 --edit-dir <E>
//   pnpm patch @excalidraw/excalidraw@0.18.0-1118751 --edit-dir <X>
//   node pan-patch.mjs --part=o1 --element=<E> --excalidraw=<X>      (O-1: A1-A4, C, E; no pixel change)
//   node pan-patch.mjs --part=o1b --excalidraw=<X>                   (O-1b, on a copy with O-1: A5 and the kept passes)
//   node pan-patch.mjs --part=o2 --element=<E> --excalidraw=<X>      (O-2, on a copy with O-1b: T and the pan blit B)
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
if (!['o1', 'o1b', 'o2'].includes(part)) throw new Error('--part=o1, o1b or o2')

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
// O-1b, @excalidraw/excalidraw: A5 and the kept passes (no pixel change), on a copy with O-1
// ------------------------------------------------------------------------------------------------------------------
if (part === 'o1b') {
  const dev = file('excalidraw', X_DEV)
  const prod = file('excalidraw', X_PROD)

  // the viewport pass: A5's typed bounds, and the last frame's array again when the answer is the same
  edit(
    dev,
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
      )) {
        visibleElements.push(element);
      }
    }
    return visibleElements;`,
    `    // Lobby patch (wave O, A1, A5): isElementInViewport's test over the renderable map with the view as scalars (no two
    // scene points per element; the same arithmetic, the same answer), each element's bounds read from a typed copy kept
    // per renderable map and checked against the versions the bounds cache checks, and the last frame's array again when
    // the answer is the same (lobbyVisibleCanvasElements, after the module's last line)
    return lobbyVisibleCanvasElements(
      this,
      elementsMap,
      zoom,
      offsetLeft,
      offsetTop,
      scrollX,
      scrollY,
      height,
      width
    );
    // (the loop that was here: for each element of elementsMap, isElementInViewport(element, width, height, the view,
    // elementsMap), the ones it keeps pushed in order; A1 made it isElementInViewportAt, which A5 inlines with the
    // view's corners computed once a frame, adding the typed bounds and the kept array)
    // (end of the Lobby patch)`,
  )
  edit(
    prod,
    'getVisibleCanvasElements({elementsMap:t,zoom:n,offsetLeft:o,offsetTop:r,scrollX:i,scrollY:a,height:s,width:l}){let d=[];for(let c of t.values())lobbyInViewAt(c,l,s,n,o,r,i,a,t)&&d.push(c);return d}',
    'getVisibleCanvasElements({elementsMap:t,zoom:n,offsetLeft:o,offsetTop:r,scrollX:i,scrollY:a,height:s,width:l}){return lobbyVisibleCanvasElements(this,t,n,o,r,i,a,s,l)}',
  )
  // the render-offset pass, kept while its inputs and its decisions hold
  edit(
    dev,
    `  getVisibleElementsWithRenderOffsets(visibleElements, elementsMap, appState, offsets) {
    return this._getVisibleElementsWithRenderOffsets({`,
    `  getVisibleElementsWithRenderOffsets(visibleElements, elementsMap, appState, offsets) {
    return lobbyOffsetsPass(this, { // Lobby patch (wave O, A4b): the pass kept while its decisions hold`,
  )
  edit(
    prod,
    'getVisibleElementsWithRenderOffsets(t,n,o,r){return this._getVisibleElementsWithRenderOffsets({',
    'getVisibleElementsWithRenderOffsets(t,n,o,r){return lobbyOffsetsPass(this,{',
  )

  const helpers = ({ BOUNDS, INVIEW, ISTEXT, CONTAINER, FRAMEID }) => `
// ---- Lobby patch (wave O, O-1b; patches/@excalidraw__excalidraw@0.18.0-1118751.patch) ----------------------------
// A5: per renderable map (A3 keeps one while the scene's nonce holds), its elements in order and their bounds in a typed
// array, with the version each entry was computed at (and, for a bound text, the version of its container: the bounds
// cache's own key, A2). An entry is computed again, through getElementBounds, when one of them moved. The test is
// isElementInViewport's four comparisons, the view's corners computed as viewportCoordsToSceneCoords computes them.
var lobbyBoundsByMap = /* @__PURE__ */ new WeakMap();
function lobbyVisibleCanvasElements(renderer, elementsMap, zoom, offsetLeft, offsetTop, scrollX, scrollY, height, width) {
  let c = lobbyBoundsByMap.get(elementsMap);
  if (!c) {
    const elements = [...elementsMap.values()];
    const n = elements.length;
    c = { elements, bounds: new Float64Array(n * 4), versions: new Float64Array(n).fill(NaN), containers: new Array(n).fill(null), containerVersions: new Float64Array(n) };
    lobbyBoundsByMap.set(elementsMap, c);
  }
  const x1 = (offsetLeft - offsetLeft) / zoom.value - scrollX;
  const y1 = (offsetTop - offsetTop) / zoom.value - scrollY;
  const x2 = (offsetLeft + width - offsetLeft) / zoom.value - scrollX;
  const y2 = (offsetTop + height - offsetTop) / zoom.value - scrollY;
  const { elements, bounds, versions, containers, containerVersions } = c;
  const visible = [];
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const container = containers[i];
    const j = i * 4;
    if (versions[i] !== element.version || container !== null && container.version !== containerVersions[i]) {
      const b = ${BOUNDS}(element, elementsMap);
      bounds[j] = b[0];
      bounds[j + 1] = b[1];
      bounds[j + 2] = b[2];
      bounds[j + 3] = b[3];
      versions[i] = element.version;
      const owner = ${ISTEXT}(element) && element.containerId ? elementsMap.get(element.containerId) ?? null : null;
      containers[i] = owner;
      containerVersions[i] = owner ? owner.version : 0;
    }
    if (x1 <= bounds[j + 2] && y1 <= bounds[j + 3] && x2 >= bounds[j] && y2 >= bounds[j + 1]) {
      visible.push(element);
    }
  }
  // the last frame's array when this one holds the same elements in the same order (the render-offset pass and the
  // visible set's cache key on its identity)
  const last = renderer.lobbyLastVisible;
  if (last && last.length === visible.length) {
    let same = true;
    for (let i = 0; i < visible.length; i++) {
      if (last[i] !== visible[i]) {
        same = false;
        break;
      }
    }
    if (same) return last;
  }
  renderer.lobbyLastVisible = visible;
  return visible;
}
// A4b: Renderer._getVisibleElementsWithRenderOffsets, the same pass, with the offset elements decided by group. At
// Lobby's fit the level-of-detail pass moves 4,850 elements out of the render with one far offset, and the pass built a
// Set of every visible element, tested each of the 4,850 and filtered every visible element, on every frame. Here the
// offset elements are grouped by offset (kept per offsets snapshot and map, built again when an element's version
// moved), each group with the union of its elements' bounds: when the view, moved by a group's offset, misses that union
// (isElementInViewportAt's four comparisons fail for the union, so for each element), none of the group is in view.
// When that holds for every group, the engine's answer is the visible elements less the groups' members (the ones the
// document shows are the ones it removes; it adds none): computed so, or the last frame's when its inputs are the same.
// Anything else is the engine's own computation.
function lobbyOffsetsPass(renderer, args) {
  const { visibleElements, elementsMap, offsets, selectedElements, frameToHighlight, ...viewport } = args;
  const last = renderer.lobbyLastOffsetsPass;
  const sameInputs = !!last && last.visibleElements === visibleElements && last.elementsMap === elementsMap && last.offsets === offsets && last.selectedElements === selectedElements && last.frameToHighlight === frameToHighlight;
  const needsFrameReordering = frameToHighlight && ${FRAMEID}(selectedElements) !== frameToHighlight.id;
  const groups = lobbyOffsetGroupsOf(renderer, offsets, elementsMap);
  if (!needsFrameReordering && lobbyOffsetGroupsUnseen(groups, viewport)) {
    if (sameInputs && last.unseen) return last.result;
    const filtered = visibleElements.filter((element) => !groups.members.has(element));
    const result = filtered.length === visibleElements.length ? visibleElements : filtered;
    renderer.lobbyLastOffsetsPass = { visibleElements, elementsMap, offsets, selectedElements, frameToHighlight, unseen: true, result };
    return result;
  }
  // the engine's own computation
  const documentVisible = renderer.getVisibleSet(visibleElements);
  const added = /* @__PURE__ */ new Set();
  const removed = /* @__PURE__ */ new Set();
  for (const [id, offset] of offsets) {
    const element = elementsMap.get(id);
    if (!element || ${ISTEXT}(element) && ${CONTAINER}(element, elementsMap)) {
      continue;
    }
    const visible = ${INVIEW}(element, viewport.width, viewport.height, viewport.zoom, viewport.offsetLeft, viewport.offsetTop, viewport.scrollX + offset.x, viewport.scrollY + offset.y, elementsMap);
    if (documentVisible.has(element) !== visible) {
      (visible ? added : removed).add(element);
    }
  }
  let result;
  if (!added.size && !removed.size) {
    result = visibleElements;
  } else if (!added.size && !needsFrameReordering) {
    result = visibleElements.filter((element) => !removed.has(element));
  } else {
    const all = [];
    for (const element of elementsMap.values()) {
      if (added.has(element) || documentVisible.has(element) && !removed.has(element)) {
        all.push(element);
      }
    }
    result = needsFrameReordering ? renderer.sortSelectedElementsIntoHighlightedFrame({ visibleElements: all, selectedElements, frameToHighlight }) : all;
  }
  renderer.lobbyLastOffsetsPass = { visibleElements, elementsMap, offsets, selectedElements, frameToHighlight, unseen: false, result };
  return result;
}
// the offset elements the pass tests (it skips a bound text: it keeps its container's visibility) grouped by offset,
// each group with its elements' versions and the union of their bounds; kept per (offsets, map) while no version moved
function lobbyOffsetGroupsOf(renderer, offsets, elementsMap) {
  const kept = renderer.lobbyOffsetGroups;
  if (kept && kept.offsets === offsets && kept.elementsMap === elementsMap && lobbyOffsetGroupsCurrent(kept)) {
    return kept;
  }
  const byOffset = /* @__PURE__ */ new Map();
  const members = /* @__PURE__ */ new Set();
  const elements = [];
  const versions = [];
  for (const [id, offset] of offsets) {
    const element = elementsMap.get(id);
    if (!element || ${ISTEXT}(element) && ${CONTAINER}(element, elementsMap)) {
      continue;
    }
    const key = offset.x + "," + offset.y;
    let group = byOffset.get(key);
    if (!group) {
      group = { x: offset.x, y: offset.y, union: [Infinity, Infinity, -Infinity, -Infinity] };
      byOffset.set(key, group);
    }
    const b = ${BOUNDS}(element, elementsMap);
    group.union[0] = Math.min(group.union[0], b[0]);
    group.union[1] = Math.min(group.union[1], b[1]);
    group.union[2] = Math.max(group.union[2], b[2]);
    group.union[3] = Math.max(group.union[3], b[3]);
    members.add(element);
    elements.push(element);
    versions.push(element.version);
  }
  const groups = { offsets, elementsMap, list: [...byOffset.values()], members, elements, versions };
  renderer.lobbyOffsetGroups = groups;
  return groups;
}
function lobbyOffsetGroupsCurrent(groups) {
  const { elements, versions } = groups;
  for (let i = 0; i < elements.length; i++) {
    if (elements[i].version !== versions[i]) return false;
  }
  return true;
}
function lobbyOffsetGroupsUnseen(groups, viewport) {
  const z = viewport.zoom.value;
  for (const g of groups.list) {
    const sx = viewport.scrollX + g.x;
    const sy = viewport.scrollY + g.y;
    const x1 = (viewport.offsetLeft - viewport.offsetLeft) / z - sx;
    const y1 = (viewport.offsetTop - viewport.offsetTop) / z - sy;
    const x2 = (viewport.offsetLeft + viewport.width - viewport.offsetLeft) / z - sx;
    const y2 = (viewport.offsetTop + viewport.height - viewport.offsetTop) / z - sy;
    if (!(x1 > g.union[2] || y1 > g.union[3] || x2 < g.union[0] || y2 < g.union[1])) return false;
  }
  return true;
}
`
  append(
    dev,
    helpers({
      BOUNDS: 'getElementBounds4',
      INVIEW: 'isElementInViewportAt',
      ISTEXT: 'isTextElement10',
      CONTAINER: 'getContainerElement3',
      FRAMEID: 'getCommonFrameId',
    }),
  )
  append(prod, helpers({ BOUNDS: 'S5', INVIEW: 'lobbyInViewAt', ISTEXT: 'gU', CONTAINER: 'hU', FRAMEID: 'Ak' }))
}

// ------------------------------------------------------------------------------------------------------------------
// O-2, @excalidraw/element: T, the element snap rounds the same at every scroll
// ------------------------------------------------------------------------------------------------------------------
if (part === 'o2') {
  const dev = file('element', EL_DEV)
  const prod = file('element', EL_PROD)
  // drawElementFromCanvas rounds an element's anchor to whole device pixels. The anchor term carries the scroll, and
  // the context's transform, read back with getTransform, is single precision (scale(1 / 1.25) is kept as
  // 0.800000011920929, so at zoom 0.5 the factor is 0.5000000075): the scroll's share of the term is off by about 1.5e-8
  // times the scroll, past SNAP_TIE_BIAS (1e-6) on any real board. An anchor on an exact half pixel (a row of grid
  // notes at 0.5 x 1.25 dpr) then rounded one way at one scroll and the other way at another: a pixel apart. With the
  // scroll snapped to whole device pixels (snapScrollToDevicePixels), its share is a whole number: added as one, the
  // rest rounded with the tie bias. Anything else (a scroll off the pixel grid, a transform other than the zoom times a
  // right angle) rounds as before.
  edit(
    dev,
    `      Math.round(a2 * anchorX + c * anchorY + e) + Math.round(a2 * dx + c * dy + SNAP_TIE_BIAS),
      Math.round(b2 * anchorX + d * anchorY + f) + Math.round(b2 * dx + d * dy + SNAP_TIE_BIAS)`,
    `      lobbySnapAnchor(a2, c, e, anchorX, anchorY, anchorSceneX, anchorSceneY, positionOffset, anchorPadding, appState, devicePixelRatio) + Math.round(a2 * dx + c * dy + SNAP_TIE_BIAS),
      lobbySnapAnchor(b2, d, f, anchorX, anchorY, anchorSceneX, anchorSceneY, positionOffset, anchorPadding, appState, devicePixelRatio) + Math.round(b2 * dx + d * dy + SNAP_TIE_BIAS) // Lobby patch, wave O T`,
  )
  edit(
    prod,
    'Math.round(b*U+w*D+I)+Math.round(b*B+w*P+nu),Math.round(y*U+S*D+A)+Math.round(y*B+S*P+nu)',
    'lobbySnapAnchor(b,w,I,U,D,N,k,r,z,i,a)+Math.round(b*B+w*P+nu),lobbySnapAnchor(y,S,A,U,D,N,k,r,z,i,a)+Math.round(y*B+S*P+nu)',
  )
  const snap = (BIAS) => `
// ---- Lobby patch (wave O, O-2; patches/@excalidraw__element@0.18.0-1118751.patch) --------------------------------
// T: one coordinate of drawElementFromCanvas's snapped position, p * anchorX + q * anchorY + t rounded, with the
// snapped scroll's share added as the whole number of device pixels it is (see the patch script for why).
function lobbySnapAnchor(p, q, t, anchorX, anchorY, sceneX, sceneY, offset, padding, appState, dpr) {
  const zoom = appState.zoom.value;
  const sx = appState.scrollX * zoom * dpr;
  const sy = appState.scrollY * zoom * dpr;
  const wx = Math.round(sx);
  const wy = Math.round(sy);
  const kx = Math.round(p / zoom);
  const ky = Math.round(q / zoom);
  if (!(zoom > 0) || Math.abs(sx - wx) > 1e-6 || Math.abs(sy - wy) > 1e-6 || Math.abs(p / zoom - kx) > 1e-3 || Math.abs(q / zoom - ky) > 1e-3) {
    return Math.round(p * anchorX + q * anchorY + t + ${BIAS});
  }
  return Math.round(p * ((sceneX + offset.x) * dpr - padding) + q * ((sceneY + offset.y) * dpr - padding) + t + ${BIAS}) + kx * wx + ky * wy;
}
`
  append(dev, snap('SNAP_TIE_BIAS'))
  append(prod, snap('nu'))
}

// ------------------------------------------------------------------------------------------------------------------
// O-2, @excalidraw/excalidraw: B, the pan blit
// ------------------------------------------------------------------------------------------------------------------
if (part === 'o2') {
  const dev = file('excalidraw', 'dist/dev/chunk-FN755BR4.js')
  const prod = file('excalidraw', 'dist/prod/chunk-K5UJM3GG.js')
  const devIndex = file('excalidraw', X_DEV)
  const prodIndex = file('excalidraw', X_PROD)

  // the static render's two callers (the throttled one and the direct one) go through the blit, which calls the
  // engine's own _renderStaticScene, unchanged, for every full render and for the elements a blit draws again
  edit(
    dev,
    `var renderStaticSceneThrottled = throttleRAF(
  (config) => {
    _renderStaticScene(config);
  }
);
var renderStaticScene = (renderConfig, throttle) => {
  if (throttle) {
    renderStaticSceneThrottled(renderConfig);
    return;
  }
  _renderStaticScene(renderConfig);
};`,
    `var renderStaticSceneThrottled = throttleRAF(
  (config) => {
    lobbyRenderStaticScene(config); // Lobby patch (wave O, B): the pan blit decides
  }
);
var renderStaticScene = (renderConfig, throttle) => {
  if (throttle) {
    renderStaticSceneThrottled(renderConfig);
    return;
  }
  lobbyRenderStaticScene(renderConfig);
};`,
  )
  edit(
    prod,
    'Pf=Xf(e=>{It(e)}),mt=(e,U)=>{if(U){Pf(e);return}It(e)};',
    'Pf=Xf(e=>{lobbyRenderStaticScene(e)}),mt=(e,U)=>{if(U){Pf(e);return}lobbyRenderStaticScene(e)};',
  )
  // the switch and the counters, exported by the chunk and the package
  edit(
    dev,
    `  normalizeFile
};
//# sourceMappingURL=chunk-FN755BR4.js.map`,
    `  normalizeFile, lobbySetPanBlit, lobbyGetPanBlitStats, lobbyResetPanBlitStats
};
//# sourceMappingURL=chunk-FN755BR4.js.map`,
  )
  edit(prod, ',sU as ua,Ze as va};', ',sU as ua,Ze as va,lobbySetPanBlit,lobbyGetPanBlitStats,lobbyResetPanBlitStats};')
  edit(
    devIndex,
    `  zoomToFitBounds
} from "./chunk-FN755BR4.js";`,
    `  zoomToFitBounds, lobbySetPanBlit, lobbyGetPanBlitStats, lobbyResetPanBlitStats
} from "./chunk-FN755BR4.js";`,
  )
  edit(
    devIndex,
    `  zoomToFitBounds
};
`,
    `  zoomToFitBounds, lobbySetPanBlit as setPanBlit, lobbyGetPanBlitStats as getPanBlitStats, lobbyResetPanBlitStats as resetPanBlitStats
};
`,
  )
  edit(
    prodIndex,
    'import{A as ra,B as Td,',
    'import{lobbySetPanBlit,lobbyGetPanBlitStats,lobbyResetPanBlitStats,A as ra,B as Td,',
  )
  edit(
    prodIndex,
    ',ai as zoomToFitBounds};',
    ',ai as zoomToFitBounds,lobbySetPanBlit as setPanBlit,lobbyGetPanBlitStats as getPanBlitStats,lobbyResetPanBlitStats as resetPanBlitStats};',
  )
  // StaticCanvas hands the canvas nonce to the render (the blit's key: a scene.triggerUpdate, an image or a font
  // arriving, changes nothing else)
  edit(
    devIndex,
    `        appState: props.appState,
        renderConfig: props.renderConfig
      },
      isRenderThrottlingEnabled()`,
    `        appState: props.appState,
        renderConfig: props.renderConfig, canvasNonce: props.canvasNonce
      },
      isRenderThrottlingEnabled()`,
  )
  edit(
    prodIndex,
    'appState:e.appState,renderConfig:e.renderConfig},ps())',
    'appState:e.appState,renderConfig:e.renderConfig,canvasNonce:e.canvasNonce},ps())',
  )

  const blit = ({ R, SNAP, BOUNDS, LABEL, ISTEXT }) => `
// ---- Lobby patch (wave O, O-2; patches/@excalidraw__excalidraw@0.18.0-1118751.patch): the pan blit ---------------
// A render whose inputs other than the scroll are the ones of this canvas's last render, and whose scroll moved by
// whole device pixels (snapScrollToDevicePixels makes it so), keeps the last frame shifted by the move and draws again
// only four bands at the canvas's edges: the exposed strips, widened to hold the ink of every element whose visibility
// changed (one that came into view drew nothing in the shifted pixels, one that left view drew into them). The bands are
// drawn by the engine's own full render of the elements whose ink reaches into them (so, there, exactly as a full render
// draws: no clip of ours), then everything else is the shifted frame again, copied back from a scratch canvas through
// a pixel-aligned rectangle. The shifted pixels are a full render's because every element and the grid land on the same
// device pixels at every snapped scroll (element patch T rounds the element snap the same at every scroll).
// The inputs: the StaticCanvas memo's own (areEqual: the canvas nonce, the scale, the renderable map, the app state it
// compares, every renderConfig value) and the canvas's size, the rough canvas, the scene map, the in-place caches'
// sizes. Any other render is a full one: an export, a drag, a zoom, a change of any input, a move of a third of the
// canvas or more, bands over 60 % of it. A render at rest (LOBBY_PAN_BLIT_REST_MS after the last blit) is a full one, and
// so is the first render after the canvas loses its context. Off unless Lobby turns it on (setPanBlit).
var lobbyPanBlitOn = false;
var LOBBY_PAN_BLIT_REST_MS = 120;
var lobbyPanBlitStates = /* @__PURE__ */ new WeakMap();
var lobbyPanBlitLast = /* @__PURE__ */ new WeakMap();
var lobbyPanBlitScratch = /* @__PURE__ */ new WeakMap();
var lobbyPanBlitHooked = /* @__PURE__ */ new WeakSet();
var lobbyPanBlitCounts = { full: 0, blit: 0, rest: 0, lost: 0, elements: 0, area: 0, last: "" };
function lobbySetPanBlit(on) {
  lobbyPanBlitOn = on === true;
}
function lobbyGetPanBlitStats() {
  return { on: lobbyPanBlitOn, ...lobbyPanBlitCounts };
}
function lobbyResetPanBlitStats() {
  lobbyPanBlitCounts = { full: 0, blit: 0, rest: 0, lost: 0, elements: 0, area: 0, last: "" };
}
function lobbyPanBlitKey(config) {
  const a = config.appState;
  const r = config.renderConfig;
  const key = [
    config.canvasNonce, config.scale, config.rc, config.elementsMap, config.allElementsMap, config.canvas.width,
    config.canvas.height, a.zoom.value, a.width, a.height, a.offsetLeft, a.offsetTop, a.theme, a.viewBackgroundColor,
    a.viewModeEnabled, a.openDialog, a.hoveredElementIds, a.shouldCacheIgnoreZoom, a.exportScale,
    a.selectedElementsAreBeingDragged, a.gridSize, a.gridStep, a.frameRendering, a.selectedElementIds,
    a.frameToHighlight, a.editingGroupId, a.currentHoveredFontFamily, a.croppingElementId, a.suggestedBinding,
    a.editingTextElement, a.newElement, a.activeEmbeddable, r.imageCache?.size, r.embedsValidationStatus?.size,
    r.elementsPendingErasure?.size
  ];
  for (const k in r) key.push(k, r[k]);
  return key;
}
function lobbySameKey(p, q) {
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}
// getCanvasPadding (element package): the margin of an element's cached canvas, all it can draw into beyond its box
function lobbyCanvasPadding(el) {
  switch (el.type) {
    case "freedraw":
      return el.strokeWidth * 12;
    case "text":
      return el.fontSize / 2;
    case "arrow":
      return el.endArrowhead || el.endArrowhead ? 40 : 20;
    default:
      return 20;
  }
}
// where an element can put ink, in scene px: its bounds, the margin of its cached canvas (a square margin, so up to
// sqrt 2 of it rotated; a frame draws its outline itself, 1 / zoom outside), its link icon, two device px of snap and
// anti-aliasing
function lobbyInkMargin(el, zoom, dpr) {
  let m = el.type === "frame" || el.type === "magicframe" ? 1 / zoom : lobbyCanvasPadding(el) / dpr * (el.angle ? Math.SQRT2 : 1);
  if (el.link) m += 40 / Math.max(1, zoom);
  return m + 2 / (zoom * dpr);
}
// an element's ink box with its bound text's (drawn with it), at its render offset; kept per canvas while the key holds
function lobbyInkOf(el, config, zoom, dpr, ink) {
  let box = ink.get(el);
  if (box) return box;
  const map = config.elementsMap;
  const b = ${BOUNDS}(el, map);
  const m = lobbyInkMargin(el, zoom, dpr);
  box = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  const label = ${LABEL}(el, map);
  if (label) {
    const t = ${BOUNDS}(label, map);
    const tm = lobbyInkMargin(label, zoom, dpr);
    box[0] = Math.min(box[0], t[0] - tm);
    box[1] = Math.min(box[1], t[1] - tm);
    box[2] = Math.max(box[2], t[2] + tm);
    box[3] = Math.max(box[3], t[3] + tm);
  }
  const owner = ${ISTEXT}(el) && el.containerId ? config.allElementsMap.get(el.containerId) ?? el : el;
  const offset = config.renderConfig.elementRenderOverrides?.get(owner.id)?.offset;
  if (offset && (offset.x || offset.y)) {
    box[0] += offset.x;
    box[1] += offset.y;
    box[2] += offset.x;
    box[3] += offset.y;
  }
  ink.set(el, box);
  return box;
}
// the render loop draws a bound text with its container, not by itself
function lobbyDrawnAlone(el, elementsMap) {
  return !(${ISTEXT}(el) && el.containerId && elementsMap.has(el.containerId));
}
function lobbyPanBlitDrop(canvas) {
  const s = lobbyPanBlitStates.get(canvas);
  if (s?.rest) clearTimeout(s.rest);
  lobbyPanBlitStates.delete(canvas);
}
function lobbyPanBlitHook(canvas) {
  if (lobbyPanBlitHooked.has(canvas)) return;
  lobbyPanBlitHooked.add(canvas);
  canvas.addEventListener("contextlost", () => {
    lobbyPanBlitDrop(canvas);
    lobbyPanBlitScratch.delete(canvas);
    lobbyPanBlitCounts.lost++;
  });
  canvas.addEventListener("contextrestored", () => {
    lobbyPanBlitDrop(canvas);
    const last = lobbyPanBlitLast.get(canvas);
    if (last && lobbyPanBlitOn) ${R}(last);
  });
}
// the canvas's scratch copy (the shifted frame waits there while the bands are drawn), the canvas's size
function lobbyPanBlitScratchOf(canvas) {
  let s = lobbyPanBlitScratch.get(canvas);
  if (!s) {
    s = canvas.ownerDocument.createElement("canvas");
    lobbyPanBlitScratch.set(canvas, s);
  }
  if (s.width !== canvas.width) s.width = canvas.width;
  if (s.height !== canvas.height) s.height = canvas.height;
  return s;
}
function lobbyPanBlitFull(canvas, config, appState, key, ink) {
  ${R}(config);
  lobbyPanBlitStates.set(canvas, {
    key,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    visible: config.visibleElements,
    visibleSet: null,
    ink: ink ?? /* @__PURE__ */ new WeakMap(),
    rest: 0
  });
  lobbyPanBlitCounts.full++;
  lobbyPanBlitCounts.last = "full";
}
function lobbyRenderStaticScene(config) {
  const canvas = config.canvas;
  if (!canvas || !lobbyPanBlitOn || config.renderConfig.isExporting) {
    if (canvas) {
      lobbyPanBlitDrop(canvas);
      lobbyPanBlitLast.delete(canvas);
      lobbyPanBlitScratch.delete(canvas);
    }
    ${R}(config);
    return;
  }
  lobbyPanBlitHook(canvas);
  lobbyPanBlitLast.set(canvas, config);
  const state = lobbyPanBlitStates.get(canvas);
  if (state?.rest) {
    clearTimeout(state.rest);
    state.rest = 0;
  }
  const appState = ${SNAP}(config.appState, config.scale);
  const key = lobbyPanBlitKey(config);
  const same = !!state && lobbySameKey(state.key, key);
  const zoom = appState.zoom.value;
  const dpr = config.scale;
  const k = zoom * dpr;
  const W = canvas.width;
  const H = canvas.height;
  let dx = 0;
  let dy = 0;
  let blit = false;
  if (same && !appState.selectedElementsAreBeingDragged) {
    const fx = (appState.scrollX - state.scrollX) * k;
    const fy = (appState.scrollY - state.scrollY) * k;
    dx = Math.round(fx);
    dy = Math.round(fy);
    blit = (dx !== 0 || dy !== 0) && Math.abs(fx - dx) < 1e-3 && Math.abs(fy - dy) < 1e-3 && Math.abs(dx) * 3 < W && Math.abs(dy) * 3 < H;
  }
  if (!blit) {
    lobbyPanBlitFull(canvas, config, appState, key, same ? state.ink : null);
    return;
  }
  // the bands, in device px: the exposed strips, then the cheapest band that holds the ink of each element whose
  // visibility changed (its ink lies within its margin of the strips or of the canvas's edges)
  let L = dx > 0 ? dx : 0;
  let Rt = dx < 0 ? -dx : 0;
  let T = dy > 0 ? dy : 0;
  let B = dy < 0 ? -dy : 0;
  const map = config.elementsMap;
  const visible = config.visibleElements;
  const oldSet = state.visibleSet ?? new Set(state.visible);
  const newSet = new Set(visible);
  const cover = (el) => {
    const box = lobbyInkOf(el, config, zoom, dpr, state.ink);
    const x1 = Math.floor((box[0] + appState.scrollX) * k);
    const y1 = Math.floor((box[1] + appState.scrollY) * k);
    const x2 = Math.ceil((box[2] + appState.scrollX) * k);
    const y2 = Math.ceil((box[3] + appState.scrollY) * k);
    if (x2 <= 0 || y2 <= 0 || x1 >= W || y1 >= H) return;
    const l = x2 * H;
    const r = (W - x1) * H;
    const t = y2 * W;
    const b = (H - y1) * W;
    const min = Math.min(l, r, t, b);
    if (min === l) L = Math.max(L, x2);
    else if (min === r) Rt = Math.max(Rt, W - x1);
    else if (min === t) T = Math.max(T, y2);
    else B = Math.max(B, H - y1);
  };
  for (const el of visible) if (!oldSet.has(el) && lobbyDrawnAlone(el, map)) cover(el);
  for (const el of state.visible) if (!newSet.has(el) && lobbyDrawnAlone(el, map)) cover(el);
  L = Math.min(L, W);
  Rt = Math.min(Rt, W);
  T = Math.min(T, H);
  B = Math.min(B, H);
  const area = (L + Rt) * H + (T + B) * W;
  if (area > W * H * 0.6 || L + Rt >= W || T + B >= H) {
    lobbyPanBlitFull(canvas, config, appState, key, state.ink);
    return;
  }
  // the previous frame, shifted, into the scratch copy ("copy": what the shift leaves is cleared)
  const scratch = lobbyPanBlitScratchOf(canvas);
  const sctx = scratch.getContext("2d");
  sctx.save();
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = "copy";
  sctx.drawImage(canvas, dx, dy);
  sctx.restore();
  // in scene px: every visible element whose ink box reaches into a band, drawn by the engine's full render
  const sxL = L / k - appState.scrollX;
  const sxR = (W - Rt) / k - appState.scrollX;
  const syT = T / k - appState.scrollY;
  const syB = (H - B) / k - appState.scrollY;
  const members = [];
  for (const el of visible) {
    if (!lobbyDrawnAlone(el, map)) continue;
    const box = lobbyInkOf(el, config, zoom, dpr, state.ink);
    if (L && box[0] < sxL || Rt && box[2] > sxR || T && box[1] < syT || B && box[3] > syB) members.push(el);
  }
  ${R}({ ...config, visibleElements: members });
  // everywhere but the bands: the shifted frame, copied back through a pixel-aligned rectangle
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(L, T, W - L - Rt, H - T - B);
  ctx.clip();
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
  state.scrollX = appState.scrollX;
  state.scrollY = appState.scrollY;
  state.visible = visible;
  state.visibleSet = newSet;
  lobbyPanBlitCounts.blit++;
  lobbyPanBlitCounts.elements += members.length;
  lobbyPanBlitCounts.area += area;
  lobbyPanBlitCounts.last = "blit";
  state.rest = setTimeout(() => {
    if (lobbyPanBlitStates.get(canvas) !== state || !lobbyPanBlitOn) return;
    state.rest = 0;
    const last = lobbyPanBlitLast.get(canvas);
    if (!last) return;
    ${R}(last);
    lobbyPanBlitCounts.rest++;
    lobbyPanBlitCounts.last = "rest";
  }, LOBBY_PAN_BLIT_REST_MS);
}
`
  append(dev, blit({ R: '_renderStaticScene', SNAP: 'snapScrollToDevicePixels', BOUNDS: 'getElementBounds', LABEL: 'getBoundTextElement', ISTEXT: 'isTextElement2' }))
  append(prod, blit({ R: 'It', SNAP: 'lt', BOUNDS: '$U', LABEL: 'Bf', ISTEXT: 'vf' }))

  // the declarations
  const types = file('excalidraw', 'dist/types/excalidraw/renderer/staticScene.d.ts')
  if (types)
    types.src += `/** Lobby patch (wave O, O-2): the pan blit's switch (off by default): a pure pan keeps the last frame shifted. */
export declare const setPanBlit: (on: boolean) => void;
/** Lobby patch (wave O, O-2): the pan blit's counters since the last reset (renders by kind, region area in px). */
export declare const getPanBlitStats: () => {
    on: boolean;
    full: number;
    blit: number;
    rest: number;
    lost: number;
    elements: number;
    area: number;
    last: string;
};
export declare const resetPanBlitStats: () => void;
`
  const index = file('excalidraw', 'dist/types/excalidraw/index.d.ts')
  if (index) index.src += 'export { setPanBlit, getPanBlitStats, resetPanBlitStats } from "./renderer/staticScene";\n'
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
