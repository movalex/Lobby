// canvas-ux's rules on the Excalidraw canvas that need no browser (the tldraw page's ../ui-defaults.test.ts
// and friends): when the style panel shows (RETRO-20, R16), the defaults (MAK-02, PRI-13), the export gate's
// rules, how the menus resolve and gate their entries (F20's plain labels; DANA-13 no Language; no debug).
import { describe, expect, it } from 'vitest'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  createFeatureRegistries,
  type MenuEntrySpec,
  type MenuTarget,
} from '../../../canvas/api/index.ts'
import { closeFeedback, feedbackRequest } from '../../feedback/state.ts'
import { CONTEXT_MENU_ENTRIES, EXPORT_OFF_ENTRY, gatedEntries } from './ContextMenu.tsx'
import { COMMANDS } from './commands.ts'
import { applySnapDefault, SNAP_DEFAULT_KEY, startToolFor } from './defaults.ts'
import { blocksNativeCopy, exportAllowedWith, exportGate } from './export-gate.ts'
import { mainMenuRows } from './MainMenu.tsx'
import { groupRows, type MenuRow, resolveEntry } from './Menu.tsx'
import { kindOf, sharedOf, showStylePanel } from './StylePanel.tsx'

describe('style panel visibility (RETRO-20, R16)', () => {
  it('shows for a selection or a creation tool whose next shape it sets; never for frames only', () => {
    expect(showStylePanel([], 'select')).toBe(false)
    expect(showStylePanel([], 'rectangle')).toBe(true)
    expect(showStylePanel([], 'freedraw')).toBe(true)
    expect(showStylePanel([], 'text')).toBe(true)
    // CR-3A-7: the note tool's next note takes the note colour, size and font picked in the panel
    expect(showStylePanel([], 'note')).toBe(true)
    expect(showStylePanel(['note'], 'select')).toBe(true)
    expect(showStylePanel(['frame', 'frame'], 'select')).toBe(false)
    expect(showStylePanel(['frame', 'note'], 'select')).toBe(true)
  })
  it('P-017: a link card or a board card is a card, not a shape: no shape styles for it (alone or with a frame)', () => {
    const rect = (kind?: string) =>
      ({ id: 'r', type: 'rectangle', customData: kind ? { lobby: { kind } } : undefined }) as never
    expect(kindOf(rect('link-card'))).toBe('card')
    expect(kindOf(rect('board-card'))).toBe('card')
    expect(kindOf(rect())).toBe('shape')
    expect(showStylePanel(['card'], 'select')).toBe(false)
    expect(showStylePanel(['card', 'frame'], 'select')).toBe(false)
    expect(showStylePanel(['card', 'note'], 'select')).toBe(true)
  })
  it('a control reads mixed only when the values differ, null for a value outside the vocabulary', () => {
    expect(sharedOf([])).toBeUndefined()
    expect(sharedOf(['a', 'a'])).toBe('a')
    expect(sharedOf(['a', 'b'])).toBe('mixed')
    expect(sharedOf([null])).toBeNull()
    expect(sharedOf(['a', null])).toBe('mixed')
  })
})

describe('defaults', () => {
  const memory = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init))
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      m,
    }
  }
  const canvas = (snap: boolean) => {
    const state = { snap }
    return {
      state,
      settings: {
        get: () => ({ grid: false, snap: state.snap, focusMode: false }),
        set: (p: { snap?: boolean }) => {
          if (p.snap !== undefined) state.snap = p.snap
        },
      },
    }
  }
  it('MAK-02: snapping turns on once per browser; a later off stays off', () => {
    const store = memory()
    const c = canvas(false)
    expect(applySnapDefault(c as never, store)).toBe(true)
    expect(c.state.snap).toBe(true)
    expect(store.m.get(SNAP_DEFAULT_KEY)).toBe('1')
    c.state.snap = false
    expect(applySnapDefault(c as never, store)).toBe(false)
    expect(c.state.snap).toBe(false)
    // blocked storage: applied, harmlessly, every time
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(applySnapDefault(canvas(false) as never, blocked)).toBe(true)
  })
  it('PRI-13: read-only people on a touch-first device start on the Hand tool', () => {
    expect(startToolFor({ coarsePointer: true, readonly: true })).toBe('hand')
    expect(startToolFor({ coarsePointer: true, readonly: false })).toBeNull()
    expect(startToolFor({ coarsePointer: false, readonly: true })).toBeNull()
  })
})

describe('export gate', () => {
  it('an unknown role allows once the policy is known; editors may; viewers may not under editors; a name-only guest never', () => {
    expect(exportAllowedWith(null, 'editors', null)).toBe(true)
    // wave K.1: an unknown policy is closed for a viewer (it allowed before)
    expect(exportAllowedWith('viewer', null, null)).toBe(false)
    expect(exportAllowedWith('viewer', 'editors', false)).toBe(false)
    expect(exportAllowedWith('editor', 'editors', false)).toBe(true)
    expect(exportAllowedWith('editor', 'editors', true)).toBe(false)
    expect(exportAllowedWith('viewer', 'everyone', false)).toBe(true)
    // audit L3: a name-only guest is limited under 'everyone' too; only 'everyone-including-guests' lets them
    expect(exportAllowedWith('editor', 'everyone', true)).toBe(false)
    expect(exportAllowedWith('editor', 'everyone-including-guests', true)).toBe(true)
  })
  it('CR-3A-4, wave K.1: while the policy is still loading only the owner and editors who are not name-only guests are let through', () => {
    expect(exportAllowedWith('editor', null, true)).toBe(false)
    expect(exportAllowedWith('commenter', null, true)).toBe(false)
    expect(exportAllowedWith(null, null, true)).toBe(false)
    expect(exportAllowedWith('editor', null, false)).toBe(true)
    expect(exportAllowedWith('editor', null, null)).toBe(true)
    expect(exportAllowedWith('owner', null, null)).toBe(true)
    // K.1: viewers, commenters and an unknown role wait for the answer (they were let through before)
    expect(exportAllowedWith('viewer', null, false)).toBe(false)
    expect(exportAllowedWith('commenter', null, false)).toBe(false)
    expect(exportAllowedWith('viewer', null, null)).toBe(false)
    expect(exportAllowedWith(null, null, null)).toBe(false)
    // the first answer decides, for the guest too
    expect(exportAllowedWith('editor', 'everyone-including-guests', true)).toBe(true)
    expect(exportAllowedWith('editor', 'everyone', true)).toBe(false)
  })
  it('stops a copy of the selection only, never text in a field', () => {
    const base = { allowed: false, onBoard: true, editing: false, selected: 1, inEditable: false }
    expect(blocksNativeCopy(base)).toBe(true)
    expect(blocksNativeCopy({ ...base, allowed: true })).toBe(false)
    expect(blocksNativeCopy({ ...base, inEditable: true })).toBe(false)
    expect(blocksNativeCopy({ ...base, editing: true })).toBe(false)
    expect(blocksNativeCopy({ ...base, selected: 0 })).toBe(false)
    expect(blocksNativeCopy({ ...base, onBoard: false })).toBe(false)
  })
})

// ---- menus -------------------------------------------------------------------------------------------------

function ctxWith(opts: { readOnly?: boolean; selection?: string[]; policy?: 'editors' | 'everyone' } = {}) {
  const registries = createFeatureRegistries()
  for (const c of COMMANDS) registries.commands.register(c)
  const board = { id: `b-${Math.random()}`, status: 'active' }
  if (opts.policy) exportGate(board.id).policy.set(opts.policy)
  const canvas = {
    readOnly: () => opts.readOnly ?? false,
    selection: opts.selection ?? [],
    get: (id: string) => ({ id, type: 'rectangle', groupIds: [], locked: false, isDeleted: false }),
    items: () => (opts.selection ?? []).map((id) => ({ id, type: 'rectangle', groupIds: [], locked: false })),
    history: { canUndo: () => false, canRedo: () => false },
    settings: { get: () => ({ grid: false, snap: true, focusMode: false }) },
    doc: { get: () => undefined },
  }
  return {
    registries,
    board,
    role: opts.readOnly ? 'viewer' : 'editor',
    canvas,
  } as unknown as CanvasFeatureContext
}
const target: MenuTarget = { ids: [], point: null, hit: null }
const ids = (rows: readonly (readonly MenuRow[])[]) => rows.map((g) => g.map((r) => r.id))

describe('menus', () => {
  it('an entry that names a command shows its label and first key and follows its enabled rule', () => {
    const cmd: CommandSpec = {
      id: 'x.cmd',
      label: 'Do it',
      kbd: ['mod+k'],
      enabled: () => false,
      run: () => {},
    }
    const ctx = ctxWith()
    ctx.registries.commands.register(cmd)
    const row = resolveEntry(
      { id: 'do', group: 'edit', order: 1, label: '', command: 'x.cmd' },
      ctx,
      target,
      'menu',
    )
    expect(row).toMatchObject({ id: 'do', label: 'Do it', kbd: 'mod+k', disabled: true })
    // an unknown command hides the entry; a read-only role disables a command not meant for it
    expect(
      resolveEntry(
        { id: 'no', group: 'edit', order: 1, label: 'No', command: 'x.none' },
        ctx,
        target,
        'menu',
      ),
    ).toBeNull()
    const ro = ctxWith({ readOnly: true })
    ro.registries.commands.register({ ...cmd, enabled: undefined })
    expect(
      resolveEntry({ id: 'do', group: 'edit', order: 1, label: '', command: 'x.cmd' }, ro, target, 'menu')
        ?.disabled,
    ).toBe(true)
  })

  it('groups follow MENU_GROUPS, then order; empty groups and submenus drop out', () => {
    const entries: MenuEntrySpec[] = [
      { id: 'b', group: 'danger', order: 1, label: 'B', run: () => {} },
      { id: 'a2', group: 'clipboard', order: 2, label: 'A2', run: () => {} },
      { id: 'a1', group: 'clipboard', order: 1, label: 'A1', run: () => {} },
      { id: 'hidden', group: 'edit', order: 1, label: 'H', visible: () => false, run: () => {} },
      {
        id: 'empty',
        group: 'edit',
        order: 2,
        label: 'E',
        submenu: [{ id: 'h', group: 'edit', order: 1, label: 'h', visible: () => false }],
      },
    ]
    expect(ids(groupRows(entries, ctxWith(), target, 'menu'))).toEqual([['a1', 'a2'], ['b']])
  })

  it('the context menu for two shapes: tldraw’s plain Arrange labels (F20), no Unlock all while nothing is locked', () => {
    const ctx = ctxWith({ selection: ['r1', 'r2'] })
    for (const e of CONTEXT_MENU_ENTRIES) ctx.registries.contextMenu.register(e)
    const rows = groupRows(gatedEntries(ctx, ctx.registries.contextMenu.list()), ctx, target, 'context-menu')
    const all = rows.flat()
    expect(all.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'cut',
        'copy',
        'duplicate',
        'group',
        'toggle-lock',
        'delete',
        'arrange',
        'reorder',
        'select-all',
      ]),
    )
    expect(all.find((r) => r.id === 'unlock-all')).toBeUndefined()
    const arrange = all
      .find((r) => r.id === 'arrange')
      ?.submenu?.flat()
      .map((r) => r.label)
    expect(arrange).toEqual([
      'Align left',
      'Align horizontally',
      'Align right',
      'Align top',
      'Align vertically',
      'Align bottom',
    ])
  })

  it('while exporting is off, the export group and copy give way to the one line', () => {
    const ctx = ctxWith({ readOnly: true, selection: ['r1'], policy: 'editors' })
    const entries: MenuEntrySpec[] = [
      ...CONTEXT_MENU_ENTRIES,
      { id: 'export-as-png', group: 'export', order: 1, label: 'Export as PNG', run: () => {} },
    ]
    const shown = gatedEntries(ctx, entries).map((e) => e.id)
    expect(shown).toContain(EXPORT_OFF_ENTRY.id)
    expect(shown).not.toContain('export-as-png')
    expect(shown).not.toContain('copy')
    const open = ctxWith({ selection: ['r1'], policy: 'everyone' })
    const allowed = gatedEntries(open, entries).map((e) => e.id)
    expect(allowed).toContain('export-as-png')
    expect(allowed).not.toContain(EXPORT_OFF_ENTRY.id)
  })

  it('the board menu: Board, Edit, then Preferences, Keyboard shortcuts and Send feedback; no Language, no debug mode', () => {
    const ctx = ctxWith()
    ctx.registries.mainMenu.register({
      id: 'dr-go-to-start-view',
      group: 'board',
      order: 10,
      label: 'Go to start view',
      run: () => {},
    })
    const rows = mainMenuRows(ctx)
    const top = rows.flat().map((r) => r.id)
    expect(top).toEqual(['dr-board', 'preferences', 'keyboard-shortcuts', 'feedback'])
    const prefs = rows
      .flat()
      .find((r) => r.id === 'preferences')
      ?.submenu?.flat()
      .map((r) => r.label)
    // W5-33: Input device (the wheel preference, CR-W5-3A-4) sits with the other canvas preferences
    expect(prefs).toEqual(['Always snap', 'Show grid', 'Input device'])
    const input = rows
      .flat()
      .find((r) => r.id === 'preferences')
      ?.submenu?.flat()
      .find((r) => r.id === 'input-device')
    expect(input?.submenu?.flat().map((r) => [r.id, r.label, r.checked])).toEqual([
      ['input-device-auto', 'Auto', false],
      ['input-device-mouse', 'Mouse (the wheel zooms)', false],
      ['input-device-trackpad', 'Trackpad (the wheel pans)', false],
    ])
    expect(JSON.stringify(rows)).not.toMatch(/language|debug/i)
  })
})

// P-027: what a phone's board menu leaves out (no keyboard to list shortcuts for, no mouse wheel to set)
describe('the board menu on a phone', () => {
  const withWidth = <T>(phone: boolean, run: () => T): T => {
    const g = globalThis as { window?: unknown }
    const before = Object.getOwnPropertyDescriptor(g, 'window')
    Object.defineProperty(g, 'window', {
      configurable: true,
      value: { matchMedia: (q: string) => ({ matches: phone && q === '(max-width: 600px)' }) },
    })
    try {
      return run()
    } finally {
      if (before) Object.defineProperty(g, 'window', before)
      else Reflect.deleteProperty(g, 'window')
    }
  }
  const idsOf = (phone: boolean) =>
    withWidth(phone, () => {
      const rows = mainMenuRows(ctxWith())
      const prefs = rows
        .flat()
        .find((r) => r.id === 'preferences')
        ?.submenu?.flat()
        .map((r) => r.id)
      return { top: rows.flat().map((r) => r.id), prefs }
    })

  it('has no Keyboard shortcuts row and no Input device, but keeps Preferences and Send feedback', () => {
    const phone = idsOf(true)
    expect(phone.top).toContain('preferences')
    expect(phone.top).toContain('feedback')
    expect(phone.top).not.toContain('keyboard-shortcuts')
    expect(phone.prefs).not.toContain('input-device')
    expect(phone.prefs).toContain('toggle-grid')
  })

  it('a wider window keeps both', () => {
    const wide = idsOf(false)
    expect(wide.top).toContain('keyboard-shortcuts')
    expect(wide.prefs).toContain('input-device')
  })
})

// P-023: Send feedback is the team's, in the board menu as in the pill and the account menu
describe('the board menu’s Send feedback, for the people it is not offered to', () => {
  it('has no feedback row for a guest or an outsider, whatever the role', () => {
    for (const readOnly of [false, true]) {
      const ids = mainMenuRows(ctxWith({ readOnly }), false)
        .flat()
        .map((r) => r.id)
      expect(ids, String(readOnly)).not.toContain('feedback')
      expect(ids, String(readOnly)).toContain('preferences')
    }
  })
})

// Wave J5: the Send feedback button, in the board menu for everybody (a viewer or a commenter has things to report).
describe('the board menu’s Send feedback', () => {
  it('opens the feedback dialog for this board, enabled for every role, and gives the keyboard back to the board', () => {
    for (const readOnly of [false, true]) {
      const ctx = ctxWith({ readOnly })
      let focused = 0
      ;(ctx.canvas as unknown as { focus(): void }).focus = () => {
        focused++
      }
      ;(ctx.board as { title?: string }).title = 'Q4 plan'
      const row = mainMenuRows(ctx)
        .flat()
        .find((r) => r.id === 'feedback')
      expect(row?.label, String(readOnly)).toBe('Send feedback')
      expect(row?.disabled).toBe(false)
      expect(feedbackRequest.get()).toBeNull()
      row?.run?.()
      expect(feedbackRequest.get()?.board).toEqual({ id: ctx.board.id, title: 'Q4 plan' })
      expect(focused).toBe(0)
      feedbackRequest.get()?.restoreFocus?.()
      expect(focused).toBe(1)
      closeFeedback()
    }
  })
})
