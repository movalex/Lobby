// Review fix (wave Q, docs/WAVE-Q-CONTRACTS.md §9): the links a /place makes on the board are pending until the client
// confirms that the room took the elements. An item with files is confirmed once every inserted element is the room's
// (its push acked); an item without files needs no confirm; a refused push or a timeout confirms nothing (the api's
// hourly sweep then decides: it keeps a link the board shows).
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { DEFAULT_INSERT_OPTIONS, libraryPlaceConfirmPath, libraryPlacePath } from '@draftroom/contracts'
import { instantiatePiece } from '@draftroom/templates/pieces'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import type { EngineCore, SaveStatus } from '../../canvas/sync/types.ts'
import { fakeCanvas, fakeCtx } from '../sort/test-kit.ts'
import { resetLibraryClient, setLibraryRequester } from './client.ts'
import { insertTile, whenPushed } from './insert.ts'
import { fakeLibraryApi, TEST_ITEM, TEST_WORKSPACE } from './test-kit.ts'

// the Node side of the engine's text layout (the item is a piece with words)
installServerTextMetrics()

/** An engine the test drives: which ids the room holds, and the save status. */
function fakeEngine() {
  const confirmed = new Set<string>()
  const acks = new Set<Parameters<EngineCore['onAck']>[0]>()
  const statuses = new Set<(s: SaveStatus) => void>()
  let status: SaveStatus = { state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }
  return {
    engine: {
      confirmed: (id: string) => (confirmed.has(id) ? ({ id } as never) : undefined),
      onAck: (l: Parameters<EngineCore['onAck']>[0]) => {
        acks.add(l)
        return () => acks.delete(l)
      },
      onSaveStatus: (l: (s: SaveStatus) => void) => {
        statuses.add(l)
        return () => statuses.delete(l)
      },
      get saveStatus() {
        return status
      },
    },
    ack(ids: readonly string[]) {
      for (const id of ids) confirmed.add(id)
      for (const l of acks) l({} as never)
    },
    status(s: Partial<SaveStatus>) {
      status = { ...status, ...s }
      for (const l of statuses) l(status)
    },
    listeners: () => acks.size + statuses.size,
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('whenPushed', () => {
  it('true once the room holds every id; the listeners go', async () => {
    const e = fakeEngine()
    const p = whenPushed(e.engine, ['a', 'b'])
    e.ack(['a'])
    await flush()
    e.ack(['b'])
    expect(await p).toBe(true)
    expect(e.listeners()).toBe(0)
  })

  it('true when the engine went from pending to saved (a re-keyed id); false on a reject of one of them', async () => {
    const e = fakeEngine()
    const p = whenPushed(e.engine, ['a'])
    e.status({ state: 'saving', pending: 1 })
    e.status({ state: 'saved', pending: 0 })
    expect(await p).toBe(true)
    const r = fakeEngine()
    const q = whenPushed(r.engine, ['x', 'y'])
    r.status({ state: 'not-saved', pending: 1, lastReject: { id: 'y', code: 'INVALID' } })
    expect(await q).toBe(false)
  })

  it('false on a timeout, without an engine, or with nothing to watch', async () => {
    vi.useFakeTimers()
    try {
      const e = fakeEngine()
      const p = whenPushed(e.engine, ['a'], 1_000)
      vi.advanceTimersByTime(1_001)
      expect(await p).toBe(false)
      expect(e.listeners()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    expect(await whenPushed(null, ['a'])).toBe(false)
    expect(await whenPushed(fakeEngine().engine, [])).toBe(false)
  })
})

const member = {
  user: { id: 'usr_alice0123456789', name: 'Alice' },
  workspaces: [{ id: TEST_WORKSPACE, name: 'DBC', role: 'member' }],
  access: { creator: true, reason: 'domain', email: 'alice@darkburn.com' },
}
const VER = 'ver_0123456789abcdef'
const AST = 'ast_0123456789abcdef'
const answerOf = (files: boolean) => {
  const p = instantiatePiece('process', { origin: { x: 0, y: 0 } })
  return {
    item: { id: TEST_ITEM, name: 'Flow start', revision: 2 },
    elements: p.elements,
    files: files
      ? [{ assetId: AST, versionId: VER, kind: 'image', name: 'a.png', mimeType: 'image/png', sizeBytes: 10 }]
      : [],
  }
}

beforeEach(() => resetLibraryClient())
afterEach(() => setLibraryRequester(null))

async function insertItem(files: boolean) {
  const f = fakeCanvas([])
  const e = fakeEngine()
  ;(f.canvas as unknown as { engine: unknown }).engine = e.engine
  const calls = fakeLibraryApi((c) => (c.path.endsWith('/confirm') ? undefined : answerOf(files)))
  const { ctx } = fakeCtx(f.canvas, {
    me: member as unknown as CanvasFeatureContext['me'],
    workspace: { id: TEST_WORKSPACE, name: 'DBC' },
    board: { id: 'b-board01', status: 'active' } as CanvasFeatureContext['board'],
  })
  const r = await insertTile(ctx, { source: 'item', id: TEST_ITEM }, { options: DEFAULT_INSERT_OPTIONS })
  if (!r.ok) throw new Error(r.reason)
  return { f, e, calls, ids: [...f.els.keys()] }
}

describe('a library item with files', () => {
  it('confirms the place once the room took its elements, not before', async () => {
    const { e, calls, ids } = await insertItem(true)
    await flush()
    expect(calls.map((c) => c.path)).toEqual([libraryPlacePath('b-board01', TEST_ITEM)])
    e.ack(ids)
    await flush()
    await flush()
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', libraryPlacePath('b-board01', TEST_ITEM)],
      ['POST', libraryPlaceConfirmPath('b-board01', TEST_ITEM)],
    ])
  })

  it('a refused push confirms nothing', async () => {
    const { e, calls, ids } = await insertItem(true)
    e.status({ state: 'not-saved', pending: 1, lastReject: { id: ids[0] ?? '', code: 'INVALID' } })
    await flush()
    expect(calls).toHaveLength(1)
  })

  it('an item without files needs no confirm', async () => {
    const { e, calls, ids } = await insertItem(false)
    e.ack(ids)
    await flush()
    await flush()
    expect(calls).toHaveLength(1)
  })
})
