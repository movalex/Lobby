// The `cards` and `kanban` export layers: what an export draws over the engine's picture (export coordinates, literal
// colours, text as <text>, only the exported elements).
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { kanbanExportSvg } from '../kanban/export.ts'
import { cardsExportSvg } from './export.ts'

const el = (id: string, type: string, lobby: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type,
    x: 100,
    y: 100,
    width: 200,
    height: 200,
    isDeleted: false,
    frameId: null,
    customData: { lobby },
    ...extra,
  }) as unknown as CanvasElement

const canvasOf = (els: CanvasElement[]) =>
  ({
    index: {
      withLobbyKey: (k: string) => els.filter((e) => k in (e.customData?.lobby ?? {})),
      byFrame: (f: string) => els.filter((e) => e.frameId === f),
    },
    collaborators: () => [{ uid: 'u1', name: 'Ada Lovelace' }],
  }) as unknown as LobbyCanvas

describe('the cards export layer', () => {
  it('draws each exported card’s status (words and icon), due date and initials at p - origin', () => {
    const c = canvasOf([
      el('c1', 'stickynote', { 'card:status': 'blocked', 'card:due': '2000-01-03', 'card:who': 'u1' }),
      el('c2', 'stickynote', { 'card:status': 'done' }),
    ])
    const svg = cardsExportSvg({ canvas: c, exported: new Set(['c1']), origin: { x: 100, y: 100 } })
    expect(svg).toContain('<rect x="8" y="172"')
    expect(svg).toContain('>Blocked</text>')
    expect(svg).toContain('>Overdue · 3 Jan 2000</text>')
    expect(svg).toContain('>AL</text>')
    expect(svg).not.toContain('Done')
    expect(svg).not.toMatch(/var\(|href=|url\(/)
    expect(cardsExportSvg({ canvas: c, exported: new Set(), origin: { x: 0, y: 0 } })).toBe('')
  })
})

describe('the kanban export layer', () => {
  it('draws the column names, counts and WIP warnings and the lines between columns', () => {
    const c = canvasOf([
      el(
        'k',
        'frame',
        { kanban: { labels: { doing: 'Shooting <A&B>' }, wip: { doing: 1 }, hidden: ['blocked'] } },
        {
          x: 0,
          y: 0,
          width: 1200,
          height: 800,
        },
      ),
      el('a', 'stickynote', { 'card:status': 'doing' }, { frameId: 'k' }),
      el('b', 'stickynote', { 'card:status': 'doing' }, { frameId: 'k' }),
    ])
    const svg = kanbanExportSvg({ canvas: c, exported: new Set(['k']), origin: { x: 0, y: 0 } })
    expect(svg).toContain('>To do</text>')
    expect(svg).toContain('>Shooting &lt;A&amp;B&gt;</text>')
    expect(svg).toContain('>2 / 1 · over the limit</text>')
    expect(svg).not.toContain('Blocked')
    expect(svg.match(/stroke-dasharray/g)).toHaveLength(3)
    expect(svg).not.toMatch(/var\(/)
  })
})
