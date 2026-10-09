// W3 (wave L, L3-2): the command palette's index and ranking, without a browser. The scorer on a fixed corpus,
// every registered command indexed with its keys, a read-only role's index, a disabled line that says why and
// cannot run, recents that survive a throwing storage, the workspace hits.
import type { SearchBoardGroup } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
// the board page's real LobbyCanvas over a bare port (as canvas/api/contracts.test.ts builds it)
import { createLobbyCanvas } from '../../canvas/api/impl.ts'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  createFeatureRegistries,
  formatChord,
  type LobbyCanvas,
} from '../../canvas/api/index.ts'
import { waveLKeyClaimOf } from '../../canvas/input/keymap.ts'
import type { CanvasPort } from '../../canvas/port.ts'
import { CANVAS_FEATURES } from '../canvas-registry.ts'
import {
  boardEntries,
  commandEntry,
  frameEntries,
  NOT_NOW,
  PALETTE_COMMAND_ID,
  READ_ONLY_REASON,
} from './board-index.ts'
import { isPaletteKey, type PaletteKeyLike } from './keys.ts'
import { chooseEntry, type PaletteEntry, pushRecent, RECENTS_MAX, readRecents } from './model.ts'
import { firstActiveLine, paletteSections } from './Palette.tsx'
import { fold, rank, scoreEntry } from './scorer.ts'
import { workspaceEntries } from './workspace-search.ts'

const entry = (label: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({
  id: `cmd:${label}`,
  label,
  group: 'Test',
  recentKey: `cmd:${label}`,
  run: () => {},
  ...extra,
})

/** A fixed corpus: the canvas-ux and navigation labels people type at most. */
const CORPUS = [
  'Undo',
  'Redo',
  'Duplicate',
  'Delete',
  'Select all',
  'Group',
  'Ungroup',
  'Toggle locked',
  'Unlock all',
  'Bring to front',
  'Send to back',
  'Align left',
  'Align horizontally',
  'Align top',
  'Distribute horizontally',
  'Distribute vertically',
  'Keyboard shortcuts',
  'Search board',
  'Show / hide minimap',
  'Zoom to fit',
  'Zoom to selection',
  'Hand tool',
  'Arrange as grid',
  'Present',
].map((l) => entry(l))
const top = (q: string, recents: string[] = []) => rank(CORPUS, q, recents)[0]?.label

describe('the scorer (fixed corpus)', () => {
  it('finds by prefix, by word starts in order, and by initials ("dh" is Distribute horizontally)', () => {
    expect(top('dh')).toBe('Distribute horizontally')
    expect(top('dv')).toBe('Distribute vertically')
    expect(top('dist h')).toBe('Distribute horizontally')
    expect(top('zoom f')).toBe('Zoom to fit')
    expect(top('ztf')).toBe('Zoom to fit')
    expect(top('undo')).toBe('Undo')
    expect(top('und')).toBe('Undo')
    expect(top('lock')).toBe('Toggle locked')
    expect(top('kbd')).toBeDefined()
    expect(top('shortcuts')).toBe('Keyboard shortcuts')
    expect(top('minimap')).toBe('Show / hide minimap')
  })

  it('an exact label beats a prefix, a prefix beats a word inside, a word beats a fuzzy run', () => {
    const q = fold('group')
    expect(scoreEntry(q, 'Group')).toBeGreaterThan(scoreEntry(q, 'Group into themes'))
    expect(scoreEntry(q, 'Group into themes')).toBeGreaterThan(scoreEntry(q, 'Ungroup'))
    expect(scoreEntry('unlock', 'Unlock all')).toBeGreaterThan(scoreEntry('unlock', 'Toggle locked'))
    expect(scoreEntry('xyzzy', 'Undo')).toBe(0)
  })

  it('accents and case do not matter; keywords count a little less than the label', () => {
    expect(scoreEntry('ÉQUIPE', 'équipe')).toBe(1000)
    const k = entry('Present', { keywords: ['slideshow'] })
    expect(rank([k], 'slides')).toEqual([k])
    expect(scoreEntry('slideshow', 'Present', ['slideshow'])).toBeLessThan(scoreEntry('present', 'Present'))
  })

  it('a recent pick is lifted over an equal match; the latest the most', () => {
    // "align" matches the three Align lines as a prefix; the recent one comes first
    expect(top('align')).toBe('Align top')
    expect(top('align', ['cmd:Align horizontally'])).toBe('Align horizontally')
    expect(
      rank(CORPUS, 'align', ['cmd:Align left', 'cmd:Align horizontally'])
        .map((e) => e.label)
        .slice(0, 2),
    ).toEqual(['Align left', 'Align horizontally'])
    // nothing typed: the recents first, most recent first, then the index in its own order
    const none = rank(CORPUS, '', ['cmd:Present', 'cmd:Undo'])
    expect(none.slice(0, 3).map((e) => e.label)).toEqual(['Present', 'Undo', 'Redo'])
    // a recent that does not match is not dragged in
    expect(rank(CORPUS, 'zoom', ['cmd:Present']).map((e) => e.label)).not.toContain('Present')
  })

  it('a pinned line (the parsed Do line) leads whatever is typed', () => {
    const doLine = entry('Make 3 red notes yellow', { id: 'do:grammar', pinned: 2000, recentKey: undefined })
    expect(rank([...CORPUS, doLine], 'make the red notes yellow')[0]).toBe(doLine)
  })

  it('sections: nothing typed is Recent then each group; typed is one ranked list', () => {
    const a = entry('Alpha', { group: 'One' })
    const b = entry('Beta', { group: 'Two' })
    const c = entry('Gamma', { group: 'One' })
    expect(
      paletteSections([a, b, c], '', ['cmd:Beta']).map((s) => [s.title, s.entries.map((e) => e.label)]),
    ).toEqual([
      ['Recent', ['Beta']],
      ['One', ['Alpha', 'Gamma']],
    ])
    expect(paletteSections([a, b, c], 'gam', []).map((s) => s.entries.map((e) => e.label))).toEqual([
      ['Gamma'],
    ])
  })

  it('nothing typed and no recents: no line is active (a reflex Ctrl/Cmd+K, Enter runs nothing, not Undo)', () => {
    const undo = entry('Undo', { group: 'Edit' })
    const lock = entry('Lock', { group: 'Arrange' })
    expect(firstActiveLine(paletteSections([undo, lock], '', []))).toBe(-1)
    // Recent first, or something typed: the first line, as before
    expect(firstActiveLine(paletteSections([undo, lock], '', ['cmd:Lock']))).toBe(0)
    expect(firstActiveLine(paletteSections([undo, lock], 'und', []))).toBe(0)
    expect(firstActiveLine([])).toBe(-1)
  })
})

// ---- the board's index -------------------------------------------------------------------------------------

function fakePort(): CanvasPort {
  const noop = () => {}
  return {
    items: () => [],
    get: () => undefined,
    bounds: () => null,
    selection: [],
    select: noop,
    viewport: { get: () => ({ x: 0, y: 0, width: 100, height: 100, zoom: 1 }), set: noop, fit: noop },
    sceneToScreen: (p) => p,
    screenToScene: (p) => p,
    transact: (_label, fn) => fn({ create: () => 'new', update: noop, delete: noop }),
    setTool: () => true,
    tool: () => 'select',
    on: () => noop,
    editingId: () => null,
    leaseHolder: () => null,
    collaborators: () => [],
    saveStatus: () => ({ state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }),
    engine: null,
  }
}

/** A feature context over a bare port, with every CANVAS_FEATURES command registered. */
function boardCtx(readOnly: boolean, extra: readonly CommandSpec[] = []): CanvasFeatureContext {
  const registries = createFeatureRegistries()
  for (const f of CANVAS_FEATURES) {
    for (const c of f.commands ?? []) registries.commands.register(c)
    for (const t of f.tools ?? []) registries.tools.register(t)
  }
  for (const c of extra) registries.commands.register(c)
  const { canvas } = createLobbyCanvas({ port: fakePort(), registries })
  return {
    canvas: { ...canvas, readOnly: () => readOnly } as LobbyCanvas,
    registries,
    board: { id: 'brd_test', status: 'active' } as CanvasFeatureContext['board'],
    role: readOnly ? 'viewer' : 'editor',
    me: { user: { id: 'usr_test' } } as CanvasFeatureContext['me'],
    workspace: { id: 'wsp_test', name: 'Test' },
    api: {} as CanvasFeatureContext['api'],
    events: {} as CanvasFeatureContext['events'],
    notify: () => {},
    dismiss: () => {},
    openPanel: () => {},
    activePanel: null,
  }
}

describe('the board index (built from the live registries)', () => {
  it('lists every registered command with its keys (formatted), the palette itself left out', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = boardCtx(false)
    const list = boardEntries(ctx, 'other')
    const byId = new Map(list.map((e) => [e.id, e]))
    let checked = 0
    for (const cmd of ctx.registries.commands.list()) {
      if (cmd.id === PALETTE_COMMAND_ID) {
        expect(byId.has(`cmd:${cmd.id}`)).toBe(false)
        continue
      }
      let offered = true
      try {
        offered = !cmd.available || cmd.available(ctx)
      } catch {
        offered = true
      }
      const e = byId.get(`cmd:${cmd.id}`)
      if (!offered) {
        expect(e, cmd.id).toBeUndefined()
        continue
      }
      expect(e, cmd.id).toBeDefined()
      for (const k of cmd.kbd ?? []) expect(e?.kbd, `${cmd.id} ${k}`).toContain(formatChord(k, 'other'))
      checked++
    }
    expect(checked).toBeGreaterThan(40)
    // the tools are there with their keys; the macOS format too
    expect(byId.get('tool:note')?.kbd).toBe('N')
    expect(
      commandEntry(ctx.registries.commands.get('canvas-ux.toggle-lock') as CommandSpec, ctx, 'mac')?.kbd,
    ).toBe('⇧⌘L')
    errors.mockRestore()
  })

  it('a read-only role gets only the commands it may run (readOnlyAllowed), and the read-only tools', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = boardCtx(true)
    const list = boardEntries(ctx, 'other')
    const commands = list.filter((e) => e.id.startsWith('cmd:'))
    expect(commands.length).toBeGreaterThan(5)
    for (const e of commands) {
      const cmd = ctx.registries.commands.get(e.id.slice(4)) as CommandSpec
      expect(cmd.readOnlyAllowed, e.id).toBe(true)
    }
    // editing commands are not in it at all (not even disabled)
    for (const id of [
      'canvas-ux.delete',
      'canvas-ux.toggle-lock',
      'canvas-ux.align-left',
      'navigation.arrange-grid',
    ])
      expect(
        list.some((e) => e.id === `cmd:${id}`),
        id,
      ).toBe(false)
    expect(list.filter((e) => e.id.startsWith('tool:')).map((e) => e.id)).toEqual(
      expect.arrayContaining(['tool:select', 'tool:hand']),
    )
    expect(list.some((e) => e.id === 'tool:note')).toBe(false)
    // no templates for a read-only role
    expect(list.some((e) => e.id.startsWith('template:'))).toBe(false)
    errors.mockRestore()
  })

  it('a disabled command is listed with its reason, cannot be chosen, and runCommand refuses it', () => {
    let ran = 0
    const reasoned: CommandSpec = {
      id: 'test.distribute',
      label: 'Distribute evenly',
      disabledReason: () => 'Select three or more objects',
      run: () => void ran++,
    }
    const plain: CommandSpec = {
      id: 'test.plain',
      label: 'Plain',
      enabled: () => false,
      run: () => void ran++,
    }
    const editOnly: CommandSpec = { id: 'test.edit', label: 'Edit only', run: () => void ran++ }
    const ctx = boardCtx(false, [reasoned, plain, editOnly])
    const e = commandEntry(reasoned, ctx) as PaletteEntry
    expect(e.disabledReason).toBe('Select three or more objects')
    const chosen = chooseEntry(e)
    expect(chosen).toEqual({ run: false, status: 'Distribute evenly: Select three or more objects' })
    // even run directly, the palette's line goes through runCommand, which refuses it
    e.run()
    expect(ran).toBe(0)
    const p = commandEntry(plain, ctx) as PaletteEntry
    expect(p.disabledReason).toBe(NOT_NOW)
    expect(chooseEntry(p).run).toBe(false)
    // a runnable one runs (through runCommand, source 'palette')
    const ok = commandEntry(editOnly, ctx) as PaletteEntry
    expect(ok.disabledReason).toBeNull()
    expect(chooseEntry(ok)).toEqual({ run: true })
    ok.run()
    expect(ran).toBe(1)
    // a read-only role never sees an editing command; the reason it would get is the read-only one
    expect(commandEntry(editOnly, boardCtx(true, [editOnly]))).toBeNull()
    expect(READ_ONLY_REASON).toMatch(/view this board/)
  })

  it('one feature whose state read throws does not break the palette: its line says it is not available', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: CommandSpec = {
      id: 'test.broken',
      label: 'Broken',
      enabled: () => {
        throw new Error('boom')
      },
      run: () => {},
    }
    const ctx = boardCtx(false, [broken])
    expect(commandEntry(broken, ctx)?.disabledReason).toBe(NOT_NOW)
    errors.mockRestore()
  })

  it('frames come in presentation order; a pick goes to the frame without selecting it', () => {
    const frames = [
      { id: 'f2', type: 'frame', name: 'Retro', x: 900, y: 0, width: 400, height: 300 },
      { id: 'f1', type: 'frame', name: 'Ideas', x: 0, y: 0, width: 400, height: 300 },
    ].map((f) => ({ angle: 0, groupIds: [], frameId: null, locked: false, isDeleted: false, ...f }))
    const selected: string[][] = []
    const ctx = {
      canvas: {
        items: () => frames,
        get: (id: string) => frames.find((f) => f.id === id),
        bounds: (id: string) => frames.find((f) => f.id === id) ?? null,
        select: (ids: string[]) => selected.push(ids),
        viewport: { zoomTo: () => {}, get: () => ({ x: 0, y: 0, width: 100, height: 100, zoom: 1 }) },
      },
    } as unknown as CanvasFeatureContext
    const list = frameEntries(ctx)
    expect(list.map((f) => f.label)).toEqual(['Ideas', 'Retro'])
    expect(list.map((f) => f.group)).toEqual(['Frames', 'Frames'])
  })
})

describe('recents (per viewer, try/catch storage)', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }

  it('keeps the latest first, without repeats, at most RECENTS_MAX, per viewer', () => {
    const s = memory()
    for (let i = 0; i < 20; i++) pushRecent('usr_a', `cmd:${i}`, s)
    pushRecent('usr_a', 'cmd:3', s)
    const list = readRecents('usr_a', s)
    expect(list[0]).toBe('cmd:3')
    expect(list).toHaveLength(RECENTS_MAX)
    expect(new Set(list).size).toBe(list.length)
    expect(readRecents('usr_b', s)).toEqual([])
  })

  it('a storage that throws, is missing or holds junk gives no recents and never throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readRecents('usr_a', throwing)).toEqual([])
    expect(() => pushRecent('usr_a', 'cmd:x', throwing)).not.toThrow()
    expect(readRecents('usr_a', null)).toEqual([])
    expect(readRecents('usr_a', { getItem: () => '{"not":"a list"}' })).toEqual([])
    expect(readRecents('usr_a', { getItem: () => 'not json' })).toEqual([])
  })
})

describe('the workspace hits', () => {
  const group = (id: string, title: string, objects: string[]): SearchBoardGroup => ({
    board: { id, title, projectId: null, status: 'active' },
    hits: objects.map((o) => ({
      kind: 'note',
      objectId: `shape:${o}`,
      pageId: null,
      cutStart: false,
      cutEnd: true,
      snippet: [
        { text: 'Book the ', hit: false },
        { text: 'quokka', hit: true },
        { text: ' venue', hit: false },
      ],
    })),
    more: 0,
    truncated: false,
  })

  it('leave this board out (its own group has them), and open the other board at the object (?el=)', () => {
    const opened: string[] = []
    const list = workspaceEntries(
      [group('brd-here', 'Here', ['a1']), group('brd-there', 'There', ['b1', 'b2'])],
      'brd-here',
      (href) => opened.push(href),
    )
    expect(list.map((e) => e.id)).toEqual(['ws:brd-there:shape:b1', 'ws:brd-there:shape:b2'])
    expect(list[0]?.label).toBe('Book the quokka venue…')
    expect(list[0]?.detail).toBe('Note · There')
    list[0]?.run()
    expect(opened).toEqual(['/b/brd-there?el=b1'])
  })
})

describe('Ctrl/Cmd+K off the board (the dashboard): the board claim’s reading, the platform’s command key', () => {
  const k = (key: string, code: string, m: Partial<PaletteKeyLike> = {}): PaletteKeyLike => ({
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...m,
  })
  it('agrees with the board’s claim (waveLKeyClaimOf) on every layout case, Ctrl off a Mac and Cmd on one', () => {
    const cases = [
      k('k', 'KeyK'),
      k('K', 'KeyK'),
      k('k', 'KeyV'),
      k('t', 'KeyK'),
      k('л', 'KeyK'),
      k('л', 'KeyQ'),
      k('k', 'KeyK', { shiftKey: true }),
      k('k', 'KeyK', { altKey: true }),
      k('k', 'KeyK', { altKey: true, altGraph: true }),
      k('k', 'KeyK', { isComposing: true }),
      k('Process', 'KeyK'),
    ]
    for (const c of cases) {
      for (const mac of [false, true]) {
        const e = { ...c, ...(mac ? { metaKey: true } : { ctrlKey: true }) }
        expect(isPaletteKey(e, mac), `${JSON.stringify(e)} mac ${mac}`).toBe(waveLKeyClaimOf(e) === 'palette')
      }
    }
    // the other command key is not it (a Mac's Ctrl+K kills a line in a text field)
    expect(isPaletteKey(k('k', 'KeyK', { ctrlKey: true }), true)).toBe(false)
    expect(isPaletteKey(k('k', 'KeyK', { metaKey: true }), false)).toBe(false)
    expect(isPaletteKey(k('k', 'KeyK'), false)).toBe(false)
  })
})
