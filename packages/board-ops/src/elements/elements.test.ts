// board-ops on the new canvas (@draftroom/board-ops/elements): readers (text, search, CSV, frames) and
// writers (remap, archive v2, pasted notes) over Excalidraw elements as Lobby stores them.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { describe, expect, it } from 'vitest'
import { PALETTE as CONVERTER_PALETTE, TL_COLOR_NAMES } from '../../../tldraw-import/src/palette.ts'
import { parseBulkText } from '../bulk-parse.ts'
import {
  colorCellOf,
  elementBounds,
  elementFileRefs,
  elementsToCsv,
  elementText,
  frameOutlineOf,
  kindOf,
  LOBBY_COLOR_NAMES,
  LOBBY_PALETTE,
  lookupOf,
  newElementId,
  noteColorName,
  noteElementsFromText,
  presentationOrderOf,
  randomInt31,
  remapElements,
  searchElements,
  strokeColorName,
} from './index.ts'
import { sampleBoard, seqIds } from './test-kit.ts'

type Any = Record<string, unknown>
const board = sampleBoard()
const get = lookupOf(board)
const el = (id: string) => board.find((e) => e.id === id) as WireElement

describe('the board sample is what the server accepts', () => {
  it('passes the element check and the invariants', () => {
    for (const e of board) expect(checkElement(e), e.id).toMatchObject({ ok: true })
    expect(checkInvariants(board)).toEqual([])
  })
})

describe('palette', () => {
  it("equals the converter's palette, so new and converted boards look the same", () => {
    expect([...LOBBY_COLOR_NAMES]).toEqual([...TL_COLOR_NAMES])
    for (const name of LOBBY_COLOR_NAMES) {
      const c = CONVERTER_PALETTE[name]
      expect(LOBBY_PALETTE[name]).toEqual({
        solid: c.solid,
        fill: c.fill,
        semi: c.semi,
        noteFill: c.noteFill,
        noteText: c.noteText,
      })
    }
  })

  it('names note fills and strokes back (the CSV colour column)', () => {
    for (const name of LOBBY_COLOR_NAMES) {
      expect(noteColorName(LOBBY_PALETTE[name].noteFill)).toBe(name)
      expect(noteColorName(LOBBY_PALETTE[name].noteFill.toUpperCase())).toBe(name)
    }
    const strokes = LOBBY_COLOR_NAMES.map((n) => LOBBY_PALETTE[n].solid)
    expect(new Set(strokes).size).toBe(strokes.length)
    for (const name of LOBBY_COLOR_NAMES) expect(strokeColorName(LOBBY_PALETTE[name].solid)).toBe(name)
    expect(noteColorName('#123456')).toBeNull()
    expect(strokeColorName(undefined)).toBeNull()
  })
})

describe('ids', () => {
  it('makes 21-character nanoid-style ids and 31-bit seeds', () => {
    const ids = Array.from({ length: 2000 }, newElementId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/)
    for (let i = 0; i < 200; i++) {
      const n = randomInt31()
      expect(Number.isInteger(n) && n > 0 && n < 2 ** 31).toBe(true)
    }
  })
})

describe('readers', () => {
  it('names elements the way Lobby does', () => {
    expect(['F', 'N', 'N-label', 'R', 'E', 'A', 'T', 'I', 'D'].map((id) => kindOf(el(id)))).toEqual([
      'frame',
      'note',
      'label',
      'rectangle',
      'ellipse',
      'arrow',
      'text',
      'image',
      'draw',
    ])
    expect(kindOf({ id: 'h', type: 'freedraw', customData: { lobby: { kind: 'highlight' } } })).toBe(
      'highlight',
    )
    const card = { id: 'c', type: 'image', customData: { lobby: { file: { kind: 'pdf' } } } }
    expect(kindOf(card)).toBe('file-card')
    expect(kindOf({ ...card, customData: { lobby: { file: { kind: 'image' }, pdfPage: 2 } } })).toBe(
      'file-card',
    )
  })

  it("reads a container's words from its label, a frame's name, an image's alt and file name", () => {
    expect(elementText(el('N'), get)).toBe('Café idea\nsecond line')
    expect(elementText(el('R'), get)).toBe('=Launch plan')
    expect(elementText(el('N-label'), get)).toBe('')
    expect(elementText(el('F'), get)).toBe('Ideas')
    expect(elementText(el('T'), get)).toBe('Free text in the frame')
    expect(elementText(el('I'), get)).toBe('Hero shot · hero.png')
    expect(elementText(el('E'), get)).toBe('')
    expect(elementText(el('D'), get)).toBe('')
    // a label that does not name its container back is not its text
    const liar = { id: 'L', type: 'text', originalText: 'nope', containerId: 'other' }
    const withLiar = lookupOf([...board, liar])
    expect(elementText({ ...el('E'), boundElements: [{ id: 'L', type: 'text' }] }, withLiar)).toBe('')
  })

  it('never throws on malformed elements', () => {
    const junk = [
      null,
      1,
      'x',
      {},
      { id: 1 },
      { id: 'a', type: 'text', originalText: 5 },
      { id: 'b', type: 'frame', name: {} },
    ]
    expect(() => searchElements(junk, 'a')).not.toThrow()
    expect(() => elementsToCsv(junk)).not.toThrow()
    expect(() => frameOutlineOf(junk)).not.toThrow()
  })

  it('bounds a rotated element by its rotated box', () => {
    const b = elementBounds({
      id: 'r',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      angle: Math.PI / 2,
    })
    expect(b.x).toBeCloseTo(25)
    expect(b.y).toBeCloseTo(-25)
    expect(b.w).toBeCloseTo(50)
    expect(b.h).toBeCloseTo(100)
  })
})

describe('search', () => {
  it('finds a note by its label words (the note, not the label), diacritic- and case-insensitive', () => {
    const hits = searchElements(board, 'cafe')
    expect(hits.map((h) => [h.id, h.kind])).toEqual([['N', 'note']])
    expect(hits[0]?.snippet).toBe('Café idea second line')
  })

  it('finds frames by name and images by alt text or file name; never deleted elements', () => {
    expect(searchElements(board, 'ideas').map((h) => h.id)).toEqual(['F'])
    expect(searchElements(board, 'hero.png').map((h) => h.id)).toEqual(['I'])
    expect(
      searchElements([...board, { ...el('T'), id: 'T2', isDeleted: true }], 'free text').map((h) => h.id),
    ).toEqual(['T'])
  })

  it('ranks exact text first, then shorter texts, then paint order; honours the limit', () => {
    const els = [
      { id: 'a', type: 'text', index: 'a2', originalText: 'plan the launch' },
      { id: 'b', type: 'text', index: 'a1', originalText: 'launch' },
      { id: 'c', type: 'text', index: 'a0', originalText: 'launch plan now' },
      { id: 'd', type: 'text', index: 'a3', originalText: 'plan the launch' },
    ]
    // 'b' is exact; the rest are the same length, so paint order (index) decides
    expect(searchElements(els, 'launch').map((h) => h.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(searchElements(els, 'launch', { limit: 2 }).map((h) => h.id)).toEqual(['b', 'c'])
    expect(searchElements(els, 'launch', { limit: 0 })).toEqual([])
    expect(searchElements(els, '   ')).toEqual([])
  })
})

describe('CSV', () => {
  const lines = elementsToCsv(board).split('\r\n')

  it('writes the header and one row per item in reading order (labels, ink and deleted elements left out)', () => {
    expect(lines[0]).toBe('id,type,text,frame,color,x,y')
    expect(lines.at(-1)).toBe('')
    expect(lines.slice(1, -1).map((l) => l.split(',')[0])).toEqual(['F', 'I', 'N', 'R', 'E', 'A', 'T', 'F2'])
  })

  it('names the colour, the frame and neutralizes formulas', () => {
    const row = (id: string) => lines.find((l) => l.startsWith(`${id},`))
    expect(row('N')).toBe('N,note,"Café idea\nsecond line",Ideas,yellow,40,100')
    expect(row('R')).toBe("R,rectangle,'=Launch plan,Ideas,orange,300,100")
    expect(row('I')).toBe('I,image,Hero shot · hero.png,,,1200,0')
    expect(row('F')).toBe('F,frame,Ideas,,,0,0')
    expect(colorCellOf({ id: 'z', type: 'rectangle', strokeColor: '#123456' })).toBe('#123456')
  })
})

describe('frames', () => {
  it('outlines frames in reading order, and presents indexed frames first, with their skip flag', () => {
    const extra = { ...el('F2'), id: 'F3', y: 800, x: 600, name: 'Third', customData: undefined }
    expect(frameOutlineOf([...board, extra]).map((f) => f.name)).toEqual(['Ideas', 'Parking lot', 'Third'])
    const order = presentationOrderOf([...board, extra])
    expect(order.map((f) => [f.name, f.presentIndex, f.skip])).toEqual([
      ['Ideas', 2, false],
      ['Parking lot', null, true],
      ['Third', null, false],
    ])
    expect(order[0]?.bounds).toEqual({ x: 0, y: 0, w: 1000, h: 600 })
  })
})

describe('remap', () => {
  const { elements, idMap, groupMap, cut } = remapElements(board, {
    newId: seqIds(),
    now: 9,
    offset: { x: 10, y: -5 },
  })
  const out = new Map(elements.map((e) => [e.id as string, e]))
  const copy = (oldId: string) => out.get(idMap.get(oldId) as string) as Any

  it('copies every live element with a fresh id, consistent references and a fresh group id', () => {
    expect(elements).toHaveLength(board.length - 1) // the deleted one is left out
    expect(idMap.has('X')).toBe(false)
    expect(copy('N-label').containerId).toBe(idMap.get('N'))
    expect(copy('N').boundElements).toEqual([{ id: idMap.get('N-label'), type: 'text' }])
    expect((copy('A').startBinding as Any).elementId).toBe(idMap.get('R'))
    expect((copy('A').endBinding as Any).elementId).toBe(idMap.get('E'))
    expect(copy('R').frameId).toBe(idMap.get('F'))
    expect(copy('I').groupIds).toEqual([groupMap.get('G1')])
    expect(copy('D').groupIds).toEqual(copy('I').groupIds)
    expect(cut).toEqual({ labels: 0, bindings: 0, frames: 0, bound: 0, customData: 2 })
    for (const e of elements) expect(checkElement(e), String(e.id)).toMatchObject({ ok: true })
    expect(checkInvariants(elements as unknown as WireElement[])).toEqual([])
  })

  it('moves, restarts server-owned fields, and orders each label right after its container', () => {
    expect([copy('N').x, copy('N').y]).toEqual([50, 95])
    for (const e of elements) {
      expect([e.version, e.created, e.updated, e.isDeleted]).toEqual([1, null, 9, false])
      expect(e.status).toBeUndefined()
      expect((e.customData as Any | undefined)?.lobbyServer).toBeUndefined()
    }
    const order = elements.map((e) => e.id)
    expect(order.indexOf(idMap.get('N-label') as string)).toBe(order.indexOf(idMap.get('N') as string) + 1)
    const keys = elements.map((e) => e.index as string)
    expect([...keys].sort()).toEqual(keys)
  })

  it("follows the registry's duplicate rules for customData", () => {
    expect((copy('N').customData as Any).lobby).toEqual({
      'tag:research': { name: 'research', color: 'blue' },
      mindmap: { rootId: idMap.get('N'), parentId: null, side: 'right', collapsed: false },
    })
    expect((copy('R').customData as Any).lobby).toEqual({ kind: 'card' }) // `ai` (identity-stamped) stripped
    expect((copy('A').customData as Any).lobby).toEqual({
      mindmapEdge: { rootId: idMap.get('N'), parentId: idMap.get('N'), childId: idMap.get('E') },
    })
    expect(copy('F').customData).toBeUndefined() // present.index dropped on a duplicate
    const kept = remapElements(board, { keepPresentIndex: true })
    const f = kept.elements.find((e) => e.id === kept.idMap.get('F'))
    expect((f?.customData as { lobby?: unknown } | undefined)?.lobby).toEqual({ present: { index: 2 } })
  })

  it('cuts references that leave the set: labels become free text, bindings unbind, frames clear', () => {
    const part = board.filter((e) => ['N-label', 'A', 'R', 'R-label', 'T'].includes(e.id))
    const r = remapElements(part, { newId: seqIds('p') })
    const byOld = (id: string) => r.elements.find((e) => e.id === r.idMap.get(id)) as Any
    expect(byOld('N-label').containerId).toBeNull()
    expect((byOld('A').startBinding as Any).elementId).toBe(r.idMap.get('R'))
    expect(byOld('A').endBinding).toBeNull()
    expect(byOld('T').frameId).toBeNull()
    expect(byOld('R').boundElements).toEqual([
      { id: r.idMap.get('R-label'), type: 'text' },
      { id: r.idMap.get('A'), type: 'arrow' },
    ])
    expect((byOld('A').customData as Any | undefined)?.lobby).toBeUndefined() // mindmapEdge refs left
    expect(checkInvariants(r.elements as unknown as WireElement[])).toEqual([])
  })

  it('wave T relink-keep: a copied panel points at a copied head, else keeps its storyboard; card keys stay', () => {
    const head = { ...el('T'), id: 'H', customData: { lobby: { 'sb:head': { aspect: '16:9', audio: 'X' } } } }
    const panel = {
      ...el('F'),
      id: 'P',
      customData: { lobby: { 'sb:of': 'H', 'sb:pos': 'a0', 'sb:dur': 2000 } },
    }
    const card = {
      ...el('R'),
      id: 'C',
      boundElements: null,
      customData: { lobby: { 'card:status': 'doing', 'card:due': '2026-10-20' } },
    }
    const both = remapElements([head, panel, card] as never, { newId: seqIds('w') })
    const lobbyOf = (r: typeof both, id: string) =>
      (r.elements.find((e) => e.id === r.idMap.get(id))?.customData as Any | undefined)?.lobby
    expect(lobbyOf(both, 'P')).toEqual({ 'sb:of': both.idMap.get('H'), 'sb:pos': 'a0', 'sb:dur': 2000 })
    // the audio card was not copied: the head keeps it
    expect(lobbyOf(both, 'H')).toEqual({ 'sb:head': { aspect: '16:9', audio: 'X' } })
    expect(lobbyOf(both, 'C')).toEqual({ 'card:status': 'doing', 'card:due': '2026-10-20' })
    const alone = remapElements([panel] as never, { newId: seqIds('v') })
    expect(lobbyOf(alone, 'P')).toEqual({ 'sb:of': 'H', 'sb:pos': 'a0', 'sb:dur': 2000 })
  })

  it('places the copies above indexAbove and refuses a bad key', () => {
    const r = remapElements(board, { indexAbove: 'a5' })
    for (const e of r.elements) expect((e.index as string) > 'a5').toBe(true)
    expect(() => remapElements(board, { indexAbove: 'zzz' })).toThrow(TypeError)
  })
})

describe('pasted notes', () => {
  it('lays out the same grid as the tldraw paste, each a stickynote with its label, valid for the server', () => {
    const text = 'a\tb\n\tc\n'
    const { elements, noteIds, truncated } = noteElementsFromText(text, {
      origin: { x: 100, y: 200 },
      color: 'light-blue',
      frameId: 'F',
      indexAbove: 'a5',
      newId: seqIds('q'),
    })
    expect(truncated).toBe(false)
    expect(parseBulkText(text)).toEqual([['a', 'b'], ['c']])
    const notes = elements.filter((e) => e.type === 'stickynote')
    expect(notes.map((n) => n.id)).toEqual(noteIds)
    expect(notes.map((n) => [n.x, n.y])).toEqual([
      [100, 200],
      [320, 200],
      [320, 420],
    ])
    for (const n of notes) {
      expect([n.width, n.height, n.frameId, n.created]).toEqual([200, 200, 'F', null])
      expect(n.backgroundColor).toBe(LOBBY_PALETTE['light-blue'].noteFill)
      const label = elements.find((e) => e.type === 'text' && e.containerId === n.id)
      expect(label?.type === 'text' && [label.originalText.length > 0, label.fontFamily]).toEqual([true, 5])
    }
    for (const e of elements) expect(checkElement(e), e.id).toMatchObject({ ok: true })
    expect(JSON.parse(JSON.stringify(elements))).toStrictEqual(elements)
    const withFrame = [el('F'), ...elements]
    expect(checkInvariants(withFrame)).toEqual([])
    for (const e of elements) expect((e.index as string) > 'a5').toBe(true)
  })

  it('reports truncation and refuses bad options', () => {
    expect(noteElementsFromText('a\nb\nc', { origin: { x: 0, y: 0 }, maxNotes: 2 }).truncated).toBe(true)
    expect(
      noteElementsFromText('x', { origin: { x: 0, y: 0 }, color: 'nope' }).elements[0]?.backgroundColor,
    ).toBe(LOBBY_PALETTE.black.noteFill)
    expect(() => noteElementsFromText('x', { origin: { x: Number.NaN, y: 0 } })).toThrow(TypeError)
    expect(() => noteElementsFromText('x', { origin: { x: 0, y: 0 }, indexAbove: '!' })).toThrow(TypeError)
  })
})

describe('entry points', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const graph = (entry: string) => {
    const files = new Set<string>()
    const bare = new Set<string>()
    const visit = (file: string) => {
      if (files.has(file)) return
      files.add(file)
      for (const m of readFileSync(file, 'utf8').matchAll(
        /^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm,
      )) {
        const spec = m[1] as string
        if (spec.startsWith('.')) visit(resolve(dirname(file), spec))
        else bare.add(spec)
      }
    }
    visit(resolve(SRC, entry))
    return {
      files: [...files].map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/')),
      bare: [...bare].sort(),
    }
  }

  it('@draftroom/board-ops/elements loads no tldraw (only canvas-schema subpaths)', () => {
    const { files, bare } = graph('elements/index.ts')
    expect(bare.every((b) => b.startsWith('@draftroom/canvas-schema/'))).toBe(true)
    for (const tl of [
      'archive.ts',
      'search.ts',
      'csv.ts',
      'frames.ts',
      'board-index.ts',
      'rich-text.ts',
      'remap.ts',
    ])
      expect(files).not.toContain(tl)
  })

  it('the v1 reader (it carries the tldraw schema) is packages/tldraw-import’s, not an entry point here', () => {
    expect(existsSync(resolve(SRC, 'elements/archive-v1.ts'))).toBe(false)
    const { bare } = graph('elements/index.ts')
    expect(bare.some((b) => b.startsWith('@draftroom/tldraw-import') || b.startsWith('@tldraw/'))).toBe(false)
  })
})

describe('referenced files', () => {
  it('lists each file version once: images by fileId (PDF pages to their version), cards by customData.lobby.file', () => {
    const els = [
      ...board,
      { id: 'p3', type: 'image', fileId: 'ver_0123456789abcdef.p3' },
      {
        id: 'c1',
        type: 'image',
        fileId: 'ver_ffffffffff',
        customData: { lobby: { file: { assetId: 'ast_aaaaaaaaaa', versionId: 'ver_ffffffffff' } } },
      },
      { id: 'gone', type: 'image', fileId: 'ver_9999999999', isDeleted: true },
      { id: 'bad', type: 'image', fileId: 'https://example.com/x.png' },
    ]
    expect(elementFileRefs(els)).toEqual([
      { versionId: 'ver_0123456789abcdef', assetId: 'ast_0123456789abcdef' },
      { versionId: 'ver_ffffffffff', assetId: 'ast_aaaaaaaaaa' },
    ])
  })
})
