import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLPageId, TLRecord } from '@tldraw/tlschema'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import { estimateShapeRect, unionRects } from './layout.ts'
import { brainstorm } from './templates/brainstorm.ts'
import { lobbyTour } from './templates/lobby-tour.ts'
import { moodBoard } from './templates/mood-board.ts'
import { pitchOutline } from './templates/pitch-outline.ts'
import { productionPlan } from './templates/production-plan.ts'
import { retrospective } from './templates/retrospective.ts'
import { storyboard } from './templates/storyboard.ts'
import {
  type TemplateBuildResult,
  type TemplateContext,
  type TemplateDefinition,
  TemplateError,
  type TemplateId,
  type TemplateInstance,
} from './types.ts'

/** Largest accepted |origin| coordinate; keeps every produced coordinate finite and precise. */
export const MAX_TEMPLATE_ORIGIN = 1e9
const PAGE_ID_RE = /^page:[A-Za-z0-9_.:~-]{1,200}$/
const INDEX_KEY_RE = /^[A-Za-z][0-9A-Za-z]{1,200}$/

/**
 * Validates an untrusted template context. Returns a fresh, plain copy (no getters or
 * prototype tricks survive) or throws TemplateError('invalid-context').
 */
export function parseTemplateContext(input: unknown): TemplateContext {
  try {
    return parseContextUnsafe(input)
  } catch (err) {
    if (err instanceof TemplateError) throw err
    // e.g. a throwing getter or a Proxy trap on the untrusted object
    throw new TemplateError('invalid-context', 'Template context could not be read')
  }
}

function parseContextUnsafe(input: unknown): TemplateContext {
  if (input === null || typeof input !== 'object') {
    throw new TemplateError('invalid-context', 'Template context must be an object')
  }
  const pageId = ownProp(input, 'pageId')
  if (typeof pageId !== 'string' || !PAGE_ID_RE.test(pageId)) {
    throw new TemplateError('invalid-context', 'Template context pageId must be a page id ("page:…")')
  }
  const origin = ownProp(input, 'origin')
  if (origin === null || typeof origin !== 'object') {
    throw new TemplateError('invalid-context', 'Template context origin must be an { x, y } object')
  }
  const x = ownProp(origin, 'x')
  const y = ownProp(origin, 'y')
  if (!isCoordinate(x) || !isCoordinate(y)) {
    throw new TemplateError(
      'invalid-context',
      `Template context origin must be finite numbers within ±${MAX_TEMPLATE_ORIGIN}`,
    )
  }
  let indexAbove: IndexKey | null = null
  const key = ownProp(input, 'indexAbove')
  if (key !== undefined && key !== null) {
    if (typeof key !== 'string' || !INDEX_KEY_RE.test(key)) {
      throw new TemplateError('invalid-context', 'Template context indexAbove must be a fractional index key')
    }
    try {
      getIndexAbove(key as IndexKey)
    } catch {
      throw new TemplateError('invalid-context', 'Template context indexAbove must be a fractional index key')
    }
    indexAbove = key as IndexKey
  }
  return { pageId: pageId as TLPageId, origin: { x, y }, indexAbove }
}

/** Reads an own property only, so values inherited from a polluted prototype are ignored. */
function ownProp(obj: object, key: string): unknown {
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined
}

function isCoordinate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TEMPLATE_ORIGIN
}

/** Wraps a raw definition so `build` validates its context and returns fresh records every call. */
function define(def: TemplateDefinition): TemplateDefinition {
  const build = def.build
  return Object.freeze({
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    sections: Object.freeze([...def.sections]),
    build(ctx: TemplateContext): TemplateBuildResult {
      return build(parseTemplateContext(ctx))
    },
  })
}

export const TEMPLATES: readonly TemplateDefinition[] = Object.freeze(
  [brainstorm, moodBoard, storyboard, pitchOutline, retrospective, productionPlan, lobbyTour].map(define),
)

const BY_ID = new Map<string, TemplateDefinition>(TEMPLATES.map((t) => [t.id, t]))

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && BY_ID.has(value)
}

export function getTemplate(id: unknown): TemplateDefinition | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined
}

/**
 * Builds a template's records (validated against draftroomSchema) plus the page-space
 * bounds of its top-level shapes. Throws TemplateError for unknown ids or bad contexts.
 */
export function instantiateTemplate(id: TemplateId, ctx: TemplateContext): TemplateInstance {
  const def = getTemplate(id)
  if (!def) throw new TemplateError('unknown-template', 'Unknown template id')
  const parsed = parseTemplateContext(ctx)
  const { records } = def.build(parsed)
  for (const record of records) validateRecord(record)
  const topLevel = records.filter(
    (r): r is Extract<TLRecord, { typeName: 'shape' }> =>
      r.typeName === 'shape' && r.parentId === parsed.pageId,
  )
  const bounds = unionRects(topLevel.map(estimateShapeRect)) ?? {
    x: parsed.origin.x,
    y: parsed.origin.y,
    w: 0,
    h: 0,
  }
  return { records, bounds }
}

function validateRecord(record: TLRecord): void {
  try {
    if (record.typeName === 'shape') draftroomSchema.types.shape.validate(record)
    else if (record.typeName === 'binding') draftroomSchema.types.binding.validate(record)
    else throw new Error(`unexpected record type ${record.typeName}`)
  } catch (err) {
    throw new TemplateError(
      'invalid-output',
      `Template produced an invalid record: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
