import { describe, expect, it } from 'vitest'
import { hashElements } from '../../packages/canvas-schema/src/hash.ts'
import { FILE_ID_PATTERN } from '../../packages/canvas-schema/src/limits.ts'
import { generateBoard, genFileId, heavyBoard, l1Board, smallBoard } from './boards.ts'

describe('generated boards', () => {
  it('the heavy board matches spike A14 (20 frames, 4,500 notes with labels, 200 images)', () => {
    const b = heavyBoard('heavy-1')
    const count = (t: string) => b.elements.filter((e) => e.type === t).length
    expect(count('stickynote')).toBe(4_500)
    expect(count('text')).toBe(4_500)
    expect(count('image')).toBe(200)
    expect(count('frame')).toBe(20)
    expect(b.elements).toHaveLength(9_220)
    expect(b.files).toHaveLength(200)
    expect(b.frame0Notes).toHaveLength(225)
    for (const f of b.files) expect(f).toMatch(FILE_ID_PATTERN)
  })

  it('L1 has about 2k objects with one bound arrow per ten notes, a fifth of them elbow', () => {
    const b = l1Board('l1-main')
    const arrows = b.elements.filter((e) => e.type === 'arrow')
    expect(arrows).toHaveLength(180)
    expect(arrows.filter((a) => (a as { elbowed: boolean }).elbowed)).toHaveLength(36)
    const objects = b.elements.filter((e) => e.type !== 'text').length
    expect(objects).toBeGreaterThanOrEqual(1_950)
    expect(objects).toBeLessThanOrEqual(2_050)
    expect(b.elements.length).toBeGreaterThanOrEqual(3_700)
  })

  it('ids are unique, labels sort after their note, bindings are symmetric', () => {
    const b = l1Board('l1-x')
    const ids = b.elements.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const pos = new Map(b.elements.map((e, i) => [e.id, i]))
    const byId = new Map(b.elements.map((e) => [e.id, e as Record<string, unknown>]))
    for (const e of b.elements) {
      if (e.type === 'text' && e.containerId)
        expect(pos.get(e.id) as number).toBeGreaterThan(pos.get(e.containerId) as number)
      if (e.type === 'arrow') {
        for (const end of [e.startBinding, e.endBinding]) {
          const t = byId.get(end?.elementId ?? '') as { boundElements: { id: string }[] }
          expect(t.boundElements.some((r) => r.id === e.id)).toBe(true)
        }
      }
    }
    const keys = b.elements.map((e) => e.index as string)
    expect([...keys].sort()).toEqual(keys) // paint order = index order
  })

  it('is deterministic, and tombstones are added on request', async () => {
    const a = smallBoard('s-1', 3)
    const b = smallBoard('s-1', 3)
    expect(await hashElements(a.elements)).toBe(await hashElements(b.elements))
    const d = generateBoard({
      id: 'd-1',
      kind: 'custom',
      frames: 1,
      notes: 10,
      images: 0,
      arrows: 0,
      deleted: 25,
    })
    expect(d.elements.filter((e) => e.isDeleted)).toHaveLength(25)
    expect(genFileId('heavy-1', 7)).toMatch(FILE_ID_PATTERN)
  })
})
