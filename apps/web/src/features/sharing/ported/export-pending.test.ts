// Wave K.1 (follow-up 4, K1-4): until the board's first export-policy answer, the board page fails closed. Before,
// the policy counted as 'everyone' until it arrived (up to HELLO_WAIT_MS for the stream's hello, then a read), so a
// viewer on an export-off board saw Export, Copy as PNG, the downloads and copy entries for a moment. Now, before
// the answer, only people no policy can limit get them: the owner, and an editor who is not a known name-only
// guest (every policy lets both export, so they see no change). Viewers, commenters, known name-only guests and
// anyone whose role is not known yet do not. Every gate on the board page follows the one rule
// (`boardExportAllowed`).
import type { ExportPolicy } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../api/client.ts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { downloadsAllowed } from '../../../file-card/ported/downloads.ts'
import type { BoardRole } from '../../../lib/permissions.ts'
import {
  exportAllowed as canvasUxAllowed,
  exportAllowedWith as canvasUxRule,
  exportAllowedOnBoard,
  exportGate,
} from '../../canvas-ux/ported/export-gate.ts'
import type { BoardEvents } from '../../events.ts'
import { exportAllowedHere } from '../../history/ported/export-allowed.ts'
import { watchExportPolicy } from '../../mindmap/ported/export-gate.ts'
import { exportAllowedWith as workshopsRule } from '../../workshops/ported/export-gate.ts'
import { boardExportAllowed } from '../export-rules.ts'
import { exportAllowedOn, exportStateOf } from './export-policy.ts'

/** A stream that never says hello: the first read waits, so the policy stays unknown for the whole test. */
const silentEvents = { on: () => () => {}, onResync: () => () => {} } as unknown as BoardEvents
const noApi = {
  request: () => new Promise(() => {}),
} as unknown as ApiClient

const ROLES: readonly (BoardRole | null)[] = ['owner', 'editor', 'commenter', 'viewer', null]

/** Who may export before the first answer: the owner, and an editor who is not a known name-only guest. */
const expected = (role: BoardRole | null, guest: boolean | null) =>
  role === 'owner' || (role === 'editor' && guest !== true)

describe('before the first export-policy answer the board page fails closed (K.1)', () => {
  it('the rule: only the owner and an editor with an account; once the policy is known, the policy decides', () => {
    for (const role of ROLES)
      for (const guest of [false, true, null])
        expect(boardExportAllowed(role, null, guest), `${role} guest=${guest}`).toBe(
          role === 'owner' || expected(role, guest),
        )
    // the owner is never a name-only guest: an unknown kind does not hide the owner's entries
    expect(boardExportAllowed('owner', null, null)).toBe(true)
    // known policies, as before
    const known: [BoardRole | null, ExportPolicy, boolean | null, boolean][] = [
      ['viewer', 'everyone', false, true],
      ['viewer', 'editors', false, false],
      ['editor', 'editors', false, true],
      ['editor', 'everyone', true, false],
      ['viewer', 'everyone-including-guests', true, true],
      [null, 'editors', null, true],
    ]
    for (const [role, policy, guest, want] of known)
      expect(boardExportAllowed(role, policy, guest), `${role} ${policy} ${guest}`).toBe(want)
  })

  it('every gate on the board page follows it: sharing, canvas-ux (menus and Ctrl+C), history, workshops, the mind map, the file cards', () => {
    for (const role of ROLES.filter((r): r is BoardRole => r !== null)) {
      const boardId = `b-pending-${role}`
      const s = exportStateOf(boardId)
      expect(s.policy.get()).toBeNull()
      s.role.set(role)
      s.guest.set(false)
      exportGate(boardId).guest.set(false)
      const want = expected(role, false)
      const ctx = {
        board: { id: boardId, title: 'Board' },
        role,
        me: { user: { id: 'usr_pending', name: 'Test' } },
        api: noApi,
        events: silentEvents,
        notify: () => {},
      } as unknown as CanvasFeatureContext
      expect(exportAllowedOn(boardId), `sharing ${role}`).toBe(want)
      expect(canvasUxAllowed(ctx), `canvas-ux menus ${role}`).toBe(want)
      expect(exportAllowedOnBoard(boardId, role, false), `canvas-ux copy ${role}`).toBe(want)
      expect(canvasUxRule(role, null, false), `canvas-ux rule ${role}`).toBe(want)
      expect(exportAllowedHere(role, null, false), `history ${role}`).toBe(want)
      expect(workshopsRule(role, null, false), `workshops ${role}`).toBe(want)
      expect(downloadsAllowed(ctx, false), `file cards ${role}`).toBe(want)
      const mindmap = watchExportPolicy(ctx)
      expect(mindmap.allowed(), `mind map ${role}`).toBe(want)
      mindmap.dispose()
    }
  })

  it('a name-only guest (an editor through a workshop link) gets nothing before the answer, whatever the gate', () => {
    const boardId = 'b-pending-guest'
    const s = exportStateOf(boardId)
    s.role.set('editor')
    s.guest.set(true)
    exportGate(boardId).guest.set(true)
    expect(exportAllowedOn(boardId)).toBe(false)
    expect(exportAllowedOnBoard(boardId, 'editor', true)).toBe(false)
    expect(exportAllowedHere('editor', null, true)).toBe(false)
  })
})

describe('while the policy is unknown nothing says exporting is off (K.1)', () => {
  it('the menus drop the entries without the "turned off" line; a copy says it is still being checked', async () => {
    const { EXPORT_OFF_ENTRY } = await import('../../canvas-ux/ported/ContextMenu.tsx')
    const { notifyExportOff } = await import('../../canvas-ux/ported/export-gate.ts')
    const { EXPORT_PENDING_TEXT, EXPORT_OFF_TEXT } = await import('../export-rules.ts')
    const boardId = 'b-pending-line'
    const notices: { text: string; testId?: string }[] = []
    const ctx = {
      board: { id: boardId },
      role: 'viewer',
      canvas: { items: () => [{ id: 'n1' }] },
      notify: (n: { text: string; testId?: string }) => notices.push(n),
    } as unknown as CanvasFeatureContext
    exportGate(boardId).guest.set(false)
    expect(canvasUxAllowed(ctx)).toBe(false)
    expect(EXPORT_OFF_ENTRY.visible?.(ctx, { ids: [], point: null, hit: null })).toBe(false)
    notifyExportOff(ctx)
    expect(notices.at(-1)).toMatchObject({ text: EXPORT_PENDING_TEXT, testId: 'export-pending-notice' })
    // the answer: exporting is off for viewers here; now the line shows and the notice says so
    exportStateOf(boardId).policy.set('editors')
    expect(EXPORT_OFF_ENTRY.visible?.(ctx, { ids: [], point: null, hit: null })).toBe(true)
    notifyExportOff(ctx)
    expect(notices.at(-1)).toMatchObject({ text: EXPORT_OFF_TEXT, testId: 'export-off-notice' })
  })
})
