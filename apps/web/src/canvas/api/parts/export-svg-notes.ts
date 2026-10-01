// OWNER: 3e (present + export). W5-37, the SVG half: notes in an exported SVG get a soft shadow and no
// outline, as today's tldraw exports have.
//
// Excalidraw 0.18's SVG export draws each sticky note as a group of three paths
// (@excalidraw/excalidraw dist/dev/chunk-FN755BR4.js, `case "stickynote"`): a hard shadow (the note's
// path offset by STICKY_NOTE_SHADOW_OFFSET, `fill="#000" fill-opacity="0.16"`), the note itself, and a
// 1 px edge (`stroke="#000" stroke-opacity="0.08"`, clipped by `#sticky-note-clipPath-<id>`). This pass
// removes the hard shadow and the edge (and the edge's clip path), and gives the note's own path one
// shared filter: tldraw's note export shadow (NoteShapeUtil.toSvg: two eroded, blurred, offset copies of
// the note's alpha under it). The note's colour, shape, text and paint order are untouched. A group that
// does not look like that (another engine version, 2C's own note rendering) is left as it is.
//
// The canvas and bitmap exports (PNG, PDF pages, copy) are drawn by the engine's canvas renderer: their
// note look is 2C's (W5-37's note rendering), which they follow once it changes.
//
// Pure string work (the export's serialized SVG), so it runs and is tested in Node.

export const NOTE_SHADOW_FILTER_ID = 'lobby-note-shadow'

/** tldraw 5's note shadow filter (NoteShapeUtil.toSvg), one definition for every note. */
export const NOTE_SHADOW_FILTER =
  `<filter id="${NOTE_SHADOW_FILTER_ID}" x="-10%" y="-10%" width="130%" height="150%">` +
  '<feMorphology in="SourceAlpha" operator="erode" radius="3" result="erode1"/>' +
  '<feGaussianBlur in="erode1" stdDeviation="3" result="blur1"/>' +
  '<feOffset in="blur1" dy="3" result="offsetBlur1"/>' +
  '<feComponentTransfer in="offsetBlur1" result="shadow1"><feFuncA type="linear" slope="0.5"/></feComponentTransfer>' +
  '<feMorphology in="SourceAlpha" operator="erode" radius="10" result="erode2"/>' +
  '<feGaussianBlur in="erode2" stdDeviation="6" result="blur2"/>' +
  '<feOffset in="blur2" dy="6" result="offsetBlur2"/>' +
  '<feComponentTransfer in="offsetBlur2" result="shadow2"><feFuncA type="linear" slope="0.5"/></feComponentTransfer>' +
  '<feMerge><feMergeNode in="shadow1"/><feMergeNode in="shadow2"/><feMergeNode in="SourceGraphic"/></feMerge>' +
  '</filter>'

const PATH_TAG = /<path\b[^>]*?(?:\/>|>\s*<\/path>)/g
const CLIP_ID = /^sticky-note-clipPath-/

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of tag.matchAll(/\s([\w:-]+)="([^"]*)"/g)) out.set(m[1] as string, m[2] as string)
  return out
}

interface PathTag {
  readonly start: number
  readonly end: number
  readonly tag: string
  readonly a: Map<string, string>
}

const isEdge = (p: PathTag) => {
  const clip = /^url\(#([^)]+)\)$/.exec(p.a.get('clip-path') ?? '')?.[1]
  return (
    !!clip &&
    CLIP_ID.test(clip) &&
    p.a.get('fill') === 'none' &&
    (p.a.get('stroke') ?? '').toLowerCase() === '#000' &&
    p.a.has('stroke-opacity')
  )
}
const isShadow = (p: PathTag) =>
  (p.a.get('fill') ?? '').toLowerCase() === '#000' && p.a.has('fill-opacity') && p.a.get('stroke') === 'none'
const isBody = (p: PathTag) =>
  !!p.a.get('fill') && p.a.get('fill') !== 'none' && !p.a.has('fill-opacity') && !p.a.has('clip-path')

/** The SVG with every engine sticky note's hard shadow and edge replaced by the soft shadow filter. */
export function softenNoteShadows(svg: string): string {
  const paths: PathTag[] = [...svg.matchAll(PATH_TAG)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    tag: m[0],
    a: attrs(m[0]),
  }))
  const edits: { start: number; end: number; text: string }[] = []
  const clips = new Set<string>()
  for (let i = 2; i < paths.length; i++) {
    const edge = paths[i] as PathTag
    const body = paths[i - 1] as PathTag
    const shadow = paths[i - 2] as PathTag
    if (!isEdge(edge) || !isBody(body) || !isShadow(shadow)) continue
    // the three are siblings, one after the other (nothing but white space between them)
    if (svg.slice(shadow.end, body.start).trim() || svg.slice(body.end, edge.start).trim()) continue
    clips.add(/^url\(#([^)]+)\)$/.exec(edge.a.get('clip-path') ?? '')?.[1] as string)
    edits.push({ start: shadow.start, end: shadow.end, text: '' })
    edits.push({
      start: body.start,
      end: body.end,
      text: body.tag.replace(/^<path\b/, `<path filter="url(#${NOTE_SHADOW_FILTER_ID})"`),
    })
    edits.push({ start: edge.start, end: edge.end, text: '' })
  }
  if (edits.length === 0) return svg
  // the edges' clip paths are now unused
  for (const m of svg.matchAll(/<clipPath\b[^>]*\sid="([^"]+)"[^>]*>[\s\S]*?<\/clipPath>/g))
    if (clips.has(m[1] as string))
      edits.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: '' })
  edits.sort((a, b) => b.start - a.start)
  let out = svg
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  // one filter definition, in the first <defs> (or right after the root's opening tag)
  const defs = /<defs\b[^>]*?(\/?)>/.exec(out)
  if (defs) {
    const at = (defs.index ?? 0) + defs[0].length
    if (defs[1]) return `${out.slice(0, defs.index)}<defs>${NOTE_SHADOW_FILTER}</defs>${out.slice(at)}`
    return out.slice(0, at) + NOTE_SHADOW_FILTER + out.slice(at)
  }
  const root = /<svg\b[^>]*>/.exec(out)
  if (!root) return out
  const at = (root.index ?? 0) + root[0].length
  return `${out.slice(0, at)}<defs>${NOTE_SHADOW_FILTER}</defs>${out.slice(at)}`
}
