// OWNER: WS2 (wave T, storyboards). What a storyboard's elements are, as `tx.create` calls (the canvas's own create
// path: ../ai/diagram/apply.ts's precedent), planned apart from the canvas so Node tests read them:
//  - the head: a free text (the storyboard's title, edited under its lease like any text) with `sb:head`;
//  - a panel: a frame with `sb:of` (the head), `sb:pos` (its order key) and `sb:dur` (ms), holding the picture slot
//    (a rectangle with the template slot marker `slot: 'image'`: an image dropped on it fills it) and three field boxes
//    (rectangles marked by the create-only `kind`: sb-camera, sb-action, sb-dialogue), each under a caption. A field's
//    words are its bound label (typed under the text lease later); an empty field has no label until someone types.
// The shot number and the duration are never drawn into the panel: they are the overlay's (derived from `sb:pos`).
// Every element is unlocked (a layout moves them all, and the room refuses writes to a locked one).
import type { SbHeadValue, StoryboardAspect } from '@draftroom/canvas-schema/planning'
import type { ItemKind } from '../../canvas/api/index.ts'
import {
  CAPTION_FONT,
  CAPTION_KIND,
  FIELD_CAPTIONS,
  FIELD_FONT,
  FIELD_KINDS,
  type FieldKind,
  HEAD_FONT,
  HEAD_KIND,
  PICTURE_KIND,
  panelGeometry,
  wrapWords,
} from './model.ts'

export type Measure = (
  text: string,
  style: { fontFamily: number; fontSize: number },
) => {
  width: number
  height: number
}

export interface Create {
  readonly kind: ItemKind
  readonly props: Readonly<Record<string, unknown>>
}

/** Nunito, Lobby's text face; Lilita One, its display face (headings). */
export const BODY_FONT = 6
export const DISPLAY_FONT = 7
/** Excalidraw's padding of a bound label inside its container (BOUND_TEXT_PADDING). */
const LABEL_PAD = 5

/** The palette of a panel (literal light colours: the engine's dark filter shades them). */
export const LOOK = {
  ink: '#1b2330',
  muted: '#5f6b7a',
  fieldStroke: '#c9d0d8',
  fieldFill: '#ffffff',
  slotStroke: '#a9b3bf',
  slotFill: '#eef1f4',
} as const

export interface PanelWords {
  readonly camera?: string
  readonly action?: string
  readonly dialogue?: string
  /** a sound line: kept with the action's words ("SFX: …") so nothing a script said is lost */
  readonly sfx?: string
}

/** The words each field box holds. */
export function fieldWords(w: PanelWords): Record<FieldKind, string> {
  const action = [w.action?.trim() ?? '', w.sfx?.trim() ? `SFX: ${w.sfx.trim()}` : '']
    .filter(Boolean)
    .join('\n')
  return {
    'sb-camera': w.camera?.trim() ?? '',
    'sb-action': action,
    'sb-dialogue': w.dialogue?.trim() ?? '',
  }
}

export interface Provenance {
  readonly by: string
  readonly run: string | null
}

export interface PanelSpec {
  readonly id: string
  readonly headId: string
  readonly pos: string
  readonly durationMs: number
  readonly aspect: StoryboardAspect
  readonly x: number
  readonly y: number
  readonly name?: string
  readonly words?: PanelWords
  /** AI made it ("Break down with AI"): `lobby.ai` on the frame and its fields */
  readonly ai?: Provenance | null
}

export interface PlannedPanel {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly creates: readonly Create[]
}

const aiOf = (p: Provenance | null | undefined) =>
  p ? { ai: p.run ? { by: p.by, run: p.run } : { by: p.by } } : {}

/** The wrapped words of each field and how many lines they take (the panel's height follows them). */
export function wrappedFields(
  aspect: StoryboardAspect,
  words: PanelWords,
  measure: Measure,
): { text: Record<FieldKind, string>; lines: Record<FieldKind, number> } {
  const g = panelGeometry(aspect)
  const raw = fieldWords(words)
  const text = {} as Record<FieldKind, string>
  const lines = {} as Record<FieldKind, number>
  for (const f of g.fields) {
    const width = (s: string) => measure(s, { fontFamily: BODY_FONT, fontSize: FIELD_FONT }).width
    const wrapped = raw[f.kind] ? wrapWords(raw[f.kind], f.box.w - 2 * LABEL_PAD - 2, width) : ''
    text[f.kind] = wrapped
    lines[f.kind] = wrapped ? wrapped.split('\n').length : 0
  }
  return { text, lines }
}

/** One panel's creates (the frame first, then its picture, captions, fields and labels), at (x, y). */
export function planPanel(spec: PanelSpec, measure: Measure, newId: () => string): PlannedPanel {
  const { text, lines } = wrappedFields(spec.aspect, spec.words ?? {}, measure)
  const g = panelGeometry(spec.aspect, lines)
  const creates: Create[] = []
  const at = (b: { x: number; y: number }) => ({ x: spec.x + b.x, y: spec.y + b.y })
  const frameId = spec.id
  creates.push({
    kind: 'frame',
    props: {
      id: frameId,
      x: spec.x,
      y: spec.y,
      width: g.width,
      height: g.height,
      name: spec.name ?? 'Panel',
      customData: {
        lobby: {
          'sb:of': spec.headId,
          'sb:pos': spec.pos,
          'sb:dur': spec.durationMs,
          ...aiOf(spec.ai),
        },
      },
    },
  })
  const slotId = newId()
  const slotLabelId = newId()
  creates.push({
    kind: 'rectangle',
    props: {
      id: slotId,
      ...at(g.picture),
      width: g.picture.w,
      height: g.picture.h,
      angle: 0,
      strokeColor: LOOK.slotStroke,
      backgroundColor: LOOK.slotFill,
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'dashed',
      roughness: 0,
      opacity: 100,
      roundness: null,
      frameId,
      boundElements: [{ id: slotLabelId, type: 'text' }],
      customData: { lobby: { slot: 'image', kind: PICTURE_KIND } },
    },
  })
  const hint = 'Drop a sketch or a frame grab'
  creates.push({
    kind: 'text',
    props: {
      id: slotLabelId,
      x: spec.x + g.picture.x + g.picture.w / 2,
      y: spec.y + g.picture.y + g.picture.h / 2,
      text: hint,
      originalText: hint,
      fontFamily: BODY_FONT,
      fontSize: 13,
      textAlign: 'center',
      verticalAlign: 'middle',
      strokeColor: LOOK.muted,
      containerId: slotId,
      frameId,
      autoResize: true,
    },
  })
  for (const f of g.fields) {
    const caption = FIELD_CAPTIONS[f.kind]
    creates.push({
      kind: 'text',
      props: {
        id: newId(),
        ...at(f.caption),
        text: caption,
        originalText: caption,
        fontFamily: BODY_FONT,
        fontSize: CAPTION_FONT,
        textAlign: 'left',
        verticalAlign: 'top',
        strokeColor: LOOK.muted,
        frameId,
        autoResize: true,
        customData: { lobby: { kind: CAPTION_KIND } },
      },
    })
    const boxId = newId()
    const words = text[f.kind]
    const labelId = words ? newId() : null
    creates.push({
      kind: 'rectangle',
      props: {
        id: boxId,
        ...at(f.box),
        width: f.box.w,
        height: f.box.h,
        angle: 0,
        strokeColor: LOOK.fieldStroke,
        backgroundColor: LOOK.fieldFill,
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        roundness: { type: 3, value: 6 },
        frameId,
        boundElements: labelId ? [{ id: labelId, type: 'text' }] : null,
        customData: { lobby: { kind: f.kind, ...aiOf(spec.ai) } },
      },
    })
    if (labelId)
      creates.push({
        kind: 'text',
        props: {
          id: labelId,
          x: spec.x + f.box.x + LABEL_PAD,
          y: spec.y + f.box.y + LABEL_PAD,
          text: words,
          originalText: raw(spec.words ?? {}, f.kind),
          fontFamily: BODY_FONT,
          fontSize: FIELD_FONT,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: LOOK.ink,
          containerId: boxId,
          frameId,
          autoResize: true,
        },
      })
  }
  return { id: frameId, width: g.width, height: g.height, creates }
}

const raw = (w: PanelWords, kind: FieldKind) => fieldWords(w)[kind]

export interface HeadSpec {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly title: string
  readonly settings: SbHeadValue
}

/** The head's create: a free text in the display face with `sb:head`. */
export function planHead(spec: HeadSpec, measure: Measure): { create: Create; height: number } {
  const title = spec.title.trim() || 'Storyboard'
  const m = measure(title, { fontFamily: DISPLAY_FONT, fontSize: HEAD_FONT })
  return {
    create: {
      kind: 'text',
      props: {
        id: spec.id,
        x: spec.x,
        y: spec.y,
        text: title,
        originalText: title,
        fontFamily: DISPLAY_FONT,
        fontSize: HEAD_FONT,
        textAlign: 'left',
        verticalAlign: 'top',
        strokeColor: LOOK.ink,
        autoResize: true,
        customData: { lobby: { 'sb:head': spec.settings, kind: HEAD_KIND } },
      },
    },
    height: Math.ceil(m.height || HEAD_FONT * 1.25),
  }
}

/** The field kinds a panel holds, by element (the strip and the AI read a panel's words through them). */
export const isFieldKind = (k: unknown): k is FieldKind => (FIELD_KINDS as readonly unknown[]).includes(k)
