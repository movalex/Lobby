// tldraw 5.4.2 record builders with every prop filled (as the editor's createShapes fills them), for B8's
// generated boards (e2e/spike-b/b8/corpus.ts) and O4's sync tests. Every record is validated with the one
// server schema. The heavy board is a port of e2e/perf/seed.ts `HEAVY` (same ids, text, positions,
// colours and tags; images reference stable fake file ids instead of uploads).
import { draftroomSchema } from '@draftroom/canvas-schema'
import { b64Vecs, type TLRecord, toRichText } from '@tldraw/tlschema'

export type { TLRecord }

export type Rec = Record<string, unknown>

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** The n-th fractional index key in order: a0…az, b00…bzz, c000… (valid tldraw IndexKeys). */
export function nthIndex(n: number): string {
  let head = 'a'
  let width = 1
  let span = 62
  let k = n
  while (k >= span) {
    k -= span
    head = String.fromCharCode(head.charCodeAt(0) + 1)
    width++
    span = 62 ** width
  }
  let s = ''
  for (let i = 0; i < width; i++) {
    s = (B62[k % 62] as string) + s
    k = Math.floor(k / 62)
  }
  return head + s
}

const checked = (r: Rec): TLRecord => {
  draftroomSchema.types[r.typeName as 'shape'].validate(r)
  return r as unknown as TLRecord
}

export const docRecord = (meta: Rec = {}) =>
  checked({ id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta })
export const pageRecord = (id: string, name: string, index: string) =>
  checked({ id, typeName: 'page', name, index, meta: {} })

const shape = (
  id: string,
  type: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  props: Rec,
  extra: Rec = {},
) =>
  checked({
    id: id.startsWith('shape:') ? id : `shape:${id}`,
    typeName: 'shape',
    type,
    parentId,
    index,
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props,
    ...extra,
  })

export const note = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  text: string,
  over: Rec = {},
  extra: Rec = {},
) =>
  shape(
    id,
    'note',
    parentId,
    index,
    x,
    y,
    {
      color: 'yellow',
      labelColor: 'black',
      size: 'm',
      font: 'sans',
      fontSizeAdjustment: 1,
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      richText: toRichText(text),
      scale: 1,
      textLastEditedBy: null,
      ...over,
    },
    extra,
  )

export const geo = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  w: number,
  h: number,
  text = '',
  over: Rec = {},
  extra: Rec = {},
) =>
  shape(
    id,
    'geo',
    parentId,
    index,
    x,
    y,
    {
      geo: 'rectangle',
      dash: 'draw',
      url: '',
      w,
      h,
      growY: 0,
      scale: 1,
      flipX: false,
      flipY: false,
      labelColor: 'black',
      color: 'blue',
      fill: 'semi',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(text),
      ...over,
    },
    extra,
  )

export const text = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  t: string,
  over: Rec = {},
) =>
  shape(id, 'text', parentId, index, x, y, {
    color: 'black',
    size: 'm',
    font: 'sans',
    textAlign: 'start',
    w: 300,
    richText: toRichText(t),
    scale: 1,
    autoSize: true,
    ...over,
  })

export const frame = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  w: number,
  h: number,
  name: string,
  extra: Rec = {},
) => shape(id, 'frame', parentId, index, x, y, { w, h, name, color: 'black' }, extra)

export const arrow = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  end: { x: number; y: number },
  over: Rec = {},
) =>
  shape(id, 'arrow', parentId, index, x, y, {
    kind: 'arc',
    labelColor: 'black',
    color: 'black',
    fill: 'none',
    dash: 'solid',
    size: 'm',
    arrowheadStart: 'none',
    arrowheadEnd: 'arrow',
    font: 'sans',
    start: { x: 0, y: 0 },
    end,
    bend: 0,
    richText: toRichText(''),
    labelPosition: 0.5,
    scale: 1,
    elbowMidPoint: 0.5,
    ...over,
  })

export const binding = (
  id: string,
  fromId: string,
  toId: string,
  terminal: 'start' | 'end',
  anchor = { x: 0.5, y: 0.5 },
  precise = false,
) =>
  checked({
    id: id.startsWith('binding:') ? id : `binding:${id}`,
    typeName: 'binding',
    type: 'arrow',
    fromId: fromId.startsWith('shape:') ? fromId : `shape:${fromId}`,
    toId: toId.startsWith('shape:') ? toId : `shape:${toId}`,
    meta: {},
    props: { terminal, normalizedAnchor: anchor, isExact: false, isPrecise: precise, snap: 'none' },
  })

export const draw = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  pts: { x: number; y: number }[],
  over: Rec = {},
) =>
  shape(id, 'draw', parentId, index, x, y, {
    color: 'violet',
    fill: 'none',
    dash: 'draw',
    size: 'm',
    segments: [
      {
        type: 'free',
        path: b64Vecs.encodePoints(
          pts.map((p) => ({ ...p, z: 0.5 })),
          2,
        ),
        dim: 2,
      },
    ],
    isComplete: true,
    isClosed: false,
    isPen: false,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    ...over,
  })

export const line = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  pts: { x: number; y: number }[],
) =>
  shape(id, 'line', parentId, index, x, y, {
    color: 'blue',
    dash: 'solid',
    size: 'm',
    spline: 'line',
    scale: 1,
    points: Object.fromEntries(
      pts.map((p, i) => [`p${i}`, { id: `p${i}`, index: nthIndex(i + 1), x: p.x, y: p.y }]),
    ),
  })

export const imageAsset = (
  id: string,
  assetId: string,
  versionId: string,
  w: number,
  h: number,
  name = 'image.jpg',
) =>
  checked({
    id: id.startsWith('asset:') ? id : `asset:${id}`,
    typeName: 'asset',
    type: 'image',
    meta: {},
    props: {
      name,
      src: `/files/${assetId}/${versionId}/original`,
      w,
      h,
      mimeType: 'image/jpeg',
      isAnimated: false,
      fileSize: 1000,
    },
  })

export const image = (
  id: string,
  parentId: string,
  index: string,
  x: number,
  y: number,
  w: number,
  h: number,
  assetId: string,
) =>
  shape(id, 'image', parentId, index, x, y, {
    w,
    h,
    playing: true,
    url: '',
    assetId: assetId.startsWith('asset:') ? assetId : `asset:${assetId}`,
    crop: null,
    flipX: false,
    flipY: false,
    altText: '',
  })

// ---- the heavy perf board (e2e/perf/seed.ts HEAVY), ported ----------------------------------------------

export const HEAVY = { frames: 20, notes: 4_500, images: 200, comments: 40 } as const

/** Records of the heavy board and its 40 comment anchors (shape refs), deterministic. */
export function heavyBoardRecords(
  spec: { frames: number; notes: number; images: number; comments: number } = HEAVY,
): {
  records: TLRecord[]
  anchors: string[]
} {
  let seed = 99
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const SUBJECTS = ['Hero shot', 'Opening title', 'Tagline', 'Moodboard', 'Casting note', 'Colour grade']
  const SUBJECTS2 = ['Location idea', 'Social cutdown', 'Packaging', 'Type pairing', 'Music bed', 'Risk']
  const DETAILS = [
    'golden hour rooftop, wide lens',
    'warm analog grain, teal shadows',
    'keep the logo small in the first 3 seconds',
    'slower push-in on the product before the reveal',
    'more contrast in the night exteriors',
    'two-word headline, lowercase',
    'shoot vertical-safe for 9:16 cutdowns',
    'legal needs the disclaimer for 2 seconds',
    'music drops out right before the tagline',
    'crop tighter so the product reads on a phone',
  ]
  const COLORS = ['yellow', 'yellow', 'light-blue', 'light-green', 'light-violet', 'orange', 'light-red']
  const TAGS = [
    { key: 'research', name: 'Research', color: 'violet' },
    { key: 'client', name: 'Client', color: 'orange' },
    { key: 'blocker', name: 'Blocker', color: 'red' },
    { key: 'idea', name: 'Idea', color: 'light-green' },
    { key: 'shoot-day', name: 'Shoot day', color: 'light-blue' },
    { key: 'copy', name: 'Copy', color: 'grey' },
  ]
  const SIZES: [number, number][] = [
    [1600, 1067],
    [1067, 1600],
    [1600, 1200],
    [1600, 900],
    [1400, 1400],
    [1080, 1350],
  ]
  const NW = 200
  const GAP = 24
  const COLS = 15
  const perFrame = Math.ceil(spec.notes / spec.frames)
  const imgsPerFrame = Math.ceil(spec.images / spec.frames)
  const rows = Math.ceil(perFrame / COLS)
  const FW = COLS * (NW + GAP) + GAP + 520
  const FH = Math.max(60 + rows * (NW + GAP) + GAP, 60 + imgsPerFrame * 340 + 20)
  const PER_ROW = Math.ceil(Math.sqrt(spec.frames * 1.25))
  const docMeta: Rec = {}
  for (const t of TAGS) docMeta[`drTagList:${t.key}`] = { name: t.name, color: t.color }
  const records: TLRecord[] = [docRecord(docMeta), pageRecord('page:page', 'Page 1', 'a1')]
  for (let i = 0; i < spec.images; i++) {
    const [w, h] = SIZES[i % SIZES.length] ?? [1600, 1200]
    const n = String(i).padStart(10, '0')
    records.push(
      imageAsset(
        `asset:perf-${i}`,
        `ast_perf${n}`,
        `ver_perf${n}`,
        w,
        h,
        `perf-ref-${String(i + 1).padStart(3, '0')}.jpg`,
      ),
    )
  }
  let notesLeft = spec.notes
  let img = 0
  for (let f = 0; f < spec.frames; f++) {
    const fid = `shape:perf-f${f}`
    records.push(
      frame(
        fid,
        'page:page',
        nthIndex(f),
        (f % PER_ROW) * (FW + 400),
        Math.floor(f / PER_ROW) * (FH + 400),
        FW,
        FH,
        `Workstream ${f + 1}`,
      ),
    )
    const n = Math.min(perFrame, notesLeft)
    notesLeft -= n
    for (let k = 0; k < n; k++) {
      const meta: Rec = {}
      if (k % 8 === 3) {
        const a = TAGS[(f + k) % TAGS.length]
        const b = TAGS[(f + k + 2) % TAGS.length]
        for (const t of k % 16 === 3 && b ? [a, b] : [a])
          if (t) meta[`drTags:${t.key}`] = { name: t.name, color: t.color }
      }
      const color = pick(COLORS)
      const body = `${pick(rand() < 0.5 ? SUBJECTS : SUBJECTS2)}: ${pick(DETAILS)}`
      records.push(
        note(
          `shape:perf-n${f}-${k}`,
          fid,
          nthIndex(k),
          GAP + (k % COLS) * (NW + GAP),
          60 + Math.floor(k / COLS) * (NW + GAP),
          body,
          { color },
          { meta },
        ),
      )
    }
    for (let k = 0; k < imgsPerFrame && img < spec.images; k++, img++) {
      const [uw, uh] = SIZES[img % SIZES.length] ?? [1600, 1200]
      const w = 480
      records.push(
        image(
          `shape:perf-i${f}-${k}`,
          fid,
          nthIndex(n + k),
          FW - 500,
          60 + k * 340,
          w,
          Math.min(320, Math.round((w * uh) / uw)),
          `asset:perf-${img}`,
        ),
      )
    }
  }
  const anchors: string[] = []
  for (let t = 0; t < spec.comments; t++)
    anchors.push(`shape:perf-n${t % spec.frames}-${(t * 37) % perFrame}`)
  return { records, anchors }
}
