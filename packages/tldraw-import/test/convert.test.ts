// The converter on the pinned engine (docs/EXCALIDRAW-MIGRATION.md §5.1-§5.3, §6.1 "Converter"): the 8
// fixtures ([DATA]'s 7 templates regenerated from this tree, plus the kitchen sink), determinism across
// runs and input orders, kept ids and `created: null`, the local mode against the whole-board
// conversion, frozen page offsets, and the limits the server applies.
import { readdirSync, readFileSync } from 'node:fs'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { createTableTextMetrics } from '@draftroom/canvas-schema/engine'
import { b64Vecs, toRichText } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import {
  convertBoard,
  convertRecords,
  elementIdOf,
  lossyCounts,
  normalizeFixedPoint,
  plainLines,
  type TlRecord,
} from '../src/index.ts'

const metrics = createTableTextMetrics()
const opts = { updatedAt: 1_759_017_600_000, metrics }
const FIXTURES = new URL('./fixtures/', import.meta.url)
const fixtureNames = readdirSync(FIXTURES)
  .filter((n) => n.startsWith('tl-') && n.endsWith('.json'))
  .sort()
const load = (name: string): TlRecord[] => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))

/** The lossy codes per fixture ([DATA]'s prototype counts, §5.2, re-measured on the pinned engine). */
const EXPECTED_LOSSY: Record<string, Record<string, number>> = {
  'tl-brainstorm.json': {},
  'tl-kitchen-sink.json': {
    'arrow-binding-dropped': 1,
    'arrowhead-approximated': 1,
    'bookmark-as-link': 1,
    'embed-as-link': 1,
    'geo-polygon': 3,
    'nested-frame': 1,
    'page-flattened': 1,
    'rich-text-formatting': 1,
  },
  'tl-lobby-tour.json': { 'rich-text-formatting': 21, 'serif-font': 1 },
  'tl-mood-board.json': {},
  'tl-pitch-outline.json': {},
  'tl-production-plan.json': {},
  'tl-retrospective.json': {},
  'tl-storyboard.json': {},
}

/** The structural invariants of a converted board ([DATA]'s prototype checks). */
function invariantProblems(els: readonly WireElement[]): string[] {
  const out: string[] = []
  const byId = new Map(els.map((e) => [e.id, e]))
  if (byId.size !== els.length) out.push('duplicate ids')
  for (let i = 1; i < els.length; i++)
    if (!((els[i - 1]?.index ?? '') < (els[i]?.index ?? ''))) out.push(`index order at ${i}`)
  for (const e of els) {
    if (e.type === 'text' && e.containerId) {
      const c = byId.get(e.containerId)
      if (!c?.boundElements?.some((x) => x.id === e.id && x.type === 'text')) out.push(`label ${e.id}`)
      if (!c || (c.index ?? '') >= (e.index ?? '')) out.push(`label order ${e.id}`)
    }
    for (const b of e.boundElements ?? []) {
      const other = byId.get(b.id)
      if (!other) out.push(`bound ${e.id}`)
      else if (b.type === 'text' && (other.type !== 'text' || other.containerId !== e.id))
        out.push(`bound text ${e.id}`)
      else if (
        b.type === 'arrow' &&
        (other.type !== 'arrow' ||
          (other.startBinding?.elementId !== e.id && other.endBinding?.elementId !== e.id))
      )
        out.push(`bound arrow ${e.id}`)
    }
    if (e.type === 'arrow')
      for (const bnd of [e.startBinding, e.endBinding]) {
        if (!bnd) continue
        const t = byId.get(bnd.elementId)
        if (!t?.boundElements?.some((x) => x.id === e.id && x.type === 'arrow')) out.push(`binding ${e.id}`)
      }
    if (e.frameId && byId.get(e.frameId)?.type !== 'frame') out.push(`frameId ${e.id}`)
    if (e.type === 'frame' && e.frameId) out.push(`nested frame ${e.id}`)
    if (/data:|blob:|X-Amz-|Signature=/i.test(JSON.stringify(e))) out.push(`forbidden url ${e.id}`)
    if (e.created !== null) out.push(`created ${e.id}`)
  }
  return out
}

describe('the 8 fixtures', () => {
  for (const name of fixtureNames) {
    it(`${name}: converts with no failure, every element passes the server check, lossy codes as pinned`, () => {
      const records = load(name)
      const res = convertBoard(records, opts)
      expect(res.failures).toEqual([])
      for (const e of res.elements) expect(checkElement(e).ok).toBe(true)
      expect(invariantProblems(res.elements)).toEqual([])
      expect(lossyCounts(res.lossy)).toEqual(EXPECTED_LOSSY[name])
      // every non-group shape keeps its id (§3.6)
      for (const r of records)
        if (r.typeName === 'shape' && r.type !== 'group')
          expect(res.mapping[r.id]).toContain(elementIdOf(r.id))
    })

    it(`${name}: byte-identical across runs and input orders`, () => {
      const records = load(name)
      const a = JSON.stringify(convertBoard(structuredClone(records), opts))
      const b = JSON.stringify(convertBoard(structuredClone(records).reverse(), opts))
      const c = JSON.stringify(convertBoard(structuredClone(records), opts))
      expect(b).toBe(a)
      expect(c).toBe(a)
    })
  }

  it('the 8 fixtures together: records in and elements out ([DATA]: 463 records → 606 elements on 0.18.1)', () => {
    let records = 0
    let elements = 0
    for (const name of fixtureNames) {
      const res = convertBoard(load(name), opts)
      records += res.counts.records
      elements += res.counts.elements
    }
    // the template fixtures here carry a document and a page record each (7 × 2 more than [DATA]'s)
    expect({ records, elements }).toEqual({ records: 477, elements: 608 })
  })
})

describe('local mode (§5.1): each record alone equals its elements in the whole board, apart from index', () => {
  for (const name of fixtureNames) {
    it(name, () => {
      const records = load(name)
      const whole = convertBoard(records, opts)
      const strip = (e: WireElement) => JSON.stringify({ ...e, index: null })
      for (const r of records) {
        if (r.typeName !== 'shape' || r.type === 'group') continue
        const alone = convertRecords(records, [r.id], { ...opts, legacyPages: whole.legacyPages })
        expect(alone.failures).toEqual([])
        const got = (alone.elements.get(r.id) ?? []).map(strip)
        const want = whole.elements.filter((e) => (whole.mapping[r.id] ?? []).includes(e.id)).map(strip)
        expect(got).toEqual(want)
        for (const e of alone.elements.get(r.id) ?? []) expect(e.index).toBeNull()
      }
    })
  }

  it('refuses a record on a page with no frozen offset (PAGE_MISSING), never guessing one', () => {
    const records = load('tl-kitchen-sink.json')
    const whole = convertBoard(records, opts)
    const onPage2 = records.find((r) => r.typeName === 'shape' && r.parentId === 'page:second') as TlRecord
    const { 'page:second': _gone, ...pages } = whole.legacyPages
    const res = convertRecords(records, [onPage2.id], { ...opts, legacyPages: pages })
    expect(res.failures.map((f) => f.code)).toEqual(['PAGE_MISSING'])
    expect(res.elements.has(onPage2.id)).toBe(false)
  })
})

describe('frozen page offsets (§5.1 "Pages 2..n")', () => {
  it('reusing legacyPages keeps page 2 in place after a page-1 edge move; recomputing would move it', () => {
    const records = load('tl-kitchen-sink.json')
    const first = convertBoard(records, opts)
    expect(first.legacyPages['page:second']?.dx).toBeGreaterThan(0)
    const moved = records.map((r) => (r.id === 'shape:cloud' ? { ...r, x: (r.x as number) + 5_000 } : r))
    const page2 = (res: ReturnType<typeof convertBoard>) =>
      res.elements
        .filter((e) => ['img1', 'pdfPage', 'vid1', 'emb1', 'bm1', 'card1'].includes(e.id))
        .map((e) => e.x)
    const frozen = convertBoard(moved, { ...opts, legacyPages: first.legacyPages })
    expect(page2(frozen)).toEqual(page2(first))
    const recomputed = convertBoard(moved, opts)
    expect(page2(recomputed)).not.toEqual(page2(first))
  })
})

describe('element construction on the pinned engine (spike A findings)', () => {
  const records = load('tl-kitchen-sink.json')
  const res = convertBoard(records, opts)
  const byId = new Map(res.elements.map((e) => [e.id, e]))

  it('notes are stickynotes with baseHeight, baseFontSize and created: null; labels are laid out by the engine', () => {
    const note = byId.get('note1')
    const label = byId.get('note1.t')
    expect(note?.type).toBe('stickynote')
    expect(note && 'baseHeight' in note && note.baseHeight).toBe(200)
    expect(note?.created).toBeNull()
    expect(label?.type === 'text' && label.baseFontSize).toBe(22)
    expect(label?.type === 'text' && label.containerId).toBe('note1')
    expect(note?.strokeColor).toBe(label?.strokeColor)
  })

  it('an arrow binds to a stickynote with a hand-built FixedPointBinding and the note lists it', () => {
    const arrow = byId.get('arr1')
    expect(arrow?.type).toBe('arrow')
    if (arrow?.type !== 'arrow') return
    expect(arrow.startBinding).toEqual({ elementId: 'note1', fixedPoint: [0.5001, 0.5001], mode: 'orbit' })
    expect(byId.get('note1')?.boundElements).toContainEqual({ id: 'arr1', type: 'arrow' })
    // a precise anchor keeps its fixed point (normalized as the engine does)
    const arc = byId.get('arr2')
    expect(arc?.type === 'arrow' && arc.startBinding?.fixedPoint).toEqual([0.5001, 1])
    expect(normalizeFixedPoint([0.50005, 0.2])).toEqual([0.5001, 0.2])
  })

  it('file cards and videos are images with customData.lobby.file; PDF pages carry pdfPage', () => {
    const card = byId.get('card1')
    expect(card?.type === 'image' && card.fileId).toBe('ver_ffffffffffff')
    expect(card?.customData?.lobby?.file).toMatchObject({ assetId: 'ast_ffffffffffff', kind: 'pdf' })
    const page = byId.get('pdfPage')
    expect(page?.type === 'image' && page.fileId).toBe('ver_pdfpdfpdfpdf.p3')
    expect(page?.customData?.lobby?.pdfPage).toBe(3)
    const vid = byId.get('vid1')
    expect(vid?.customData?.lobby?.file).toMatchObject({ kind: 'video', versionId: 'ver_vvvvvvvvvvvv' })
  })

  it('Lobby meta becomes customData by class: tags, +1s, mind maps, present, private notes, attribution', () => {
    const note = byId.get('note1')
    expect(note?.customData?.lobby).toEqual({
      'tag:research': { name: 'Research', color: 'blue' },
      'plusOne:usr_aaaaaaaaaaaa': true,
      'plusOne:usr_bbbbbbbbbbbb': true,
    })
    expect(byId.get('note1.t')?.customData?.lobbyServer?.lastEditedBy).toEqual({
      uid: 'usr_aaaaaaaaaaaa',
      name: '',
      guest: false,
    })
    expect(byId.get('note2')?.customData?.lobbyServer?.privateNote).toEqual({ session: 'pbs_aaaaaaaaaaaa' })
    expect(byId.get('diamond')?.customData?.lobby?.mindmap).toEqual({
      rootId: 'rect',
      parentId: 'rect',
      side: 'right',
      collapsed: false,
    })
    expect(byId.get('frameA')?.customData?.lobby?.present).toEqual({ index: 1, skip: false })
    expect(byId.get('arr4')?.customData?.lobby?.mindmapEdge).toEqual({
      rootId: 'rect',
      parentId: 'rect',
      childId: 'diamond',
    })
  })

  it('the board document: start view offset by its page, workshop settings, tag definitions, frozen pages', () => {
    expect(res.doc.startView).toEqual({ x: -100, y: -100, w: 1600, h: 1000, frameId: 'frameA' })
    expect(res.doc.workshop).toEqual({ hideNoteAuthors: true, hideCursors: false })
    expect(Object.keys(res.doc.tagDefs).sort()).toEqual(['research', 'urgent'])
    expect(Object.keys(res.legacyPages).sort()).toEqual(['page:page', 'page:second'])
  })
})

describe('limits (§3.5): the converter never writes an element the server would refuse', () => {
  const base = (
    id: string,
    type: string,
    props: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      id: `shape:${id}`,
      typeName: 'shape',
      type,
      parentId: 'page:page',
      index: 'a1',
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props,
      ...extra,
    }) as TlRecord
  const page = { id: 'page:page', typeName: 'page', name: 'P', index: 'a1', meta: {} } as TlRecord

  it('a 6,000-point stroke is simplified and, if needed, split into grouped parts of at most 2,500 points', () => {
    const pts = Array.from({ length: 6_000 }, (_, i) => ({ x: i * 0.7, y: Math.sin(i / 3) * 40, z: 0.5 }))
    const draw = base('long', 'draw', {
      color: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      segments: [{ type: 'free', path: b64Vecs.encodePoints(pts, 2), dim: 2 }],
      isComplete: true,
      isClosed: false,
      isPen: false,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
    })
    const res = convertBoard([page, draw], opts)
    expect(res.failures).toEqual([])
    expect(lossyCounts(res.lossy)).toEqual({ 'stroke-simplified': 1 })
    for (const e of res.elements) {
      expect(e.type).toBe('freedraw')
      if (e.type === 'freedraw') expect(e.points.length).toBeLessThanOrEqual(2_500)
    }
    if (res.elements.length > 1) for (const e of res.elements) expect(e.groupIds).toContain('long.g')
  })

  it('more than 200 +1s keep the first 200 (over-limit); a javascript: link is dropped (link-dropped)', () => {
    const uids = Array.from({ length: 205 }, (_, i) => `usr_${String(i).padStart(12, '0')}`)
    const note = base(
      'n',
      'note',
      {
        color: 'black',
        labelColor: 'black',
        size: 'm',
        font: 'sans',
        fontSizeAdjustment: 1,
        align: 'middle',
        verticalAlign: 'middle',
        growY: 0,
        url: 'javascript:alert(1)',
        richText: toRichText('x'),
        scale: 1,
        textLastEditedBy: null,
      },
      { meta: { plusOnes: uids } },
    )
    const res = convertBoard([page, note], opts)
    expect(res.failures).toEqual([])
    const n = res.elements.find((e) => e.id === 'n')
    expect(Object.keys(n?.customData?.lobby ?? {}).length).toBe(200)
    expect(n?.link).toBeNull()
    expect(lossyCounts(res.lossy)).toEqual({ 'link-dropped': 1, 'over-limit': 1 })
  })
})

describe('rich text → plain lines (§5.1)', () => {
  it('paragraphs, hard breaks, bullets, numbers, the first link; formatting reported by type only', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'T', marks: [{ type: 'bold' }] }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }],
        },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'two',
                      marks: [{ type: 'link', attrs: { href: 'https://x.test/' } }],
                    },
                  ],
                },
                { type: 'paragraph', content: [{ type: 'text', text: 'more' }] },
              ],
            },
          ],
        },
        { type: 'paragraph' },
      ],
    }
    const t = plainLines(doc)
    expect(t.lines).toEqual(['T', 'a', 'b', '1. one', '2. two', '   more', ''])
    expect(t.link).toBe('https://x.test/')
    expect(t.formatted).toBe('bold,heading,orderedList')
  })
})
