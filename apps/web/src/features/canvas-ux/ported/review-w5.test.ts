// OWNER: 3a. The wave-5 review's pure pieces for the canvas tools: one Tab stop per control (W5-42), the
// tools' keys for assistive tech (W5-50), the text editor's name (W5-59), the board menu's View, Paste and
// the context menu's Paste (W5-33).
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { CANVAS_FEATURES } from '../../canvas-registry.ts'
import { CONTEXT_MENU_ENTRIES } from './ContextMenu.tsx'
import { editorName } from './canvas-events.ts'
import { CMD, COMMANDS } from './commands.ts'
import { MAIN_MENU_ENTRIES } from './MainMenu.tsx'
import { rovingTab } from './StylePanel.tsx'
import { ariaKeys, OVERFLOW_TOOLS, rovingIndex } from './Toolbar.tsx'

describe('W5-42: one Tab stop per control', () => {
  it('the picked option, else the first', () => {
    const opts = ['s', 'm', 'l', 'xl'] as const
    expect(opts.map((_, i) => rovingTab(opts, 'l', i))).toEqual([-1, -1, 0, -1])
    expect(opts.map((_, i) => rovingTab(opts, 'mixed', i))).toEqual([0, -1, -1, -1])
    expect(opts.map((_, i) => rovingTab(opts, undefined, i))).toEqual([0, -1, -1, -1])
    expect(rovingIndex([{ active: false }, { active: true }])).toBe(1)
    expect(rovingIndex([{ active: false }, { active: false }])).toBe(0)
  })
})

describe('W5-50: the tools say their keys', () => {
  it('as aria-keyshortcuts values', () => {
    expect(ariaKeys('v')).toBe('V')
    expect(ariaKeys('shift+d')).toBe('Shift+D')
    expect(ariaKeys('mod+u')).toMatch(/^(Control|Meta)\+U$/)
    expect(ariaKeys(undefined)).toBeUndefined()
  })
})

describe('W5-59: the text editor is named for what it edits', () => {
  const el = (type: string) => ({ id: 'x', type }) as unknown as CanvasElement
  it('a note, a free text, a connector label, a shape label', () => {
    expect(editorName(el('stickynote'))).toBe('Sticky note text')
    expect(editorName(el('text'))).toBe('Text')
    expect(editorName(el('arrow'))).toBe('Connector label')
    expect(editorName(el('rectangle'))).toBe('Shape label')
    expect(editorName(undefined)).toBe('Text')
  })
})

describe('W5-33: the menus', () => {
  it('Board ▸ View holds navigation’s camera rows, each once across every feature', () => {
    // wave-5 integration: 3a and 3b each registered the six View rows (with different ids), so the
    // submenu listed twelve. The View group is the navigation feature's; canvas-ux adds none.
    expect(MAIN_MENU_ENTRIES.filter((e) => e.group === 'view')).toEqual([])
    const view = CANVAS_FEATURES.flatMap((f) =>
      (f.mainMenu ?? []).filter((e) => e.group === 'view').map((e) => `${f.id}:${e.command ?? e.id}`),
    )
    expect(view).toEqual([
      'navigation:navigation.zoom-in',
      'navigation:navigation.zoom-out',
      'navigation:navigation.zoom-to-100',
      'navigation:navigation.zoom-to-fit',
      'navigation:navigation.zoom-to-selection',
      'navigation:navigation.view.minimap',
    ])
  })

  it('no two board-menu or context-menu entries of one group run the same command, across every feature', () => {
    for (const list of ['mainMenu', 'contextMenu'] as const) {
      const seen = new Map<string, string>()
      for (const f of CANVAS_FEATURES)
        for (const e of f[list] ?? []) {
          if (!e.command) continue
          const key = `${e.group}:${e.command}`
          expect(seen.get(key), `${list} ${key} from ${f.id} and ${seen.get(key)}`).toBeUndefined()
          seen.set(key, f.id)
        }
    }
  })

  it('Paste in Edit ▸ and in the context menu, through the Paste command', () => {
    expect(COMMANDS.some((c) => c.id === CMD.paste && c.label === 'Paste')).toBe(true)
    expect(MAIN_MENU_ENTRIES.find((e) => e.id === 'paste')).toMatchObject({
      group: 'clipboard',
      command: CMD.paste,
    })
    expect(CONTEXT_MENU_ENTRIES.find((e) => e.id === 'paste')).toMatchObject({
      group: 'clipboard',
      command: CMD.paste,
    })
  })

  it('D4: More holds the polygon tools between the ellipse and the line, in tldraw’s order', () => {
    const ids = OVERFLOW_TOOLS.map((t) => t.id)
    expect(ids.slice(ids.indexOf('ellipse'), ids.indexOf('line') + 1)).toEqual([
      'ellipse',
      'triangle',
      'diamond',
      'hexagon',
      'rhombus',
      'star',
      'cloud',
      'heart',
      'arrow-left',
      'arrow-up',
      'arrow-down',
      'arrow-right',
      'line',
    ])
  })
})
