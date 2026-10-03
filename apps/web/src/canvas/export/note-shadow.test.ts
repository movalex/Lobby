// W5-37 (CR 3E-7): notes in a bitmap export take a soft shadow, on the export's own canvas only. The patch of
// the 2D context against fake contexts (no DOM here); the pixel check is e2e/excalidraw/c3-polish.spec.ts.
import { describe, expect, it } from 'vitest'
import {
  createSoftNoteShadows,
  EDGE_LINE_WIDTH,
  EDGE_STROKE,
  HARD_SHADOW_FILL,
  SOFT_SHADOW,
} from './note-shadow.ts'
import { exportFrameRendering } from './plan.ts'

interface FakeCtx {
  canvas: object
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  getTransform(): { a: number; b: number; c: number; d: number }
  save(): void
  restore(): void
}

/** What the engine does for one note (index.js `drawElementOnCanvas`), as the calls a context receives. */
function drawNote(
  ctx: FakeCtx,
  fill: (this: FakeCtx) => void,
  stroke: (this: FakeCtx) => void,
  body = '#ffec99',
) {
  ctx.save()
  ctx.fillStyle = HARD_SHADOW_FILL
  fill.call(ctx) // the hard shadow
  ctx.fillStyle = body
  fill.call(ctx) // the note
  ctx.strokeStyle = EDGE_STROKE
  ctx.lineWidth = EDGE_LINE_WIDTH
  stroke.call(ctx) // the 1 px edge
  ctx.restore()
}

function world(transform = { a: 1, b: 0, c: 0, d: 1 }) {
  const calls: { op: 'fill' | 'stroke'; style: string; shadowBlur: number; offset: [number, number] }[] = []
  const created: object[] = []
  const makeCtx = (canvas: object): FakeCtx => {
    const stack: Partial<FakeCtx>[] = []
    const ctx: FakeCtx = {
      canvas,
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      shadowColor: 'rgba(0, 0, 0, 0)',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      getTransform: () => transform,
      save() {
        stack.push({
          shadowColor: ctx.shadowColor,
          shadowBlur: ctx.shadowBlur,
          shadowOffsetX: ctx.shadowOffsetX,
          shadowOffsetY: ctx.shadowOffsetY,
          fillStyle: ctx.fillStyle,
          strokeStyle: ctx.strokeStyle,
        })
      },
      restore() {
        Object.assign(ctx, stack.pop())
      },
    }
    return ctx
  }
  const context2d = {
    fill(this: FakeCtx) {
      calls.push({
        op: 'fill',
        style: this.fillStyle,
        shadowBlur: this.shadowBlur,
        offset: [this.shadowOffsetX, this.shadowOffsetY],
      })
    },
    stroke(this: FakeCtx) {
      calls.push({ op: 'stroke', style: this.strokeStyle, shadowBlur: this.shadowBlur, offset: [0, 0] })
    },
  }
  const originalFill = context2d.fill
  const originalStroke = context2d.stroke
  const document = {
    createElement(_tag: string) {
      const el = {}
      created.push(el)
      return el
    },
  }
  const originalCreate = document.createElement
  const shadows = createSoftNoteShadows({ document, context2d: context2d as never })
  return {
    shadows,
    calls,
    created,
    context2d,
    document,
    makeCtx,
    originalFill,
    originalStroke,
    originalCreate,
  }
}

describe('soft note shadows in a bitmap export (W5-37)', () => {
  it('on the export’s canvas the hard shadow and the edge are not drawn, and the note carries a soft shadow', () => {
    const w = world()
    w.shadows.begin()
    const canvas = w.document.createElement('canvas')
    w.shadows.markExportCanvas() // exportToCanvas asks getDimensions right after making its canvas
    drawNote(w.makeCtx(canvas), w.context2d.fill, w.context2d.stroke)
    w.shadows.end()
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]).toMatchObject({ op: 'fill', style: '#ffec99' })
    expect(w.calls[0]?.shadowBlur).toBe(SOFT_SHADOW.blur)
    expect(w.calls[0]?.offset).toEqual([0, SOFT_SHADOW.dy])
  })

  it('scales the shadow with the export and turns it with a rotated note', () => {
    const scaled = world({ a: 2, b: 0, c: 0, d: 2 })
    scaled.shadows.begin()
    const canvas = scaled.document.createElement('canvas')
    scaled.shadows.markExportCanvas()
    drawNote(scaled.makeCtx(canvas), scaled.context2d.fill, scaled.context2d.stroke)
    scaled.shadows.end()
    expect(scaled.calls[0]?.shadowBlur).toBe(SOFT_SHADOW.blur * 2)
    expect(scaled.calls[0]?.offset).toEqual([0, SOFT_SHADOW.dy * 2])

    // 90 degrees: "down" in the note's own frame is to the left of the page (the transform's c, d)
    const turned = world({ a: 0, b: 1, c: -1, d: 0 })
    turned.shadows.begin()
    const canvas2 = turned.document.createElement('canvas')
    turned.shadows.markExportCanvas()
    drawNote(turned.makeCtx(canvas2), turned.context2d.fill, turned.context2d.stroke)
    turned.shadows.end()
    expect(turned.calls[0]?.offset).toEqual([-SOFT_SHADOW.dy, 0])
  })

  it('leaves every other canvas alone: the live board, the engine’s caches', () => {
    const w = world()
    w.shadows.begin()
    const live = w.document.createElement('canvas') // made during the export, but not asked about
    const exportCanvas = w.document.createElement('canvas')
    w.shadows.markExportCanvas()
    drawNote(w.makeCtx(live), w.context2d.fill, w.context2d.stroke)
    w.shadows.end()
    // all three calls of the hard look reached the original methods unchanged
    expect(w.calls.map((c) => [c.op, c.style])).toEqual([
      ['fill', HARD_SHADOW_FILL],
      ['fill', '#ffec99'],
      ['stroke', EDGE_STROKE],
    ])
    expect(w.calls.every((c) => c.shadowBlur === 0)).toBe(true)
    expect(exportCanvas).not.toBe(live)
  })

  it('only changes the engine’s own calls: other fills and strokes on the export canvas pass through', () => {
    const w = world()
    w.shadows.begin()
    const canvas = w.document.createElement('canvas')
    w.shadows.markExportCanvas()
    const ctx = w.makeCtx(canvas)
    ctx.fillStyle = '#1971c2'
    w.context2d.fill.call(ctx)
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 2
    w.context2d.stroke.call(ctx)
    ctx.strokeStyle = EDGE_STROKE
    ctx.lineWidth = 3 // not the edge's width
    w.context2d.stroke.call(ctx)
    w.shadows.end()
    expect(w.calls.map((c) => c.op)).toEqual(['fill', 'stroke', 'stroke'])
    expect(w.calls.every((c) => c.shadowBlur === 0)).toBe(true)
  })

  it('puts everything back when the export is over, and nests', () => {
    const w = world()
    w.shadows.begin()
    w.shadows.begin()
    expect(w.context2d.fill).not.toBe(w.originalFill)
    w.shadows.end()
    expect(w.context2d.fill).not.toBe(w.originalFill) // the outer export still runs
    w.shadows.end()
    expect(w.context2d.fill).toBe(w.originalFill)
    expect(w.context2d.stroke).toBe(w.originalStroke)
    expect(w.document.createElement).toBe(w.originalCreate)
    // after it, even a marked canvas of an earlier export takes nothing
    const canvas = w.document.createElement('canvas')
    w.shadows.markExportCanvas()
    drawNote(w.makeCtx(canvas), w.context2d.fill, w.context2d.stroke)
    expect(w.calls).toHaveLength(3)
    // an `end` without a `begin` does nothing
    w.shadows.end()
  })

  it('does not take a canvas it was not told about, whatever its size, and ignores other element types', () => {
    const w = world()
    w.shadows.begin()
    w.document.createElement('div')
    w.shadows.markExportCanvas() // the last CANVAS made is none yet: nothing to mark
    const canvas = w.document.createElement('canvas')
    drawNote(w.makeCtx(canvas), w.context2d.fill, w.context2d.stroke)
    w.shadows.end()
    expect(w.calls).toHaveLength(3)
  })
})

describe('frame names in an export (W5-37, CR 3E-6)', () => {
  it('stay on by default and off when the board page has them off (focus mode)', () => {
    expect(exportFrameRendering(undefined)).toEqual({ enabled: true, clip: true, outline: true, name: true })
    expect(exportFrameRendering({ name: true }).name).toBe(true)
    expect(exportFrameRendering({ name: false })).toEqual({
      enabled: true,
      clip: true,
      outline: true,
      name: false,
    })
    expect(exportFrameRendering(null).name).toBe(true)
  })
})
