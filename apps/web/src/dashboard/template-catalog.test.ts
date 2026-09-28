import { describe, expect, it } from 'vitest'
import { createSampleBoard, SAMPLE_BOARD } from './sample-board.ts'
import { CATEGORIES, filterTemplates, previewFromRecords, templateCatalog } from './template-catalog.ts'
import { newBoardPath, TEMPLATE_IDS } from './template-paths.ts'

describe('template picker catalog (PRE-01)', () => {
  const catalog = templateCatalog()

  it('lists the Lobby tour sample first, then the six @draftroom/templates, with names, one-sentence descriptions, categories and sections', () => {
    expect(catalog.map((e) => e.id)).toEqual([...TEMPLATE_IDS])
    expect(catalog.map((e) => e.category)[0]).toBe('sample')
    for (const e of catalog) {
      expect(e.name.length).toBeGreaterThan(2)
      expect(e.description).toMatch(/\.$/)
      expect(['ideate', 'visual', 'plan', 'review', 'sample']).toContain(e.category)
      expect(e.sections.length).toBeGreaterThan(0)
    }
    expect(catalog.filter((e) => e.category === 'sample')).toHaveLength(1)
  })

  it('keeps the sample out of every category chip, and finds it under All by name or "sample"', () => {
    expect(CATEGORIES).not.toContain('sample')
    for (const c of CATEGORIES)
      expect(filterTemplates(catalog, '', c).map((e) => e.id)).not.toContain('lobby-tour')
    expect(filterTemplates(catalog, '', 'all')[0]?.id).toBe('lobby-tour')
    expect(filterTemplates(catalog, 'sample', 'all').map((e) => e.id)).toEqual(['lobby-tour'])
    expect(filterTemplates(catalog, 'lobby tour', 'all').map((e) => e.id)).toEqual(['lobby-tour'])
    expect(filterTemplates(catalog, 'mood board', 'all').map((e) => e.id)).toContain('lobby-tour')
  })

  it('"Start with the sample board" makes a board titled like the template and opens it with the tour', async () => {
    const tour = catalog.find((e) => e.id === SAMPLE_BOARD.templateId)
    expect(tour?.name).toBe(SAMPLE_BOARD.title)
    const calls: unknown[] = []
    const path = await createSampleBoard(
      async (workspaceId, input) => {
        calls.push([workspaceId, input])
        return { id: 'b-3k9x0q2m7a' }
      },
      'ws_1',
      'prj_2',
    )
    expect(calls).toEqual([['ws_1', { title: 'Lobby tour', projectId: 'prj_2' }]])
    expect(path).toBe('/b/b-3k9x0q2m7a?template=lobby-tour')
    await expect(
      createSampleBoard(
        async () => {
          throw new Error('403')
        },
        'ws_1',
        null,
      ),
    ).rejects.toThrow('403')
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
      // TemplateThumb sizes strokes by the height only past 3:1, so only the tour's strip is affected.
      if (e.category !== 'sample') expect(bounds.w / bounds.h).toBeLessThanOrEqual(3)
    }
    const tour = catalog.find((e) => e.id === 'lobby-tour')
    expect((tour?.preview.bounds.w ?? 0) / (tour?.preview.bounds.h ?? 1)).toBeGreaterThan(3)
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

  it('draws full-colour fills (palette swatches) in their colour; other shapes stay neutral boxes', () => {
    const geo = (id: string, fill: string, color: string) => ({
      typeName: 'shape',
      id,
      type: 'geo',
      parentId: 'page:p',
      x: 0,
      y: 0,
      props: { w: 100, h: 80, fill, color },
    })
    const p = previewFromRecords(
      [geo('shape:a', 'fill', 'orange'), geo('shape:b', 'solid', 'orange')],
      'page:p',
      {
        x: 0,
        y: 0,
        w: 100,
        h: 80,
      },
    )
    expect(p.items.map((i) => i.kind)).toEqual(['swatch', 'box'])
    expect(p.items[0]?.color).toBe('#ffb66e')
    // The tour's Mood board shows its palette in the gallery strip.
    const tour = catalog.find((e) => e.id === 'lobby-tour')
    expect(tour?.preview.items.filter((i) => i.kind === 'swatch').length).toBeGreaterThanOrEqual(4)
  })

  it('searches names, descriptions, categories and section names, within a category', () => {
    expect(filterTemplates(catalog, '', 'all')).toHaveLength(7)
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
