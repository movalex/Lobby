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
import { runCommand } from './commands.ts'

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
