// Helpers for the scene tests (not exported from the package): deterministic ids, and a template built on
// both engines from ONE plan with the same ids, so the tldraw records and the Excalidraw elements can be
// compared record by record (and handed to packages/tldraw-import's converter and semantic diff).

import type { WireElement } from '@draftroom/canvas-schema/elements'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { planToRecords } from '../../../tldraw-import/src/templates/records.ts'
import type { TLPageId, TLRecord } from '../../../tldraw-import/src/tldraw.ts'
import type { BoardPlan, PlanNode } from '../builder.ts'
import type { TemplateId, TemplatePoint } from '../common.ts'
import { getTemplateSource, planOf } from '../source.ts'
import { planToScene } from './emit.ts'

/** The Node side of the engine's text layout (the server table), as apps/sync installs it. */
export const metrics = installServerTextMetrics()

export const PAGE = 'page:scene-test' as TLPageId

/** `e1`, `e2`, … (valid element ids and valid bare tldraw ids). */
export function seqIds(prefix = 'e'): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

export interface AlignedTemplate {
  plan: BoardPlan
  elements: WireElement[]
  idOf: Map<PlanNode, string>
  /** the tldraw records of the same plan, every shape id `shape:<element id>` of its node */
  records: TLRecord[]
}

/** One template on both engines with aligned ids (deterministic: ids from `seqIds`, `now` fixed). */
export function alignedTemplate(
  id: TemplateId,
  origin: TemplatePoint = { x: 0, y: 0 },
  opts: { indexAbove?: string | null } = {},
): AlignedTemplate {
  const source = getTemplateSource(id)
  if (!source) throw new Error(`no template ${id}`)
  const plan = planOf(source, origin)
  const { elements, idOf } = planToScene(plan, { newId: seqIds(), now: 1_790_000_000_000, ...opts })
  const raw = planToRecords(plan, { pageId: PAGE, origin, indexAbove: null })
  // shapes come out in plan order, one per node: rename each to its node's element id
  const shapes = raw.filter((r) => r.typeName === 'shape')
  const rename = new Map<string, string>()
  plan.nodes.forEach((node, i) => {
    const shape = shapes[i]
    const el = idOf.get(node)
    if (!shape || !el) throw new Error('plan and records disagree')
    rename.set(shape.id, `shape:${el}`)
  })
  const records = JSON.parse(
    JSON.stringify(raw, (_k, v) => (typeof v === 'string' && rename.has(v) ? rename.get(v) : v)),
  ) as TLRecord[]
  return { plan, elements, idOf, records }
}

/** The page and document records a board file holds next to the shapes (for the converter). */
export function boardRecords(records: readonly TLRecord[]): Record<string, unknown>[] {
  return [
    { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
    { id: PAGE, typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
    ...(records as unknown as Record<string, unknown>[]),
  ]
}

export const byId = (elements: readonly WireElement[]) => new Map(elements.map((e) => [e.id, e]))

/** The label of a container, by `containerId` (tests read structure, not id suffixes). */
export function labelOf(elements: readonly WireElement[], containerId: string): WireElement | undefined {
  return elements.find((e) => e.type === 'text' && e.containerId === containerId)
}

/** Plain words of an element: a text's `originalText`, a container's label words, a frame's name. */
export function wordsOf(elements: readonly WireElement[], el: WireElement): string {
  if (el.type === 'text') return el.originalText
  if (el.type === 'frame') return el.name ?? ''
  const label = labelOf(elements, el.id)
  return label?.type === 'text' ? label.originalText : ''
}
