// The tldraw registry (default build, until wave 4): the engine-neutral sources (./source.ts) emitted as
// tldraw records (./tldraw.ts) and validated against draftroomSchema.

import { guardContext, ownProp, readOrigin, TemplateError, unionRects } from '@draftroom/templates/common'
import { getTemplateSource, planOf, TEMPLATE_SOURCES, type TemplateSource } from '@draftroom/templates/source'
import type { TLPageId, TLRecord } from '@tldraw/tlschema'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import { draftroomSchema } from '../schema.ts'
import { estimateShapeRect } from './layout.ts'
import { planToRecords } from './records.ts'
import type {
  TemplateBuildResult,
  TemplateContext,
  TemplateDefinition,
  TemplateId,
  TemplateInstance,
} from './types.ts'

export { isTemplateId } from '@draftroom/templates/source'

/** Largest accepted |origin| coordinate; keeps every produced coordinate finite and precise. */
export const MAX_TEMPLATE_ORIGIN = 1e9
const PAGE_ID_RE = /^page:[A-Za-z0-9_.:~-]{1,200}$/
const INDEX_KEY_RE = /^[A-Za-z][0-9A-Za-z]{1,200}$/

/**
 * Validates an untrusted template context. Returns a fresh, plain copy (no getters or
 * prototype tricks survive) or throws TemplateError('invalid-context').
 */
export function parseTemplateContext(input: unknown): TemplateContext {
  return guardContext(() => parseContextUnsafe(input))
}

function parseContextUnsafe(input: unknown): TemplateContext {
  if (input === null || typeof input !== 'object') {
    throw new TemplateError('invalid-context', 'Template context must be an object')
  }
  const pageId = ownProp(input, 'pageId')
  if (typeof pageId !== 'string' || !PAGE_ID_RE.test(pageId)) {
    throw new TemplateError('invalid-context', 'Template context pageId must be a page id ("page:…")')
  }
  const origin = readOrigin(input, MAX_TEMPLATE_ORIGIN)
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
  return { pageId: pageId as TLPageId, origin, indexAbove }
}

/** Wraps a source so `build` validates its context and returns fresh records every call. */
function define(source: TemplateSource): TemplateDefinition {
  return Object.freeze({
    id: source.id,
    name: source.name,
    description: source.description,
    category: source.category,
    sections: Object.freeze([...source.sections]),
    build(ctx: TemplateContext): TemplateBuildResult {
      const parsed = parseTemplateContext(ctx)
      return { records: planToRecords(planOf(source, parsed.origin), parsed) }
    },
  })
}

export const TEMPLATES: readonly TemplateDefinition[] = Object.freeze(TEMPLATE_SOURCES.map(define))

const BY_ID = new Map<string, TemplateDefinition>(TEMPLATES.map((t) => [t.id, t]))

export function getTemplate(id: unknown): TemplateDefinition | undefined {
  return typeof id === 'string' && getTemplateSource(id) ? BY_ID.get(id) : undefined
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
