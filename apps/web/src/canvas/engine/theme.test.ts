// W5-10 and W5-15 (wave 5, 2C): frame names and outlines that read, and Lobby's dark-mode colours.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { contrastRatio } from '../../features/a11y/ported/contrast.ts'
import { NOTE_PALETTE } from '../../features/canvas-ux/palette.ts'
import type { EditorInkSource } from './theme.ts'

// the engine creates its dark-mode cache only in a browser (`typeof window`): stand one in before it loads
;(globalThis as { window?: unknown }).window ??= globalThis
const common = await import('@excalidraw/common')
const theme = await import('./theme.ts')

beforeAll(() => {
  expect(theme.installLobbyEngineTheme()).toBe(true)
})

const dark = (c: string) => common.applyDarkModeFilter(c, true)

describe('W5-10: frames read on the canvas', () => {
  it('frame names are Lobby ink, >= 4.5:1 on the canvas in both modes (was #999999, 2.65:1)', () => {
    const fs = common.FRAME_STYLE as {
      nameColorLightTheme: string
      nameColorDarkTheme: string
      strokeColor: string
    }
    expect(fs.nameColorLightTheme).toBe(theme.INK)
    expect(contrastRatio(fs.nameColorLightTheme, theme.CANVAS_LIGHT)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(fs.nameColorDarkTheme, theme.CANVAS_DARK)).toBeGreaterThanOrEqual(4.5)
  })
  it('W5-38: a frame’s name sits above its selection box (the box is drawn 2 × the handle spacing out, 1 px wide)', () => {
    const fs = common.FRAME_STYLE as { nameOffsetY: number }
    const box = common.DEFAULT_TRANSFORM_HANDLE_SPACING * 2 + 1
    expect(fs.nameOffsetY).toBe(theme.FRAME_NAME_OFFSET)
    expect(fs.nameOffsetY).toBeGreaterThan(box)
  })
  it('frame outlines are >= 3:1 on the canvas in both modes, and the dark canvas is tldraw’s', () => {
    const fs = common.FRAME_STYLE as { strokeColor: string }
    expect(contrastRatio(fs.strokeColor, theme.CANVAS_LIGHT)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(dark(fs.strokeColor), theme.CANVAS_DARK)).toBeGreaterThanOrEqual(3)
    expect(dark(theme.CANVAS_LIGHT)).toBe(theme.CANVAS_DARK)
  })
})

describe('W5-15: dark mode keeps Lobby’s colours', () => {
  it('brand and palette colours get tldraw’s designed dark shades, not an inverted hue', () => {
    expect(dark('#f1ac4b')).toBe('#ffc034') // Ember / yellow (Excalidraw's filter: #874c00)
    expect(dark('#e03131')).toBe('#e03131') // Signal red (filter: #ff8383)
    expect(dark('#ae3ec9')).toBe('#ae3ec9') // violet (filter: #de7ef6)
    expect(dark('#4465e9')).toBe('#4f72fc')
    expect(dark('#F1AC4B')).toBe('#ffc034') // case does not matter
  })
  it('note fills get the palette’s designed dark fills, and every note reads (>= 4.5:1) with the dark ink', () => {
    for (const s of NOTE_PALETTE) {
      const fill = dark(s.light.fill)
      const ink = dark('#1e1e1e')
      expect(contrastRatio(fill, ink), `${s.label}: ${fill} with ${ink}`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(fill, dark(theme.INK)), s.label).toBeGreaterThanOrEqual(4.5)
      if (s.name !== 'white') expect(fill).toBe(s.dark.fill.toLowerCase())
    }
  })
  it('any other explicit colour is drawn as it is; greys and non-hex values follow Excalidraw’s filter', () => {
    expect(dark('#123abc')).toBe('#123abc')
    expect(dark('#7f3f9a80')).toBe('#7f3f9a80')
    expect(theme.lobbyDarkColor('#808080')).toBeNull()
    expect(theme.lobbyDarkColor('transparent')).toBeNull()
    expect(dark('transparent')).toBe(common.applyDarkModeFilter('transparent', true))
    // the engine's default ink becomes Lobby's dark ink
    expect(dark('#1e1e1e')).toBe(theme.CHALK)
  })
  it('light mode is untouched', () => {
    expect(common.applyDarkModeFilter('#f1ac4b', false)).toBe('#f1ac4b')
  })
})

describe('wave M (the foundation): noteInkFor, the frozen signature W2 reads', () => {
  it('answers today’s ink for every note colour: INK in light, CHALK in dark (what the label ink renders as)', () => {
    for (const s of NOTE_PALETTE) {
      expect(theme.noteInkFor(s.light.fill, 'light'), s.label).toBe(theme.INK)
      expect(theme.noteInkFor(s.light.fill, 'dark'), s.label).toBe(theme.CHALK)
      expect(theme.noteInkFor(s.light.fill, 'dark')).toBe(dark(theme.INK))
    }
  })
})

describe('wave M (M1-5): a note of an off-palette fill and its label are drawn in the ink that reads, in dark mode', async () => {
  const { elementWithCanvasCache } = await import('@excalidraw/element')
  // the engine's per-element canvas cache, as its renderer asks it: a note, then that note's label
  const cache = elementWithCanvasCache as unknown as WeakMap<object, object>
  const pastel = (id: string, fill = '#b2f2bb', ink = '#1e1e1e') => ({
    note: { id, type: 'stickynote', backgroundColor: fill, strokeColor: ink },
    label: { id: `${id}-t`, type: 'text', containerId: id, strokeColor: ink },
  })
  /** One drawing of `el` as the engine makes it: ask the cache, read the ink while drawing, store the drawing. */
  const draw = (el: { readonly strokeColor: string; readonly [k: string]: unknown }) => {
    const hit = cache.get(el)
    if (hit) return { hit, ink: null }
    const ink = dark(el.strokeColor)
    const drawing = { drawn: el }
    cache.set(el, drawing)
    return { hit: undefined, ink, drawing }
  }

  it('noteInkOverride: INK for the default inks of a pastel note and its label; nothing for swatches or picked inks', () => {
    const { note, label } = pastel('o1')
    expect(theme.noteInkOverride(note, null)).toBe(theme.INK)
    expect(theme.noteInkOverride(label, note)).toBe(theme.INK)
    // Lobby's INK and black are default inks too
    expect(theme.noteInkOverride({ ...label, strokeColor: theme.INK }, note)).toBe(theme.INK)
    expect(theme.noteInkOverride({ ...label, strokeColor: '#000000' }, note)).toBe(theme.INK)
    // a swatch note keeps CHALK (the table's answer: no override)
    const butter = pastel('o2', '#f8e48f')
    expect(theme.noteInkOverride(butter.label, butter.note)).toBeNull()
    // a picked ink is drawn as it is
    expect(theme.noteInkOverride({ ...label, strokeColor: '#e03131' }, note)).toBeNull()
    // a label whose note is not the one just drawn, a free text, a shape's label: untouched
    expect(theme.noteInkOverride(label, pastel('other').note)).toBeNull()
    expect(theme.noteInkOverride({ ...label, containerId: null }, note)).toBeNull()
    expect(theme.noteInkOverride(label, { ...note, type: 'rectangle' })).toBeNull()
  })

  it('drawn by the engine: the footer and the label get INK while drawn, every other ask gets CHALK', () => {
    const { note, label } = pastel('d1')
    expect(draw(note).ink).toBe(theme.INK) // the note's date footer
    expect(dark('#1e1e1e')).toBe(theme.CHALK) // after the drawing: the table again
    expect(draw(label).ink).toBe(theme.INK)
    expect(dark('#1e1e1e')).toBe(theme.CHALK)
    // drawn again: both cached drawings are kept
    expect(draw(note).hit).toBeDefined()
    expect(draw(label).hit).toBeDefined()
    // a free text drawn right after a pastel note's label is not touched
    draw(note)
    expect(draw({ id: 'free', type: 'text', containerId: null, strokeColor: '#1e1e1e' }).ink).toBe(
      theme.CHALK,
    )
  })

  it('a swatch note is drawn as before (CHALK), and its cached drawing is kept', () => {
    const { note, label } = pastel('s1', '#a6d8f3')
    expect(draw(note).ink).toBe(theme.CHALK)
    expect(draw(label).ink).toBe(theme.CHALK)
    expect(draw(note).hit).toBeDefined()
    expect(draw(label).hit).toBeDefined()
  })

  it('a note recoloured from a swatch to a pastel: its label (unchanged) is drawn again, in INK', () => {
    const { note, label } = pastel('r1', '#a6d8f3')
    draw(note)
    expect(draw(label).ink).toBe(theme.CHALK)
    // the note is a new element (a fill write); its label is the same object
    const recoloured = { ...note, backgroundColor: '#a5d8ff' }
    expect(draw(recoloured).ink).toBe(theme.INK)
    const again = draw(label)
    expect(again.hit).toBeUndefined()
    expect(again.ink).toBe(theme.INK)
    // and back to a swatch: drawn again in CHALK
    draw({ ...note })
    const back = draw(label)
    expect(back.hit).toBeUndefined()
    expect(back.ink).toBe(theme.CHALK)
  })

  it('other elements are the engine’s own cache: a hit is a hit, a miss a miss', () => {
    const rect = { id: 'rect', type: 'rectangle', strokeColor: '#1e1e1e', backgroundColor: '#b2f2bb' }
    expect(cache.get(rect)).toBeUndefined()
    const drawing = {}
    cache.set(rect, drawing)
    expect(cache.get(rect)).toBe(drawing)
    expect(dark('#1e1e1e')).toBe(theme.CHALK)
  })
})

describe('wave N.1: the text editor over a pastel note reads in dark mode (the render was fixed in M1-5, the editor was not)', () => {
  const PASTEL = '#b2f2bb'
  interface El {
    id: string
    type: string
    containerId?: string | null
    strokeColor: string
    backgroundColor?: string
  }
  interface Scene {
    editing: El | null
    elements: El[]
    theme?: 'light' | 'dark'
  }
  const label: El = { id: 'l1', type: 'text', containerId: 'n1', strokeColor: '#1e1e1e' }
  const noteOf = (fill: string): El => ({
    id: 'n1',
    type: 'stickynote',
    backgroundColor: fill,
    strokeColor: '#1e1e1e',
  })
  /** The engine slice the watch reads, over `scene` (read at each ask, so a test may change it). */
  const sourceOf = (scene: Scene) => {
    const listeners = new Set<() => void>()
    const src: EditorInkSource = {
      getAppState: () => ({ editingTextElement: scene.editing, theme: scene.theme ?? 'dark' }),
      getSceneElementsMapIncludingDeleted: () => new Map(scene.elements.map((e) => [e.id, e])),
      onChange: (cb) => {
        listeners.add(cb)
        return () => void listeners.delete(cb)
      },
    }
    const changed = () => {
      for (const l of listeners) l()
    }
    return { src, changed }
  }

  it('noteEditorInk: INK for the label of a pastel note being edited in dark mode; nothing else changes', () => {
    const on = (scene: Scene) => theme.noteEditorInk(sourceOf(scene).src)
    expect(on({ editing: label, elements: [noteOf(PASTEL), label] })).toBe(theme.INK)
    // the scene's copy of the label wins over the one the editor opened with (the ink may have changed since)
    const picked = { ...label, strokeColor: '#e03131' }
    expect(on({ editing: label, elements: [noteOf(PASTEL), picked] })).toBeNull()
    // a swatch note keeps CHALK (its designed dark fill), light mode and a free text keep the engine's colour
    expect(on({ editing: label, elements: [noteOf('#a6d8f3'), label] })).toBeNull()
    expect(on({ editing: label, elements: [noteOf(PASTEL), label], theme: 'light' })).toBeNull()
    const free = { ...label, containerId: null }
    expect(on({ editing: free, elements: [noteOf(PASTEL), free] })).toBeNull()
    expect(on({ editing: null, elements: [noteOf(PASTEL), label] })).toBeNull()
    // a label whose note is not in the scene (yet)
    expect(on({ editing: label, elements: [label] })).toBeNull()
  })

  describe('watchNoteEditorInk', () => {
    interface Area {
      style: { color: string }
      isConnected: boolean
    }
    class FakeObserver {
      static all: FakeObserver[] = []
      target: unknown = null
      readonly cb: () => void
      constructor(cb: () => void) {
        this.cb = cb
        FakeObserver.all.push(this)
      }
      observe(target: unknown) {
        this.target = target
      }
      disconnect() {
        FakeObserver.all = FakeObserver.all.filter((o) => o !== this)
      }
      takeRecords() {
        return []
      }
    }
    /** The browser tells the observers of `target` that it changed. */
    const fire = (target: unknown) => {
      for (const o of [...FakeObserver.all]) if (o.target === target) o.cb()
    }
    beforeEach(() => {
      FakeObserver.all = []
      vi.stubGlobal('MutationObserver', FakeObserver)
    })
    afterEach(() => vi.unstubAllGlobals())

    /** A board root whose textareas are `areas.list`. */
    const rootOf = (areas: { list: Area[] }) =>
      ({ querySelectorAll: () => areas.list }) as unknown as HTMLElement
    const chalkArea = (): Area => ({ style: { color: theme.CHALK }, isConnected: true })

    it('inks an editor the moment it appears, and again whenever the engine writes its own colour', () => {
      const area = chalkArea()
      const areas = { list: [] as Area[] }
      const root = rootOf(areas)
      const stop = theme.watchNoteEditorInk(
        root,
        sourceOf({ editing: label, elements: [noteOf(PASTEL), label] }).src,
      )
      // Excalidraw appends its textarea, already styled with the dark cache's answer
      areas.list = [area]
      fire(root)
      expect(area.style.color).toBe(theme.INK)
      // every layout (typing, zoom, a scene update) sets the colour again
      area.style.color = theme.CHALK
      fire(area)
      expect(area.style.color).toBe(theme.INK)
      stop()
      expect(FakeObserver.all).toEqual([])
    })

    it('the editing state landing after the textarea does: the next change applies the ink', () => {
      const area = chalkArea()
      const scene: Scene = { editing: null, elements: [noteOf(PASTEL), label] }
      const { src, changed } = sourceOf(scene)
      theme.watchNoteEditorInk(rootOf({ list: [area] }), src)
      expect(area.style.color).toBe(theme.CHALK)
      scene.editing = label
      changed()
      expect(area.style.color).toBe(theme.INK)
    })

    it('leaves a swatch note’s editor (CHALK on its designed dark fill) and light mode alone', () => {
      const scenes: Scene[] = [
        { editing: label, elements: [noteOf('#a6d8f3'), label] },
        { editing: label, elements: [noteOf(PASTEL), label], theme: 'light' },
      ]
      for (const scene of scenes) {
        const area = chalkArea()
        theme.watchNoteEditorInk(rootOf({ list: [area] }), sourceOf(scene).src)
        fire(area)
        expect(area.style.color).toBe(theme.CHALK)
      }
    })

    it('forgets an editor that left the page', () => {
      const area = chalkArea()
      const areas = { list: [area] }
      const root = rootOf(areas)
      theme.watchNoteEditorInk(root, sourceOf({ editing: label, elements: [noteOf(PASTEL), label] }).src)
      expect(FakeObserver.all).toHaveLength(2) // the root's and the editor's
      area.isConnected = false
      areas.list = []
      fire(root)
      expect(FakeObserver.all).toHaveLength(1)
    })
  })
})
