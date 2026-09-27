import { describe, expect, it } from 'vitest'
import { filterTemplates, previewFromRecords, templateCatalog } from './template-catalog.ts'
import { newBoardPath, TEMPLATE_IDS } from './template-paths.ts'

describe('template picker catalog (PRE-01)', () => {
  const catalog = templateCatalog()

  it('lists the six @draftroom/templates with names, one-sentence descriptions, categories and sections', () => {
    expect(catalog.map((e) => e.id)).toEqual([...TEMPLATE_IDS])
    for (const e of catalog) {
      expect(e.name.length).toBeGreaterThan(2)
      expect(e.description).toMatch(/\.$/)
      expect(['ideate', 'visual', 'plan', 'review']).toContain(e.category)
      expect(e.sections.length).toBeGreaterThan(0)
    }
  })

  it('builds each preview from the frames the template really creates (one per section)', () => {
    for (const e of catalog) {
      expect(e.preview.frames.map((f) => f.name)).toEqual([...e.sections])
      expect(e.preview.items.length).toBeGreaterThan(0)
      const { bounds } = e.preview
      expect(bounds.w).toBeGreaterThan(0)
      // Everything drawn lies within the template bounds (children are placed relative to their frame).
      for (const it of [...e.preview.frames, ...e.preview.items]) {
        expect(it.x).toBeGreaterThanOrEqual(bounds.x - 1)
        expect(it.y).toBeGreaterThanOrEqual(bounds.y - 1)
        expect(it.x + it.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1)
      }
    }
  })

  it('resolves frame-relative child positions to page space', () => {
    const p = previewFromRecords(
      [
        {
          typeName: 'shape',
          id: 'shape:f',
          type: 'frame',
          parentId: 'page:p',
          x: 100,
          y: 50,
          props: { w: 400, h: 300, name: 'A' },
        },
        {
          typeName: 'shape',
          id: 'shape:n',
          type: 'note',
          parentId: 'shape:f',
          x: 10,
          y: 20,
          props: { color: 'yellow', scale: 1 },
        },
        { typeName: 'binding', id: 'binding:x' },
      ],
      'page:p',
      { x: 100, y: 50, w: 400, h: 300 },
    )
    expect(p.frames).toEqual([{ x: 100, y: 50, w: 400, h: 300, name: 'A' }])
    expect(p.items).toEqual([{ kind: 'note', x: 110, y: 70, w: 200, h: 200, color: '#ffe066' }])
  })

  it('searches names, descriptions, categories and section names, within a category', () => {
    expect(filterTemplates(catalog, '', 'all')).toHaveLength(6)
    expect(filterTemplates(catalog, 'panel', 'all').map((e) => e.id)).toEqual(['storyboard'])
    expect(filterTemplates(catalog, 'RETRO', 'all').map((e) => e.id)).toContain('retrospective')
    expect(filterTemplates(catalog, '', 'visual').map((e) => e.id)).toEqual(['mood-board', 'storyboard'])
    expect(filterTemplates(catalog, 'panel', 'plan')).toEqual([])
    expect(filterTemplates(catalog, 'zzz-nothing', 'all')).toEqual([])
  })

  it('opens a new board with ?template=<id> only when a template was picked', () => {
    expect(newBoardPath('b-3k9x0q2m7a', null)).toBe('/b/b-3k9x0q2m7a')
    expect(newBoardPath('b-3k9x0q2m7a', 'mood-board')).toBe('/b/b-3k9x0q2m7a?template=mood-board')
  })
})
