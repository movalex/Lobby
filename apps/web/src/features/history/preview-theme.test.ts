// Wave M (W2, M2-4, FTU-9): the time-travel preview's frame names and note labels in the board's inks
// (./preview-theme.ts). The colours are checked through the engine's own dark table (canvas/engine/theme.ts), the one
// the exporter draws the preview with, so what is asserted is the colour a person sees, not the one stored.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { contrastRatio } from '../a11y/ported/contrast.ts'

// the engine creates its dark-mode cache only in a browser (`typeof window`): stand one in before it loads
;(globalThis as { window?: unknown }).window ??= globalThis
const theme = await import('../../canvas/engine/theme.ts')
const pt = await import('./preview-theme.ts')

beforeAll(() => {
  expect(theme.installLobbyEngineTheme()).toBe(true)
})

/**
 * The colour the exporter draws a stored colour in, in `mode`: in dark Lobby's table decides (the colours used here are
 * all ones it answers; a grey or a non-hex colour would be left to the engine's own filter and fails the test).
 */
const drawn = (stored: string, mode: 'light' | 'dark'): string => {
  if (mode === 'light') return stored
  const answer = theme.lobbyDarkColor(stored)
  if (answer === null) throw new Error(`${stored} is left to the engine's own dark filter`)
  return answer
}

const frame = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  type: 'frame',
  x: 100,
  y: 200,
  width: 800,
  height: 450,
  name: 'Plan',
  isDeleted: false,
  ...over,
})
const note = (id: string, fill: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'stickynote',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  backgroundColor: fill,
  isDeleted: false,
  ...over,
})
const label = (id: string, containerId: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'text',
  containerId,
  text: 'Idea',
  strokeColor: '#1e1e1e',
  isDeleted: false,
  ...over,
})
type Out = Record<string, unknown> & { id: string }
const run = (els: unknown[], mode: 'light' | 'dark') => pt.themedPreviewElements(els, mode) as Out[]
const byId = (els: Out[], id: string) => els.find((e) => e.id === id)

describe('frame names', () => {
  it('a frame keeps nothing of its own to draw as a name and gets a text element above its top left, after it', () => {
    const out = run([frame()], 'dark')
    expect(out.map((e) => e.id)).toEqual(['f1', 'lobby-preview-label:f1'])
    expect(byId(out, 'f1')?.name).toBe('')
    const l = byId(out, 'lobby-preview-label:f1') as Out
    expect(l).toMatchObject({ type: 'text', text: 'Plan', x: 100, containerId: null, frameId: null })
    // the label's bottom is the engine's gap above the frame
    expect((l.y as number) + (l.height as number)).toBe(200 - 6)
  })

  it('the name is drawn in Lobby’s ink in both modes: INK on the canvas in light, >= 4.5:1 in dark', () => {
    for (const mode of ['light', 'dark'] as const) {
      const l = byId(run([frame()], mode), 'lobby-preview-label:f1') as Out
      const shown = drawn(l.strokeColor as string, mode)
      const bg = mode === 'light' ? theme.CANVAS_LIGHT : theme.CANVAS_DARK
      expect(shown, mode).toBe(mode === 'light' ? theme.INK : theme.CHALK)
      expect(contrastRatio(shown, bg), mode).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("why: the engine's own dark name colour is a grey the table leaves to the engine's filter, which turns it dark", () => {
    expect(theme.lobbyDarkColor(theme.FRAME_NAME_DARK)).toBeNull()
  })

  it('an unnamed frame is called Frame; a long name is cut at the frame’s width; a blank name draws nothing', () => {
    expect((byId(run([frame({ name: null })], 'light'), 'lobby-preview-label:f1') as Out).text).toBe('Frame')
    const cut = byId(
      run([frame({ name: 'x'.repeat(300), width: 200 })], 'light'),
      'lobby-preview-label:f1',
    ) as Out
    expect((cut.text as string).length).toBeLessThan(30)
    expect(cut.text as string).toMatch(/…$/)
    expect((cut.width as number) <= 200).toBe(true)
    expect(run([frame({ name: '   ' })], 'light').map((e) => e.id)).toEqual(['f1'])
  })

  it('a deleted frame, other elements and the order are left as they are; the input is not changed', () => {
    const input = [
      note('n1', '#f6c453'),
      frame({ isDeleted: true }),
      frame({ id: 'f2' }),
      { id: 'r', type: 'rectangle' },
    ]
    const snapshot = JSON.stringify(input)
    const out = run(input, 'dark')
    expect(out.map((e) => e.id)).toEqual(['n1', 'f1', 'f2', 'lobby-preview-label:f2', 'r'])
    expect(byId(out, 'f1')?.name).toBe('Plan') // deleted: untouched
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('frameOfPreviewLabel', () => {
  it('names the frame a title stands for, and nothing for any other id', () => {
    expect(pt.frameOfPreviewLabel('lobby-preview-label:f9')).toBe('f9')
    expect(pt.frameOfPreviewLabel('f9')).toBeNull()
    expect(pt.frameOfPreviewLabel('')).toBeNull()
  })
})

describe('note labels (noteInkFor)', () => {
  it('today’s ink (INK in light, CHALK in dark) is drawn as noteInkFor says, in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const out = run([note('n1', '#f6c453'), label('t1', 'n1')], mode)
      const t = byId(out, 't1') as Out
      expect(drawn(t.strokeColor as string, mode), mode).toBe(theme.noteInkFor('#f6c453', mode))
    }
  })

  it('N1 (wave M follow-up 2): a label in a colour the person chose keeps it, in both modes (only the default ink is swapped)', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const chosen of ['#e03131', '#2f9e44', '#f6c453']) {
        const els = [note('n1', '#b2f2bb'), label('t1', 'n1', { strokeColor: chosen })]
        const out = run(els, mode)
        expect(byId(out, 't1'), `${mode} ${chosen}`).toBe(els[1])
      }
    }
    // the default inks are still swapped: Excalidraw's #1e1e1e, Lobby's INK and black
    for (const dflt of ['#1e1e1e', theme.INK, '#000000']) {
      const out = run([note('n1', '#f6c453'), label('t1', 'n1', { strokeColor: dflt })], 'dark')
      expect(drawn((byId(out, 't1') as Out).strokeColor as string, 'dark'), dflt).toBe(
        theme.noteInkFor('#f6c453', 'dark'),
      )
    }
  })

  it('a label that is not a note’s (a shape’s, a free text) is not touched', () => {
    const els = [
      { id: 'r1', type: 'rectangle', backgroundColor: '#b2f2bb' },
      label('t2', 'r1'),
      { id: 't3', type: 'text', containerId: null, strokeColor: '#e03131' },
    ]
    const out = run(els, 'dark')
    expect(byId(out, 't2')).toBe(els[1])
    expect(byId(out, 't3')).toBe(els[2])
  })

  it('stores the colour the exporter must be given: INK for CHALK, a hair off INK for INK (drawn as it is, not as CHALK)', () => {
    expect(pt.storedInkFor(theme.CHALK, 'dark')).toBe(theme.INK)
    expect(drawn(pt.storedInkFor(theme.CHALK, 'dark') as string, 'dark')).toBe(theme.CHALK)
    const dark = pt.storedInkFor(theme.INK, 'dark') as string
    expect(dark).toBe(pt.INK_DRAWN_AS_IS)
    expect(dark).not.toBe(theme.INK) // INK itself would be drawn as CHALK
    expect(drawn(dark, 'dark')).toBe(pt.INK_DRAWN_AS_IS)
    expect(contrastRatio(pt.INK_DRAWN_AS_IS, theme.INK)).toBeLessThan(1.05) // the same ink to the eye
    // light: as it is; an ink that is neither answer of noteInkFor is left alone
    expect(pt.storedInkFor(theme.CHALK, 'light')).toBe(theme.CHALK)
    expect(pt.storedInkFor('#ff0000', 'dark')).toBeNull()
  })

  it('with W1’s rule (a light pastel gets INK, also in dark) the label is dark on the pastel, >= 4.5:1 (it was CHALK on it, about 1.1:1)', async () => {
    vi.resetModules()
    vi.doMock('../../canvas/engine/theme.ts', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../canvas/engine/theme.ts')>()
      return { ...real, noteInkFor: (fill: string) => (fill === '#b2f2bb' ? real.INK : real.CHALK) }
    })
    try {
      const w1 = await import('./preview-theme.ts')
      const out = w1.themedPreviewElements([note('n1', '#b2f2bb'), label('t1', 'n1')], 'dark') as Out[]
      const t = byId(out, 't1') as Out
      const shown = drawn(t.strokeColor as string, 'dark')
      // the pastel is drawn as it is in dark (any other explicit colour); the label is dark
      expect(theme.lobbyDarkColor('#b2f2bb')).toBe('#b2f2bb')
      expect(contrastRatio(shown, '#b2f2bb')).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(theme.CHALK, '#b2f2bb')).toBeLessThan(2)
    } finally {
      vi.doUnmock('../../canvas/engine/theme.ts')
      vi.resetModules()
    }
  })
})
