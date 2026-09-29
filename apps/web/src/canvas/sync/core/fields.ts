/**
 * Field groups as the engine core diffs, overlays and sends them (docs/EXCALIDRAW-MIGRATION.md §2.4.2,
 * §2.5.2, §3.2). The map is canvas-schema's groups.ts (one map for the core, undo and the server); this
 * file only says how a group's values are read from, written to and compared between element copies.
 *
 * A group key is a `GroupName`, `c:<key>` for one `customData.lobby` key, or `fit` (the lease holder's
 * conditional container fit, or a leased free text's own `x`/`y`, §2.9.4 rule 1): not a group on the
 * wire, the op's `fit` field.
 *
 * NODE-SAFE (CONTRACTS.md): explicit `.ts` extensions, no DOM, no Vite, no `@excalidraw/excalidraw`.
 */
import {
  type ElementKind,
  ENGINE_ARTIFACT_FIELDS,
  FIELD_GROUPS,
  type GroupName,
  kindOf,
  pathUnitOf,
} from '@draftroom/canvas-schema/groups'
import { roundGeometry, stripLocalFileSuffix } from '@draftroom/canvas-schema/limits'
import type { Fit, Op, PatchOp } from '@draftroom/canvas-schema/protocol'
import type { SceneElement } from '../types.ts'

export type GroupKey = GroupName | `c:${string}` | 'fit'

/** The fields a container fit (or a leased free text's own fit) may carry (§2.4.2 `fit`). */
export const FIT_FIELDS = ['x', 'y', 'width', 'height'] as const
/** A leased free text's fit: only its own `x`, `y` (its box is `layout`). */
export const FREE_TEXT_FIT_FIELDS = ['x', 'y'] as const

/** Groups whose fields travel together (coupled geometry): the whole group from one copy. */
const COUPLED: ReadonlySet<GroupName> = new Set(['pos', 'shape', 'layout', 'path'])

type Rec = Readonly<Record<string, unknown>>

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!deepEqual(ra[k], rb[k])) return false
  return true
}

export const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

/** `customData.lobby` of an element (never null). */
export const lobbyOf = (el: Rec | undefined): Record<string, unknown> =>
  ((el?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) as Record<
    string,
    unknown
  >

/** A value as it is compared and sent: a local `fileId` derivative suffix is local-only (E9). */
export const normalized = (field: string, value: unknown): unknown =>
  field === 'fileId' && typeof value === 'string' ? stripLocalFileSuffix(value) : value

export const kindOrNull = (el: Rec & { readonly type: string }): ElementKind | null =>
  kindOf(el as { type: string; containerId?: string | null })

/** The top-level fields of `group` on an element of `kind`. */
export function fieldsOf(kind: ElementKind, group: GroupName): string[] {
  const out: string[] = []
  for (const [f, g] of Object.entries(FIELD_GROUPS[kind])) if (g === group) out.push(f)
  return out
}

export interface GroupDiff {
  /** changed groups (and `c:<key>` keys) */
  readonly groups: Set<GroupKey>
  /** changed top-level fields, with their group (for the fit split) */
  readonly fields: Map<string, GroupName>
}

/**
 * The groups in which `local` differs from `ref` (`ref` undefined: everything). Server-owned, local-only
 * and engine-artifact fields are in no group and never differ; `customData.lobby` is compared per key,
 * `customData.lobbyServer` never (server-owned); `boundElements` is the `bound` group, by id.
 */
export function diffGroups(local: SceneElement, ref: SceneElement | undefined): GroupDiff {
  const groups = new Set<GroupKey>()
  const fields = new Map<string, GroupName>()
  const kind = kindOrNull(local)
  if (!kind) return { groups, fields }
  const map = FIELD_GROUPS[kind]
  if (!ref) {
    for (const [f, g] of Object.entries(map)) {
      groups.add(g)
      fields.set(f, g)
    }
    for (const k of Object.keys(lobbyOf(local))) groups.add(`c:${k}`)
    return { groups, fields }
  }
  const refKind = kindOrNull(ref)
  for (const [f, g] of Object.entries(map)) {
    if (g === 'bound') {
      if (!sameBound(local.boundElements, ref.boundElements)) {
        groups.add('bound')
        fields.set(f, g)
      }
      continue
    }
    if (!deepEqual(normalized(f, local[f]), normalized(f, ref[f]))) {
      groups.add(g)
      fields.set(f, g)
    }
  }
  // a field the other kind has and this one lacks (a label unbound into a free text changes its kind)
  if (refKind && refKind !== kind)
    for (const [f, g] of Object.entries(FIELD_GROUPS[refKind]))
      if (!(f in map) && ref[f] !== undefined) {
        groups.add(g)
        fields.set(f, g)
      }
  const la = lobbyOf(local)
  const lb = lobbyOf(ref)
  for (const k of new Set([...Object.keys(la), ...Object.keys(lb)]))
    if (!deepEqual(la[k], lb[k])) groups.add(`c:${k}`)
  return { groups, fields }
}

type BoundRef = { readonly id: string; readonly type: string }
const boundIds = (v: unknown): BoundRef[] => ((v as BoundRef[] | null | undefined) ?? []).map((r) => r)

export function sameBound(a: unknown, b: unknown): boolean {
  const x = boundIds(a)
  const y = boundIds(b)
  if (x.length !== y.length) return false
  const ids = new Set(y.map((r) => `${r.type}:${r.id}`))
  return x.every((r) => ids.has(`${r.type}:${r.id}`))
}

/** `b` of a patch: ids added and removed between `ref` and `local`. */
export function boundPatch(
  local: SceneElement,
  ref: SceneElement | undefined,
): { add: { id: string; type: 'arrow' | 'text' }[]; rm: string[] } | null {
  const before = boundIds(ref?.boundElements)
  const after = boundIds(local.boundElements)
  const add = after
    .filter((r) => !before.some((x) => x.id === r.id))
    .map((r) => ({ id: r.id, type: r.type as 'arrow' | 'text' }))
  const rm = before.filter((r) => !after.some((x) => x.id === r.id)).map((r) => r.id)
  return add.length || rm.length ? { add, rm } : null
}

/**
 * A copy of `dst` with the values of `groups` taken from `src` (a `path` unit whole: an elbow field
 * `src` lacks is removed; `c:<key>` per key; `fit` its fields; `bound` the whole `boundElements`).
 * Server-owned fields stay `dst`'s.
 */
export function copyGroups(dst: SceneElement, src: SceneElement, groups: Iterable<GroupKey>): SceneElement {
  // a deep copy: the result goes into the scene, and Excalidraw mutates scene elements in place
  const out: Record<string, unknown> = structuredClone(dst) as Record<string, unknown>
  const kind = kindOrNull(src) ?? kindOrNull(dst)
  let lobby: Record<string, unknown> | null = null
  for (const g of groups) {
    if (g === 'fit') {
      for (const f of FIT_FIELDS) if (src[f] !== undefined) out[f] = clone(src[f])
      continue
    }
    if (g.startsWith('c:')) {
      const key = g.slice(2)
      lobby ??= { ...lobbyOf(dst) }
      const v = lobbyOf(src)[key]
      if (v === undefined) delete lobby[key]
      else lobby[key] = clone(v)
      continue
    }
    if (!kind) continue
    if (g === 'path') {
      if (src.type === 'arrow' || src.type === 'line') {
        const unit = pathUnitOf(src)
        for (const f of ['fixedSegments', 'startIsSpecial', 'endIsSpecial']) if (!(f in unit)) delete out[f]
        Object.assign(out, unit)
      }
      continue
    }
    for (const f of fieldsOf(kind, g as GroupName)) {
      if (src[f] === undefined) delete out[f]
      else out[f] = clone(src[f])
    }
  }
  if (lobby) {
    const cd = { ...((dst.customData as Record<string, unknown> | undefined) ?? {}) }
    if (Object.keys(lobby).length) cd.lobby = lobby
    else delete cd.lobby
    if (Object.keys(cd).length) out.customData = cd
    else delete out.customData
  }
  return out as SceneElement
}

/** An element as it goes out in a create: without engine artifacts, `status`, a local file suffix or `lobbyServer`, rounded (§3.5). */
export function toWire(el: SceneElement): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(el)) {
    if (v === undefined || k === 'status' || ENGINE_ARTIFACT_FIELDS.includes(k)) continue
    out[k] = clone(normalized(k, v))
  }
  const cd = out.customData as Record<string, unknown> | undefined
  if (cd) {
    const lobby = cd.lobby as Record<string, unknown> | undefined
    if (lobby && Object.keys(lobby).length) out.customData = { lobby }
    else delete out.customData
  }
  return roundGeometry(out as { type: string; x: number; y: number }) as Record<string, unknown>
}

/** An element as the engine core holds it for the hash (hash.ts drops `status` and the file suffix itself). */
export function withoutArtifacts(el: SceneElement): SceneElement {
  if (!ENGINE_ARTIFACT_FIELDS.some((f) => f in el)) return el
  const out: Record<string, unknown> = { ...el }
  for (const f of ENGINE_ARTIFACT_FIELDS) delete out[f]
  return out as SceneElement
}

const roundUnit = (el: SceneElement, unit: Record<string, unknown>): Record<string, unknown> => {
  const r = roundGeometry({ ...unit, type: el.type } as { type: string; x: number; y: number })
  const out: Record<string, unknown> = { ...(r as Record<string, unknown>) }
  delete out.type
  return out
}

/**
 * The patch op carrying `groups` of `local` against `ref` (the server copy this client builds on).
 * Coupled groups (`pos`, `shape`, `layout`, `path`) carry all their fields from the one local copy (the
 * `path` unit whole, §2.4.2); other groups only the fields that changed; `c` per key (null removes);
 * `b` by id; `fit` the fit fields that changed. Returns null when nothing is left to send.
 */
export function buildPatch(
  local: SceneElement,
  ref: SceneElement,
  groups: ReadonlySet<GroupKey>,
  opts: { pv: number; off?: number; freeTextFit?: boolean },
): PatchOp | null {
  const kind = kindOrNull(local)
  if (!kind) return null
  const g: Record<string, Record<string, unknown>> = {}
  const c: Record<string, unknown> = {}
  let b: PatchOp['b']
  let fit: Fit | undefined
  for (const key of groups) {
    if (key === 'fit') {
      const fields = opts.freeTextFit ? FREE_TEXT_FIT_FIELDS : FIT_FIELDS
      const f: Record<string, number> = {}
      for (const name of fields) {
        const v = local[name]
        if (typeof v === 'number' && !deepEqual(v, ref[name])) f[name] = v
      }
      if (Object.keys(f).length) fit = f as Fit
      continue
    }
    if (key.startsWith('c:')) {
      const k = key.slice(2)
      const v = lobbyOf(local)[k]
      if (!deepEqual(v, lobbyOf(ref)[k])) c[k] = v === undefined ? null : clone(v)
      continue
    }
    if (key === 'bound') {
      b = boundPatch(local, ref) ?? undefined
      continue
    }
    const group = key as GroupName
    if (group === 'path') {
      if (local.type === 'arrow' || local.type === 'line') g.path = roundUnit(local, pathUnitOf(local))
      continue
    }
    const values: Record<string, unknown> = {}
    for (const f of fieldsOf(kind, group)) {
      const v = normalized(f, local[f])
      if (COUPLED.has(group) || !deepEqual(v, normalized(f, ref[f])))
        values[f] = v === undefined ? null : clone(v)
    }
    if (group === 'shape' && local.type === 'freedraw') {
      const r = roundGeometry(local as unknown as { type: string; x: number; y: number }) as unknown as Rec
      if ('points' in values) values.points = clone(r.points)
      if ('pressures' in values) values.pressures = clone(r.pressures)
    }
    if (Object.keys(values).length) g[group] = values
  }
  const op: Record<string, unknown> = { k: 'p', id: local.id, pv: opts.pv }
  if (Object.keys(g).length) op.g = g
  if (Object.keys(c).length) op.c = c
  if (b) op.b = b
  if (fit) op.fit = fit
  if (opts.off !== undefined) op.off = Math.max(0, Math.round(opts.off))
  if (!op.g && !op.c && !op.b && !op.fit) return null
  return op as PatchOp
}

/** The id an op writes. */
export const opId = (op: Op): string => (op.k === 'c' ? op.el.id : op.id)
