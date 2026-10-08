// K3-3 (wave K, UXD-01): the top bar loses its Export icon; the board menu's Export ▸ keeps the dialog
// (Board menu ▸ Export ▸ Export…, the same command the icon ran). In a browser: e2e/excalidraw/k3-facilitate.spec.ts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { exportStateOf } from '../../sharing/ported/export-policy.ts'
import { workshopKit } from '../../workshops/ported/ctx-kit.ts'
import { getController } from './controller.ts'
import { feature } from './index.tsx'

describe('Export lives in the board menu, not the top bar (K3-3)', () => {
  it('the top-bar item is the Present button only', () => {
    const item = feature.topBar?.find((t) => t.id === 'present-export')
    if (!item) throw new Error('no present-export top-bar item')
    const html = renderToStaticMarkup(createElement(item.component, { ctx: workshopKit().ctx }))
    expect(html).toContain('data-testid="present-button"')
    expect(html).not.toContain('export-button')
    expect(item.overflowCaption).toBe('Present')
  })

  it('Board menu ▸ Export ▸ "Export…" opens the export dialog (the command the icon ran)', () => {
    const entry = feature.mainMenu?.find((e) => e.id === 'export-dialog')
    expect(entry).toMatchObject({ group: 'export', label: 'Export…', command: 'present-export.export' })
    // first in the Export ▸ group, before Export as ▸, Export all as ▸ and Export as PDF…
    const group = (feature.mainMenu ?? [])
      .filter((e) => e.group === 'export')
      .sort((a, b) => a.order - b.order)
    expect(group.map((e) => e.id)).toEqual(['export-dialog', 'export-as', 'export-all-as', 'print'])
    const command = feature.commands?.find((c) => c.id === 'present-export.export')
    expect(command).toMatchObject({ label: 'Export…', readOnlyAllowed: true })
    // the command asks the controller for the dialog: the request the top-bar item renders it from
    const kit = workshopKit()
    // the board's export policy is known (wave K.1: before the first answer only the owner and editors export)
    exportStateOf(kit.ctx.board.id).policy.set('everyone')
    expect(getController(kit.ctx.canvas).exportRequest.get()).toBeNull()
    command?.run(kit.ctx, 'menu' as never)
    expect(getController(kit.ctx.canvas).exportRequest.get()).toMatchObject({ focus: 'image' })
  })
})
