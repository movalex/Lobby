/**
 * Strict per-type element schemas (docs/EXCALIDRAW-MIGRATION.md §3.1, §3.5), pinned to the field set of
 * `@excalidraw/element@0.18.0-1118751` (`dist/types/element/src/types.d.ts`; every key of every type was
 * listed from the engine's own constructors on 2026-09-29). Unknown keys are refused. Frozen at the
 * spike B contracts step C0.
 *
 * `WireElement` is an element as it travels (a create's `el`, a server `c` op, snapshots) and as the
 * server stores it. Server-owned fields (`id`, `type`, `version`, `versionNonce`, `updated`, `created`,
 * `customData.lobbyServer`) are present but never taken from a client (§3.2); `status` (image) is
 * local-only: optional here, ignored from clients, stored as `'saved'`.
 *
 * Pure: zod only, no engine code.
 */
import { z } from 'zod'
import { CustomData, checkLobbyData } from './custom-data.ts'
import { TOMBSTONE_KEYS } from './hash.ts'
import {
  COORD_LIMIT,
  ELEMENT_ID_PATTERN,
  FILE_ID_PATTERN,
  isAllowedColor,
  isAllowedLink,
  jsonByteLength,
  MAX_BOUND_ELEMENTS,
  MAX_COLOR_CHARS,
  MAX_FIXED_SEGMENTS,
  MAX_FRAME_NAME_CHARS,
  MAX_FREEDRAW_POINTS,
  MAX_GROUP_IDS,
  MAX_LINEAR_POINTS,
  MAX_ORIGINAL_TEXT_CHARS,
  MAX_TEXT_CHARS,
  maxElementBytes,
} from './limits.ts'
import { planningElementProblem } from './planning-keys.ts'

/** Types Lobby stores (§3.1). */
export const ELEMENT_TYPES = [
  'stickynote',
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'freedraw',
  'image',
  'frame',
] as const
export type ElementType = (typeof ELEMENT_TYPES)[number]
/** Types the server refuses (`INVALID`): `iframe`'s generation HTML is a script-injection route [DATA]. */
export const REFUSED_ELEMENT_TYPES = ['selection', 'magicframe', 'iframe', 'embeddable'] as const
export const isElementType = (t: unknown): t is ElementType =>
  typeof t === 'string' && (ELEMENT_TYPES as readonly string[]).includes(t)

// ---- field schemas -------------------------------------------------------------------------------

export const ElementId = z.string().regex(ELEMENT_ID_PATTERN)
const Coord = z.number().finite().gte(-COORD_LIMIT).lte(COORD_LIMIT)
/** A point relative to the element's `x`, `y` (a `LocalPoint`). */
export const LocalPoint = z.tuple([Coord, Coord])
const Angle = z.number().finite().gte(-1_000).lte(1_000)
const Color = z.string().max(MAX_COLOR_CHARS).refine(isAllowedColor, 'colour not allowed')
const Int = z.number().int()
const NonNegInt = Int.nonnegative()
const Epoch = z.number().finite().nonnegative()
const Link = z.string().refine((l) => isAllowedLink(l), 'link not allowed')

export const BoundElementRef = z.strictObject({ id: ElementId, type: z.enum(['arrow', 'text']) })
export const FixedPointBinding = z.strictObject({
  elementId: ElementId,
  fixedPoint: z.tuple([z.number().finite(), z.number().finite()]),
  mode: z.enum(['inside', 'orbit', 'skip']),
})
export type FixedPointBinding = z.infer<typeof FixedPointBinding>
export const FixedSegment = z.strictObject({ start: LocalPoint, end: LocalPoint, index: NonNegInt })
export type FixedSegment = z.infer<typeof FixedSegment>
/** Current arrowheads of the pinned engine (the legacy names `dot`, `crowfoot_*` are not stored). */
export const ARROWHEADS = [
  'arrow',
  'bar',
  'circle',
  'circle_outline',
  'triangle',
  'triangle_outline',
  'diamond',
  'diamond_outline',
  'cardinality_one',
  'cardinality_many',
  'cardinality_one_or_many',
  'cardinality_exactly_one',
  'cardinality_zero_or_one',
  'cardinality_zero_or_many',
] as const
const Arrowhead = z.enum(ARROWHEADS).nullable()
const Roundness = z
  .strictObject({
    type: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    value: z.number().finite().optional(),
  })
  .nullable()

/** Every type's common fields (`_ExcalidrawElementBase`). */
const base = {
  id: ElementId,
  x: Coord,
  y: Coord,
  width: Coord,
  height: Coord,
  angle: Angle,
  strokeColor: Color,
  backgroundColor: Color,
  fillStyle: z.enum(['hachure', 'cross-hatch', 'solid', 'zigzag']),
  strokeWidth: z.number().finite().nonnegative().lte(1_000),
  strokeStyle: z.enum(['solid', 'dashed', 'dotted']),
  roundness: Roundness,
  roughness: z.number().finite().nonnegative().lte(10),
  opacity: z.number().finite().gte(0).lte(100),
  seed: Int,
  version: Int.positive(),
  versionNonce: Int,
  index: z.string().min(1).max(200).nullable(),
  isDeleted: z.boolean(),
  groupIds: z.array(ElementId).max(MAX_GROUP_IDS),
  frameId: ElementId.nullable(),
  boundElements: z.array(BoundElementRef).max(MAX_BOUND_ELEMENTS).nullable(),
  updated: Epoch,
  created: Epoch.nullable(),
  link: Link.nullable(),
  locked: z.boolean(),
  customData: CustomData.optional(),
}

const linear = {
  points: z.array(LocalPoint).max(MAX_LINEAR_POINTS),
  startBinding: FixedPointBinding.nullable(),
  endBinding: FixedPointBinding.nullable(),
  startArrowhead: Arrowhead,
  endArrowhead: Arrowhead,
}

export const RectangleElement = z.strictObject({ ...base, type: z.literal('rectangle') })
export const EllipseElement = z.strictObject({ ...base, type: z.literal('ellipse') })
export const DiamondElement = z.strictObject({ ...base, type: z.literal('diamond') })
/** Lobby notes: `created` is always null (no date footer, §2.11); `baseHeight` is the note size. */
export const StickyNoteElement = z.strictObject({
  ...base,
  type: z.literal('stickynote'),
  baseHeight: z.number().finite().positive().lte(COORD_LIMIT),
})
/** Free text (`containerId: null`) and bound labels share one schema; `groups.ts` tells them apart. */
export const TextElement = z.strictObject({
  ...base,
  type: z.literal('text'),
  fontSize: z.number().finite().positive().lte(10_000),
  /** limits.ts LOBBY_FONT_FAMILIES: 5 Excalifont, 6 Nunito, 7 Lilita One (headings, D3), 8 Comic Shanns */
  fontFamily: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  baseFontSize: z.number().finite().positive().lte(10_000).nullable(),
  text: z.string().max(MAX_TEXT_CHARS),
  textAlign: z.enum(['left', 'center', 'right']),
  verticalAlign: z.enum(['top', 'middle', 'bottom']),
  containerId: ElementId.nullable(),
  originalText: z.string().max(MAX_ORIGINAL_TEXT_CHARS),
  autoResize: z.boolean(),
  lineHeight: z.number().finite().positive().lte(100),
  labelPosition: z.number().finite().nullable().optional(),
})
/**
 * Arrows, straight, curved (`roundness`) or elbow (`elbowed: true`). An elbow arrow also has
 * `fixedSegments`, `startIsSpecial` and `endIsSpecial`; an arrow that stopped being elbowed may keep
 * them (null or stale), which is why they are optional here and in the `path` unit (groups.ts).
 */
export const ArrowElement = z.strictObject({
  ...base,
  ...linear,
  type: z.literal('arrow'),
  elbowed: z.boolean(),
  fixedSegments: z.array(FixedSegment).max(MAX_FIXED_SEGMENTS).nullable().optional(),
  startIsSpecial: z.boolean().nullable().optional(),
  endIsSpecial: z.boolean().nullable().optional(),
})
/** Lines are never bound (§2.8): both bindings must be null. `polygon: true` for closed shapes. */
export const LineElement = z.strictObject({
  ...base,
  ...linear,
  type: z.literal('line'),
  startBinding: z.null(),
  endBinding: z.null(),
  polygon: z.boolean(),
})
export const FreedrawElement = z.strictObject({
  ...base,
  type: z.literal('freedraw'),
  points: z.array(LocalPoint).max(MAX_FREEDRAW_POINTS),
  pressures: z.array(z.number().finite().gte(0).lte(1)).max(MAX_FREEDRAW_POINTS),
  simulatePressure: z.boolean(),
  strokeOptions: z.strictObject({
    variability: z.enum(['variable', 'constant']),
    streamline: z.number().finite().gte(0).lte(1),
  }),
})
/** Images, PDF pages and file cards (D7): `fileId` is a Lobby version id, never bytes or a URL. */
export const ImageElement = z.strictObject({
  ...base,
  type: z.literal('image'),
  fileId: z.string().regex(FILE_ID_PATTERN),
  status: z.enum(['pending', 'saved', 'error']).optional(),
  scale: z.tuple([z.union([z.literal(1), z.literal(-1)]), z.union([z.literal(1), z.literal(-1)])]),
  crop: z
    .strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
      naturalWidth: z.number().finite().positive(),
      naturalHeight: z.number().finite().positive(),
    })
    .nullable(),
})
/** Frames; no nesting (a frame's own `frameId` must be null, checked by the invariants). */
export const FrameElement = z.strictObject({
  ...base,
  type: z.literal('frame'),
  name: z.string().max(MAX_FRAME_NAME_CHARS).nullable(),
})

export const WireElement = z.discriminatedUnion('type', [
  StickyNoteElement,
  RectangleElement,
  EllipseElement,
  DiamondElement,
  TextElement,
  ArrowElement,
  LineElement,
  FreedrawElement,
  ImageElement,
  FrameElement,
])
export type WireElement = z.infer<typeof WireElement>
export type ArrowWireElement = z.infer<typeof ArrowElement>
export type LineWireElement = z.infer<typeof LineElement>
export type TextWireElement = z.infer<typeof TextElement>

/** UTF-8 bytes of an element's JSON. */
export const elementBytes = (el: unknown): number => jsonByteLength(el)

// ---- tombstones on the wire (CONTRACTS_REV 7, W5-02) ----------------------------------------------------

export { TOMBSTONE_KEYS }

/** Every field of a tombstone outside TOMBSTONE_KEYS, the same for every type: no content, no geometry. */
const NEUTRAL_BASE = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roundness: null,
  roughness: 0,
  opacity: 100,
  seed: 1,
  groupIds: [],
  frameId: null,
  boundElements: null,
  created: null,
  link: null,
  locked: false,
} as const
const NEUTRAL_LINEAR = {
  points: [
    [0, 0],
    [0, 0],
  ],
  startBinding: null,
  endBinding: null,
  startArrowhead: null,
  endArrowhead: null,
} as const
/** The `fileId` of a redacted image tombstone: a valid version id no upload ever has (all zeros). */
export const REDACTED_FILE_ID = 'ver_0000000000'
const NEUTRAL_BY_TYPE: Readonly<Record<ElementType, Readonly<Record<string, unknown>>>> = {
  stickynote: { baseHeight: 1 },
  rectangle: {},
  ellipse: {},
  diamond: {},
  text: {
    fontSize: 20,
    fontFamily: 6,
    baseFontSize: null,
    text: '',
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    originalText: '',
    autoResize: true,
    lineHeight: 1.25,
  },
  arrow: { ...NEUTRAL_LINEAR, elbowed: false },
  line: { ...NEUTRAL_LINEAR, polygon: false },
  freedraw: {
    points: [[0, 0]],
    pressures: [],
    simulatePressure: true,
    strokeOptions: { variability: 'constant', streamline: 0.5 },
  },
  image: { fileId: REDACTED_FILE_ID, status: 'saved', scale: [1, 1], crop: null },
  frame: { name: null },
}

/**
 * The wire form of a stored tombstone (§2.4.2, revised for W5-02): its TOMBSTONE_KEYS (id, type, the
 * deletion, version, versionNonce, index, updated) over its type's neutral values, so it is a valid
 * `WireElement` every client and Excalidraw's scene accept, and it carries none of the deleted element's
 * content: no text, no author (`customData` is gone), no link, no file id, no geometry, no membership. The
 * reset snapshot, catch-ups, every server op that stores or keeps an element deleted, and the stored copy in
 * a reject's `el` use it. The server keeps the full row (`lb_elements`, `lb_deleted`) for "Recently
 * deleted" and its restores; an undelete reaches clients as the full live element. hash.ts hashes a
 * tombstone by the same keys, so a client that still holds the content it saw live converges with one that
 * holds this form.
 */
export function redactTombstone(
  el: Readonly<Record<string, unknown>> & { readonly type: string },
): WireElement {
  const type = (isElementType(el.type) ? el.type : 'rectangle') as ElementType
  const neutral = JSON.parse(JSON.stringify({ ...NEUTRAL_BASE, ...NEUTRAL_BY_TYPE[type] })) as Record<
    string,
    unknown
  >
  return {
    ...neutral,
    id: el.id,
    type,
    isDeleted: true,
    version: el.version,
    versionNonce: el.versionNonce,
    index: el.index ?? null,
    updated: el.updated,
  } as WireElement
}

/** Whether `el` is in the redacted form (every non-tombstone field neutral), e.g. for tests and clients. */
export function isRedactedTombstone(
  el: Readonly<Record<string, unknown>> & { readonly type: string },
): boolean {
  if (el.isDeleted !== true) return false
  const r = redactTombstone(el) as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(el), ...Object.keys(r)])
  for (const k of keys) if (JSON.stringify(el[k]) !== JSON.stringify(r[k])) return false
  return true
}

export type ElementCheck =
  | { ok: true; element: WireElement }
  | { ok: false; code: 'INVALID' | 'TOO_LARGE'; detail: string }

/**
 * The per-element server check (§3.5): the strict schema, the per-type byte limit, the
 * `customData.lobby` registry and budgets, and `pressures` matching `points` on freedraw. Cross-element
 * rules are in invariants.ts; class rules (who may write a key) are the server's (O1).
 */
export function checkElement(raw: unknown): ElementCheck {
  if (raw && typeof raw === 'object' && 'type' in raw && !isElementType((raw as { type: unknown }).type))
    return {
      ok: false,
      code: 'INVALID',
      detail: `type ${JSON.stringify(String((raw as { type: unknown }).type).slice(0, 32))} is not stored`,
    }
  const parsed = WireElement.safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      code: 'INVALID',
      detail: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    }
  const el = parsed.data
  if (elementBytes(el) > maxElementBytes(el.type))
    return { ok: false, code: 'TOO_LARGE', detail: `${el.type} over ${maxElementBytes(el.type)} bytes` }
  if (el.type === 'freedraw' && el.pressures.length !== 0 && el.pressures.length !== el.points.length)
    return { ok: false, code: 'INVALID', detail: 'pressures do not match points' }
  // `created` is server-owned: the server stores null for every stickynote (§2.11) whatever a client sent,
  // and `index` validity (a fractional key) is the server's step 11 (engine/fractional.ts), not a schema rule.
  const lobby = el.customData?.lobby
  if (lobby) {
    const check = checkLobbyData(lobby)
    if (!check.ok) return check
    // wave T (CONTRACTS_REV 14): which element types the planning keys go on, and their cross-key rules
    const planning = planningElementProblem(
      el.type,
      (el as { containerId?: string | null }).containerId,
      lobby,
    )
    if (planning) return { ok: false, code: 'INVALID', detail: planning }
  }
  return { ok: true, element: el }
}
