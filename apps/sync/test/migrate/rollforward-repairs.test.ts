// The roll-forward's repairs (rollforward.ts step g0, 2B; V3's wave-5 re-check): ordinary edits on both
// sides of a rollback used to leave a board that could not open. Each case builds a valid ours state (the
// §2.4.4 invariants hold on lb_elements before the merge, as the room keeps them) and a schema-valid
// theirs (r0Edit validates every record as TLSocketRoom does), rolls forward and expects the board to
// open with no violation. Shapes of V3's `v3-probe-brick`, `v3-probe-raw` and `v3-probe-geokind`.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTableTextMetrics,
  indexKeyBetween,
  installServerTextMetrics,
} from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import type { TLRecord } from '@tldraw/tlschema'
import { afterAll, describe, expect, it } from 'vitest'
import { unregisterBornAfterCheck } from '../../src/r0/index.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { type RollForwardReport, rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import {
  excalidrawCreate,
  excalidrawEdit,
  fixtureRecords,
  lbRows,
  r0Edit,
  seedBoardRecords,
} from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const suiteDir = mkdtempSync(join(tmpdir(), 'dr-rf-repairs-'))
afterAll(() => {
  unregisterBornAfterCheck()
  rmSync(suiteDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

type R = TLRecord & Record<string, any>
type Txn = {
  get(id: string): TLRecord | undefined
  set(id: string, r: TLRecord): void
  delete(id: string): void
}
const els = (path: string) => [...lbRows(path).values()].map((r) => JSON.parse(r.data) as Record<string, any>)
const topKey = (path: string) =>
  [...lbRows(path).values()]
    .map((r) => r.idx)
    .sort()
    .at(-1) as string
let n = 0

function board(name: string, unlock: string[] = []) {
  const rooms = join(suiteDir, `${name}-${n++}`, 'rooms')
  const boardId = `b-rfrep${String(n).padStart(4, '0')}`
  const seed = fixtureRecords('kitchen-sink').map((r) =>
    unlock.includes(r.id) ? ({ ...r, isLocked: false } as TLRecord) : r,
  )
  const path = seedBoardRecords(rooms, boardId, seed)
  const conv = convertBoardFile(
    { kind: 'convert', boardId, path, reportDir: join(rooms, '..', 'migration'), backupKey: null, at: 1 },
    metrics,
  )
  expect(conv.ok).toBe(true)
  const rollForward = () =>
    rollForwardBoardFile(
      { kind: 'rollforward', boardId, path, reportDir: join(rooms, '..', 'migration'), at: 2 },
      metrics,
    ) as RollForwardReport
  return { rooms, boardId, path, rollForward, theirs: (fn: (txn: Txn) => void) => r0Edit(rooms, boardId, fn) }
}

function newRect(path: string, id: string, extra: Record<string, unknown>) {
  const base = JSON.parse(lbRows(path).get('rect')?.data ?? '{}') as Record<string, unknown>
  const el: Record<string, unknown> = {
    ...base,
    id,
    index: indexKeyBetween(topKey(path), null),
    version: 1,
    versionNonce: 1000,
    boundElements: null,
    groupIds: [],
    frameId: null,
    x: Number(base.x) + 13,
    y: Number(base.y) + 400,
    ...extra,
  }
  delete el.customData
  excalidrawCreate(path, el)
}

function newLabel(path: string, id: string, containerId: string) {
  const rows = lbRows(path)
  const k = rows.get(containerId)?.idx as string
  const next =
    [...rows.values()]
      .map((r) => r.idx)
      .filter((x) => x > k)
      .sort()[0] ?? null
  const base = JSON.parse(rows.get('rect.t')?.data ?? '{}') as Record<string, unknown>
  const c = JSON.parse(rows.get(containerId)?.data ?? '{}') as Record<string, unknown>
  excalidrawCreate(path, {
    ...base,
    id,
    index: indexKeyBetween(k, next),
    version: 1,
    versionNonce: 7,
    containerId,
    frameId: c.frameId ?? null,
    groupIds: c.groupIds ?? [],
    x: c.x,
    y: c.y,
    text: 'ours label',
    originalText: 'ours label',
  })
  excalidrawEdit(path, containerId, ['bound'], (e) => {
    e.boundElements = [...((e.boundElements as unknown[]) ?? []), { id, type: 'text' }]
  })
}

const del = (txn: Txn, ids: string[]) => {
  for (const id of ids) if (txn.get(id)) txn.delete(id)
}
const oursDeletes = (path: string, ids: string[]) => {
  for (const id of ids)
    excalidrawEdit(path, id, ['life'], (e) => {
      e.isDeleted = true
    })
}

function expectOpen(b: ReturnType<typeof board>, codes: string[]) {
  const oursViolations = checkInvariants(els(b.path) as never)
  expect(oursViolations, 'ours valid before the merge').toEqual([])
  const rep = b.rollForward()
  expect(
    rep.ok,
    `${rep.reason ?? ''} ${JSON.stringify(rep.violations)} ${JSON.stringify(rep.failures)}`,
  ).toBe(true)
  expect(checkInvariants(els(b.path) as never)).toEqual([])
  for (const code of codes)
    expect(
      rep.repaired.map((r) => r.code),
      `repaired ${code}`,
    ).toContain(code)
  return rep
}

describe('the roll-forward repairs what the room would repair, instead of closing the board', () => {
  it('A: a frame deleted on R0 while Excalidraw added a child → the child is a free element', () => {
    const b = board('A')
    newRect(b.path, 'oursChild', { frameId: 'frameA' })
    b.theirs((txn) =>
      del(txn, [
        'binding:b1s',
        'shape:noteInInner',
        'shape:frameInner',
        'shape:grpGeo',
        'shape:grpNote',
        'shape:grp',
        'shape:note1',
        'shape:note2',
        'shape:note3',
        'shape:frameA',
      ]),
    )
    expectOpen(b, ['frame-cleared'])
    const child = els(b.path).find((e) => e.id === 'oursChild')
    expect(child?.isDeleted).toBeFalsy()
    expect(child?.frameId).toBeNull()
  })

  it('A2: an inner frame deleted on R0 while Excalidraw added a child', () => {
    const b = board('A2')
    newRect(b.path, 'oursChild', { frameId: 'frameInner' })
    b.theirs((txn) => del(txn, ['shape:noteInInner', 'shape:frameInner']))
    expectOpen(b, ['frame-cleared'])
  })

  it('B: a container deleted on R0 after Excalidraw added a label → the label goes with it', () => {
    const b = board('B', ['shape:tri'])
    newLabel(b.path, 'oursLabel', 'tri')
    b.theirs((txn) => del(txn, ['shape:tri']))
    expectOpen(b, ['label-orphaned'])
    expect(els(b.path).find((e) => e.id === 'oursLabel')?.isDeleted).toBe(true)
  })

  it('C: a container brought to the front on R0 while Excalidraw typed its label → the label follows it', () => {
    const b = board('C', ['shape:tri'])
    newLabel(b.path, 'oursLabel', 'tri')
    b.theirs((txn) => {
      const r = txn.get('shape:tri') as R
      txn.set('shape:tri', { ...r, index: 'a~' } as TLRecord)
    })
    expectOpen(b, ['label-order'])
    const rows = lbRows(b.path)
    expect((rows.get('oursLabel')?.idx as string) > (rows.get('tri')?.idx as string)).toBe(true)
  })

  it('D: R0 creates a note in a frame Excalidraw deleted → the note is a free note', () => {
    const b = board('D')
    oursDeletes(b.path, ['frameInner', 'noteInInner', 'noteInInner.t'])
    b.theirs((txn) => {
      const note = txn.get('shape:noteInInner') as R
      txn.set('shape:newNote', {
        ...note,
        id: 'shape:newNote',
        x: note.x + 20,
        y: note.y + 30,
        index: 'a2',
      } as TLRecord)
    })
    expectOpen(b, ['frame-cleared'])
    const created = els(b.path).find((e) => e.id === 'newNote')
    expect(created?.isDeleted).toBeFalsy()
    expect(created?.frameId).toBeNull()
  })

  const oursDeletesDiamond = (path: string) => {
    oursDeletes(path, ['diamond', 'diamond.t'])
    excalidrawEdit(path, 'arr2', ['bind'], (e) => {
      e.endBinding = null
    })
    excalidrawEdit(path, 'arr3', ['bind'], (e) => {
      e.startBinding = null
    })
  }

  it('F: R0 draws a new arrow bound to a shape Excalidraw deleted → that end is unbound (open item 12)', () => {
    const b = board('F')
    oursDeletesDiamond(b.path)
    b.theirs((txn) => {
      const a = txn.get('shape:arr4') as R
      txn.set('shape:newArrow', {
        ...a,
        id: 'shape:newArrow',
        x: a.x + 10,
        y: a.y + 50,
        index: 'aZ',
      } as TLRecord)
      const bind = txn.get('binding:b3s') as R
      txn.set('binding:newBind', {
        ...bind,
        id: 'binding:newBind',
        fromId: 'shape:newArrow',
        toId: 'shape:diamond',
      } as TLRecord)
    })
    expectOpen(b, ['binding-cleared'])
    const arrow = els(b.path).find((e) => e.id === 'newArrow')
    expect(arrow?.isDeleted).toBeFalsy()
    expect(arrow?.startBinding ?? null).toBeNull()
  })

  it('H: R0 types a label into a shape Excalidraw deleted → the label goes with the shape', () => {
    const b = board('H', ['shape:tri'])
    oursDeletes(b.path, ['tri', 'tri.o'])
    b.theirs((txn) => {
      const r = txn.get('shape:tri') as R
      const star = txn.get('shape:star') as R
      txn.set('shape:tri', { ...r, props: { ...r.props, richText: star.props.richText } } as TLRecord)
    })
    expectOpen(b, ['label-orphaned'])
  })

  it('K (control): R0 moves a shape Excalidraw recoloured → no repair needed', () => {
    const b = board('K')
    excalidrawEdit(b.path, 'diamond', ['style'], (e) => {
      e.strokeColor = '#1971c2'
    })
    b.theirs((txn) => {
      const r = txn.get('shape:rect') as R
      txn.set('shape:rect', { ...r, x: r.x + 30 } as TLRecord)
    })
    const rep = expectOpen(b, [])
    expect(rep.repaired).toEqual([])
  })
})

describe('a record beyond the coordinate limits is clamped, never the whole board refused', () => {
  const geo = (txn: Txn, id: string, over: Record<string, unknown>, props: Record<string, unknown> = {}) => {
    const base = txn.get('shape:rect') as R
    txn.set(id, { ...base, id, ...over, props: { ...base.props, ...props } } as TLRecord)
  }
  const CASES: Record<string, { edit: (txn: Txn) => void; owner: string }> = {
    'far-x-2e6': { edit: (t) => geo(t, 'shape:far', { x: 2e6, y: 0, index: 'aZ1' }), owner: 'far' },
    'wide-2e6': {
      edit: (t) => geo(t, 'shape:wide', { x: 10, y: 0, index: 'aZ1' }, { w: 2e6 }),
      owner: 'wide',
    },
    'huge-size': {
      edit: (t) => geo(t, 'shape:huge', { x: 1e9, y: -1e9, index: 'aZ1' }, { w: 1e9, h: 1e9 }),
      owner: 'huge',
    },
    'moved-existing-far': {
      edit: (t) => {
        const r = t.get('shape:diamond') as R
        t.set('shape:diamond', { ...r, x: 1.2e6 } as TLRecord)
      },
      owner: 'diamond',
    },
  }
  for (const [name, { edit, owner }] of Object.entries(CASES)) {
    it(`${name}: the roll-forward opens the board, the element sits at the edge`, () => {
      const b = board(`raw-${name}`)
      b.theirs(edit)
      const rep = b.rollForward()
      expect(rep.ok, `${rep.reason ?? ''} ${JSON.stringify(rep.failures)}`).toBe(true)
      expect(checkInvariants(els(b.path) as never)).toEqual([])
      expect(rep.lossy['coords-clamped'] ?? 0).toBeGreaterThan(0)
      for (const e of els(b.path)) {
        expect(Math.abs(e.x)).toBeLessThanOrEqual(1_000_000)
        expect(Math.abs(e.y)).toBeLessThanOrEqual(1_000_000)
      }
    })
    it(`${name}: the lazy first conversion opens the board too, and page 2 stays in range`, () => {
      const rooms = join(suiteDir, `lazy-${name}-${n++}`, 'rooms')
      const boardId = `b-rflazy${String(n).padStart(4, '0')}`
      const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
      r0Edit(rooms, boardId, edit)
      const rep = convertBoardFile(
        { kind: 'convert', boardId, path, reportDir: join(rooms, '..', 'migration'), backupKey: null, at: 1 },
        metrics,
      ) as unknown as { ok: boolean; reason?: string; lossy?: Record<string, number> }
      expect(rep.ok, rep.reason).toBe(true)
      expect(rep.lossy?.['coords-clamped'] ?? 0).toBeGreaterThan(0)
      const all = els(path)
      const out = all.filter((e) => Math.abs(e.x) > 1_000_000 || Math.abs(e.y) > 1_000_000)
      expect(out).toEqual([])
      // only the raw record (its parts and label) sits at the edge; the rest of the board, page 2
      // included, is where it was
      const boundToOwner = (e: Record<string, any>) =>
        e.type === 'arrow' && [e.startBinding?.elementId, e.endBinding?.elementId].includes(owner)
      const atEdge = all.filter((e) => Math.abs(e.x) >= 900_000 || Math.abs(e.y) >= 900_000)
      expect(atEdge.length).toBeGreaterThan(0)
      expect(
        atEdge.filter((e) => e.id !== owner && !e.id.startsWith(`${owner}.`) && !boundToOwner(e)),
      ).toEqual([])
    })
  }
})

describe('a geo kind changed on R0: the new outline sits next to its holder, not on top of the board', () => {
  it('rect -> star', () => {
    const b = board('geo', ['shape:rect'])
    b.theirs((txn) => {
      const s = txn.get('shape:rect') as R
      txn.set('shape:rect', { ...s, props: { ...s.props, geo: 'star', w: 73, h: 57 } } as TLRecord)
    })
    const rep = b.rollForward()
    expect(rep.ok).toBe(true)
    const live = [...lbRows(b.path).values()].filter((x) => !x.deleted)
    const order = live
      .sort((a, c) => (a.idx < c.idx ? -1 : a.idx > c.idx ? 1 : a.id < c.id ? -1 : 1))
      .map((x) => x.id)
    const parts = live
      .filter((x) => x.id === 'rect' || x.id.startsWith('rect.'))
      .map((x) => order.indexOf(x.id))
    parts.sort((a, c) => a - c)
    expect(parts.length).toBeGreaterThan(1)
    expect((parts.at(-1) as number) - (parts[0] as number)).toBe(parts.length - 1)
    expect(parts.at(-1)).not.toBe(order.length - 1)
  })

  // V3's wave-5 re-check (open after the engine fixer's round): between holders of different types the
  // holder kept ours' type, so a cloud turned into an ellipse on R0 stayed a transparent rectangle with the
  // ellipse's style, and a diamond turned into a heart stayed a diamond under the heart's outline. Both
  // failed on 747d41d (type 'rectangle' / 'diamond' after the merge).
  const live = (path: string) => [...lbRows(path).values()].filter((x) => !x.deleted)
  const paintOrder = (path: string) =>
    live(path)
      .sort((a, c) => (a.idx < c.idx ? -1 : a.idx > c.idx ? 1 : a.id < c.id ? -1 : 1))
      .map((x) => x.id)
  const elementOf = (path: string, id: string) =>
    JSON.parse(lbRows(path).get(id)?.data ?? 'null') as Record<string, unknown> | null

  it('cloud -> ellipse: the holder becomes a native ellipse (row and data), its outline is deleted', () => {
    const b = board('geo-cloud', ['shape:cloud'])
    expect(elementOf(b.path, 'cloud')?.type).toBe('rectangle')
    expect(lbRows(b.path).get('cloud.o')?.deleted).toBe(0)
    b.theirs((txn) => {
      const s = txn.get('shape:cloud') as R
      txn.set('shape:cloud', { ...s, props: { ...s.props, geo: 'ellipse' } } as TLRecord)
    })
    const rep = b.rollForward()
    expect(
      rep.ok,
      `${rep.reason ?? ''} ${JSON.stringify(rep.failures)} ${JSON.stringify(rep.violations)}`,
    ).toBe(true)
    const holder = elementOf(b.path, 'cloud')
    expect(holder?.type).toBe('ellipse')
    expect(holder?.strokeColor).not.toBe('transparent')
    expect(lbRows(b.path).get('cloud')?.type).toBe('ellipse')
    expect(lbRows(b.path).get('cloud.o')?.deleted).toBe(1)
    expect(checkInvariants(els(b.path) as never)).toEqual([])
    expect(rep.conflicts).toEqual([])
  })

  it('diamond -> heart: the holder becomes the polygon’s transparent rectangle, the outline sits next to it', () => {
    const b = board('geo-diamond', ['shape:diamond'])
    expect(elementOf(b.path, 'diamond')?.type).toBe('diamond')
    expect(lbRows(b.path).has('diamond.o')).toBe(false)
    b.theirs((txn) => {
      const s = txn.get('shape:diamond') as R
      txn.set('shape:diamond', { ...s, props: { ...s.props, geo: 'heart' } } as TLRecord)
    })
    const rep = b.rollForward()
    expect(
      rep.ok,
      `${rep.reason ?? ''} ${JSON.stringify(rep.failures)} ${JSON.stringify(rep.violations)}`,
    ).toBe(true)
    const holder = elementOf(b.path, 'diamond')
    expect(holder?.type).toBe('rectangle')
    expect(holder?.strokeColor).toBe('transparent')
    expect(lbRows(b.path).get('diamond')?.type).toBe('rectangle')
    const outline = elementOf(b.path, 'diamond.o')
    expect(outline?.type).toBe('line')
    expect(outline?.polygon).toBe(true)
    expect(lbRows(b.path).get('diamond.o')?.deleted).toBe(0)
    const order = paintOrder(b.path)
    expect(Math.abs(order.indexOf('diamond.o') - order.indexOf('diamond'))).toBe(1)
    expect(checkInvariants(els(b.path) as never)).toEqual([])
  })

  it('ours moved the cloud on Excalidraw, R0 made it an ellipse: the type changes and the move stays, no conflict', () => {
    const b = board('geo-cloud-move', ['shape:cloud'])
    const before = elementOf(b.path, 'cloud') as Record<string, unknown>
    excalidrawEdit(b.path, 'cloud', ['pos'], (e) => {
      e.x = Number(e.x) + 40
      e.y = Number(e.y) + 25
    })
    b.theirs((txn) => {
      const s = txn.get('shape:cloud') as R
      txn.set('shape:cloud', { ...s, props: { ...s.props, geo: 'ellipse' } } as TLRecord)
    })
    const rep = b.rollForward()
    expect(rep.ok).toBe(true)
    const holder = elementOf(b.path, 'cloud') as Record<string, unknown>
    expect(holder.type).toBe('ellipse')
    expect([holder.x, holder.y]).toEqual([Number(before.x) + 40, Number(before.y) + 25])
    expect(rep.conflicts.filter((c) => c.elementId === 'cloud')).toEqual([])
    expect(checkInvariants(els(b.path) as never)).toEqual([])
  })
})
