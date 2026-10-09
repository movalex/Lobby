// Wave L (W5): the commands other workstreams run by id ('workshops.vote.setup', 'workshops.spotlight',
// 'present-export.export' with frameIds): registered, runnable only by a facilitator (an editor with an account,
// never a read-only role), and doing what their args say. The ids and the args readers are
// ../commands.ts (wave-l-exports.test.ts).
import { describe, expect, it } from 'vitest'
import { type CommandSpec, commandRunnable } from '../../../canvas/api/index.ts'
import { CANVAS_FEATURES } from '../../canvas-registry.ts'
import { exportFrameIds } from '../../present-export/ported/export-frames.ts'
import { WORKSHOP_COMMAND_IDS } from '../commands.ts'
import { workshopKit } from './ctx-kit.ts'
import { el, note } from './test-kit.ts'

const command = (id: string): CommandSpec => {
  const found = CANVAS_FEATURES.flatMap((f) => f.commands ?? []).filter((c) => c.id === id)
  if (found.length !== 1) throw new Error(`${id}: ${found.length} commands`)
  return found[0] as CommandSpec
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('the wave L workshop commands are registered, once, with labels', () => {
  it('names all three ids', () => {
    for (const id of Object.values(WORKSHOP_COMMAND_IDS)) expect(command(id).label.length).toBeGreaterThan(0)
    expect(command('workshops.spotlight-end').label).toBe('End the spotlight')
  })
})

describe("'workshops.vote.setup' {scope, refs?, onePerObject?}", () => {
  it('opens the vote setup prefilled with what it is given; with no (or unusable) args, its own defaults', () => {
    const kit = workshopKit({ elements: [...note('n1', 'a'), ...note('n2', 'b')] })
    const cmd = command('workshops.vote.setup')
    void cmd.run(kit.ctx, 'api', { scope: 'selection', refs: ['shape:n1', 'shape:n2'], onePerObject: true })
    expect(kit.store.getSnapshot()).toMatchObject({
      setupOpen: true,
      setupPrefill: { scope: 'selection', refs: ['shape:n1', 'shape:n2'], onePerObject: true },
    })
    kit.store.setSetupOpen(false)
    void cmd.run(kit.ctx, 'palette')
    expect(kit.store.getSnapshot()).toMatchObject({ setupOpen: true, setupPrefill: null })
    kit.store.setSetupOpen(false)
    void cmd.run(kit.ctx, 'api', { scope: 'selection' }) // a selection with no objects: not usable
    expect(kit.store.getSnapshot().setupPrefill).toBeNull()
  })

  it('is for facilitators: an owner or an editor may run it, a viewer or a commenter may not', () => {
    const cmd = command('workshops.vote.setup')
    expect(commandRunnable(cmd, workshopKit({ role: 'owner' }).ctx)).toBe(true)
    expect(commandRunnable(cmd, workshopKit({ role: 'editor' }).ctx)).toBe(true)
    for (const role of ['commenter', 'viewer'] as const) {
      const kit = workshopKit({ role })
      ;(kit.ctx.canvas as unknown as { readOnly: () => boolean }).readOnly = () => true
      expect(commandRunnable(cmd, kit.ctx), role).toBe(false)
    }
  })
})

describe("'workshops.spotlight' {ids}", () => {
  const answer = (kit: ReturnType<typeof workshopKit>) =>
    kit.next(
      (m, p) => m === 'POST' && p.endsWith('/spotlight'),
      () => ({
        spotlight: null,
        version: { epoch: 'e', n: 1 },
        serverNow: new Date().toISOString(),
      }),
    )

  it('spotlights the ids it is given (as api refs), a bound label standing for its note', async () => {
    const kit = workshopKit({ elements: [...note('n1', 'a'), ...note('n2', 'b')] })
    answer(kit)
    void command('workshops.spotlight').run(kit.ctx, 'api', { ids: ['n1-label', 'n2'] })
    await settle()
    const call = kit.calls.find((c) => c.path.endsWith('/spotlight'))
    expect(call?.body).toEqual({ refs: ['shape:n1', 'shape:n2'], bringEveryone: true })
  })

  it('with no ids it spotlights the selection; with nothing selected it says so and asks nothing', async () => {
    const kit = workshopKit({ elements: note('n1', 'a') })
    const notices: string[] = []
    kit.ctx.notify = (n) => void notices.push(n.text)
    void command('workshops.spotlight').run(kit.ctx, 'palette')
    await settle()
    expect(kit.calls.filter((c) => c.path.endsWith('/spotlight'))).toEqual([])
    expect(notices).toEqual(['Select something to spotlight first.'])
    answer(kit)
    kit.ctx.canvas.select(['n1'])
    void command('workshops.spotlight').run(kit.ctx, 'palette')
    await settle()
    expect(kit.calls.find((c) => c.path.endsWith('/spotlight'))?.body).toMatchObject({ refs: ['shape:n1'] })
  })

  it('is a facilitator’s; ending is the starter’s or an owner’s', () => {
    const start = command('workshops.spotlight')
    const end = command('workshops.spotlight-end')
    const editorKit = workshopKit({ role: 'editor' })
    expect(commandRunnable(start, editorKit.ctx)).toBe(true)
    expect(commandRunnable(end, editorKit.ctx)).toBe(false) // none is on
    // someone else's spotlight: an owner may end it, an editor may not
    const theirs = {
      spotlight: {
        refs: ['shape:n1'],
        bringEveryone: false,
        by: { userId: 'usr_someoneelse0001', name: 'Maya' },
        startedAt: new Date().toISOString(),
        endsAt: new Date().toISOString(),
        version: { epoch: 'e', n: 1 },
      },
      version: { epoch: 'e', n: 1 },
      reason: null,
      endedBy: null,
    }
    const owner = workshopKit({ role: 'owner' })
    owner.events.emit('workshop.spotlight', theirs)
    editorKit.events.emit('workshop.spotlight', theirs)
    expect(commandRunnable(end, owner.ctx)).toBe(true)
    expect(commandRunnable(end, editorKit.ctx)).toBe(false)
  })
})

describe("'present-export.export' {frameIds}", () => {
  it('opens on the frames it names: only frames that are on the board now', () => {
    const canvas = {
      get: (id: string) =>
        ({
          f1: el('f1', 'frame'),
          f2: el('f2', 'frame'),
          gone: el('gone', 'frame', { isDeleted: true }),
          note: el('note', 'stickynote'),
        })[id],
    }
    expect(exportFrameIds(canvas, { frameIds: ['f2', 'gone', 'note', 'nope', 'f1'] })).toEqual(['f2', 'f1'])
    // no args, or no usable ones: the dialog as it was (nothing selected for it)
    expect(exportFrameIds(canvas, undefined)).toEqual([])
    expect(exportFrameIds(canvas, { frameIds: [] })).toEqual([])
    expect(exportFrameIds(canvas, { frameIds: 'f1' })).toEqual([])
  })
})
