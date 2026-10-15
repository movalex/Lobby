// WS4 (wave Q): the `.excalidrawlib` normaliser, over library files written the way community libraries are (v1 and
// v2; ./fixtures). The engine's own parser is browser-only (it needs a DOM to load), so these tests stand in a small
// reader with the same contract for `loadLibraryFromBlob` (type `excalidrawlib`, version 1 or 2, v1 items are arrays)
// and run everything after it for real: the per-item cleaning, canvas-schema's checks, board-ops serializeLibraryItem,
// the contracts' ImportLibraryInput. The real engine reads the same fixture files in a browser in
// e2e/excalidraw/q4-import.spec.ts.
import { readFileSync } from 'node:fs'
import { serializeLibraryItem } from '@draftroom/board-ops/elements'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { ImportLibraryInput, LIBRARY_DEFAULT_LICENCE, LIBRARY_LIMITS } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import { type LibraryEngine, normaliseExcalidrawLib } from './excalidrawlib.ts'
import { cleanLibraryElements, FONT_MAP, IMPORT_ITEM_LIMITS, normaliseLibraryItem } from './normalise.ts'

installServerTextMetrics()

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const fileOf = (text: string, name = 'library.excalidrawlib', type = 'application/json') =>
  Object.assign(new Blob([text], { type }), { name })

/** The engine's reader for a library, as far as the import depends on it (loadLibraryFromBlob). */
function engineDouble(): LibraryEngine & { calls: { load: number; restore: number } } {
  const calls = { load: 0, restore: 0 }
  return {
    calls,
    async loadLibraryFromBlob(blob) {
      calls.load++
      const data = JSON.parse(await blob.text()) as Record<string, unknown>
      if (data?.type !== 'excalidrawlib' || (data.version !== 1 && data.version !== 2))
        throw new Error('Invalid library')
      const list = (data.libraryItems ?? data.library ?? []) as unknown[]
      return list.map((i) =>
        Array.isArray(i) ? { elements: i } : (i as { name?: unknown; elements: unknown[] }),
      )
    },
    restoreElements(elements) {
      calls.restore++
      return elements
    },
  }
}

type Options = Parameters<typeof normaliseExcalidrawLib>[1]
const run = (text: string, extra: Partial<Options> = {}) =>
  normaliseExcalidrawLib(fileOf(text), {
    scope: 'personal',
    engine: engineDouble(),
    now: 1_790_000_000_000,
    ...extra,
  })

const rect = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  ...over,
})
interface Text {
  type: string
  fontFamily?: number
}
interface Labelled {
  id: string
  type: string
  containerId?: string
  boundElements: { id: string }[] | null
}
const libOf = (items: unknown[]) => JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: items })

describe('a v2 library in the current element shape', () => {
  it('becomes an import body the api accepts, one item per library item', async () => {
    const r = await run(fixture('flowchart-bits.excalidrawlib'), { folderId: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // the contracts' own schema accepts it as it is
    expect(ImportLibraryInput.safeParse(r.input).success).toBe(true)
    expect(r.input.scope).toBe('personal')
    expect(r.input.fileName).toBe('library.excalidrawlib')
    expect(r.input.licence).toBe(LIBRARY_DEFAULT_LICENCE)
    expect(r.input.author).toBeNull()
    expect(r.input.folderId).toBeNull()
    expect(r.input.items.map((i) => i.name)).toEqual([
      'Process step',
      'Decision',
      'Two steps and an arrow',
      // no name in the file: the first words of the item
      'Note to self',
    ])
    expect(r.report).toMatchObject({ itemsInFile: 4, itemsImported: 4, itemsSkipped: 0, itemsWithImages: 0 })
    expect(r.warnings.join(' ')).not.toMatch(/left out/)
  })

  it('holds every element to canvas-schema, per element and across the item, at the origin', async () => {
    const r = await run(fixture('flowchart-bits.excalidrawlib'))
    if (!r.ok) throw new Error(r.code)
    for (const item of r.input.items) {
      const els = item.elements as never[]
      for (const e of els) expect(checkElement(e).ok, item.name).toBe(true)
      expect(checkInvariants(els), item.name).toEqual([])
      const xs = (els as { x: number }[]).map((e) => e.x)
      const ys = (els as { y: number }[]).map((e) => e.y)
      expect(Math.min(...xs), item.name).toBeGreaterThanOrEqual(0)
      expect(Math.min(...ys), item.name).toBeGreaterThanOrEqual(0)
      // the same rules as a saved selection: running the serializer again changes nothing it would refuse
      const again = serializeLibraryItem(els, { limits: IMPORT_ITEM_LIMITS })
      expect(again.ok, item.name).toBe(true)
    }
  })

  it('maps the old fonts to the ones Lobby serves and lays the labels out again', async () => {
    const r = await run(fixture('flowchart-bits.excalidrawlib'))
    if (!r.ok) throw new Error(r.code)
    const families = r.input.items.flatMap((i) =>
      (i.elements as unknown as Text[]).filter((e) => e.type === 'text').map((e) => e.fontFamily),
    )
    // Virgil -> Excalifont, Helvetica -> Nunito, Cascadia -> Comic Shanns
    expect(families.sort()).toEqual([FONT_MAP[1], FONT_MAP[2], FONT_MAP[3]].sort())
    for (const f of families) expect([5, 6, 7, 8]).toContain(f)
    expect(r.report.cuts.fonts).toBe(3)
    expect(r.report.cuts.relaid).toBe(3)
    // a label stays bound to its container, and sits inside it
    const step = r.input.items[0]?.elements as unknown as Labelled[]
    const [box, label] = [step.find((e) => e.type === 'rectangle'), step.find((e) => e.type === 'text')]
    expect(label?.containerId).toBe(box?.id)
    expect(box?.boundElements?.map((b) => b.id)).toEqual([label?.id])
  })

  it('keeps a bound arrow and a group inside an item, with ids of the item’s own', async () => {
    const r = await run(fixture('flowchart-bits.excalidrawlib'))
    if (!r.ok) throw new Error(r.code)
    const flow = r.input.items[2]?.elements as {
      id: string
      type: string
      groupIds: string[]
      startBinding?: { elementId: string }
      endBinding?: { elementId: string }
    }[]
    const [a, b] = flow.filter((e) => e.type === 'rectangle')
    const arrow = flow.find((e) => e.type === 'arrow')
    expect(arrow?.startBinding?.elementId).toBe(a?.id)
    expect(arrow?.endBinding?.elementId).toBe(b?.id)
    expect(new Set(flow.map((e) => e.groupIds[0])).size).toBe(1)
    // none of the file's own ids survives
    for (const e of flow) expect(['f1', 'f2', 'fa', 'g1']).not.toContain(e.id)
    expect(flow[0]?.groupIds[0]).not.toBe('g1')
  })
})

describe('what an outside library must not bring in', () => {
  it('leaves out pictures, embeds and iframes, and counts them', async () => {
    const r = await run(fixture('unsafe.excalidrawlib'))
    if (!r.ok) throw new Error(r.code)
    const types = r.input.items.flatMap((i) => (i.elements as { type: string }[]).map((e) => e.type))
    for (const bad of ['image', 'embeddable', 'iframe', 'magicframe']) expect(types).not.toContain(bad)
    // the two items that held a picture keep their other elements; the item that was only a picture is skipped
    expect(r.report.cuts.images).toBe(2)
    expect(r.report.itemsWithImages).toBe(2)
    expect(r.report.cuts.embeds).toBe(2)
    expect(r.report.skipped).toEqual([{ index: 2, problem: 'no-elements' }])
    expect(r.input.items.map((i) => i.name)).toEqual([
      'Links and extra data',
      'A picture and a box',
      'Embeds',
      'An unknown font',
    ])
    expect(r.warnings.join(' ')).toMatch(/2 pictures were left out/)
    expect(r.warnings.join(' ')).toMatch(/2 embeds were left out/)
  })

  it('strips data: and javascript: links and foreign customData, and keeps a web link', async () => {
    const r = await run(fixture('unsafe.excalidrawlib'))
    if (!r.ok) throw new Error(r.code)
    const json = JSON.stringify(r.input)
    expect(json).not.toMatch(/data:|blob:|javascript:/i)
    expect(json).not.toMatch(/lobbyServer|board-card|someone/)
    const links = ((r.input.items[0]?.elements ?? []) as { link: string | null }[]).map((e) => e.link)
    expect(links.filter((l) => l !== null)).toEqual(['https://example.com/page'])
    expect(links.filter((l) => l === null)).toHaveLength(2)
    expect(r.report.cuts.links).toBe(2)
    expect(r.report.cuts.customData).toBe(1)
    for (const item of r.input.items)
      for (const e of item.elements as { customData?: unknown }[]) expect(e.customData).toBeUndefined()
  })

  it('reads an unknown font as Nunito', async () => {
    const r = await run(fixture('unsafe.excalidrawlib'))
    if (!r.ok) throw new Error(r.code)
    const text = ((r.input.items[3]?.elements ?? []) as unknown as Text[]).find((e) => e.type === 'text')
    expect(text?.fontFamily).toBe(6)
  })

  it('drops one element the room would refuse and keeps the rest of its item', () => {
    const bad = rect('bad', { x: 5_000_000 })
    const out = normaliseLibraryItem({ name: 'Mixed', elements: [rect('ok'), bad] }, 0)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.elements).toHaveLength(1)
    expect(out.cuts.invalid).toBe(1)
  })

  it('cuts the references to what it left out (a label whose container was an embed)', () => {
    const { elements, cuts } = cleanLibraryElements([
      { ...rect('e'), type: 'embeddable' },
      rect('r', { frameId: 'gone' }),
    ])
    expect(cuts.embeds).toBe(1)
    expect(elements).toHaveLength(1)
    const out = normaliseLibraryItem({ elements: [rect('r', { frameId: 'gone' })] }, 0)
    expect(out.ok).toBe(true)
    if (out.ok) expect((out.elements[0] as { frameId: string | null }).frameId).toBeNull()
  })

  it('gives a legacy arrow the elbowed flag the room wants', () => {
    const arrow = {
      ...rect('ar'),
      type: 'arrow',
      points: [
        [0, 0],
        [50, 20],
      ],
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: 'arrow',
    }
    const out = normaliseLibraryItem({ elements: [arrow] }, 0)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.elements[0]).toMatchObject({ type: 'arrow', elbowed: false })
  })

  it('unlocks what was locked and sets the fields the room expects', () => {
    const odd = { ...rect('a'), locked: true, created: 5, updated: undefined }
    const { elements } = cleanLibraryElements([odd], 77)
    expect(elements[0]).toMatchObject({ locked: false, created: null, updated: 77, link: null })
  })

  it('never fetches anything', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network')))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await run(fixture('flowchart-bits.excalidrawlib'))
      await run(fixture('unsafe.excalidrawlib'))
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('a file that is not a library, or is too big', () => {
  it('refuses what the engine’s reader refuses', async () => {
    const refusals: [string, string][] = [
      ['not JSON', 'this is not json'],
      ['a scene', JSON.stringify({ type: 'excalidraw', version: 2, elements: [] })],
      ['a future version', JSON.stringify({ type: 'excalidrawlib', version: 3, libraryItems: [] })],
      ['an array', '[]'],
      ['null', 'null'],
    ]
    for (const [what, text] of refusals) {
      const r = await run(text)
      expect(r, what).toEqual({ ok: false, code: 'not-a-library' })
    }
  })

  it('refuses an image (the engine would read a scene out of a PNG)', async () => {
    const png = fileOf(fixture('flowchart-bits.excalidrawlib'), 'a.png', 'image/png')
    const r = await normaliseExcalidrawLib(png, { scope: 'personal', engine: engineDouble() })
    expect(r).toEqual({ ok: false, code: 'not-a-library' })
  })

  it('refuses a file over the import’s 5 MB before it reads it', async () => {
    const bytes = new Uint8Array(LIBRARY_LIMITS.importBytes + 1)
    const big = Object.assign(new Blob([bytes]), { name: 'big.excalidrawlib' })
    const engine = engineDouble()
    const r = await normaliseExcalidrawLib(big, { scope: 'workspace', engine })
    expect(r).toEqual({ ok: false, code: 'too-large' })
    expect(engine.calls.load).toBe(0)
  })

  it('says so when a library has no items, or nothing in it can be used', async () => {
    expect(await run(libOf([]))).toEqual({ ok: false, code: 'empty' })
    const onlyEmbeds = libOf([
      { id: 'x', status: 'published', created: 1, name: 'E', elements: [rect('e', { type: 'embeddable' })] },
    ])
    expect(await run(onlyEmbeds)).toEqual({ ok: false, code: 'nothing-usable' })
  })
})

describe('the limits', () => {
  const item = (n: number) => ({
    id: `i${n}`,
    status: 'published',
    created: 1,
    name: `Item ${n}`,
    elements: [rect(`r${n}`)],
  })

  it('takes at most 500 items and says how many it left', async () => {
    const r = await run(libOf(Array.from({ length: LIBRARY_LIMITS.importItems + 3 }, (_, i) => item(i))))
    if (!r.ok) throw new Error(r.code)
    expect(r.input.items).toHaveLength(LIBRARY_LIMITS.importItems)
    expect(r.report.itemsSkipped).toBe(3)
    expect(r.report.skipped.every((s) => s.problem === 'over-item-limit')).toBe(true)
    expect(r.warnings[0]).toMatch(/^3 items were left out/)
  })

  it('skips an item over 500 elements or 256 KiB and imports the others', async () => {
    const many = {
      id: 'many',
      status: 'published',
      created: 1,
      name: 'Too many',
      elements: Array.from({ length: LIBRARY_LIMITS.itemElements + 1 }, (_, i) => rect(`m${i}`)),
    }
    const words = 'x'.repeat(9_000)
    const heavy = {
      id: 'heavy',
      status: 'published',
      created: 1,
      name: 'Too heavy',
      elements: Array.from({ length: 16 }, (_, i) => rect(`h${i}`)).map((e, i) => ({
        ...e,
        type: 'text',
        text: words,
        originalText: words,
        fontSize: 20,
        fontFamily: 6,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        baseFontSize: null,
        autoResize: true,
        lineHeight: 1.25,
        id: `t${i}`,
      })),
    }
    const r = await run(libOf([item(1), many, heavy, item(2)]))
    if (!r.ok) throw new Error(r.code)
    expect(r.input.items.map((i) => i.name)).toEqual(['Item 1', 'Item 2'])
    expect(r.report.skipped).toEqual([
      { index: 1, problem: 'too-many-elements' },
      { index: 2, problem: 'too-large' },
    ])
  })

  it('leaves the last items out when the body would pass its byte cap', async () => {
    const items = Array.from({ length: 20 }, (_, i) => item(i))
    const whole = await run(libOf(items))
    if (!whole.ok) throw new Error(whole.code)
    const bytes = new TextEncoder().encode(JSON.stringify(whole.input.items)).length
    const r = await run(libOf(items), { maxBodyBytes: 4096 + Math.floor(bytes / 2) })
    if (!r.ok) throw new Error(r.code)
    expect(r.input.items.length).toBeGreaterThan(5)
    expect(r.input.items.length).toBeLessThan(20)
    expect(r.report.skipped.every((s) => s.problem === 'over-body-limit')).toBe(true)
    expect(r.report.itemsImported + r.report.itemsSkipped).toBe(20)
  })

  it('names are at most 80 characters, and an item without one gets a name', async () => {
    const long = { ...item(1), name: 'N'.repeat(200) }
    const unnamed = { id: 'u', status: 'published', created: 1, elements: [rect('u1')] }
    const r = await run(libOf([long, unnamed]))
    if (!r.ok) throw new Error(r.code)
    expect([...(r.input.items[0]?.name ?? '')]).toHaveLength(LIBRARY_LIMITS.nameChars)
    expect(r.input.items[1]?.name).toBe('Imported item 2')
  })
})

describe('the file’s own claims', () => {
  it('stores the licence and author the file states, and lets the caller override them', async () => {
    const text = JSON.stringify({
      type: 'excalidrawlib',
      version: 2,
      license: 'MIT',
      authors: [{ name: 'Someone' }],
      libraryItems: [{ id: 'a', status: 'published', created: 1, name: 'A', elements: [rect('a1')] }],
    })
    const r = await run(text)
    if (!r.ok) throw new Error(r.code)
    expect(r.input.licence).toBe('MIT')
    expect(r.input.author).toBe('Someone')
    const mine = {
      licence: 'CC-BY 4.0',
      author: 'The team',
      folderId: 'lbf_aaaaaaaaaa',
      scope: 'workspace',
    } as const
    const o = await run(text, mine)
    if (!o.ok) throw new Error(o.code)
    expect(o.input).toMatchObject(mine)
  })

  it('cuts a licence or author note to its limit and a path off the file name', async () => {
    const text = JSON.stringify({
      type: 'excalidrawlib',
      version: 2,
      license: 'L'.repeat(1000),
      author: 'A'.repeat(500),
      libraryItems: [{ id: 'a', status: 'published', created: 1, elements: [rect('a1')] }],
    })
    const r = await normaliseExcalidrawLib(fileOf(text, 'C:\\Users\\me\\Downloads\\my lib.excalidrawlib'), {
      scope: 'personal',
      engine: engineDouble(),
    })
    if (!r.ok) throw new Error(r.code)
    expect(r.input.licence).toHaveLength(LIBRARY_LIMITS.licenceChars)
    expect(r.input.author).toHaveLength(LIBRARY_LIMITS.authorChars)
    expect(r.input.fileName).toBe('my lib.excalidrawlib')
  })
})

describe('the only reader', () => {
  /** a source file's code: its comment lines are left out (they name what is not used) */
  const src = (name: string) =>
    readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')

  it('imports the engine in excalidrawlib.ts alone, and only reads, parses and restores', () => {
    expect(src('normalise.ts')).not.toMatch(/@excalidraw\//)
    expect(src('index.ts')).not.toMatch(/@excalidraw\//)
    const reader = src('excalidrawlib.ts')
    const imports = [...reader.matchAll(/(?:from|import\()\s*'(@excalidraw\/[^']+)'/g)].map((m) => m[1])
    expect(imports).toEqual(['@excalidraw/excalidraw'])
    // the three pure functions, and none of the library machinery (state, URL tokens, sidebar) or a file picker
    expect(reader).toMatch(/loadLibraryFromBlob/)
    expect(reader).toMatch(/restoreElements/)
    expect(reader).not.toMatch(/useHandleLibrary|parseLibraryTokensFromUrl|updateLibrary|libraryItemsAtom/)
    expect(reader).not.toMatch(/mergeLibraryItems/)
    expect(reader).not.toMatch(/showOpenFilePicker|fetch\(|XMLHttpRequest|WebSocket/)
  })
})
