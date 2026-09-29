// The roll-forward's property test (docs/EXCALIDRAW-MIGRATION.md §6.1 "Roll-forward merge"): random
// tldraw-side edits (add, delete, move, re-order, page-2 edit, frame move) against random Excalidraw-side
// edits (recolour, move, delete, create), 40 seeds: no edit is lost except listed same-group conflicts,
// elements neither side touched are byte-identical, and Excalidraw-era order is kept.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import type { TLRecord } from '@tldraw/tlschema'
import { afterAll, describe, expect, it } from 'vitest'
import { unregisterBornAfterCheck } from '../../src/r0/index.ts'
import { convertBoardFile } from '../../src/room/migrate/convert-board.ts'
import { rollForwardBoardFile } from '../../src/room/migrate/rollforward.ts'
import {
  excalidrawCreate,
  excalidrawEdit,
  fixtureRecords,
  lbRows,
  r0Edit,
  seedBoardRecords,
} from './support.ts'

const metrics = installServerTextMetrics(createTableTextMetrics())
const suiteDir = mkdtempSync(join(tmpdir(), 'dr-rfp-'))
afterAll(() => {
  unregisterBornAfterCheck()
  rmSync(suiteDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const COLORS = ['red', 'green', 'violet', 'orange', 'light-blue'] as const
/** Shapes on page 1 with no bindings and no children (their moves compose with nothing else). */
const ROOT_PLAIN = [
  'shape:star',
  'shape:cloud',
  'shape:title',
  'shape:draw1',
  'shape:pen1',
  'shape:hl',
  'shape:line1',
]
const PAGE2 = ['shape:img1', 'shape:pdfPage', 'shape:card1']
const OURS_EDITABLE = [
  'star',
  'cloud',
  'title',
  'draw1',
  'pen1',
  'hl',
  'line1',
  'img1',
  'pdfPage',
  'card1',
  'diamond',
]

function prng(seed: number) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
}

describe('roll-forward property test', () => {
  for (let seed = 1; seed <= 40; seed++)
    it(`seed ${seed}`, () => {
      const rand = prng(seed * 7919)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
      const rooms = join(suiteDir, `s${seed}`, 'rooms')
      const boardId = `b-prop${String(seed).padStart(5, '0')}`
      const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
      expect(
        convertBoardFile(
          {
            kind: 'convert',
            boardId,
            path,
            reportDir: join(rooms, '..', 'migration'),
            backupKey: null,
            at: 1,
          },
          metrics,
        ).ok,
      ).toBe(true)
      const converted = lbRows(path)

      // ---- ours: 1-4 edits on distinct elements
      const oursEdits = new Map<string, { kind: 'color' | 'delete' | 'move'; value?: string }>()
      for (let i = 0, n = 1 + Math.floor(rand() * 4); i < n; i++) {
        const id = pick(OURS_EDITABLE)
        if (oursEdits.has(id)) continue
        const kind = pick(['color', 'color', 'delete', 'move'] as const)
        if (kind === 'color') {
          const value = `#0000${String(10 + i).padStart(2, '0')}`
          excalidrawEdit(path, id, ['style'], (e) => {
            e.strokeColor = value
          })
          oursEdits.set(id, { kind, value })
        } else if (kind === 'delete') {
          excalidrawEdit(path, id, ['life'], (e) => {
            e.isDeleted = true
          })
          oursEdits.set(id, { kind })
        } else {
          const linear = ['line1', 'draw1', 'pen1', 'hl'].includes(id)
          excalidrawEdit(path, id, [linear && id === 'line1' ? 'path' : 'pos'], (e) => {
            e.y = (e.y as number) + 33
          })
          oursEdits.set(id, { kind })
        }
      }
      const created = rand() < 0.6
      if (created)
        excalidrawCreate(path, {
          ...JSON.parse(converted.get('star')?.data ?? '{}'),
          id: `ours-new-${seed}`,
          groupIds: [],
          boundElements: null,
          customData: undefined,
          index: `${converted.get('hl')?.idx}V`,
          version: 1,
        })
      const oursBefore = lbRows(path)

      // ---- theirs: 1-5 edits on distinct records
      const theirsEdits = new Map<
        string,
        { kind: 'color' | 'delete' | 'move' | 'reorder' | 'add' | 'frame'; value?: string; dx?: number }
      >()
      r0Edit(rooms, boardId, (txn) => {
        for (let i = 0, n = 1 + Math.floor(rand() * 5); i < n; i++) {
          const kind = pick(['color', 'delete', 'move', 'reorder', 'add', 'page2', 'frame'] as const)
          const id = kind === 'page2' ? pick(PAGE2) : kind === 'frame' ? 'shape:frameA' : pick(ROOT_PLAIN)
          if (theirsEdits.has(id)) continue
          const r = txn.get(id) as
            | (TLRecord & { x: number; y: number; props: Record<string, unknown> })
            | undefined
          if (!r) continue
          if (kind === 'color' && 'color' in r.props) {
            const value = pick(COLORS)
            txn.set(id, { ...r, props: { ...r.props, color: value } } as TLRecord)
            theirsEdits.set(id, { kind, value })
          } else if (kind === 'delete') {
            txn.delete(id)
            theirsEdits.set(id, { kind })
          } else if (kind === 'move' || kind === 'page2' || kind === 'frame') {
            const dx = 25 + Math.round(rand() * 50)
            txn.set(id, { ...r, x: r.x + dx } as TLRecord)
            theirsEdits.set(id, { kind: kind === 'frame' ? 'frame' : 'move', dx })
          } else if (kind === 'reorder') {
            txn.set(id, { ...r, index: 'a0' } as unknown as TLRecord)
            theirsEdits.set(id, { kind })
          } else if (kind === 'add') {
            const nid = `shape:theirs${seed}${i}`
            txn.set(nid, { ...r, id: nid, x: r.x + 400, index: 'aZ', meta: {} } as unknown as TLRecord)
            theirsEdits.set(nid, { kind: 'add' })
          }
        }
      })

      const rep = rollForwardBoardFile(
        { kind: 'rollforward', boardId, path, reportDir: join(rooms, '..', 'migration'), at: 2 },
        metrics,
      )
      expect({ ok: rep.ok, reason: rep.reason, failures: rep.failures }).toEqual({
        ok: true,
        reason: rep.reason === 'nothing-to-merge' ? 'nothing-to-merge' : undefined,
        failures: [],
      })
      if (rep.reason === 'nothing-to-merge') return
      const after = lbRows(path)
      const data = (id: string) => JSON.parse(after.get(id)?.data ?? 'null') as Record<string, unknown> | null
      const conflict = (id: string, g: string) =>
        rep.conflicts.some((c) => c.elementId === id && c.group === g)
      const theirsOf = (elId: string) => theirsEdits.get(`shape:${elId}`)

      // no ours edit is lost except a listed conflict or a theirs delete (delete wins)
      for (const [id, edit] of oursEdits) {
        const t = theirsOf(id)
        if (t?.kind === 'delete') {
          expect(after.get(id)?.deleted).toBe(1)
          continue
        }
        if (edit.kind === 'delete') expect(after.get(id)?.deleted).toBe(1)
        else if (edit.kind === 'color') {
          if (t?.kind === 'color') expect(conflict(id, 'style')).toBe(true)
          else expect(data(id)?.strokeColor).toBe(edit.value)
        } else if (edit.kind === 'move') {
          const moved = t?.kind === 'move'
          if (moved) expect(conflict(id, id === 'line1' ? 'path' : 'pos')).toBe(true)
          else expect(data(id)?.y).toBe(JSON.parse(oursBefore.get(id)?.data ?? '{}').y)
        }
      }
      if (created) expect(after.get(`ours-new-${seed}`)).toEqual(oursBefore.get(`ours-new-${seed}`))
      // no theirs edit is lost (ours deleted it: delete wins; both wrote a group: theirs wins)
      for (const [shapeId, edit] of theirsEdits) {
        const id = shapeId.slice('shape:'.length)
        if (edit.kind === 'add') {
          expect(after.get(id)?.deleted).toBe(0)
          continue
        }
        if (oursEdits.get(id)?.kind === 'delete') continue
        if (edit.kind === 'delete') expect(after.get(id)?.deleted).toBe(1)
        if (edit.kind === 'move') {
          const before = JSON.parse(converted.get(id)?.data ?? '{}').x as number
          expect(data(id)?.x).toBeCloseTo(before + (edit.dx ?? 0), 1)
        }
        if (edit.kind === 'frame')
          expect(data('frameA')?.x).toBeCloseTo(
            (JSON.parse(converted.get('frameA')?.data ?? '{}').x as number) + (edit.dx ?? 0),
            1,
          )
      }
      // untouched by either side (and not inside a moved frame, not an arrow): byte-identical
      const frameMoved = theirsEdits.has('shape:frameA')
      for (const [id, row] of oursBefore) {
        const owner = id.split('.')[0] as string
        const touched =
          oursEdits.has(owner) ||
          theirsEdits.has(`shape:${owner}`) ||
          owner.startsWith('arr') ||
          (frameMoved &&
            ['frameA', 'frameInner', 'noteInInner', 'note1', 'note2', 'note3', 'grpGeo', 'grpNote'].includes(
              owner,
            ))
        if (!touched) expect({ id, row: after.get(id) }).toEqual({ id, row })
      }
      // ours' order is kept among elements theirs did not re-place
      const replaced = new Set(
        [...theirsEdits].filter(([, e]) => e.kind === 'reorder' || e.kind === 'add').map(([s]) => s.slice(6)),
      )
      const keptIds = [...oursBefore.keys()].filter((id) => !replaced.has(id.split('.')[0] as string))
      const byIdx = (m: typeof after) =>
        [...keptIds].sort((a, b) => ((m.get(a)?.idx ?? '') < (m.get(b)?.idx ?? '') ? -1 : 1))
      expect(byIdx(after)).toEqual(byIdx(oursBefore))
      // live indices stay unique
      const live = [...after.values()].filter((r) => !r.deleted).map((r) => r.idx)
      expect(new Set(live).size).toBe(live.length)
    })
})
