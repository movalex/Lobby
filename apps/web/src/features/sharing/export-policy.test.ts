// The client side of export-control (docs/WAVE3-CONTRACTS.md): the per-board store, how it is fed
// (first answer, board events, resyncs) and the gates that read it (tldraw actions, copy, the export
// controller). The api enforces on its own; these are what keep the UI honest about it.

import { CANVAS_ORIGINAL_LIMITS, type ExportPolicyState } from '@draftroom/contracts'
import type { Editor, TLAsset, TLAssetContext, TLUiActionItem, TLUiActionsContextType } from 'tldraw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.ts'
import { ANIMATED_ORIGINAL_LIMITS, createAssetStore, SMALL_ORIGINAL_BYTES } from '../../assets/asset-store.ts'
import { stableFileRef } from '../../assets/contract.ts'
import { AssetMetaStore } from '../../assets/meta-store.ts'
import { derivative, makeMeta, TEST_BOARD } from '../../assets/test-fixtures.ts'
import type { NoticeInput } from '../../board/board-context.ts'
import { blocksNativeCopy, GATED_ACTIONS, gateExportActions } from '../canvas-ux/export-gate.tsx'
import type { BoardEvents } from '../events.ts'
import { getController } from '../present-export/controller.ts'
import {
  boardExportState,
  clientExportAllowed,
  EXPORT_OFF_TEXT,
  exportAllowed,
  exportAllowedOnBoard,
  exportAllowedWith,
  exportCertainOnBoard,
  exportPolicyOf,
  exportPolicySentence,
  guardExport,
  refreshExportPolicy,
  saveExportPolicy,
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

describe('the Export dialog sentence follows the policy (F9)', () => {
  it('says who may export for each policy, and nothing while it is unknown', () => {
    expect(exportPolicySentence('everyone')).toBe('Everyone who can view the board can export it.')
    expect(exportPolicySentence('editors')).toBe(
      'Only editors can export this board: viewers, commenters and guests can’t.',
    )
    expect(exportPolicySentence(null)).toBe('')
  })

  it('reads the policy of the board the editor shows, live, and nothing before binding', () => {
    expect(exportPolicyOf(fakeEditor())).toBeNull()
    const m = mount({ role: 'owner', connected: true })
    expect(exportPolicyOf(m.editor)).toBeNull() // the first answer has not arrived
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    expect(exportPolicySentence(exportPolicyOf(m.editor))).toContain('Only editors')
    m.ev.emit('export-control.policy', { exportPolicy: 'everyone' })
    expect(exportPolicySentence(exportPolicyOf(m.editor))).toContain('Everyone who can view')
    m.stop()
    expect(exportPolicyOf(m.editor)).toBeNull()
  })
})

describe("the Share dialog's client card line (DANA2-01)", () => {
  it('off under editors, and on a board nobody chose for (the first client link turns it off); on only when chosen', () => {
    expect(clientExportAllowed(null, null)).toBeNull()
    expect(clientExportAllowed('editors', null)).toBe(false)
    expect(clientExportAllowed('editors', true)).toBe(false)
    expect(clientExportAllowed('everyone', false)).toBe(false)
    expect(clientExportAllowed('everyone', true)).toBe(true)
    expect(clientExportAllowed('everyone', null)).toBeNull()
  })

  it('the store learns whether the policy is stored from answers, and every event means it is', async () => {
    const m = mount()
    const s = boardExportState(m.boardId)
    expect(s.stored.get()).toBeNull()
    m.pending[0]?.resolve({ exportPolicy: 'everyone', canExport: true, policySet: false })
    await flush()
    expect(s.stored.get()).toBe(false)
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' }) // a client link was created
    expect(s.stored.get()).toBe(true)
    expect(clientExportAllowed(s.policy.get(), s.stored.get())).toBe(false)
    // An older server leaves the flag out: what was known stays.
    const again = refreshExportPolicy(m.api, m.boardId)
    m.pending[1]?.resolve({ exportPolicy: 'editors', canExport: false })
    await again
    expect(s.stored.get()).toBe(true)
  })
})

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

  it("limits name-only guests under 'editors' whatever their role (SEAM-04); unknown kind = not a guest", () => {
    expect(exportAllowedWith('editor', 'editors', true)).toBe(false)
    expect(exportAllowedWith('owner', 'editors', true)).toBe(false)
    expect(exportAllowedWith('editor', 'editors', false)).toBe(true)
    expect(exportAllowedWith('editor', 'editors', null)).toBe(true)
    expect(exportAllowedWith('editor', 'everyone', true)).toBe(true)
    // The board store follows the kind too.
    const boardId = newBoardId()
    const s = boardExportState(boardId)
    s.role.set('editor')
    s.policy.set('editors')
    expect(exportAllowedOnBoard(boardId)).toBe(true)
    s.guest.set(true)
    expect(exportAllowedOnBoard(boardId)).toBe(false)
  })
})

describe('what the canvas may load from originals (SEAM-10)', () => {
  it('only when exporting is certainly allowed: the policy is known, and it is open or the person is an editor with an account', () => {
    const boardId = newBoardId()
    const s = boardExportState(boardId)
    expect(exportCertainOnBoard(boardId)).toBe(false) // nothing known yet
    s.policy.set('everyone')
    expect(exportCertainOnBoard(boardId)).toBe(true)
    s.policy.set('editors')
    expect(exportCertainOnBoard(boardId)).toBe(false) // role unknown
    s.role.set('editor')
    expect(exportCertainOnBoard(boardId)).toBe(false) // kind unknown
    s.guest.set(false)
    expect(exportCertainOnBoard(boardId)).toBe(true)
    s.guest.set(true)
    expect(exportCertainOnBoard(boardId)).toBe(false)
    s.guest.set(false)
    s.role.set('viewer')
    expect(exportCertainOnBoard(boardId)).toBe(false)
  })

  it('an animated WebP plays from its original only then; a limited viewer’s canvas shows its preview (the api refuses that original)', async () => {
    const thumb = derivative({ role: 'thumb', width: 480, height: 320 })
    const meta = makeMeta({
      kind: 'image',
      status: 'ready',
      mimeType: 'image/webp',
      name: 'loop.webp',
      sizeBytes: 200_000,
      derivatives: [thumb],
      probe: {
        width: 480,
        height: 320,
        pageCount: null,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      },
    })
    const metaStore = new AssetMetaStore({
      fetchImpl: (async () => Response.json(meta)) as unknown as typeof fetch,
    })
    const store = createAssetStore({ boardId: TEST_BOARD, metaStore, reducedMotion: () => false })
    const asset = {
      id: 'asset:webp',
      typeName: 'asset',
      type: 'image',
      props: {
        w: 480,
        h: 320,
        name: 'loop.webp',
        isAnimated: true,
        mimeType: 'image/webp',
        src: stableFileRef(meta.assetId, meta.versionId),
        fileSize: 200_000,
      },
      meta: {},
    } as TLAsset
    const ctx = {
      screenScale: 1,
      steppedScreenScale: 1,
      dpr: 1,
      networkEffectiveType: null,
      shouldResolveToOriginal: false,
    } as TLAssetContext
    const original = `/files/${meta.assetId}/${meta.versionId}/original?board=${TEST_BOARD}`
    const preview = `/files/${meta.assetId}/${meta.versionId}/d/${thumb.id}?board=${TEST_BOARD}`
    const s = boardExportState(TEST_BOARD)
    s.role.set('viewer')
    s.guest.set(false)
    s.policy.set('editors')
    expect(await store.resolve?.(asset, ctx)).toBe(preview)
    s.policy.set('everyone')
    expect(await store.resolve?.(asset, ctx)).toBe(original)
    s.policy.set('editors')
    s.role.set('editor')
    expect(await store.resolve?.(asset, ctx)).toBe(original)
    s.guest.set(true) // a name-only guest on a workshop link
    expect(await store.resolve?.(asset, ctx)).toBe(preview)
    // A GIF still plays for limited viewers: the api serves what the canvas renders from its original.
    const gif = { ...meta, mimeType: 'image/gif' }
    const gifStore = createAssetStore({
      boardId: TEST_BOARD,
      metaStore: new AssetMetaStore({
        fetchImpl: (async () => Response.json(gif)) as unknown as typeof fetch,
      }),
      reducedMotion: () => false,
    })
    s.role.set('viewer')
    expect(
      await gifStore.resolve?.(
        { ...asset, props: { ...asset.props, mimeType: 'image/gif' } } as TLAsset,
        ctx,
      ),
    ).toBe(original)
    s.policy.set(null)
    s.role.set(null)
    s.guest.set(null)
  })

  it('the canvas and the api share the same original limits', () => {
    expect(SMALL_ORIGINAL_BYTES).toBe(CANVAS_ORIGINAL_LIMITS.smallOriginalBytes)
    expect(ANIMATED_ORIGINAL_LIMITS.maxBytes).toBe(CANVAS_ORIGINAL_LIMITS.animatedMaxBytes)
    expect(ANIMATED_ORIGINAL_LIMITS.maxPixels).toBe(CANVAS_ORIGINAL_LIMITS.animatedMaxPixels)
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

  it("the Share dialog's own fetch never overwrites a newer event (review: stale answer from the dialog)", async () => {
    const m = mount()
    m.pending[0]?.resolve({ exportPolicy: 'everyone', canExport: true })
    await flush()
    const done = refreshExportPolicy(m.api, m.boardId) // the dialog opens and asks
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' }) // the owner turns it off meanwhile
    m.pending[1]?.resolve({ exportPolicy: 'everyone', canExport: true }) // read before that change
    await done
    expect(boardExportState(m.boardId).policy.get()).toBe('editors')
    expect(exportAllowed(m.editor)).toBe(false)
  })

  it("an owner's save applies its answer, unless a newer change arrived first (two owners at once)", async () => {
    const m = mount({ role: 'owner' })
    m.pending[0]?.resolve({ exportPolicy: 'everyone', canExport: true })
    await flush()
    // Stream down: no event, the answer is what this tab learns.
    const first = saveExportPolicy(m.api, m.boardId, 'editors')
    expect(m.pending[1]?.path).toBe(`/api/boards/${m.boardId}/export-policy`)
    m.pending[1]?.resolve({ exportPolicy: 'editors', canExport: true })
    expect(await first).toEqual({ exportPolicy: 'editors', canExport: true })
    expect(boardExportState(m.boardId).policy.get()).toBe('editors')

    // Our change, then another owner's, both announced before our answer comes back.
    const second = saveExportPolicy(m.api, m.boardId, 'everyone')
    m.ev.emit('export-control.policy', { exportPolicy: 'everyone' })
    m.ev.emit('export-control.policy', { exportPolicy: 'editors' })
    m.pending[2]?.resolve({ exportPolicy: 'everyone', canExport: true })
    await second
    expect(boardExportState(m.boardId).policy.get()).toBe('editors')
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
