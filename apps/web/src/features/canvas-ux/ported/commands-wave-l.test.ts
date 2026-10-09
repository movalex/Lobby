// Wave L foundation (W3, L3-1): the CommandSpec additions (keywords, group, disabledReason, run args) and the
// 'palette' CommandSource, through canvas-ux's runCommand (the one path the menus, the palette and the
// cross-workstream callers share). A command without the new fields behaves exactly as before.
import { describe, expect, it } from 'vitest'
import {
  type CanvasFeatureContext,
  type CommandSource,
  type CommandSpec,
  commandRunnable,
  createFeatureRegistries,
} from '../../../canvas/api/index.ts'
import { CMD, COMMANDS, runCommand } from './commands.ts'
import { filterSections, type ShortcutSection } from './ShortcutsDialog.tsx'

function ctxWith(readOnly = false) {
  const registries = createFeatureRegistries()
  const ctx = { registries, canvas: { readOnly: () => readOnly } } as unknown as CanvasFeatureContext
  return { ctx, registries }
}

describe('CommandSpec wave L additions', () => {
  it('runCommand passes args to run, from the palette or any source; no args is the old call', () => {
    const { ctx, registries } = ctxWith()
    const calls: { source: CommandSource; args: unknown; n: number }[] = []
    const cmd: CommandSpec = {
      id: 'test.ask',
      label: 'Ask',
      keywords: ['question', 'query'],
      group: 'AI',
      run: (_c, source, ...rest) => void calls.push({ source, args: rest[0], n: rest.length }),
    }
    registries.commands.register(cmd)
    expect(runCommand(ctx, 'test.ask', 'palette', { question: 'Why?' })).toBe(true)
    expect(runCommand(ctx, 'test.ask', 'menu')).toBe(true)
    expect(calls).toEqual([
      { source: 'palette', args: { question: 'Why?' }, n: 1 },
      { source: 'menu', args: undefined, n: 0 },
    ])
  })

  it('a disabled reason refuses the command like enabled() false; null runs it', () => {
    const { ctx, registries } = ctxWith()
    let reason: string | null = 'Select two or more objects'
    let ran = 0
    registries.commands.register({
      id: 'test.distribute',
      label: 'Distribute',
      disabledReason: () => reason,
      run: () => void ran++,
    })
    const cmd = registries.commands.get('test.distribute') as CommandSpec
    expect(runCommand(ctx, 'test.distribute', 'palette')).toBe(false)
    expect(commandRunnable(cmd, ctx)).toBe(false)
    reason = null
    expect(runCommand(ctx, 'test.distribute', 'palette')).toBe(true)
    expect(commandRunnable(cmd, ctx)).toBe(true)
    expect(ran).toBe(1)
  })

  it('an unknown id is a no-op (a workstream that has not registered its command yet); read-only rules hold', () => {
    const { ctx, registries } = ctxWith(true)
    expect(runCommand(ctx, 'workshops.vote.setup', 'api', { scope: 'selection' })).toBe(false)
    let ran = 0
    registries.commands.register({ id: 'test.edit', label: 'Edit', run: () => void ran++ })
    registries.commands.register({
      id: 'test.view',
      label: 'View',
      readOnlyAllowed: true,
      run: () => void ran++,
    })
    expect(runCommand(ctx, 'test.edit', 'palette')).toBe(false)
    expect(runCommand(ctx, 'test.view', 'palette')).toBe(true)
    expect(ran).toBe(1)
    const unavailable: CommandSpec = {
      id: 'x',
      label: 'x',
      readOnlyAllowed: true,
      available: () => false,
      run: () => {},
    }
    expect(commandRunnable(unavailable, ctx)).toBe(false)
  })
})

describe('canvas-ux’s palette words (L3-2): groups, keywords, and a reason only where enabled() says no', () => {
  /** A canvas with `n` selected notes (the last `locked` of them locked), history `undo`/`redo`. */
  function canvasWith(
    n: number,
    opts: { locked?: number; undo?: boolean; redo?: boolean; readOnly?: boolean } = {},
  ) {
    const els = Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      type: 'stickynote',
      x: i * 300,
      y: 0,
      width: 200,
      height: 200,
      angle: 0,
      groupIds: i < 2 ? ['g1'] : [],
      frameId: null,
      locked: i >= n - (opts.locked ?? 0),
      boundElements: null,
    }))
    const registries = createFeatureRegistries()
    return {
      registries,
      canvas: {
        readOnly: () => opts.readOnly === true,
        selection: els.map((e) => e.id),
        get: (id: string) => els.find((e) => e.id === id),
        items: () => els,
        history: { canUndo: () => opts.undo === true, canRedo: () => opts.redo === true },
      },
    } as unknown as CanvasFeatureContext
  }

  it('every canvas-ux command has a group; a disabled reason appears exactly when enabled() is false', () => {
    const contexts = [
      canvasWith(0),
      canvasWith(1),
      canvasWith(2),
      canvasWith(3),
      canvasWith(3, { locked: 3 }),
      canvasWith(2, { undo: true, redo: true }),
    ]
    for (const cmd of COMMANDS) {
      expect(cmd.group, cmd.id).toBeTruthy()
      if (!cmd.disabledReason) continue
      for (const ctx of contexts) {
        let enabled: boolean
        try {
          enabled = cmd.enabled ? cmd.enabled(ctx) : true
        } catch {
          continue // a read this fake canvas does not offer (the clipboard's text)
        }
        const reason = cmd.disabledReason(ctx)
        expect(reason === null, `${cmd.id}: enabled ${enabled}, reason ${reason}`).toBe(enabled)
      }
    }
  })

  it('the reasons say what to do', () => {
    const reason = (id: string, ctx: CanvasFeatureContext) =>
      COMMANDS.find((c) => c.id === id)?.disabledReason?.(ctx) ?? null
    expect(reason(CMD.distributeH, canvasWith(2))).toBe('Select three or more objects to space them out')
    expect(reason(CMD.alignLeft, canvasWith(1))).toBe('Select two or more objects to align them')
    expect(reason(CMD.undo, canvasWith(0))).toBe('Nothing to undo')
    expect(reason(CMD.delete, canvasWith(2, { locked: 2 }))).toBe('The selection is locked')
    expect(reason(CMD.delete, canvasWith(0))).toBe('Select something first')
    expect(reason(CMD.alignLeft, canvasWith(2))).toBeNull()
    expect(COMMANDS.find((c) => c.id === CMD.toggleLock)?.keywords).toContain('lock')
  })
})

describe('the shortcuts dialog’s search (L3-2: the palette’s scorer over the same rows)', () => {
  const sections: ShortcutSection[] = [
    {
      id: 'edit',
      title: 'Edit',
      rows: [
        { label: 'Toggle locked', keys: ['mod+shift+l'] },
        { label: 'Undo', keys: ['mod+z'] },
      ],
    },
    { id: 'features', title: 'View and features', rows: [{ label: 'Command palette', keys: ['mod+k'] }] },
    { id: 'dr-board', title: 'Board', rows: [{ label: 'Pan (hold)', keys: [{ text: 'Space' }] }] },
  ]
  it('keeps the rows whose words or keys match, best first; an empty query keeps everything', () => {
    expect(filterSections(sections, '', 'other')).toEqual(sections)
    expect(filterSections(sections, 'lock', 'other').map((s) => s.rows.map((r) => r.label))).toEqual([
      ['Toggle locked'],
    ])
    expect(filterSections(sections, 'ctrl+k', 'other').map((s) => s.rows.map((r) => r.label))).toEqual([
      ['Command palette'],
    ])
    expect(filterSections(sections, 'cp', 'other')[0]?.rows[0]?.label).toBe('Command palette')
    expect(filterSections(sections, 'space', 'other')[0]?.rows[0]?.label).toBe('Pan (hold)')
    expect(filterSections(sections, 'xyzzy', 'other')).toEqual([])
  })
})
