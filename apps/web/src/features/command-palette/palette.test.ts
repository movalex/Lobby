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
import { commandEntries } from '../ai/command/provider.ts'
import { CANVAS_FEATURES } from '../canvas-registry.ts'
import {
  boardEntries,
  commandEntry,
  frameEntries,
  NOT_NOW,
  PALETTE_COMMAND_ID,
  READ_ONLY_REASON,
  STARTERS,
} from './board-index.ts'
import { isPaletteKey, type PaletteKeyLike } from './keys.ts'
import { chooseEntry, type PaletteEntry, pushRecent, RECENTS_MAX, readRecents } from './model.ts'
import { firstActiveLine, paletteSections, TRY_SECTION, UNAVAILABLE_SECTION } from './Palette.tsx'
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
  'Lock or unlock',
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
    expect(top('lock')).toBe('Lock or unlock')
    expect(top('kbd')).toBeDefined()
    expect(top('shortcuts')).toBe('Keyboard shortcuts')
    expect(top('minimap')).toBe('Show / hide minimap')
  })

  it('an exact label beats a prefix, a prefix beats a word inside, a word beats a fuzzy run', () => {
    const q = fold('group')
    expect(scoreEntry(q, 'Group')).toBeGreaterThan(scoreEntry(q, 'Group into themes'))
    expect(scoreEntry(q, 'Group into themes')).toBeGreaterThan(scoreEntry(q, 'Ungroup'))
    expect(scoreEntry('unlock', 'Unlock all')).toBeGreaterThan(scoreEntry('unlock', 'Lock or unlock'))
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

interface FakeEl {
  id: string
  x: number
  y: number
  width: number
  height: number
  [key: string]: unknown
}

function fakePort(els: readonly FakeEl[] = []): CanvasPort {
  const noop = () => {}
  return {
    items: () => els as never,
    get: (id: string) => els.find((e) => e.id === id) as never,
    bounds: (id: string) => els.find((e) => e.id === id) ?? null,
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
function boardCtx(
  readOnly: boolean,
  extra: readonly CommandSpec[] = [],
  els: Parameters<typeof fakePort>[0] = [],
): CanvasFeatureContext {
  const registries = createFeatureRegistries()
  for (const f of CANVAS_FEATURES) {
    for (const c of f.commands ?? []) registries.commands.register(c)
    for (const t of f.tools ?? []) registries.tools.register(t)
  }
  for (const c of extra) registries.commands.register(c)
  const { canvas } = createLobbyCanvas({ port: fakePort(els), registries })
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

// ---- M3-2: an empty palette starts with Try; the exact command beats a guessed frame name ---------------------------------

/** A command that is on and runs, for the lines wave L's features register only when AI is on. */
const on = (id: string, label: string, over: Partial<CommandSpec> = {}): CommandSpec => ({
  id,
  label,
  enabled: () => true,
  readOnlyAllowed: true,
  run: () => {},
  ...over,
})

describe('the empty palette (M3-2, FTU-4.3, FTU-12)', () => {
  const askOn = [
    on('ai.ask', 'Ask this board'),
    on('flow.diagram', 'Diagram from words…', { readOnlyAllowed: false }),
  ]

  it('starts with Try: what wave L offers, in order, under the words that say what each does', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const list = boardEntries(boardCtx(false, askOn), 'other')
    const sections = paletteSections(list, '', [])
    expect(sections[0]?.id).toBe(TRY_SECTION)
    expect(sections[0]?.title).toBe('Try')
    const labels = sections[0]?.entries.map((e) => e.label) ?? []
    // the ones that can run come first; the order is STARTERS'
    expect(labels).toEqual(
      expect.arrayContaining(['Wrap up this board', 'Ask this board', 'Diagram from words']),
    )
    // the ones that can run, in STARTERS order, then the ones with a reason (Sort needs notes selected)
    const rankOf = (e: PaletteEntry) => STARTERS.findIndex((s) => s.id === e.id)
    const lines = sections[0]?.entries ?? []
    for (const part of [lines.filter((e) => !e.disabledReason), lines.filter((e) => !!e.disabledReason)]) {
      const ranks = part.map(rankOf)
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    }
    expect(lines.findIndex((e) => !!e.disabledReason)).toBeGreaterThan(
      lines.findLastIndex((e) => !e.disabledReason) - 1,
    )
    expect(labels.indexOf('Wrap up this board')).toBeLessThan(labels.indexOf('Ask this board'))
    expect(labels.indexOf('Ask this board')).toBeLessThan(labels.indexOf('Diagram from words'))
    for (const e of sections[0]?.entries ?? []) expect(e.detail, e.id).toBeTruthy()
    // the line keeps its own id (a pick is remembered under it, typing still finds it) and is not listed twice
    const all = sections.flatMap((s) => s.entries.map((e) => e.id))
    expect(all.filter((id) => id === 'cmd:ai.ask')).toHaveLength(1)
    // Undo and Redo no longer open the list
    expect(sections[0]?.entries.some((e) => e.id === 'cmd:canvas-ux.undo')).toBe(false)
    errors.mockRestore()
  })

  it('does not preselect a line: a reflex Ctrl/Cmd+K, Enter still runs nothing', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sections = paletteSections(boardEntries(boardCtx(false, askOn), 'other'), '', [])
    expect(sections[0]?.id).toBe(TRY_SECTION)
    expect(firstActiveLine(sections)).toBe(-1)
    // with a recent pick that can run, the first line is that pick, as before
    expect(
      firstActiveLine(paletteSections(boardEntries(boardCtx(false, askOn), 'other'), '', ['cmd:ai.recap'])),
    ).toBe(0)
    errors.mockRestore()
  })

  it('a pick that is in Recent is not listed again in Try', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const list = boardEntries(boardCtx(false, askOn), 'other')
    const sections = paletteSections(list, '', ['cmd:ai.recap'])
    expect(sections.map((s) => s.id).slice(0, 2)).toEqual(['recent', TRY_SECTION])
    expect(sections[1]?.entries.map((e) => e.id)).not.toContain('cmd:ai.recap')
    expect(sections[0]?.entries.map((e) => e.id)).toEqual(['cmd:ai.recap'])
    errors.mockRestore()
  })

  it('adds Ask all boards only when that command is registered and reports itself available', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tryIds = (extra: CommandSpec[]) =>
      paletteSections(boardEntries(boardCtx(false, [...askOn, ...extra]), 'other'), '', [])
        .find((s) => s.id === TRY_SECTION)
        ?.entries.map((e) => e.id)
    expect(tryIds([])).not.toContain('cmd:ai.askWorkspace')
    expect(tryIds([on('ai.askWorkspace', 'Ask all boards')])).toContain('cmd:ai.askWorkspace')
    // registered but off (a 404 seen, or no AI for the workspace): left out, not shown greyed
    expect(tryIds([on('ai.askWorkspace', 'Ask all boards', { enabled: () => false })])).not.toContain(
      'cmd:ai.askWorkspace',
    )
    errors.mockRestore()
  })

  it('a viewer’s Try has only what a viewer can do', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sections = paletteSections(boardEntries(boardCtx(true, askOn), 'other'), '', [])
    const ids = sections.find((s) => s.id === TRY_SECTION)?.entries.map((e) => e.id) ?? []
    expect(ids).toContain('cmd:ai.recap')
    expect(ids).toContain('cmd:ai.ask')
    // diagrams add to the board: not offered to a viewer
    expect(ids).not.toContain('cmd:flow.diagram')
    errors.mockRestore()
  })

  it('leaves the lines that cannot run out of the empty palette (no grey tail of "Not available right now")', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const list = boardEntries(boardCtx(false, askOn), 'other')
    const sections = paletteSections(list, '', [])
    expect(sections.map((s) => s.id)).not.toContain(UNAVAILABLE_SECTION)
    // outside Try, every line shown can run
    const rest = sections.filter((s) => s.id !== TRY_SECTION).flatMap((s) => s.entries)
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((e) => !e.disabledReason)).toBe(true)
    // inside Try, the ones that can run are first, and the ones that cannot keep their reasons
    const tryLines = sections.find((s) => s.id === TRY_SECTION)?.entries ?? []
    const firstOff = tryLines.findIndex((e) => !!e.disabledReason)
    if (firstOff >= 0) expect(tryLines.slice(firstOff).every((e) => !!e.disabledReason)).toBe(true)
    // every line is in at most one place; the ones left out are exactly lines that cannot run
    const placed = sections.flatMap((s) => s.entries.map((e) => e.id))
    expect(new Set(placed).size).toBe(placed.length)
    const left = list.filter((e) => !placed.includes(e.id))
    expect(left.length).toBeGreaterThan(5)
    for (const e of left) expect(e.disabledReason, e.id).toBeTruthy()
    errors.mockRestore()
  })

  it('typing finds a line that cannot run now, with its reason', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const list = boardEntries(boardCtx(false, askOn), 'other')
    const left = list.filter((e) => !!e.disabledReason && !e.starter)
    const hidden = left[0]
    expect(hidden).toBeDefined()
    if (!hidden) return
    const matches = paletteSections(list, hidden.label, []).find((s) => s.id === 'matches')
    expect(matches?.entries.map((e) => e.id)).toContain(hidden.id)
    errors.mockRestore()
  })

  it('a line the person picked before stays under Recent even when it cannot run now, with its reason', () => {
    const off = entry('Crop', { group: 'Media', disabledReason: 'Select a picture first' })
    const on = entry('Alpha', { group: 'One' })
    const sections = paletteSections([off, on], '', [off.recentKey as string])
    expect(sections.find((s) => s.id === UNAVAILABLE_SECTION)?.entries.map((e) => e.id)).toEqual([off.id])
    expect(sections.map((s) => s.id)).toEqual(['group:One', UNAVAILABLE_SECTION])
  })

  it('a palette whose lines mark no starters has no Try (the dashboard’s), and typing is the ranked list as before', () => {
    const a = entry('Alpha', { group: 'One' })
    const b = entry('Beta', { group: 'Two', disabledReason: 'Not today' })
    const sections = paletteSections([a, b], '', [])
    expect(sections.map((s) => s.id)).toEqual(['group:One'])
    expect(paletteSections([a, b], 'alp', []).map((s) => s.id)).toEqual(['matches'])
    // Beta cannot run now: typing finds it, with its reason
    const typed = paletteSections([a, b], 'bet', [])
    expect(typed[0]?.entries.map((e) => [e.label, e.disabledReason])).toEqual([['Beta', 'Not today']])
  })

  it('Undo and Redo show their keys, as Cut does (the engine takes the chords, so the registry has none)', () => {
    const ctx = boardCtx(false)
    const undo = commandEntry(ctx.registries.commands.get('canvas-ux.undo') as CommandSpec, ctx, 'other')
    const redo = commandEntry(ctx.registries.commands.get('canvas-ux.redo') as CommandSpec, ctx, 'other')
    expect(undo?.kbd).toBe('Ctrl+Z')
    expect(redo?.kbd).toBe('Ctrl+Shift+Z or Ctrl+Y')
    expect(commandEntry(ctx.registries.commands.get('canvas-ux.undo') as CommandSpec, ctx, 'mac')?.kbd).toBe(
      '⌘Z',
    )
    // the key is only shown: the registry still has no chord for it (a second handler would fight the engine's)
    expect(ctx.registries.commands.get('canvas-ux.undo')?.kbd).toBeUndefined()
  })

  it('"show grid" on a board with a “Grid ideas” frame ranks the Show grid command first, not the frame', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const frame = {
      id: 'f1',
      type: 'frame',
      name: 'Grid ideas',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      angle: 0,
      groupIds: [],
      frameId: null,
      locked: false,
      isDeleted: false,
    }
    const ctx = boardCtx(false, [], [frame])
    const typed = commandEntries(ctx, 'show grid')
    // the grammar does read “show grid” as “find the frame Grid ideas” (a guess), so a guessed line is there
    const guess = typed.find((e) => e.id === 'do:grammar')
    expect(guess?.label).toBe('Find frame “Grid ideas”')
    const ranked = rank([...typed, ...boardEntries(ctx, 'other')], 'show grid', [])
    expect(ranked[0]?.id).toBe('cmd:canvas-ux.toggle-grid')
    expect(ranked[0]?.label).toBe('Show grid')
    // the guess is still offered, right after the exact name
    expect(ranked.findIndex((e) => e.id === 'do:grammar')).toBeGreaterThan(0)
    expect(ranked.findIndex((e) => e.id === 'do:grammar')).toBeLessThan(5)
    // a phrase that is only the frame (no command of that name) still leads with it
    const retro = commandEntries(
      boardCtx(false, [], [{ ...frame, id: 'f2', name: 'Retro' }]),
      'zoom to retro',
    )
    expect(rank([...retro, ...boardEntries(boardCtx(false), 'other')], 'zoom to retro', [])[0]?.id).toBe(
      'do:grammar',
    )
    errors.mockRestore()
  })
})
