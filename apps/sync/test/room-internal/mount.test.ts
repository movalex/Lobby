// The room extension mount point (CR 2F-1, engine-switch.ts) and what room-internal copies from other
// modules (in-process, no server): extensions' routes follow the room's own, the service is otherwise the
// room's, and the place-notes palette and note font stay the converter's.

import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { convertBoard, type TlRecord } from '@draftroom/tldraw-import'
import { describe, expect, it } from 'vitest'
import {
  type ElementRoomDeps,
  type ElementRoomService,
  extendElementRoom,
  type InternalRoute,
  registerRoomExtension,
} from '../../src/engine-switch.ts'
import { NOTE_FILL, NOTE_FONT_FAMILY, NOTE_FONT_SIZE, NOTE_INK } from '../../src/room-internal/place-notes.ts'
import { docRecord, nthIndex, pageRecord, note as tlNote } from '../migrate/tl-records.ts'

const route = (path: RegExp): InternalRoute => ({ method: 'GET', path, handle: () => undefined })

function fakeService(): ElementRoomService & { closedAll: number } {
  const svc = {
    closedAll: 0,
    connect: () => ({ message() {}, closed() {} }),
    routes: () => [route(/^\/internal\/boards\/([^/]+)\/snapshot$/)],
    metrics: () => 'm 1',
    async closeAll() {
      svc.closedAll++
    },
    roomIfOpen: (b: string) => (b === 'open-board' ? { closeSession() {} } : null),
    sessionsOf: () => [],
    openBoards: () => ['open-board'],
  }
  return svc
}
const deps = {
  dataDir: '.',
  config: {},
  log() {},
  onSessionRemoved() {},
  onDocumentChange() {},
} as unknown as ElementRoomDeps

describe('the room extension mount point (CR 2F-1)', () => {
  it('appends the extensions’ routes after the room’s own and forwards everything else', async () => {
    const svc = fakeService()
    const seen: unknown[] = []
    const off = registerRoomExtension((ctx) => {
      seen.push(ctx.service, ctx.deps)
      return [route(/^\/internal\/boards\/([^/]+)\/text$/)]
    })
    try {
      const ext = extendElementRoom(svc, deps)
      expect(ext).not.toBe(svc)
      expect(ext.routes().map((r) => String(r.path))).toEqual([
        String(/^\/internal\/boards\/([^/]+)\/snapshot$/),
        String(/^\/internal\/boards\/([^/]+)\/text$/),
      ])
      ext.routes()
      expect(seen).toEqual([svc, deps]) // built once, from the room's own service
      expect(ext.metrics()).toBe('m 1')
      expect(ext.roomIfOpen('open-board')).not.toBeNull()
      expect(ext.openBoards()).toEqual(['open-board'])
      await ext.closeAll()
      expect(svc.closedAll).toBe(1)
      expect(ext.prepareBoard).toBeUndefined()
      expect(ext.serverWrite).toBeUndefined()
    } finally {
      off()
    }
  })

  it('is the service itself when nothing is registered, and forwards CR 2F-2 members when the room has them', async () => {
    const svc = fakeService()
    expect(extendElementRoom(svc, deps)).toBe(svc)
    const withHooks = Object.assign(fakeService(), {
      prepareBoard: async (b: string) => b === 'x',
      serverWrite: async <T>(_b: string, apply: (tx: never) => { result: T }) => apply({} as never).result,
    })
    const off = registerRoomExtension(() => [])
    try {
      const ext = extendElementRoom(withHooks as ElementRoomService, deps)
      expect(await ext.prepareBoard?.('x')).toBe(true)
      expect(await ext.serverWrite?.('x', () => ({ changed: [], doc: {}, result: 7 }))).toBe(7)
    } finally {
      off()
    }
  })
})

describe('place-notes builds notes as the converter does', () => {
  it('uses the converter’s note fill for every colour, its ink, and its label font and size', () => {
    const metrics = installedServerTextMetrics() ?? installServerTextMetrics()
    const colors = Object.keys(NOTE_FILL)
    const records = [
      docRecord(),
      pageRecord('page:page', 'Page 1', 'a1'),
      ...colors.map((color, i) => tlNote(`n${i}`, 'page:page', nthIndex(i + 2), i * 300, 0, 'x', { color })),
    ] as unknown as TlRecord[]
    const conv = convertBoard(records, { updatedAt: 1, metrics })
    for (const [i, color] of colors.entries()) {
      const note = conv.elements.find((e) => e.id === `n${i}`) as Record<string, unknown>
      const label = conv.elements.find((e) => e.type === 'text' && e.containerId === `n${i}`) as Record<
        string,
        unknown
      >
      expect(note.backgroundColor, color).toBe(NOTE_FILL[color])
      expect(note.strokeColor).toBe(NOTE_INK)
      expect(label.fontFamily).toBe(NOTE_FONT_FAMILY)
      expect(label.baseFontSize).toBe(NOTE_FONT_SIZE)
    }
  })
})
