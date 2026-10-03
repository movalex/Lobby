// W5-14 (3e): the file-card faces exports draw. The layout is pure (a fake measure: 7 units a
// character); the session's resolver is checked with a fake face maker (no DOM in Node).
import type { AssetVersionMeta } from '@draftroom/dev-assets/shared'
import { describe, expect, it } from 'vitest'
import type { CardView } from '../../../file-card/ported/model.ts'
import type { FileKey } from '../../files/loader.ts'
import {
  cardFaceLayout,
  cardsByVersion,
  type FaceInput,
  type FaceOp,
  FOOTER_H,
  faceSession,
  statusText,
  wrapClamp,
} from './export-faces.ts'

const measure = (text: string) => Array.from(text).length * 7

const view = (v: Partial<CardView>): CardView => ({
  status: 'ready',
  kind: 'pdf',
  name: 'Brief.pdf',
  sizeBytes: 1_258_291,
  pageCount: 12,
  durationMs: null,
  errorMessage: null,
  missing: false,
  ...v,
})
const input = (v: Partial<CardView>, extra: Partial<FaceInput> = {}): FaceInput => ({
  view: view(v),
  office: null,
  converted: false,
  hasCover: true,
  strip: 0,
  more: 0,
  ...extra,
})
const texts = (ops: readonly FaceOp[]) =>
  ops.filter((o): o is Extract<FaceOp, { op: 'text' }> => o.op === 'text').map((o) => o.text)
const of = <K extends FaceOp['op']>(ops: readonly FaceOp[], op: K) =>
  ops.filter((o): o is Extract<FaceOp, { op: K }> => o.op === op)

describe('card face layout (W5-14)', () => {
  it('a ready PDF: the cover letterboxed above the footer, the pages chip, the kind badge, name and size · pages', () => {
    const { ops } = cardFaceLayout(input({}, { strip: 3, more: 8 }), 240, 300, measure)
    const [cover] = of(ops, 'image').filter((o) => o.slot === 'cover')
    // the preview takes what the footer (56) and the page strip (58) leave
    expect(cover).toMatchObject({ x: 0, y: 0, w: 240, h: 300 - FOOTER_H - 58, fit: 'contain' })
    expect(of(ops, 'image').filter((o) => o.slot.startsWith('page:'))).toHaveLength(3)
    expect(texts(ops)).toEqual(['12 pages', '+8', 'PDF', 'Brief.pdf', '1.2 MB · ', '12 pages'])
    // the kind badge is the PDF red, in the footer band
    const badge = of(ops, 'rect').find((r) => r.fill === '#b3261e')
    expect(badge?.y).toBeGreaterThanOrEqual(300 - FOOTER_H)
    // no controls in a picture: no "View pages", no Download
    expect(texts(ops).some((t) => /View pages|Download/.test(t))).toBe(false)
  })

  it('a video: poster, duration chip and the play button; an attachment: the footer is the whole card', () => {
    const video = cardFaceLayout(
      input({ kind: 'video', name: 'cut.mp4', pageCount: null, durationMs: 65_000 }),
      320,
      200,
      measure,
    )
    expect(texts(video.ops)).toContain('1:05')
    expect(of(video.ops, 'circle')).toHaveLength(1)
    expect(of(video.ops, 'icon')).toHaveLength(1)
    const zip = cardFaceLayout(
      input({ kind: 'other', name: 'notes.zip', pageCount: null }, { hasCover: false }),
      320,
      200,
      measure,
    )
    expect(of(zip.ops, 'image')).toHaveLength(0)
    expect(texts(zip.ops)).toEqual(['ZIP', 'notes.zip', '1.2 MB · ', 'Attachment'])
    // no preview: the badge sits in the middle of the card (the footer fills it)
    const badge = of(zip.ops, 'rect').find((r) => r.fill === '#1f3a5f')
    expect((badge?.y ?? 0) + 19).toBeCloseTo(100, 5)
  })

  it('a failed preview (an encrypted PDF) shows the error; one still processing says so; an Office conversion is noted and coloured', () => {
    const failed = cardFaceLayout(
      input(
        { status: 'failed', errorMessage: 'This PDF is password-protected.', pageCount: null },
        { hasCover: false },
      ),
      240,
      300,
      measure,
    )
    expect(texts(failed.ops)).toEqual(
      expect.arrayContaining(['!', 'This PDF is', 'password-protected.', 'Preview failed']),
    )
    const processing = cardFaceLayout(input({ status: 'processing' }, { hasCover: false }), 240, 300, measure)
    expect(texts(processing.ops)).toEqual(
      expect.arrayContaining(['PDF', 'Generating preview…', 'Processing']),
    )
    const docx = cardFaceLayout(
      input({ name: 'Plan.docx' }, { office: 'docx', converted: true }),
      320,
      300,
      measure,
    )
    expect(texts(docx.ops)).toContain('Preview made from a PDF conversion')
    expect(of(docx.ops, 'rect').some((r) => r.fill === '#2b579a')).toBe(true)
  })

  it('a long name wraps onto two lines and is cut with an ellipsis (F2-09)', () => {
    expect(wrapClamp('a quarterly campaign brief final v3.pdf', 105, '', measure, 2)).toEqual([
      'a quarterly',
      'campaign brief…',
    ])
    expect(wrapClamp('averyveryverylongfilenamewithoutspaces.pdf', 70, '', measure, 2)).toEqual([
      'averyveryv',
      'erylongfi…',
    ])
    expect(wrapClamp('short.pdf', 140, '', measure, 2)).toEqual(['short.pdf'])
    expect(statusText(view({ missing: true }))).toBe('Unavailable')
  })
})

const card = (id: string, versionId: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 240,
  height: 300,
  fileId: versionId,
  customData: {
    lobby: {
      file: {
        assetId: 'ast_0123456789abcdefghij',
        versionId,
        kind,
        name: `${id}.bin`,
        mimeType: 'x/y',
        sizeBytes: 10,
      },
    },
  },
  ...extra,
})

describe('the export resolver with card faces (W5-14)', () => {
  const V1 = 'ver_aaaaaaaaaaaaaaaaaaaa'
  const V2 = 'ver_bbbbbbbbbbbbbbbbbbbb'
  const IMG = 'ver_cccccccccccccccccccc'
  const scene = [
    card('pdf', V1, 'pdf'),
    card('pdf-big', V1, 'pdf', { width: 480, height: 600 }),
    card('zip', V2, 'other', { width: 320, height: 200 }),
    card('photo', IMG, 'image'),
    card('page', V1, 'pdf', { fileId: `${V1}.p2` }),
    card('gone', 'ver_dddddddddddddddddddd', 'pdf', { isDeleted: true }),
  ]

  it('finds the cards by version (the largest box per version), never images, placed pages or deleted ones', () => {
    const cards = cardsByVersion(scene)
    expect([...cards.keys()]).toEqual([V1, V2])
    expect(cards.get(V1)).toMatchObject({ width: 480, height: 600 })
  })

  it("hands the export a card's face (made once per version), and nothing for anything else", async () => {
    const asked: string[] = []
    const base = {
      assetOf: () => null,
      resolveUrl: async (v: string, d: string, f: FileKey) => `/board/${v}/${d}/${f.page ?? '-'}`,
    }
    const made: string[] = []
    const session = faceSession(
      base,
      cardsByVersion(scene),
      {
        boardId: 'b1',
        meta: {
          load: async () => ({ meta: null as AssetVersionMeta | null, missing: false, error: false }),
        },
      },
      { pixelRatio: 2, type: 'image/png' },
      async (src, facts, _key, size) => {
        made.push(`${facts.versionId} ${size.width}x${size.height}`)
        asked.push((await src.coverUrl?.(facts.versionId, _key)) ?? '')
        return new Blob([`face of ${facts.versionId}`])
      },
    )
    const key = (v: string, page: number | null = null): FileKey => ({
      key: v,
      versionId: v,
      derivative: 'thumb',
      page,
    })
    const text = async (b: Blob | null) => (b ? await b.text() : null)
    expect(await text(await session.faceOf(null, key(V1)))).toBe(`face of ${V1}`)
    expect(await text(await session.faceOf(null, { ...key(V1), key: `${V1}@display` }))).toBe(`face of ${V1}`)
    expect(await text(await session.faceOf(null, key(V2)))).toBe(`face of ${V2}`)
    // a placed page and a plain image have no face: the export keeps the board's bytes for them
    expect(await session.faceOf(null, key(V1, 2))).toBeNull()
    expect(await session.faceOf(null, key(IMG))).toBeNull()
    expect(made).toEqual([`${V1} 480x600`, `${V2} 320x200`])
    // the face's cover is the board resolver's display pick
    expect(asked[0]).toBe(`/board/${V1}/display/-`)
    // after the export nothing more is handed out
    session.release()
    expect(await session.faceOf(null, key(V1))).toBeNull()
  })

  it('a face that cannot be drawn is null, so the export falls back to the cover, as before', async () => {
    const session = faceSession(
      { assetOf: () => null, resolveUrl: async (v: string) => `/cover/${v}` },
      cardsByVersion(scene),
      { boardId: 'b1', meta: { load: async () => ({ meta: null, missing: false, error: false }) } },
      { pixelRatio: 1, type: 'image/png' },
      async () => null,
    )
    const key = { key: V1, versionId: V1, derivative: 'thumb', page: null } as FileKey
    expect(await session.faceOf(null, key)).toBeNull()
    const failing = faceSession(
      null,
      cardsByVersion(scene),
      { boardId: 'b1', meta: { load: async () => ({ meta: null, missing: false, error: false }) } },
      { pixelRatio: 1, type: 'image/png' },
      async () => {
        throw new Error('no DOM')
      },
    )
    expect(await failing.faceOf(null, key)).toBeNull()
  })
})
