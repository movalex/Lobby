// P-005: which selected element typing labels (a plain shape) and the rule the key allowlist asks.
import { describe, expect, it } from 'vitest'
import { type CanvasFeatureContext, createFeatureRegistries } from '../../../canvas/api/index.ts'
import { KEYS } from './keys.ts'
import { installTypeToLabel, isPlainShape, labelsOnType, typesOnKey } from './type-to-label.ts'

type El = { id: string; type: string; customData?: unknown; isDeleted?: boolean }

function fake(
  els: El[],
  o: { selection?: string[]; readOnly?: boolean; editing?: string | null; locked?: string[] } = {},
) {
  const registries = createFeatureRegistries()
  const canvas = {
    selection: o.selection ?? [],
    get: (id: string) => els.find((e) => e.id === id),
    readOnly: () => o.readOnly ?? false,
    editingId: () => o.editing ?? null,
    isLocked: (id: string) => (o.locked ?? []).includes(id),
    setTool: () => true,
  }
  const ctx = { canvas, registries } as unknown as CanvasFeatureContext
  return { ctx, canvas: ctx.canvas, registries }
}

const rect: El = { id: 'r', type: 'rectangle' }
const ellipse: El = { id: 'o', type: 'ellipse' }
const diamond: El = { id: 'd', type: 'diamond' }
const note: El = { id: 'n', type: 'stickynote' }
const linkCard: El = { id: 'l', type: 'rectangle', customData: { lobby: { kind: 'link-card' } } }
const boardCard: El = { id: 'b', type: 'rectangle', customData: { lobby: { kind: 'board-card' } } }
const topic: El = { id: 't', type: 'ellipse', customData: { lobby: { mindmap: { rootId: 't' } } } }
const tagged: El = { id: 'g', type: 'rectangle', customData: { lobby: { ai: { by: 'u' } } } }
const image: El = { id: 'i', type: 'image' }
const arrow: El = { id: 'a', type: 'arrow' }
const text: El = { id: 'x', type: 'text' }

describe('isPlainShape', () => {
  it('a rectangle, an ellipse or a diamond, also one with other Lobby data (an AI mark)', () => {
    for (const el of [rect, ellipse, diamond, tagged]) expect(isPlainShape(el), el.id).toBe(true)
  })
  it('not a card, a mind-map topic, a note, an image, an arrow or a text', () => {
    for (const el of [linkCard, boardCard, topic, note, image, arrow, text])
      expect(isPlainShape(el), el.id).toBe(false)
  })
})

describe('labelsOnType and typesOnKey', () => {
  const all = [rect, ellipse, note, linkCard, image, { ...diamond, isDeleted: true }]
  it('a plain unlocked shape, for an editor, with no text editor open', () => {
    expect(labelsOnType(fake(all).canvas, 'r')).toBe(true)
    expect(labelsOnType(fake(all, { locked: ['r'] }).canvas, 'r')).toBe(false)
    expect(labelsOnType(fake(all, { readOnly: true }).canvas, 'r')).toBe(false)
    expect(labelsOnType(fake(all, { editing: 'n' }).canvas, 'r')).toBe(false)
    expect(labelsOnType(fake(all).canvas, 'l')).toBe(false)
    expect(labelsOnType(fake(all).canvas, 'd')).toBe(false) // deleted
    expect(labelsOnType(fake(all).canvas, 'missing')).toBe(false)
  })
  it('typesOnKey: one selected note or plain shape, unlocked', () => {
    expect(typesOnKey(fake(all, { selection: ['r'] }).canvas)).toBe(true)
    expect(typesOnKey(fake(all, { selection: ['o'] }).canvas)).toBe(true)
    expect(typesOnKey(fake(all, { selection: ['n'] }).canvas)).toBe(true)
    expect(typesOnKey(fake(all, { selection: ['n'], locked: ['n'] }).canvas)).toBe(false)
    expect(typesOnKey(fake(all, { selection: ['r', 'o'] }).canvas)).toBe(false)
    expect(typesOnKey(fake(all, { selection: ['i'] }).canvas)).toBe(false)
    expect(typesOnKey(fake(all, { selection: ['l'] }).canvas)).toBe(false)
    expect(typesOnKey(fake(all, { selection: [] }).canvas)).toBe(false)
  })
})

describe('the registered rule', () => {
  it('applies to plain shapes and leaves the edit to the allowlist’s lease flow (start declines)', () => {
    const f = fake([rect, linkCard])
    const off = installTypeToLabel(f.ctx)
    const spec = f.registries.typeToEdit.get('canvas-ux.type-to-label')
    expect(spec?.applies('r')).toBe(true)
    expect(spec?.applies('l')).toBe(false)
    expect(spec?.start('r', 'a')).toBe(false)
    off()
    expect(f.registries.typeToEdit.get('canvas-ux.type-to-label')).toBeUndefined()
  })

  it('Shift+D on a selected shape is a letter for its label, not the highlighter', () => {
    const highlight = KEYS.find((k) => k.id === 'canvas-ux.tool-highlight')
    const e = { key: 'D', code: 'KeyD', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }
    expect(highlight?.match?.(e, fake([rect], { selection: ['r'] }).ctx)).toBe(false)
    expect(highlight?.match?.(e, fake([image], { selection: ['i'] }).ctx)).toBe(true)
  })
})
