// The client side of export-control (docs/WAVE3-CONTRACTS.md): the per-board store, how it is fed
// (first answer, board events, resyncs) and the gates that read it (tldraw actions, copy, the export
// controller). The api enforces on its own; these are what keep the UI honest about it.

import type { ExportPolicyState } from '@draftroom/contracts'
import type { Editor, TLUiActionItem, TLUiActionsContextType } from 'tldraw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import { blocksNativeCopy, GATED_ACTIONS, gateExportActions } from '../canvas-ux/export-gate.tsx'
import type { BoardEvents } from '../events.ts'
import { getController } from '../present-export/controller.ts'
import {
  boardExportState,
  EXPORT_OFF_TEXT,
  exportAllowed,
  exportAllowedOnBoard,
  exportAllowedWith,
  guardExport,
  syncExportPolicy,
} from './export-policy.ts'

let n = 0
const newBoardId = () => `b-export-${++n}`

/** A controllable board event stream (the one BoardPage shares with every feature). */
function fakeEvents() {
  type Listener = Parameters<BoardEvents['on']>[1]
  const listeners = new Map<string, Set<Listener>>()
  const resync = new Set<() => void>()
  let connected = false
  let seq = 0
  const events: BoardEvents = {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(fn)
      return () => void listeners.get(type)?.delete(fn)
    },
    onResync(fn) {
      resync.add(fn)
      if (connected) fn()
      return () => void resync.delete(fn)
    },
    serverOffsetMs: () => 0,
    onAccessLost: () => () => {},
    close() {},
  }
  return {
    events,
    emit: (type: string, data: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(data, { type, data, seq: ++seq })
    },
    connect: () => {
      connected = true
      for (const fn of resync) fn()
    },
    listenerCount: () => [...listeners.values()].reduce((a, s) => a + s.size, 0) + resync.size,
  }
}

/** api.request answering GET export-policy from a queue of deferred answers (tests resolve them). */
function fakeApi() {
  const pending: { resolve(s: ExportPolicyState): void; reject(e: unknown): void; path: string }[] = []
  const api = {
    request: vi.fn(
      (_method: string, path: string) =>
        new Promise((resolve, reject) => pending.push({ resolve, reject, path })),
    ),
  } as unknown as ApiClient
  return { api, pending }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const fakeEditor = () => ({}) as Editor

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function mount(opts: { role?: 'owner' | 'editor' | 'commenter' | 'viewer'; connected?: boolean } = {}) {
  const boardId = newBoardId()
  const editor = fakeEditor()
  const ev = fakeEvents()
  if (opts.connected) ev.connect()
  const { api, pending } = fakeApi()
  const notices: NoticeInput[] = []
  const notify = (x: NoticeInput) => void notices.push(x)
  boardExportState(boardId).role.set(opts.role ?? 'viewer')
  const stop = syncExportPolicy({ editor, boardId, api, events: ev.events, notify })
  cleanups.push(stop)
  return { boardId, editor, ev, api, pending, notices, stop }
}

describe('exportAllowedWith', () => {
  it("limits only viewers and commenters, only under 'editors'; unknown role or policy = allowed", () => {
    expect(exportAllowedWith('viewer', 'editors')).toBe(false)
    expect(exportAllowedWith('commenter', 'editors')).toBe(false)
    expect(exportAllowedWith('editor', 'editors')).toBe(true)
    expect(exportAllowedWith('owner', 'editors')).toBe(true)
    for (const role of ['viewer', 'commenter', 'editor', 'owner'] as const)
      expect(exportAllowedWith(role, 'everyone')).toBe(true)
    expect(exportAllowedWith(null, 'editors')).toBe(true)
    expect(exportAllowedWith('viewer', null)).toBe(true)
  })
})

describe('syncExportPolicy', () => {
  it('asks once on mount (stream not connected yet) and applies the answer', async () => {
    const m = mount()
    expect(m.pending).toHaveLength(1)
    expect(m.pending[0]?.path).toBe(`/api/boards/${m.boardId}/export-policy`)
    expect(exportAllowed(m.editor)).toBe(true) // nothing known yet: no flash of disabled entries
    m.pending[0]?.resolve({ exportPolicy: 'editors', canExport: false })
    await flush()
    expect(exportAllowed(m.editor)).toBe(false)
    expect(exportAllowedOnBoard(m.boardId)).toBe(false)
  })

  it('an already connected stream triggers the one fetch (no double request)', () => {
    const m = mount({ connected: true })
    expect(m.pending).toHaveLength(1)
  })

  it('board events switch it live, both ways; malformed events are ignored', () => {
    const m = mount()
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    expect(exportAllowed(m.editor)).toBe(false)
    m.ev.emit('export-control.policy', { exportPolicy: 'nobody' })
    m.ev.emit('export-control.policy', null)
    expect(exportAllowed(m.editor)).toBe(false)
    m.ev.emit('export-control.policy', { exportPolicy: 'everyone' })
    expect(exportAllowed(m.editor)).toBe(true)
  })

  it('an answer to a request sent before an event never overwrites the event', async () => {
    const m = mount()
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    m.pending[0]?.resolve({ exportPolicy: 'everyone', canExport: true }) // stale
    await flush()
    expect(exportAllowed(m.editor)).toBe(false)
  })

  it('refetches after every reconnect (a missed event is repaired)', async () => {
    const m = mount()
    m.pending[0]?.resolve({ exportPolicy: 'everyone', canExport: true })
    await flush()
    m.ev.connect()
    expect(m.pending).toHaveLength(2)
    m.pending[1]?.resolve({ exportPolicy: 'editors', canExport: false })
    await flush()
    expect(exportAllowed(m.editor)).toBe(false)
  })

  it('a failed request keeps what was known', async () => {
    const m = mount()
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    m.ev.connect()
    m.pending[1]?.reject(new Error('offline'))
    await flush()
    expect(exportAllowed(m.editor)).toBe(false)
  })

  it('the role decides: an owner or editor on the same board is never limited, and a role change applies at once', () => {
    const m = mount({ role: 'editor' })
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    expect(exportAllowed(m.editor)).toBe(true)
    boardExportState(m.boardId).role.set('commenter') // stepped down while the board is open
    expect(exportAllowed(m.editor)).toBe(false)
    boardExportState(m.boardId).role.set('owner')
    expect(exportAllowed(m.editor)).toBe(true)
  })

  it('cleanup unsubscribes, ignores late answers and unbinds the editor', async () => {
    const m = mount()
    m.stop()
    expect(m.ev.listenerCount()).toBe(0)
    m.pending[0]?.resolve({ exportPolicy: 'editors', canExport: false })
    await flush()
    expect(boardExportState(m.boardId).policy.get()).toBeNull()
    expect(exportAllowed(m.editor)).toBe(true) // an unbound editor is not limited by a stale board
  })
})

describe('gates', () => {
  it('guardExport notices once per attempt with the owner-facing reason, and passes when allowed', () => {
    const m = mount()
    expect(guardExport(m.editor)).toBe(true)
    expect(m.notices).toEqual([])
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    expect(guardExport(m.editor)).toBe(false)
    expect(m.notices).toEqual([
      { key: 'export-off', text: EXPORT_OFF_TEXT, testId: 'export-off-notice', timeoutMs: 6000 },
    ])
    expect(EXPORT_OFF_TEXT).toBe('The board owner turned off exporting for viewers.')
  })

  it("tldraw's copy, cut, Copy as SVG/JSON and Download original do nothing but explain while it is off", () => {
    const m = mount()
    const calls: string[] = []
    const actions: TLUiActionsContextType = {}
    for (const id of [...GATED_ACTIONS, 'select-all'])
      actions[id] = { id, label: id, onSelect: () => void calls.push(id) } as unknown as TLUiActionItem
    const gated = gateExportActions(m.editor, actions)
    for (const id of [...GATED_ACTIONS, 'select-all']) gated[id]?.onSelect('menu')
    expect(calls).toEqual([...GATED_ACTIONS, 'select-all'])

    calls.length = 0
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    for (const id of [...GATED_ACTIONS, 'select-all']) gated[id]?.onSelect('menu')
    expect(calls).toEqual(['select-all'])
    expect(m.notices).toHaveLength(GATED_ACTIONS.length)
  })

  it('Ctrl/Cmd+C is stopped exactly when tldraw would copy shapes, and only while it is off', () => {
    const base = { allowed: false, focused: true, editingShape: false, selected: 2, inEditable: false }
    expect(blocksNativeCopy(base)).toBe(true)
    expect(blocksNativeCopy({ ...base, allowed: true })).toBe(false)
    // Cases tldraw's own listener ignores too (so text elsewhere can still be copied):
    expect(blocksNativeCopy({ ...base, focused: false })).toBe(false)
    expect(blocksNativeCopy({ ...base, editingShape: true })).toBe(false)
    expect(blocksNativeCopy({ ...base, selected: 0 })).toBe(false)
    expect(blocksNativeCopy({ ...base, inEditable: true })).toBe(false)
  })

  it('the export controller: Export dialog, PNG/SVG quick export and Copy as PNG only explain while it is off', async () => {
    const m = mount()
    const editor = {
      getSelectedShapeIds: () => [],
      getCurrentPageShapeIds: () => new Set(),
      getShape: () => undefined,
      getInstanceState: () => ({ exportBackground: true }),
    } as unknown as Editor
    // The controller is per editor; bind this one to the same board.
    cleanups.push(
      syncExportPolicy({ editor, boardId: m.boardId, api: m.api, events: m.ev.events, notify: () => {} }),
    )
    const notices: NoticeInput[] = []
    const controller = getController(editor)
    controller.attach({ title: 'Pitch', notify: (x) => void notices.push(x) })

    controller.openExport('pdf')
    expect(controller.exportRequest.get()).toMatchObject({ focus: 'pdf' })
    controller.closeExport()

    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    controller.openExport('image')
    expect(controller.exportRequest.get()).toBeNull()
    await controller.quickExport('png', 'board')
    controller.copyAsPng()
    expect(notices.map((x) => x.testId)).toEqual([
      'export-off-notice',
      'export-off-notice',
      'export-off-notice',
    ])
  })
})
