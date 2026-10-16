// OWNER: WS3 (wave T, the animatic and the storyboard exports; docs/WAVE-T-CONTRACTS.md §1). What the player, Present
// storyboard and the two exports read of a storyboard: its panels in order with their numbers, start times and
// durations (canvas-schema's planning model: derived, never stored), each panel's picture and fields, the title and
// the sound track. Read only, through the scene index (`withLobbyKey`, `byFrame`: never a walk of the scene) and
// `bounds`; nothing here writes.
//
// WS2's storyboard as WS3 codes against it (the design §2.1; the lead integrates):
//  - a panel is a frame with `sb:of` (its head), `sb:pos` and `sb:dur`; its frame name is the user's;
//  - a field is a rectangle in the panel with a bound label and `kind` = `sb-camera` | `sb-action` | `sb-dialogue` |
//    `sb-sfx` | `sb-music` (several of one kind are read in paint order, one per line);
//  - the picture is the panel's largest uploaded image (with whatever is drawn over it), else its image slot
//    (`slot: 'image'`: the template's placeholder, with what is drawn on it), else what is drawn in the panel apart
//    from the fields; an empty panel has none;
//  - the head (a free text with `sb:head`) is the title; a deleted head leaves "Untitled storyboard";
//  - the sound: `sb:head.audio` names a file card: a video card (its sound) or an MP3/M4A/WAV/OGG attachment (served
//    inline only when the api's byte check agreed, apps/api/src/files/mime.ts), started `audioOffsetMs` after the
//    animatic (a negative offset skips the sound's start).
import {
  type PlanningElement,
  SB_ASPECTS,
  type SbHeadValue,
  type Storyboard,
  type StoryboardAspect,
  storyboardTimings,
} from '@draftroom/canvas-schema/planning'
import type { Bounds, CanvasElement } from '../../canvas/api/index.ts'
import { type PlanningScene, storyboardOfSelection, storyboardsOn } from '../planning/model.ts'

/** What this model reads of the canvas: the scene index, an element by id and its bounds. */
export interface StoryboardCanvas extends PlanningScene {
  get(id: string): CanvasElement | undefined
  bounds(id: string): Bounds | null
}

export const SB_FIELD_KINDS = {
  camera: 'sb-camera',
  action: 'sb-action',
  dialogue: 'sb-dialogue',
  sfx: 'sb-sfx',
  music: 'sb-music',
} as const
export type FieldName = keyof typeof SB_FIELD_KINDS
export const FIELD_NAMES = Object.keys(SB_FIELD_KINDS) as FieldName[]
export const FIELD_LABELS: Readonly<Record<FieldName, string>> = {
  camera: 'Camera',
  action: 'Action',
  dialogue: 'Dialogue',
  sfx: 'SFX',
  music: 'Music',
}
const KIND_FIELD = new Map<string, FieldName>(
  (Object.entries(SB_FIELD_KINDS) as [FieldName, string][]).map(([f, k]) => [k, f]),
)

export type PanelFields = Readonly<Record<FieldName, string>>

/** What a panel's picture is drawn from: these elements, clipped to `bounds` (scene units). */
export interface PanelPicture {
  readonly bounds: Bounds
  readonly ids: readonly string[]
  /** a signature of what it draws (ids and versions): a cached rendering is stale when it changes */
  readonly sig: string
}

export interface PanelView {
  readonly id: string
  /** the shot number, 1..N in storyboard order */
  readonly number: number
  /** the frame's name as typed ('' when unnamed) */
  readonly name: string
  readonly startMs: number
  readonly durationMs: number
  readonly bounds: Bounds | null
  readonly picture: PanelPicture | null
  readonly fields: PanelFields
}

export interface AudioTrack {
  /** the file card element */
  readonly elementId: string
  readonly source: 'audio' | 'video'
  readonly assetId: string
  readonly versionId: string
  readonly name: string
  readonly mimeType: string
  /** ms after the animatic's start the sound starts (negative: its first ms are skipped) */
  readonly offsetMs: number
}

export interface StoryboardView {
  readonly id: string
  readonly title: string
  readonly aspect: StoryboardAspect
  /** width / height of the aspect */
  readonly ratio: number
  readonly fps: 24 | 25 | 30
  readonly settings: SbHeadValue | null
  readonly panels: readonly PanelView[]
  readonly totalMs: number
  readonly audio: AudioTrack | null
}

export const UNTITLED_STORYBOARD = 'Untitled storyboard'

/** The four audio types the api serves an attachment inline with (apps/api/src/files/mime.ts AUDIO_MIMES). */
export const AUDIO_MIMES: readonly string[] = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg']

const ASPECT_RATIO: Readonly<Record<StoryboardAspect, number>> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '2.39:1': 2.39,
}

const lobbyOf = (el: CanvasElement | undefined): Readonly<Record<string, unknown>> => {
  const l = el?.customData?.lobby
  return l && typeof l === 'object' ? l : {}
}

/** An element's text as typed (a label's or a free text's). */
export function textOf(el: CanvasElement | undefined): string {
  const t = el as { originalText?: unknown; text?: unknown } | undefined
  const s = typeof t?.originalText === 'string' ? t.originalText : typeof t?.text === 'string' ? t.text : ''
  return s.trim()
}

const area = (b: Bounds | null) => (b ? b.width * b.height : 0)
const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

function union(boxes: readonly Bounds[]): Bounds | null {
  if (!boxes.length) return null
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.width)
    y1 = Math.max(y1, b.y + b.height)
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Clips `b` to `clip` (null when nothing is left). */
function clipTo(b: Bounds, clip: Bounds | null): Bounds | null {
  if (!clip) return b
  const x = Math.max(b.x, clip.x)
  const y = Math.max(b.y, clip.y)
  const x1 = Math.min(b.x + b.width, clip.x + clip.width)
  const y1 = Math.min(b.y + b.height, clip.y + clip.height)
  return x1 > x && y1 > y ? { x, y, width: x1 - x, height: y1 - y } : null
}

const isUploadedImage = (el: CanvasElement) => {
  if (el.type !== 'image') return false
  const f = lobbyOf(el).file as { kind?: unknown } | undefined
  return f?.kind === 'image'
}

/** A panel's picture and fields, from its children (the scene index's `byFrame`). */
export function panelContent(
  scene: StoryboardCanvas,
  panelId: string,
): { picture: PanelPicture | null; fields: PanelFields } {
  const children = scene.index.byFrame(panelId).filter((e) => !e.isDeleted)
  const fieldOf = new Map<string, FieldName>()
  for (const el of children) {
    const kind = lobbyOf(el).kind
    const f = typeof kind === 'string' ? KIND_FIELD.get(kind) : undefined
    if (f && el.type !== 'text') fieldOf.set(el.id, f)
  }
  const texts: Record<FieldName, string[]> = { camera: [], action: [], dialogue: [], sfx: [], music: [] }
  const content: CanvasElement[] = []
  for (const el of children) {
    const container = el.containerId ?? null
    if (fieldOf.has(el.id)) continue
    if (container && fieldOf.has(container)) {
      const words = textOf(el)
      if (words) texts[fieldOf.get(container) as FieldName].push(words)
      continue
    }
    content.push(el)
  }
  const fields = Object.fromEntries(FIELD_NAMES.map((f) => [f, texts[f].join('\n')])) as PanelFields
  const frame = scene.bounds(panelId)
  const boxOf = (el: CanvasElement) => scene.bounds(el.id)
  let region: Bounds | null = null
  const images = content.filter(isUploadedImage)
  if (images.length) {
    const largest = images.reduce((a, b) => (area(boxOf(b)) > area(boxOf(a)) ? b : a))
    region = boxOf(largest)
  }
  if (!region) {
    const slot = content.find((e) => lobbyOf(e).slot === 'image')
    if (slot) region = boxOf(slot)
  }
  if (!region) region = union(content.map(boxOf).filter((b): b is Bounds => !!b && area(b) > 0))
  region = region ? clipTo(region, frame) : null
  if (!region || area(region) <= 0) return { picture: null, fields }
  const drawn = content.filter((e) => {
    const b = boxOf(e)
    return !!b && overlaps(b, region as Bounds)
  })
  if (!drawn.length) return { picture: null, fields }
  const sig = drawn
    .map((e) => `${e.id}:${(e as { version?: unknown }).version ?? ''}`)
    .concat(`${region.x},${region.y},${region.width},${region.height}`)
    .join('|')
  return { picture: { bounds: region, ids: drawn.map((e) => e.id), sig }, fields }
}

/** The sound of a storyboard's head: a video card's or a byte-checked audio attachment's, else null. */
export function audioTrackOf(scene: StoryboardCanvas, settings: SbHeadValue | null): AudioTrack | null {
  const id = settings?.audio
  if (!id) return null
  const el = scene.get(id)
  if (!el || el.isDeleted) return null
  const f = lobbyOf(el).file as
    | { assetId?: unknown; versionId?: unknown; kind?: unknown; name?: unknown; mimeType?: unknown }
    | undefined
  if (!f || typeof f.assetId !== 'string' || typeof f.versionId !== 'string') return null
  const mimeType = typeof f.mimeType === 'string' ? f.mimeType : ''
  const source =
    f.kind === 'video' ? 'video' : f.kind === 'other' && AUDIO_MIMES.includes(mimeType) ? 'audio' : null
  if (!source) return null
  return {
    elementId: id,
    source,
    assetId: f.assetId,
    versionId: f.versionId,
    name: typeof f.name === 'string' ? f.name : '',
    mimeType,
    offsetMs: settings?.audioOffsetMs ?? 0,
  }
}

/** A storyboard as the player and the exports read it. */
export function storyboardView(
  scene: StoryboardCanvas,
  sb: Storyboard<CanvasElement & PlanningElement>,
): StoryboardView {
  const timings = storyboardTimings(sb)
  const settings = sb.settings
  const aspect = settings?.aspect && SB_ASPECTS.includes(settings.aspect) ? settings.aspect : '16:9'
  const panels = sb.panels.map((p, i): PanelView => {
    const t = timings.panels[i] as (typeof timings.panels)[number]
    const name = (p as { name?: unknown }).name
    return {
      id: p.id,
      number: t.number,
      name: typeof name === 'string' ? name.trim() : '',
      startMs: t.startMs,
      durationMs: t.durationMs,
      bounds: scene.bounds(p.id),
      ...panelContent(scene, p.id),
    }
  })
  return {
    id: sb.id,
    title: (sb.head ? textOf(sb.head) : '') || UNTITLED_STORYBOARD,
    aspect,
    ratio: ASPECT_RATIO[aspect],
    fps: settings?.fps ?? 24,
    settings,
    panels,
    totalMs: timings.totalMs,
    audio: audioTrackOf(scene, settings),
  }
}

/** Every storyboard on the board that has a panel, by id. */
export function storyboardViews(scene: StoryboardCanvas): StoryboardView[] {
  const out: StoryboardView[] = []
  for (const sb of storyboardsOn(scene).values())
    if (sb.panels.length) out.push(storyboardView(scene, sb as Storyboard<CanvasElement & PlanningElement>))
  return out
}

/** The storyboard an id belongs to (a head, a panel, or something inside a panel), with a panel, else null. */
export function storyboardIdAt(scene: StoryboardCanvas, id: string): string | null {
  const el = scene.get(id)
  if (!el) return null
  const sb = storyboardOfSelection(storyboardsOn(scene), el)
  return sb?.panels.length ? sb.id : null
}

/** The storyboard of a selection (its first member that belongs to one), else null. */
export function storyboardOfIds(scene: StoryboardCanvas, ids: readonly string[]): string | null {
  for (const id of ids) {
    const sb = storyboardIdAt(scene, id)
    if (sb) return sb
  }
  return null
}

/** One storyboard by id (null when it has no panel left). */
export function storyboardById(scene: StoryboardCanvas, id: string): StoryboardView | null {
  const sb = storyboardsOn(scene).get(id)
  return sb?.panels.length ? storyboardView(scene, sb as Storyboard<CanvasElement & PlanningElement>) : null
}

/** "SH 03 · 2.5 s": the chip's words (two digits up to 99). */
export function shotLabel(number: number): string {
  return `SH ${String(number).padStart(2, '0')}`
}
