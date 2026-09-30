// The engine-neutral side of the templates: the plan subpath the dashboard reads, the one content source
// both engines emit from, and which engine each entry point may load.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { instantiateTemplate, TEMPLATES } from './index.ts'
import { planBounds, planTemplate, TEMPLATE_INFOS } from './plan.ts'
import { PAGE } from './test-utils.ts'

const SRC = dirname(fileURLToPath(import.meta.url))

/** Every module reachable from `entry` through relative imports, and every bare import they make. */
function importGraph(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>()
  const bare = new Set<string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      const spec = m[1] as string
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec))
      else bare.add(spec)
    }
  }
  visit(resolve(SRC, entry))
  return { files: [...files].map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/')), bare: [...bare].sort() }
}

describe('the plan catalogue (@draftroom/templates/plan)', () => {
  it('lists the same templates, with the same metadata, as the tldraw registry', () => {
    expect(
      TEMPLATE_INFOS.map(({ id, name, description, category, sections }) => ({
        id,
        name,
        description,
        category,
        sections: [...sections],
      })),
    ).toEqual(
      TEMPLATES.map(({ id, name, description, category, sections }) => ({
        id,
        name,
        description,
        category,
        sections: [...sections],
      })),
    )
  })

  it("gives each template's plan the bounds of its tldraw instance, at any origin", () => {
    for (const t of TEMPLATE_INFOS)
      for (const origin of [
        { x: 0, y: 0 },
        { x: 1234.5, y: -987 },
      ])
        expect(planBounds(planTemplate(t.id, origin))).toEqual(
          instantiateTemplate(t.id, { pageId: PAGE, origin }).bounds,
        )
  })

  it('has one plan node per tldraw shape, in the same order', () => {
    for (const t of TEMPLATE_INFOS) {
      const plan = planTemplate(t.id)
      const shapes = instantiateTemplate(t.id, { pageId: PAGE, origin: { x: 0, y: 0 } }).records.filter(
        (r) => r.typeName === 'shape',
      )
      const kind = (type: string) => (type === 'geo' ? 'geo' : type)
      expect(plan.nodes.map((n) => n.kind)).toEqual(shapes.map((s) => kind((s as { type: string }).type)))
    }
  })

  it('throws a typed error for unknown ids', () => {
    expect(() => planTemplate('nope' as never)).toThrow(expect.objectContaining({ code: 'unknown-template' }))
  })
})

describe('which engine each entry point loads', () => {
  it('the plan loads neither engine (the dashboard gallery chunk of both builds)', () => {
    const { files, bare } = importGraph('plan.ts')
    expect(bare).toEqual([])
    expect(files).not.toContain('tldraw.ts')
  })

  it('the scene loads no tldraw: only the canvas-schema engine wrappers and board-ops elements', () => {
    const { files, bare } = importGraph('scene/index.ts')
    expect(bare.filter((b) => /tldraw|^@excalidraw\//.test(b))).toEqual([])
    for (const f of ['tldraw.ts', 'registry.ts', 'index.ts', 'layout.ts', 'types.ts'])
      expect(files).not.toContain(f)
    expect(bare).toEqual([
      '@draftroom/board-ops/elements',
      '@draftroom/canvas-schema/elements',
      '@draftroom/canvas-schema/engine',
      '@draftroom/canvas-schema/invariants',
      '@draftroom/canvas-schema/limits',
    ])
  })

  it('the template content (./templates/*.ts) imports only the neutral builder', () => {
    for (const t of [
      'brainstorm',
      'lobby-tour',
      'mood-board',
      'pitch-outline',
      'production-plan',
      'retrospective',
      'storyboard',
    ])
      expect(importGraph(`templates/${t}.ts`).bare).toEqual([])
  })
})
