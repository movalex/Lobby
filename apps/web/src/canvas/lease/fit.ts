// Classifies the local writes made while a text editor is open (docs/EXCALIDRAW-MIGRATION.md §2.9.4).
// Pure: it takes element snapshots, not the engine, so it runs in Node tests and in the spike pages.
//
// Rule 1 of §2.9.4: on the lease holder's client, a change to the edited label's CONTAINER made while the
// editor is open and no gesture runs is the container's fit (`x`, `y`, `width`, `height`), sent as the
// op's `fit` field, never as ordinary `pos`/`shape` writes. Everything else keeps its field group
// (§3.2). Arrows bound to that container that moved in the same window are reported separately
// ('bound-arrow'): open item 3 of the plan (auto-fit also runs updateBoundElements) needs a rule for them.

/** The element fields this module reads. Everything else is compared generically. */
export interface ElementSnapshot {
  id: string
  type: string
  containerId?: string | null
  boundElements?: readonly { id: string; type: string }[] | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  autoResize?: boolean
  [key: string]: unknown
}

export type GroupName =
  | 'pos'
  | 'shape'
  | 'text'
  | 'layout'
  | 'textStyle'
  | 'style'
  | 'bind'
  | 'bound'
  | 'z'
  | 'membership'
  | 'meta'
  | 'file'
  | 'life'
  | 'custom'
  | 'local'
  | 'server'

/** Fields a container fit may carry (§2.4.2 `fit`). */
export const FIT_FIELDS = ['x', 'y', 'width', 'height'] as const
export type FitField = (typeof FIT_FIELDS)[number]
export type Fit = Partial<Record<FitField, number>>

const SERVER_OWNED = new Set(['id', 'type', 'version', 'versionNonce', 'updated', 'created'])

const BASE_GROUPS: Record<string, GroupName> = {
  x: 'pos',
  y: 'pos',
  width: 'shape',
  height: 'shape',
  angle: 'shape',
  points: 'shape',
  pressures: 'shape',
  simulatePressure: 'shape',
  polygon: 'shape',
  scale: 'shape',
  crop: 'shape',
  roundness: 'shape',
  seed: 'shape',
  elbowed: 'shape',
  fixedSegments: 'shape',
  startIsSpecial: 'shape',
  endIsSpecial: 'shape',
  baseHeight: 'shape',
  originalText: 'text',
  text: 'layout',
  fontSize: 'textStyle',
  baseFontSize: 'textStyle',
  fontFamily: 'textStyle',
  lineHeight: 'textStyle',
  textAlign: 'textStyle',
  verticalAlign: 'textStyle',
  autoResize: 'textStyle',
  strokeColor: 'style',
  backgroundColor: 'style',
  fillStyle: 'style',
  strokeWidth: 'style',
  strokeStyle: 'style',
  strokeOptions: 'style',
  roughness: 'style',
  opacity: 'style',
  startArrowhead: 'style',
  endArrowhead: 'style',
  startBinding: 'bind',
  endBinding: 'bind',
  containerId: 'bind',
  labelPosition: 'bind',
  boundElements: 'bound',
  index: 'z',
  groupIds: 'membership',
  frameId: 'membership',
  link: 'meta',
  locked: 'meta',
  name: 'meta',
  fileId: 'file',
  isDeleted: 'life',
  customData: 'custom',
  status: 'local',
}

/** The field group of `field` on `element` (§3.2: the map is per element kind). */
export function groupOf(element: ElementSnapshot, field: string): GroupName {
  if (SERVER_OWNED.has(field)) return 'server'
  const isBoundLabel = element.type === 'text' && !!element.containerId
  const isFreeText = element.type === 'text' && !element.containerId
  if (isBoundLabel && ['x', 'y', 'width', 'height', 'fontSize'].includes(field)) return 'layout'
  if (isFreeText && (field === 'width' || field === 'height')) return 'layout'
  return BASE_GROUPS[field] ?? 'custom'
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Keys whose values differ (server-owned keys included, so a report can show version bumps). */
export function changedFields(prev: ElementSnapshot, next: ElementSnapshot): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  return [...keys].filter((k) => !same(prev[k], next[k])).sort()
}

export interface EditorContext {
  /** The text element being edited. */
  labelId: string
  /** Its container, or null for free text. */
  containerId: string | null
  /** This client holds the lease on the label's lease id. */
  holder: boolean
  /** A gesture runs (drag, resize, rotate…; §2.5.3). Its writes are user writes, never fit. */
  gesture: boolean
  /** The editor is open (guard) or opening while the lease is still pending. */
  pending?: boolean
}

export interface ClassifiedWrite {
  id: string
  role: 'container' | 'label' | 'bound-arrow' | 'other'
  /** Every changed field, server-owned ones included. */
  fields: string[]
  /** Container only: the fit values (the holder's conditional write). */
  fit?: Fit
  /** Changed non-server fields that are NOT fit, by group. */
  groups: Partial<Record<GroupName, string[]>>
  /** Pending lease only: the guard holds this write back (the leased label, or a fit-only container write). */
  heldBack?: boolean
}

function boundTo(arrow: ElementSnapshot, containerId: string): boolean {
  return arrow.startBinding?.elementId === containerId || arrow.endBinding?.elementId === containerId
}

/**
 * Classifies every element that changed between `prev` and `next` (two local snapshots taken while the
 * editor is open; remote changes must already be folded into `prev` by the caller).
 */
export function classifyEditorWrites(
  prev: ReadonlyMap<string, ElementSnapshot>,
  next: ReadonlyMap<string, ElementSnapshot>,
  ctx: EditorContext,
): ClassifiedWrite[] {
  const out: ClassifiedWrite[] = []
  for (const [id, after] of next) {
    const before = prev.get(id)
    if (!before) {
      const role = id === ctx.labelId ? 'label' : 'other'
      // A label Excalidraw created for an unlabelled container is held back too (guard step 3).
      out.push({
        id,
        role,
        fields: ['(created)'],
        groups: {},
        heldBack: ctx.pending === true && role === 'label',
      })
      continue
    }
    const fields = changedFields(before, after)
    if (fields.length === 0) continue
    const role: ClassifiedWrite['role'] =
      id === ctx.labelId
        ? 'label'
        : id === ctx.containerId
          ? 'container'
          : ctx.containerId && after.type === 'arrow' && boundTo(after, ctx.containerId)
            ? 'bound-arrow'
            : 'other'
    const write: ClassifiedWrite = { id, role, fields, groups: {}, heldBack: false }
    // The editor's container writes are fit for the holder AND while the lease is pending (then they
    // are held back, guard step 3); never during a gesture.
    const asFit = role === 'container' && (ctx.holder || ctx.pending === true) && !ctx.gesture
    for (const f of fields) {
      const g = groupOf(after, f)
      if (g === 'server') continue
      if (asFit && (FIT_FIELDS as readonly string[]).includes(f)) {
        write.fit = { ...write.fit, [f]: after[f] as number }
        continue
      }
      const list = write.groups[g] ?? []
      list.push(f)
      write.groups[g] = list
    }
    if (ctx.pending) {
      // Guard step 3 (§2.9.2): nothing is pushed for the leased label or its container fit while the
      // lease is pending. Anything else would still go out.
      write.heldBack = role === 'label' || (role === 'container' && Object.keys(write.groups).length === 0)
    }
    out.push(write)
  }
  return out
}

/** The writes that would be pushed (not held back by the guard). */
export function wouldPush(writes: readonly ClassifiedWrite[]): ClassifiedWrite[] {
  return writes.filter((w) => !w.heldBack)
}
