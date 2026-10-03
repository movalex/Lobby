// W5-37, the bitmap half (CR 3E-7): sticky notes in a PNG, a PDF page or a copy get the soft shadow the SVG
// export already has, and no outline, instead of the engine's hard one.
//
// Why a patch of the 2D context: the engine draws a note on a canvas as three calls
// (@excalidraw/element dist/dev/index.js `drawElementOnCanvas`, `case "stickynote"`): a fill of the note's path
// offset by STICKY_NOTE_SHADOW_OFFSET in `rgba(0, 0, 0, 0.16)` (the hard shadow), a fill of the note itself, and
// a clipped 1 px stroke in `rgba(0, 0, 0, 0.08)` (the edge). Those colours are constants of the engine, not
// element fields, and `exportToCanvas` builds and fills its own canvas inside, so there is no seam in the
// scene prep to draw the note differently (replacing the element would drop the note's own paths and its date
// footer). What can be changed is how those calls land on THE EXPORT'S canvas, and only there:
//   - the hard shadow's fill is not drawn;
//   - the note's own fill, which follows it at once, is drawn with a canvas shadow (offset down in the note's
//     own frame, blurred), so it sits under the note, over whatever the scene has painted below it, in paint
//     order;
//   - the edge's stroke is not drawn.
// The patch is on for the length of one export, on the 2D context's prototype, and acts only on canvases the
// export itself created: `exportToCanvas` makes its canvas and asks `getDimensions` for its size in the same
// breath, so `document.createElement` (wrapped for the same length) remembers the last canvas made, and
// `markExportCanvas` (called from `getDimensions`) adds it to the set the patch looks at. The live board, the
// engine's own element caches and any other canvas never take a changed call. If the engine changes how it
// draws notes, nothing here matches and the export falls back to its hard shadow (the SVG half,
// canvas/api/parts/export-svg-notes.ts, is a string pass with the same fallback).
//
// The look is tldraw's note export shadow (NoteShapeUtil.toSvg, two eroded, blurred, offset copies of the
// note's alpha) approximated with ONE canvas shadow: a 2D canvas cannot erode a path, and a second fill would
// draw a translucent note twice. Constants below; the pixel check is e2e/excalidraw/c3-polish.spec.ts.

/** The engine's hard shadow fill and edge stroke (@excalidraw/common STICKY_NOTE_SHADOW_OPACITY, STICKY_NOTE_EDGE_SHADOW_*). */
export const HARD_SHADOW_FILL = 'rgba(0, 0, 0, 0.16)'
export const EDGE_STROKE = 'rgba(0, 0, 0, 0.08)'
export const EDGE_LINE_WIDTH = 1

/** The soft shadow, in the note's own units (scaled with the export): blur, offset down, colour. */
export const SOFT_SHADOW = { blur: 9, dy: 4, color: 'rgba(0, 0, 0, 0.34)' } as const

interface Ctx2D {
  readonly canvas: object
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  getTransform(): { a: number; b: number; c: number; d: number }
  save(): void
  restore(): void
}

type Method = (this: Ctx2D, ...args: unknown[]) => unknown

/** What the patch needs from the page (`globalThis` in the browser; fakes in the unit test). */
export interface ShadowEnv {
  readonly document: { createElement: (tag: string, ...rest: never[]) => object }
  readonly context2d: { fill: Method; stroke: Method }
}

export interface SoftNoteShadows {
  /** Starts patching (nests: the patch is removed when the last `begin` has been `end`ed). */
  begin(): void
  end(): void
  /** Marks the canvas created last as an export canvas: only those take the soft shadow. */
  markExportCanvas(): void
}

/** The patch over `env`; one per page (see `softNoteShadows`). */
export function createSoftNoteShadows(env: ShadowEnv): SoftNoteShadows {
  let depth = 0
  let lastCanvas: object | null = null
  let undo: (() => void) | null = null
  const exportCanvases = new WeakSet<object>()
  /** contexts whose hard shadow was just skipped: their next fill is the note's own */
  const awaitingBody = new WeakSet<object>()

  const install = () => {
    const { document, context2d } = env
    const hadOwnCreate = Object.hasOwn(document, 'createElement')
    const originalCreate = document.createElement
    const originalFill = context2d.fill
    const originalStroke = context2d.stroke
    document.createElement = function (this: unknown, tag: string, ...rest: never[]) {
      const el = originalCreate.call(this, tag, ...rest)
      if (typeof tag === 'string' && tag.toLowerCase() === 'canvas') lastCanvas = el
      return el
    } as typeof originalCreate
    context2d.fill = function (this: Ctx2D, ...args: unknown[]) {
      if (!exportCanvases.has(this.canvas)) return originalFill.apply(this, args)
      if (this.fillStyle === HARD_SHADOW_FILL) {
        awaitingBody.add(this)
        return undefined
      }
      if (awaitingBody.delete(this)) {
        const m = this.getTransform()
        const scale = Math.hypot(m.a, m.b) || 1
        this.save()
        this.shadowColor = SOFT_SHADOW.color
        this.shadowBlur = SOFT_SHADOW.blur * scale
        // "down" in the note's own frame, through the transform (a rotated note's shadow rotates with it)
        this.shadowOffsetX = m.c * SOFT_SHADOW.dy
        this.shadowOffsetY = m.d * SOFT_SHADOW.dy
        try {
          return originalFill.apply(this, args)
        } finally {
          this.restore()
        }
      }
      return originalFill.apply(this, args)
    }
    context2d.stroke = function (this: Ctx2D, ...args: unknown[]) {
      if (
        exportCanvases.has(this.canvas) &&
        this.strokeStyle === EDGE_STROKE &&
        this.lineWidth === EDGE_LINE_WIDTH
      )
        return undefined
      return originalStroke.apply(this, args)
    }
    undo = () => {
      if (hadOwnCreate) document.createElement = originalCreate
      else delete (document as { createElement?: unknown }).createElement
      context2d.fill = originalFill
      context2d.stroke = originalStroke
      lastCanvas = null
    }
  }

  return {
    begin() {
      if (depth++ === 0) install()
    },
    end() {
      if (depth > 0 && --depth === 0) {
        undo?.()
        undo = null
      }
    },
    markExportCanvas() {
      if (depth > 0 && lastCanvas) exportCanvases.add(lastCanvas)
    },
  }
}

let page: SoftNoteShadows | null = null

/** The page's patch (browser only: needs `document` and `CanvasRenderingContext2D`). */
export function softNoteShadows(): SoftNoteShadows {
  page ??= createSoftNoteShadows({
    document: globalThis.document as unknown as ShadowEnv['document'],
    context2d: CanvasRenderingContext2D.prototype as unknown as ShadowEnv['context2d'],
  })
  return page
}
