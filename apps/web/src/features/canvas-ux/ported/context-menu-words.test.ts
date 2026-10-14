// P-013 (wave P): the context menu speaks Lobby's words, not the engine's: "Lock" or "Unlock" for what the
// selection is, never "Toggle locked"; "Select by type" (Lobby has no pages), never "Select all on this page".
import { describe, expect, it } from 'vitest'
import { type CanvasFeatureContext, createFeatureRegistries } from '../../../canvas/api/index.ts'
import { CONTEXT_MENU_ENTRIES } from './ContextMenu.tsx'
import { CMD, COMMANDS } from './commands.ts'
import { resolveEntry } from './Menu.tsx'
import { feature as navigation } from './navigation/index.tsx'

type El = { id: string; type: string; locked?: boolean; groupIds: string[]; x: number; y: number }

function ctxWith(els: El[], selection: string[]) {
  const registries = createFeatureRegistries()
  for (const c of COMMANDS) registries.commands.register(c)
  const canvas = {
    selection,
    get: (id: string) => els.find((e) => e.id === id),
    items: () => els,
    readOnly: () => false,
    isLocked: (id: string) => els.find((e) => e.id === id)?.locked === true,
    editingId: () => null,
  }
  const ctx = { canvas, registries, role: 'editor', board: { id: 'b', status: 'active' } }
  return ctx as unknown as CanvasFeatureContext
}

const target = { kind: 'selection' } as never
const lockLabel = (ctx: CanvasFeatureContext) => {
  const entry = CONTEXT_MENU_ENTRIES.find((e) => e.id === 'toggle-lock')
  if (!entry) throw new Error('no toggle-lock entry')
  return resolveEntry(entry, ctx, target, 'context-menu' as never)
}

describe('P-013: Lock / Unlock', () => {
  const a: El = { id: 'a', type: 'rectangle', groupIds: [], x: 0, y: 0 }
  const b: El = { id: 'b', type: 'stickynote', groupIds: [], x: 0, y: 0, locked: true }
  it('says Lock for an unlocked selection, Unlock for a locked one, Lock for a mixed one (it locks all)', () => {
    expect(lockLabel(ctxWith([a, b], ['a']))?.label).toBe('Lock')
    expect(lockLabel(ctxWith([a, b], ['b']))?.label).toBe('Unlock')
    expect(lockLabel(ctxWith([a, b], ['a', 'b']))?.label).toBe('Lock')
  })
  it('keeps the shortcut, and the command (palette, shortcuts) is named in words too', () => {
    expect(lockLabel(ctxWith([a], ['a']))?.kbd).toBe('mod+shift+l')
    const cmd = COMMANDS.find((c) => c.id === CMD.toggleLock)
    expect(cmd?.label).toBe('Lock or unlock')
    expect(cmd?.label).not.toMatch(/toggle/i)
  })
})

describe('P-013: select by type', () => {
  it('the submenu is "Select by type", never "on this page"', () => {
    const entry = navigation.contextMenu?.find((e) => e.id === 'navigation.select-all-type')
    expect(entry?.label).toBe('Select by type')
    const words = [...CONTEXT_MENU_ENTRIES, ...(navigation.contextMenu ?? [])].map((e) =>
      typeof e.label === 'string' ? e.label : '',
    )
    for (const w of words) expect(w).not.toMatch(/page|toggle/i)
  })
})
