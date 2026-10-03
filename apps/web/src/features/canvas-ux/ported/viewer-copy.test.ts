// CR-3A-4: Copy for viewers and commenters, as far as the export policy lets them (the rule the board
// session's input layer and the menus share: export-gate.ts exportAllowedOnBoard, ContextMenu.tsx, commands.ts).
import { describe, expect, it } from 'vitest'
import {
  type CanvasFeatureContext,
  createFeatureRegistries,
  type MenuTarget,
} from '../../../canvas/api/index.ts'
import { CONTEXT_MENU_ENTRIES, gatedEntries } from './ContextMenu.tsx'
import { COMMANDS } from './commands.ts'
import { exportAllowedOnBoard, exportGate } from './export-gate.ts'
import { groupRows } from './Menu.tsx'

let seq = 0
/**
 * A viewer's (or editor's) canvas with one element selected (a note with words, or with `text: ''` a
 * rectangle with none), on a board with `policy`.
 */
function ctxOf(opts: {
  readOnly: boolean
  policy?: 'editors' | 'everyone' | 'everyone-including-guests'
  text?: string
}) {
  const registries = createFeatureRegistries()
  for (const c of COMMANDS) registries.commands.register(c)
  const board = { id: `viewer-copy-${++seq}`, status: 'active' }
  if (opts.policy) exportGate(board.id).policy.set(opts.policy)
  const words = opts.text ?? 'Call the client'
  const el = (id: string) => ({
    id,
    type: 'rectangle',
    groupIds: [],
    locked: false,
    isDeleted: false,
    frameId: null,
    containerId: null,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  })
  const canvas = {
    readOnly: () => opts.readOnly,
    selection: ['r1'],
    get: (id: string) => el(id),
    items: () => [el('r1')],
    isHidden: () => false,
    text: { of: (id: string) => (id === 'r1' ? words : '') },
    history: { canUndo: () => false, canRedo: () => false },
    settings: { get: () => ({ grid: false, snap: false, focusMode: false }) },
    doc: { get: () => undefined },
  }
  return {
    registries,
    board,
    role: opts.readOnly ? 'viewer' : 'editor',
    canvas,
  } as unknown as CanvasFeatureContext
}
const target: MenuTarget = { ids: ['r1'], point: null, hit: null }

/** The context menu's rows for `ctx`, as the menu draws them. */
function contextMenu(ctx: CanvasFeatureContext) {
  for (const e of CONTEXT_MENU_ENTRIES) ctx.registries.contextMenu.register(e)
  return groupRows(gatedEntries(ctx, ctx.registries.contextMenu.list()), ctx, target, 'context-menu').flat()
}

describe('exportAllowedOnBoard (what the input layer asks before it lets a copy through)', () => {
  it('follows the policy for each role, and a name-only guest only under everyone-including-guests', () => {
    const board = 'viewer-copy-rule'
    const policy = exportGate(board).policy
    // no answer yet: counts as 'everyone' (the menus do not flash disabled)
    expect(exportAllowedOnBoard(board, 'viewer', false)).toBe(true)
    policy.set('everyone')
    for (const role of ['viewer', 'commenter', 'editor', 'owner'] as const)
      expect(exportAllowedOnBoard(board, role, false), role).toBe(true)
    policy.set('editors')
    expect(exportAllowedOnBoard(board, 'viewer', false)).toBe(false)
    expect(exportAllowedOnBoard(board, 'commenter', false)).toBe(false)
    expect(exportAllowedOnBoard(board, 'editor', false)).toBe(true)
    expect(exportAllowedOnBoard(board, 'owner', false)).toBe(true)
    // audit L3: a name-only guest is limited under 'everyone' too, whatever their role
    policy.set('everyone')
    expect(exportAllowedOnBoard(board, 'commenter', true)).toBe(false)
    expect(exportAllowedOnBoard(board, 'editor', true)).toBe(false)
    policy.set('everyone-including-guests')
    expect(exportAllowedOnBoard(board, 'commenter', true)).toBe(true)
  })

  it('a guest the gate already knows is a guest even when the session has not said so', () => {
    const board = 'viewer-copy-known-guest'
    const g = exportGate(board)
    g.policy.set('everyone')
    g.guest.set(true)
    expect(exportAllowedOnBoard(board, 'commenter', false)).toBe(false)
    g.guest.set(false)
    expect(exportAllowedOnBoard(board, 'commenter', false)).toBe(true)
  })

  it('CR-3A-4: before the first policy answer a name-only guest cannot copy (the session’s word or the gate’s); an account can', () => {
    const board = 'viewer-copy-policy-loading'
    const g = exportGate(board)
    expect(g.policy.get()).toBeNull()
    expect(exportAllowedOnBoard(board, 'editor', true)).toBe(false)
    expect(exportAllowedOnBoard(board, 'commenter', true)).toBe(false)
    expect(exportAllowedOnBoard(board, 'editor', false)).toBe(true)
    g.guest.set(true) // the gate learns it from the session's user kind
    expect(exportAllowedOnBoard(board, 'editor', false)).toBe(false)
    g.guest.set(false)
    expect(exportAllowedOnBoard(board, 'editor', false)).toBe(true)
    // the answer arrives: guests follow the policy like everyone
    g.guest.set(true)
    g.policy.set('everyone-including-guests')
    expect(exportAllowedOnBoard(board, 'editor', true)).toBe(true)
    g.policy.set('everyone')
    expect(exportAllowedOnBoard(board, 'editor', true)).toBe(false)
  })

  it('no role: allowed until known (the first answer decides)', () => {
    expect(exportAllowedOnBoard('viewer-copy-no-role', null, false)).toBe(true)
  })
})

describe('the context menu’s Copy for a read-only canvas', () => {
  it('shows an enabled Copy for a viewer while exporting is allowed, and none (only the one line) while it is off', () => {
    const open = contextMenu(ctxOf({ readOnly: true, policy: 'everyone' }))
    expect(open.find((r) => r.id === 'copy')).toMatchObject({ id: 'copy', disabled: false })
    // the rest of the editing entries stay editors'
    expect(open.map((r) => r.id)).not.toContain('cut')
    expect(open.map((r) => r.id)).not.toContain('duplicate')
    const off = contextMenu(ctxOf({ readOnly: true, policy: 'editors' }))
    expect(off.map((r) => r.id)).not.toContain('copy')
    expect(off.map((r) => r.id)).toContain('dr-export-off')
  })

  it('CR-3A-4: a viewer’s menu shows Copy only when the selection has words to copy', () => {
    const rows = (text: string) => contextMenu(ctxOf({ readOnly: true, policy: 'everyone', text }))
    expect(rows('Call the client').map((r) => r.id)).toContain('copy')
    // a rectangle, an image, a blank note: nothing to copy, so no Copy that does nothing
    for (const none of ['', '   ', '\n']) expect(rows(none).map((r) => r.id)).not.toContain('copy')
    // editors copy the elements themselves: Copy stays whatever the selection says
    expect(contextMenu(ctxOf({ readOnly: false, policy: 'everyone', text: '' })).map((r) => r.id)).toContain(
      'copy',
    )
    // and the command (the main menu's Copy) follows the same rule
    const copy = COMMANDS.find((c) => c.id === 'canvas-ux.copy')
    expect(copy?.enabled?.(ctxOf({ readOnly: true, policy: 'everyone', text: '' }))).toBe(false)
    expect(copy?.enabled?.(ctxOf({ readOnly: true, policy: 'everyone', text: 'words' }))).toBe(true)
  })

  it('an editor keeps Copy under both policies the gate lets them through', () => {
    expect(
      contextMenu(ctxOf({ readOnly: false, policy: 'everyone' })).find((r) => r.id === 'copy'),
    ).toMatchObject({ disabled: false })
  })

  it('Copy is the one clipboard command a read-only role may run', () => {
    const readOnly = COMMANDS.filter((c) => c.readOnlyAllowed).map((c) => c.label)
    expect(readOnly).toContain('Copy')
    expect(readOnly).not.toContain('Cut')
    expect(readOnly).not.toContain('Paste')
  })
})
