// Adversarial review: templates composed with each other and with @draftroom/board-ops.

import {
  exportBoardArchive,
  frameOutline,
  importBoardArchive,
  presentationOrder,
  remapIds,
} from '@draftroom/board-ops'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLPageId, TLRecord } from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'
import { describe, expect, it } from 'vitest'
import { instantiateTemplate, TEMPLATES } from './index.ts'
import { bindingsOf, byId, framesOf, PAGE, shapesOf } from './test-utils.ts'

function validateAll(records: readonly TLRecord[]): void {
  for (const r of records) {
    const type = r.typeName === 'shape' ? draftroomSchema.types.shape : draftroomSchema.types.binding
    type.validate(r)
  }
}

const topIndex = (records: readonly TLRecord[], pageId: string): IndexKey =>
  shapesOf(records)
    .filter((s) => s.parentId === pageId)
    .map((s) => s.index)
    .sort()
    .at(-1) as IndexKey

describe.each(TEMPLATES.map((t) => [t.id, t] as const))('%s composed twice', (id, def) => {
  const first = instantiateTemplate(id, { pageId: PAGE, origin: { x: 0, y: 0 } })
  // Second copy directly below the first, stacked above it in z-order.
  const second = instantiateTemplate(id, {
    pageId: PAGE,
    origin: { x: 0, y: first.bounds.h + 400 },
    indexAbove: topIndex(first.records, PAGE),
  })
  const both = [...first.records, ...second.records]

  it('shares no ids and keeps each copy bound to its own shapes', () => {
    const ids = both.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    validateAll(both)
    const secondShapes = new Set(shapesOf(second.records).map((s) => s.id as string))
    for (const b of bindingsOf(second.records)) {
      expect(secondShapes.has(b.fromId)).toBe(true)
      expect(secondShapes.has(b.toId)).toBe(true)
    }
  })

  it('stacks the second copy above the first with unique page-level index keys', () => {
    const pageKeys = shapesOf(both)
      .filter((s) => s.parentId === PAGE)
      .map((s) => s.index)
    expect(new Set(pageKeys).size).toBe(pageKeys.length)
    const firstTop = topIndex(first.records, PAGE)
    for (const s of shapesOf(second.records).filter((x) => x.parentId === PAGE)) {
      expect(s.index > firstTop).toBe(true)
    }
  })

  it('reads as the sections twice, first copy then second, through frameOutline and presentationOrder', () => {
    const outline = frameOutline(both, PAGE).map((e) => e.name)
    expect(outline).toEqual([...def.sections, ...def.sections])
    const slides = presentationOrder(both, PAGE)
    expect(slides.map((e) => e.name)).toEqual([...def.sections, ...def.sections])
    const firstFrames = new Set(framesOf(first.records).map((f) => f.id as string))
    expect(slides.slice(0, def.sections.length).every((e) => firstFrames.has(e.id))).toBe(true)
  })

  it('keeps the section order at far-away origins', () => {
    const far = instantiateTemplate(id, { pageId: PAGE, origin: { x: -1e9, y: 1e9 } })
    expect(frameOutline(far.records, PAGE).map((e) => e.name)).toEqual([...def.sections])
  })

  it('duplicates through remapIds and survives an archive round trip without losing bindings', () => {
    const target = 'page:copy' as TLPageId
    const dup = remapIds(first.records, { targetPageId: target, offset: { x: 5000, y: 0 } })
    validateAll(dup.records)
    expect(dup.records).toHaveLength(first.records.length)
    expect(frameOutline(dup.records, target).map((e) => e.name)).toEqual([...def.sections])

    const archive = JSON.parse(
      JSON.stringify(exportBoardArchive(first.records, draftroomSchema.serialize(), [])),
    )
    const imported = importBoardArchive(archive, { targetPageId: target })
    expect(imported.warnings).toEqual([])
    expect(bindingsOf(imported.records)).toHaveLength(bindingsOf(first.records).length)
    const shapes = byId(imported.records)
    for (const b of bindingsOf(imported.records)) {
      expect(shapes.get(b.fromId)?.type).toBe('arrow')
      expect(shapes.get(b.toId)).toBeDefined()
    }
    expect(frameOutline(imported.records, target).map((e) => e.name)).toEqual([...def.sections])
  })
})
