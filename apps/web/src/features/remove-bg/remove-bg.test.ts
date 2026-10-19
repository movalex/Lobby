// Wave W, WS2 (docs/WAVE-W-CONTRACTS.md §4.1 step 4, §4.4): background removal on the web. What is offered and to whom,
// the one write (ONE canvas.transact: one undo step; only a ver_ id and its facts, never a data:, blob: or signed URL),
// the tracker following this tab's op by its events (and by reading it again when an event may have been missed), and
// the palette command held while the contracts list it pending.

import {
  FILE_OP_EVENT,
  type FileOpState,
  PENDING_PALETTE_COMMAND_IDS,
  WORKER_OP_MESSAGES,
} from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.ts'
import type { AssetVersionMeta } from '../../assets/contract.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { editMenu } from '../../file-card/ported/edit-media.tsx'
import type { FileFacts } from '../../file-card/ported/model.ts'
import { FORMATS_FLAG_KEYS, setFormatsOffer } from '../formats/flags.ts'
import { feature, REMOVE_BG_COMMANDS, removeBgCommandHeld } from './index.tsx'
import { fileRefusal, REMOVE_BG_COMMAND_ID, REMOVE_BG_STEP, removeBgTarget, swapToResult } from './model.ts'
import { mountTracker, type RemoveBgDeps, startRemoveBackground, trackerOf } from './run.ts'

const VER = 'ver_SOURCE0000000000000'
const AST = 'ast_SOURCE0000000000000'
const NEW_VER = 'ver_RESULT0000000000000'
const NEW_AST = 'ast_RESULT0000000000000'
const OP = 'wop_0123456789abcdefghij'

// biome-ignore lint/suspicious/noExplicitAny: element fixtures, typed loosely
type El = any

const image = (id: string, over: Record<string, unknown> = {}, file: Record<string, unknown> = {}): El => ({
  id,
  type: 'image',
  fileId: VER,
  isDeleted: false,
  x: 10,
  y: 20,
  width: 400,
  height: 300,
  crop: null,
  customData: {
    lobby: {
      alt: 'Key art',
      file: {
        assetId: AST,
        versionId: VER,
        kind: 'image',
        name: 'Key art.png',
        mimeType: 'image/png',
        sizeBytes: 1000,
        ...file,
      },
    },
  },
  ...over,
})

/** A canvas that keeps elements in a map and records every transact (label and its updates). */
function fakeCtx(elements: El[], opts: { readOnly?: boolean; locked?: string[]; selection?: string[] } = {}) {
  const els = new Map<string, El>(elements.map((e) => [e.id, e]))
  const transacts: { label: string; updates: [string, Record<string, unknown>][] }[] = []
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const resyncs = new Set<() => void>()
  const notices: { key: string; text: string; testId?: string; tone?: string }[] = []
  const dismissed: string[] = []
  const canvas = {
    get: (id: string) => els.get(id),
    readOnly: () => opts.readOnly === true,
    isLocked: (id: string) => opts.locked?.includes(id) === true,
    selection: opts.selection ?? [],
    transact(label: string, fn: (tx: unknown) => unknown) {
      const updates: [string, Record<string, unknown>][] = []
      const out = fn({
        update(id: string, patch: Record<string, unknown>) {
          updates.push([id, patch])
          const cur = els.get(id)
          const lobby = { ...cur.customData?.lobby, ...(patch.customData as El)?.lobby }
          els.set(id, { ...cur, ...patch, customData: { ...cur.customData, lobby } })
        },
      })
      transacts.push({ label, updates })
      return out
    },
  }
  const ctx = {
    canvas,
    registries: {},
    board: { id: 'b-0123456789' },
    me: { user: { id: 'usr_bob000000000000000' } },
    events: {
      on(type: string, l: (data: unknown) => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(l)
        listeners.set(type, set)
        return () => set.delete(l)
      },
      onResync(l: () => void) {
        resyncs.add(l)
        return () => resyncs.delete(l)
      },
      serverOffsetMs: () => 0,
      onAccessLost: () => () => {},
      close: () => {},
    },
    notify: (n: { key: string; text: string; testId?: string; tone?: string }) => notices.push(n),
    dismiss: (k: string) => dismissed.push(k),
    api: {},
    role: 'editor',
  }
  const emit = (type: string, data: unknown) => {
    for (const l of listeners.get(type) ?? []) l(data)
  }
  const resync = () => {
    for (const l of resyncs) l()
  }
  return { ctx: ctx as unknown as CanvasFeatureContext, els, transacts, notices, dismissed, emit, resync }
}

const state = (over: Partial<FileOpState> = {}): FileOpState => ({
  id: OP,
  kind: 'remove-bg',
  status: 'queued',
  boardId: 'b-0123456789',
  sourceVersionId: VER,
  resultVersionId: null,
  resultAssetId: null,
  pagesReady: null,
  errorCode: null,
  message: null,
  createdAt: '2026-10-19T12:00:00.000Z',
  finishedAt: null,
  ...over,
})

const META = {
  schemaVersion: 1,
  assetId: NEW_AST,
  versionId: NEW_VER,
  boardId: 'b-0123456789',
  name: 'Key art (no background).png',
  declaredMimeType: 'image/png',
  mimeType: 'image/png',
  kind: 'image',
  sizeBytes: 2345,
  status: 'queued',
} as unknown as AssetVersionMeta

const flush = () => new Promise((r) => setTimeout(r, 0))

function deps(over: Partial<RemoveBgDeps> = {}): RemoveBgDeps & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    request: async () => state(),
    read: async (_ctx, id) => {
      reads.push(id)
      return state({ status: 'running' })
    },
    cancel: async () => state({ status: 'cancelled', errorCode: 'CANCELLED', message: 'Cancelled.' }),
    meta: async (_ctx, assetId, versionId) => (assetId === NEW_AST && versionId === NEW_VER ? META : null),
    pollMs: 60_000,
    ...over,
  }
}

const on = () => true

describe('what is offered', () => {
  it('one image this tab may write, a PNG, JPEG or WebP within 25 MB, while the switches offer it', () => {
    const f = fakeCtx([
      image('img'),
      image('gif', {}, { mimeType: 'image/gif' }),
      image('huge', {}, { sizeBytes: 26 * 1024 * 1024 }),
      image('page', { fileId: `${VER}.p1` }),
      image('card', {}, { kind: 'pdf', mimeType: 'application/pdf' }),
      { ...image('gone'), isDeleted: true },
    ])
    expect(removeBgTarget(f.ctx, ['img'], on)?.id).toBe('img')
    expect(removeBgTarget(f.ctx, ['img'], () => false)).toBeNull() // the web switch or the api's offer is off
    expect(removeBgTarget(f.ctx, ['img', 'gif'], on)).toBeNull()
    for (const id of ['gif', 'huge', 'page', 'card', 'gone', 'nope'])
      expect(removeBgTarget(f.ctx, [id], on), id).toBeNull()
    expect(removeBgTarget(fakeCtx([image('img')], { readOnly: true }).ctx, ['img'], on)).toBeNull()
    expect(removeBgTarget(fakeCtx([image('img')], { locked: ['img'] }).ctx, ['img'], on)).toBeNull()
    // the shipped switches are off: nothing is offered by default
    expect(removeBgTarget(f.ctx, ['img'])).toBeNull()
  })

  it('fileRefusal says why in words', () => {
    const facts = {
      assetId: AST,
      versionId: VER,
      kind: 'image' as const,
      name: 'a',
      mimeType: 'image/webp',
      sizeBytes: 5,
    }
    expect(fileRefusal(facts)).toBeNull()
    expect(fileRefusal({ ...facts, mimeType: 'image/svg+xml' })).toMatch(/PNG, JPEG and WebP/)
    expect(fileRefusal({ ...facts, sizeBytes: 30 * 1024 * 1024 })).toMatch(/too large/)
  })

  it('the edit menu has the row (after Alternative text), hidden while nothing is offered', () => {
    const row = editMenu.find((m) => m.id === 'media.remove-background')
    expect(row).toMatchObject({ group: 'edit', order: 83, label: 'Remove background (beta)' })
    const f = fakeCtx([image('img')])
    expect(row?.visible?.(f.ctx, { ids: ['img'] } as never)).toBe(false)
  })

  it('the palette command is held while the contracts list it pending', () => {
    expect(PENDING_PALETTE_COMMAND_IDS).toContain(REMOVE_BG_COMMAND_ID)
    expect(removeBgCommandHeld()).toBe(true)
    expect(feature.commands).toEqual([])
    expect(removeBgCommandHeld([])).toBe(false)
    expect(REMOVE_BG_COMMANDS.map((c) => c.id)).toEqual([REMOVE_BG_COMMAND_ID])
  })
})

describe('the swap', () => {
  const result = {
    assetId: NEW_AST,
    versionId: NEW_VER,
    kind: 'image' as const,
    name: 'Key art (no background).png',
    mimeType: 'image/png',
    sizeBytes: 2345,
  }

  it('is ONE transact (one undo step) writing only fileId and customData.lobby.file, ids only', () => {
    const f = fakeCtx([image('img')])
    expect(swapToResult(f.ctx, 'img', VER, result)).toBe('swapped')
    expect(f.transacts).toHaveLength(1)
    const [t] = f.transacts
    expect(t?.label).toBe(REMOVE_BG_STEP)
    expect(t?.updates).toHaveLength(1)
    const [id, patch] = t?.updates[0] ?? []
    expect(id).toBe('img')
    expect(Object.keys(patch ?? {}).sort()).toEqual(['customData', 'fileId'])
    expect(patch).toEqual({ fileId: NEW_VER, customData: { lobby: { file: result } } })
    const json = JSON.stringify(f.els.get('img'))
    expect(json).not.toMatch(/data:|blob:|https?:/)
    // the box, the alt text and the other keys are the same element's
    expect(f.els.get('img')).toMatchObject({ x: 10, y: 20, width: 400, height: 300 })
    expect(f.els.get('img').customData.lobby.alt).toBe('Key art')
  })

  it('writes nothing when the element no longer shows the source, is gone, or may not be written', () => {
    const replaced = fakeCtx([
      image('img', { fileId: 'ver_OTHER00000000000000' }, { versionId: 'ver_OTHER00000000000000' }),
    ])
    expect(swapToResult(replaced.ctx, 'img', VER, result)).toBe('changed')
    const gone = fakeCtx([{ ...image('img'), isDeleted: true }])
    expect(swapToResult(gone.ctx, 'img', VER, result)).toBe('gone')
    const locked = fakeCtx([image('img')], { locked: ['img'] })
    expect(swapToResult(locked.ctx, 'img', VER, result)).toBe('locked')
    const ro = fakeCtx([image('img')], { readOnly: true })
    expect(swapToResult(ro.ctx, 'img', VER, result)).toBe('locked')
    // a result that is not a stored version's ids is never written
    const bad = fakeCtx([image('img')])
    expect(swapToResult(bad.ctx, 'img', VER, { ...result, versionId: 'data:image/png;base64,AAAA' })).toBe(
      'changed',
    )
    for (const f of [replaced, gone, locked, ro, bad]) expect(f.transacts).toEqual([])
  })
})

describe('the tracker', () => {
  it('asks, follows the op by its events, and swaps the result in once done (one transact)', async () => {
    const f = fakeCtx([image('img')], { selection: ['img'] })
    const d = deps()
    const unmount = mountTracker(f.ctx, d)
    // the switches are off by default: offer it for this test through a selection the target accepts
    const target = removeBgTarget(f.ctx, ['img'], on)
    expect(target).not.toBeNull()
    const tracker = trackerOf(f.ctx.registries as never)
    tracker?.track(state(), 'img', (target as El).customData.lobby.file as FileFacts)
    expect(tracker?.pendingIds()).toEqual([OP])
    expect(f.notices.at(-1)).toMatchObject({ testId: 'remove-bg-progress' })
    // an event of someone else's op (never sent here, but harmless) and a malformed one are ignored
    f.emit(FILE_OP_EVENT, { op: state({ id: 'wop_someoneelse00000000', status: 'done' }) })
    f.emit(FILE_OP_EVENT, { nope: 1 })
    f.emit(FILE_OP_EVENT, { op: state({ status: 'running' }) })
    expect(f.notices.at(-1)?.text).toMatch(/^Removing the background of Key art.png/)
    f.emit(FILE_OP_EVENT, {
      op: state({
        status: 'done',
        resultVersionId: NEW_VER,
        resultAssetId: NEW_AST,
        finishedAt: '2026-10-19T12:00:03.000Z',
      }),
    })
    await flush()
    expect(f.transacts).toHaveLength(1)
    expect(f.els.get('img').fileId).toBe(NEW_VER)
    expect(f.els.get('img').customData.lobby.file).toMatchObject({
      assetId: NEW_AST,
      versionId: NEW_VER,
      mimeType: 'image/png',
    })
    expect(f.notices.at(-1)).toMatchObject({ testId: 'remove-bg-done' })
    expect(tracker?.pendingIds()).toEqual([])
    // a repeated done (a reconnect replays) changes nothing more
    f.emit(FILE_OP_EVENT, { op: state({ status: 'done', resultVersionId: NEW_VER, resultAssetId: NEW_AST }) })
    await flush()
    expect(f.transacts).toHaveLength(1)
    unmount()
    expect(trackerOf(f.ctx.registries as never)).toBeNull()
  })

  it('a missed event: on reconnect it reads the op again and finishes', async () => {
    const f = fakeCtx([image('img')])
    let reads = 0
    const d = deps({
      read: async () => {
        reads++
        return state({ status: 'done', resultVersionId: NEW_VER, resultAssetId: NEW_AST })
      },
    })
    const unmount = mountTracker(f.ctx, d)
    trackerOf(f.ctx.registries as never)?.track(state(), 'img', image('img').customData.lobby.file)
    f.resync()
    await flush()
    await flush()
    expect(reads).toBe(1)
    expect(f.els.get('img').fileId).toBe(NEW_VER)
    unmount()
  })

  it('failed: the op’s own fixed message, nothing written; cancelled: nothing at all', async () => {
    const f = fakeCtx([image('img')])
    const unmount = mountTracker(f.ctx, deps())
    const t = trackerOf(f.ctx.registries as never)
    t?.track(state(), 'img', image('img').customData.lobby.file)
    f.emit(FILE_OP_EVENT, {
      op: state({
        status: 'failed',
        errorCode: 'IMAGE_TOO_LARGE',
        message: 'This image is too large. Use one under 40 megapixels and 25 MB.',
      }),
    })
    await flush()
    expect(f.notices.at(-1)).toMatchObject({
      tone: 'error',
      testId: 'remove-bg-failed',
      text: expect.stringMatching(/too large/),
    })
    t?.track(state({ id: 'wop_second0000000000000' }), 'img', image('img').customData.lobby.file)
    f.emit(FILE_OP_EVENT, {
      op: state({
        id: 'wop_second0000000000000',
        status: 'cancelled',
        errorCode: 'CANCELLED',
        message: 'Cancelled.',
      }),
    })
    await flush()
    expect(t?.pendingIds()).toEqual([])
    expect(f.transacts).toEqual([])
    unmount()
  })

  it('queued says it waits for the file worker; running says it is removing; no local give-up', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeCtx([image('img')])
      let status: 'queued' | 'running' = 'queued'
      const unmount = mountTracker(f.ctx, deps({ read: async () => state({ status }), pollMs: 5_000 }))
      const t = trackerOf(f.ctx.registries as never)
      t?.track(state(), 'img', image('img').customData.lobby.file)
      expect(f.notices.at(-1)).toMatchObject({
        testId: 'remove-bg-progress',
        text: 'Queued: waiting for the file worker to remove the background of Key art.png… (beta)',
      })
      // a busy queue for 40 minutes: still followed, still saying queued, no failure of its own
      await vi.advanceTimersByTimeAsync(40 * 60_000)
      expect(t?.pendingIds()).toEqual([OP])
      expect(f.notices.some((n) => n.testId === 'remove-bg-failed')).toBe(false)
      expect(f.notices.at(-1)?.text).toMatch(/^Queued: waiting for the file worker/)
      status = 'running'
      await vi.advanceTimersByTimeAsync(5_000)
      expect(f.notices.at(-1)?.text).toBe('Removing the background of Key art.png… (beta)')
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the new codes show their contract messages, whatever words the api sent', async () => {
    const f = fakeCtx([image('img')])
    const unmount = mountTracker(f.ctx, deps())
    const t = trackerOf(f.ctx.registries as never)
    for (const [i, code] of (['WORKER_BUSY', 'FILE_TOO_COMPLEX'] as const).entries()) {
      const id = `wop_code${i}000000000000000`
      t?.track(state({ id }), 'img', image('img').customData.lobby.file)
      f.emit(FILE_OP_EVENT, { op: state({ id, status: 'failed', errorCode: code, message: null }) })
      await flush()
      expect(f.notices.at(-1)).toMatchObject({ testId: 'remove-bg-failed', text: WORKER_OP_MESSAGES[code] })
    }
    unmount()
  })

  it('the image was replaced while the worker ran: it is left as it is, and the person is told', async () => {
    const f = fakeCtx([image('img')])
    const unmount = mountTracker(f.ctx, deps())
    trackerOf(f.ctx.registries as never)?.track(state(), 'img', image('img').customData.lobby.file)
    f.els.set(
      'img',
      image('img', { fileId: 'ver_OTHER00000000000000' }, { versionId: 'ver_OTHER00000000000000' }),
    )
    f.emit(FILE_OP_EVENT, { op: state({ status: 'done', resultVersionId: NEW_VER, resultAssetId: NEW_AST }) })
    await flush()
    expect(f.transacts).toEqual([])
    expect(f.notices.at(-1)).toMatchObject({ testId: 'remove-bg-skipped' })
    unmount()
  })

  it('startRemoveBackground: nothing without an offer; a refusal is said in words and nothing is followed', async () => {
    const f = fakeCtx([image('img')], { selection: ['img'] })
    const unmount = mountTracker(f.ctx, deps())
    // the shipped switches are off
    expect(await startRemoveBackground(f.ctx, ['img'], deps())).toBeNull()
    expect(f.notices).toEqual([])
    // a dev-auth page's switch on AND the api's offer: it asks
    const g = globalThis as { localStorage?: unknown }
    const saved = g.localStorage
    g.localStorage = { getItem: (k: string) => (k === FORMATS_FLAG_KEYS.removeBackground ? '1' : null) }
    setFormatsOffer({ removeBackground: true })
    try {
      const busy = deps({
        request: async () => {
          throw new ApiError(
            'conflict',
            409,
            'FILE_OP_ACTIVE',
            'The background of this image is already being removed.',
          )
        },
      })
      expect(await startRemoveBackground(f.ctx, ['img'], busy)).toBeNull()
      expect(f.notices.at(-1)).toMatchObject({
        testId: 'remove-bg-refused',
        text: expect.stringMatching(/already/),
      })
      expect(trackerOf(f.ctx.registries as never)?.pendingIds()).toEqual([])
      const ok = await startRemoveBackground(f.ctx, ['img'], deps())
      expect(ok?.id).toBe(OP)
      expect(trackerOf(f.ctx.registries as never)?.pendingIds()).toEqual([OP])
    } finally {
      setFormatsOffer(null)
      g.localStorage = saved
    }
    unmount()
  })
})
