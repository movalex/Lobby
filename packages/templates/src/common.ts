// Engine-neutral pieces of the template package: ids, categories, geometry, the typed error and the
// context readers both engines share. No tldraw and no Excalidraw import here (docs/EXCALIDRAW-MIGRATION.md
// §4.2 "Templates": one content source, emitted as tldraw records for the default build and as Excalidraw
// elements for the new canvas; wave 4 deletes the tldraw emitter).

export type TemplateId =
  | 'brainstorm'
  | 'mood-board'
  | 'storyboard'
  | 'pitch-outline'
  | 'retrospective'
  | 'production-plan'
  | 'lobby-tour'

/** 'sample': the Lobby tour demo board (shown first on the dashboard, under no category chip). */
export type TemplateCategory = 'ideate' | 'visual' | 'plan' | 'review' | 'sample'

export interface TemplatePoint {
  x: number
  y: number
}

export interface TemplateBounds {
  x: number
  y: number
  w: number
  h: number
}

/** A rectangle in page (scene) space. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A sticky note at scale 1 is 200 x 200 on both engines (tldraw's note, Lobby's `stickynote`). */
export const NOTE_SIZE = 200

export type TemplateErrorCode = 'unknown-template' | 'invalid-context' | 'invalid-output'

/** Typed error for bad template ids, bad contexts, and (never expected) invalid output. */
export class TemplateError extends Error {
  readonly code: TemplateErrorCode

  constructor(code: TemplateErrorCode, message: string) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
  }
}

/** Reads an own property only, so values inherited from a polluted prototype are ignored. */
export function ownProp(obj: object, key: string): unknown {
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined
}

/** A finite number within ±`max`. */
export function isCoordinate(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
}

/**
 * Reads an untrusted `origin` ({x, y}, finite, within ±`max`) into a fresh plain object, or throws
 * TemplateError('invalid-context').
 */
export function readOrigin(input: object, max: number): TemplatePoint {
  const origin = ownProp(input, 'origin')
  if (origin === null || typeof origin !== 'object') {
    throw new TemplateError('invalid-context', 'Template context origin must be an { x, y } object')
  }
  const x = ownProp(origin, 'x')
  const y = ownProp(origin, 'y')
  if (!isCoordinate(x, max) || !isCoordinate(y, max)) {
    throw new TemplateError(
      'invalid-context',
      `Template context origin must be finite numbers within ±${max}`,
    )
  }
  return { x, y }
}

/** Runs a context reader, turning anything but a TemplateError (a throwing getter, a Proxy trap) into one. */
export function guardContext<T>(read: () => T): T {
  try {
    return read()
  } catch (err) {
    if (err instanceof TemplateError) throw err
    throw new TemplateError('invalid-context', 'Template context could not be read')
  }
}

export function unionRects(rects: Iterable<Rect>): Rect | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let any = false
  for (const r of rects) {
    any = true
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return any ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null
}
