import { describe, expect, it } from 'vitest'
import { classifyEditorWrites, type ElementSnapshot, groupOf, wouldPush } from './fit.ts'

const note: ElementSnapshot = {
  id: 'note',
  type: 'stickynote',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  baseHeight: 200,
  version: 3,
  versionNonce: 1,
  boundElements: [
    { id: 'label', type: 'text' },
    { id: 'arrow', type: 'arrow' },
  ],
}
const label: ElementSnapshot = {
  id: 'label',
  type: 'text',
  containerId: 'note',
  x: 16,
  y: 80,
  width: 100,
  height: 25,
  fontSize: 20,
  text: 'Hi',
  originalText: 'Hi',
  version: 2,
}
const arrow: ElementSnapshot = {
  id: 'arrow',
  type: 'arrow',
  x: 100,
  y: 300,
  width: 0,
  height: 100,
  points: [
    [0, 0],
    [0, -100],
  ],
  endBinding: { elementId: 'note' },
  version: 4,
}
const other: ElementSnapshot = { id: 'r', type: 'rectangle', x: 500, y: 0, width: 10, height: 10, version: 1 }

const map = (...els: ElementSnapshot[]) => new Map(els.map((e) => [e.id, e]))
const ctx = { labelId: 'label', containerId: 'note', holder: true, gesture: false }

describe('classifyEditorWrites (§2.9.4 rule 1)', () => {
  it("the holder's container growth is fit, never pos/shape; the label's words and layout keep their groups", () => {
    const next = map(
      { ...note, height: 260, version: 4, versionNonce: 2 },
      { ...label, text: 'Hi there\nfriend', originalText: 'Hi there friend', height: 50, y: 70, version: 3 },
      {
        ...arrow,
        y: 360,
        height: 40,
        points: [
          [0, 0],
          [0, -40],
        ],
        version: 5,
      },
      other,
    )
    const out = classifyEditorWrites(map(note, label, arrow, other), next, ctx)
    const byId = Object.fromEntries(out.map((w) => [w.id, w]))
    expect(byId.note).toMatchObject({ role: 'container', fit: { height: 260 }, groups: {} })
    expect(byId.label).toMatchObject({
      role: 'label',
      groups: { layout: ['height', 'text', 'y'], text: ['originalText'] },
    })
    expect(byId.arrow).toMatchObject({
      role: 'bound-arrow',
      groups: { pos: ['y'], shape: ['height', 'points'] },
    })
    expect(byId.r).toBeUndefined()
  })

  it('baseHeight is not a fit field (the wire fit has only x, y, width, height)', () => {
    const out = classifyEditorWrites(map(note), map({ ...note, baseHeight: 210, height: 210 }), ctx)
    expect(out[0]).toMatchObject({ fit: { height: 210 }, groups: { shape: ['baseHeight'] } })
  })

  it('a non-holder, or a running gesture, writes ordinary pos/shape', () => {
    const next = map({ ...note, x: 40, height: 260 })
    for (const c of [
      { ...ctx, holder: false },
      { ...ctx, gesture: true },
    ]) {
      const out = classifyEditorWrites(map(note), next, c)
      expect(out[0]?.fit).toBeUndefined()
      expect(out[0]?.groups).toEqual({ pos: ['x'], shape: ['height'] })
    }
  })

  it('while the lease is pending, the label and the fit are held back; other writes would be pushed', () => {
    const next = map(
      { ...note, height: 230 },
      { ...label, x: 18, width: 98 },
      { ...other, x: 510 },
      { id: 'new-label', type: 'text', containerId: 'note2' },
    )
    const out = classifyEditorWrites(map(note, label, other), next, { ...ctx, holder: false, pending: true })
    const byId = Object.fromEntries(out.map((w) => [w.id, w]))
    expect(byId.note).toMatchObject({ role: 'container', fit: { height: 230 }, heldBack: true })
    expect(byId.label).toMatchObject({ role: 'label', groups: { layout: ['width', 'x'] }, heldBack: true })
    expect(byId.r).toMatchObject({ role: 'other', heldBack: false })
    expect(wouldPush(out).map((w) => w.id)).toEqual(['r', 'new-label'])
    // A container write beyond the fit (a style change while pending) is not held back.
    const styled = classifyEditorWrites(map(note), map({ ...note, height: 230, backgroundColor: '#fff' }), {
      ...ctx,
      holder: false,
      pending: true,
    })
    expect(styled[0]).toMatchObject({
      fit: { height: 230 },
      groups: { style: ['backgroundColor'] },
      heldBack: false,
    })
  })

  it('field groups are per element kind: a bound label x/y/width/height/fontSize are layout', () => {
    expect(groupOf(label, 'x')).toBe('layout')
    expect(groupOf(label, 'fontSize')).toBe('layout')
    expect(groupOf({ id: 't', type: 'text' }, 'width')).toBe('layout')
    expect(groupOf({ id: 't', type: 'text' }, 'x')).toBe('pos')
    expect(groupOf({ id: 't', type: 'text' }, 'fontSize')).toBe('textStyle')
    expect(groupOf(note, 'baseHeight')).toBe('shape')
    expect(groupOf(note, 'version')).toBe('server')
  })
})
