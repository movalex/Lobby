/**
 * The semantic diff (docs/EXCALIDRAW-MIGRATION.md §5.3 "Verification per board", §8.3 B8 "Lossless
 * check"): not counts, but record by record, between the tldraw records a board was converted from and
 * the elements it became. It reads the elements as stored (it never trusts the converter's own mapping
 * for what it checks) and re-derives what it compares with its OWN small readers (plain text, transforms),
 * so a converter bug cannot hide behind the same helper on both sides.
 *
 * The report carries check names, counts and failing ids only; never text, names or values.
 */
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { convertRecords, elementIdOf, indexSnapshot } from './convert.ts'
import type { ConvertOptions, LegacyPages, Lossy, TlRecord } from './types.ts'

type Rec = Record<string, unknown>
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export interface CheckResult {
  readonly name: DiffCheckName
  /** false only when a failing id is listed; `skipped` checks are neither */
  readonly pass: boolean
  readonly total: number
  readonly failed: number
  /** up to 50 failing ids (tldraw record ids or element ids), never content */
  readonly failedIds: readonly string[]
  readonly skipped?: string
}

export const DIFF_CHECKS = [
  'shape-mapping',
  'plain-text',
  'asset-set',
  'anchors',
  'frame-membership',
  'bounds',
  'limits',
  'local-mode',
] as const
export type DiffCheckName = (typeof DIFF_CHECKS)[number]

export interface DiffInput {
  /** the (migrated) tldraw records converted */
  readonly records: readonly TlRecord[]
  /** the elements as written (lb_elements rows' data) */
  readonly elements: readonly WireElement[]
  readonly lossy: readonly Lossy[]
  readonly legacyPages: LegacyPages
  /** object refs to resolve (comment anchors, vote targets): `shape:<id>` */
  readonly anchors?: readonly string[]
  /** runs the local-mode check with these options (it re-converts every record alone) */
  readonly localMode?: ConvertOptions
}

export interface DiffReport {
  readonly ok: boolean
  readonly checks: readonly CheckResult[]
}

const MAX_IDS = 50

function result(name: DiffCheckName, total: number, failed: string[], skipped?: string): CheckResult {
  return {
    name,
    pass: failed.length === 0,
    total,
    failed: failed.length,
    failedIds: failed.slice(0, MAX_IDS),
    ...(skipped ? { skipped } : {}),
  }
}

// ---- the diff's own readers ------------------------------------------------------------------------------

/**
 * Plain text of tldraw rich text under the documented rules (§5.1 "text (rich)"), written independently
 * of the converter's reader: paragraph and heading lines, hard breaks as new lines, list items prefixed
 * "• " or "<n>. " (numbered per list from 1), an item's second and later blocks indented by its prefix's
 * width, nested lists restarting their own prefixes; an empty document is one empty line.
 */
export function plainTextOf(rich: unknown): string {
  if (typeof rich === 'string') return rich.replace(/\r\n?/g, '\n')
  const out: string[] = []
  const inlineText = (node: Rec): string => {
    if (node.type === 'text') return str(node.text)
    if (node.type === 'hardBreak') return '\n'
    return (Array.isArray(node.content) ? node.content : []).filter(isObj).map(inlineText).join('')
  }
  const block = (node: Rec, prefix: string, depth: number) => {
    if (depth > 64) return
    const kids = (Array.isArray(node.content) ? node.content : []).filter(isObj)
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      kids.forEach((item, i) => {
        block(item, node.type === 'bulletList' ? '• ' : `${i + 1}. `, depth + 1)
      })
      return
    }
    const hasInline = (Array.isArray(node.content) ? node.content : []).some(
      (k) => isObj(k) && (k.type === 'text' || k.type === 'hardBreak'),
    )
    if (hasInline) {
      for (const line of inlineText(node).split('\n')) out.push(prefix + line)
      return
    }
    if (kids.length === 0) {
      if (node.type === 'paragraph' || node.type === 'heading') out.push(prefix)
      return
    }
    kids.forEach((k, i) => {
      block(k, i === 0 ? prefix : ' '.repeat(prefix.length), depth + 1)
    })
  }
  if (isObj(rich)) block(rich, '', 0)
  return (out.length ? out : ['']).join('\n')
}

type M = [number, number, number, number, number, number]
const mulM = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]

// ---- the diff ---------------------------------------------------------------------------------------------------

export function semanticDiff(input: DiffInput): DiffReport {
  const shapes = new Map<string, TlRecord>()
  const pageIds = new Set<string>()
  const assets = new Map<string, TlRecord>()
  for (const r of input.records) {
    if (r.typeName === 'shape') shapes.set(r.id, r)
    else if (r.typeName === 'page') pageIds.add(r.id)
    else if (r.typeName === 'asset') assets.set(r.id, r)
  }
  const byId = new Map(input.elements.map((e) => [e.id, e]))
  const lossyById = new Map<string, Set<string>>()
  for (const l of input.lossy) lossyById.set(l.id, (lossyById.get(l.id) ?? new Set()).add(l.code))
  const idOf = (tlId: string) => elementIdOf(tlId)
  const checks: CheckResult[] = []
  const groupIdsCarried = new Set(input.elements.flatMap((e) => e.groupIds))
  // a record's elements: its id and its suffixed ids (`.t`, `.o`, `.s<n>`); converted ids never contain '.'
  const byOwner = new Map<string, WireElement[]>()
  for (const e of input.elements) {
    const owner = e.id.split('.')[0] as string
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), e])
  }

  // 1. every shape → an element id (a group → the group id its descendants carry) or a lossy code
  {
    const failed: string[] = []
    for (const s of shapes.values()) {
      const id = idOf(s.id)
      const mapped = s.type === 'group' ? groupIdsCarried.has(id) : byId.has(id)
      if (!mapped && !lossyById.get(s.id)?.size) failed.push(s.id)
    }
    checks.push(result('shape-mapping', shapes.size, failed))
  }

  // 2. plain text of every text-bearing shape = its element's originalText (frames: the name)
  {
    const failed: string[] = []
    let total = 0
    for (const s of shapes.values()) {
      const p = isObj(s.props) ? s.props : {}
      const codes = lossyById.get(s.id)
      if (codes?.has('over-limit') || codes?.has('missing-asset') || codes?.has('unknown-shape')) continue
      const id = idOf(s.id)
      if (s.type === 'frame') {
        total++
        const el = byId.get(id)
        const name = el && el.type === 'frame' ? (el.name ?? '') : null
        if (name !== str(p.name)) failed.push(s.id)
        continue
      }
      if (!['note', 'geo', 'text', 'arrow'].includes(String(s.type))) continue
      const want = plainTextOf(p.richText)
      const hasAny = want.replace(/\s/g, '').length > 0
      total++
      const el = s.type === 'text' ? byId.get(id) : byId.get(`${id}.t`)
      const got = el && el.type === 'text' ? el.originalText : null
      if (!hasAny) {
        if (s.type !== 'text' && got !== null) failed.push(s.id)
        continue
      }
      if (got !== want) failed.push(s.id)
    }
    checks.push(result('plain-text', total, failed))
  }

  // 3. the set of referenced version ids is equal
  {
    const want = new Set<string>()
    const STABLE = /^\/files\/ast_[0-9A-Za-z]{10,40}\/(ver_[0-9A-Za-z]{10,40})\/original$/
    for (const s of shapes.values()) {
      const p = isObj(s.props) ? s.props : {}
      if (s.type === 'dr-file-card' && typeof p.versionId === 'string') want.add(p.versionId)
      if ((s.type === 'image' || s.type === 'video') && typeof p.assetId === 'string') {
        const ap = assets.get(p.assetId)?.props
        const src = isObj(ap) ? str(ap.src) : ''
        const m = STABLE.exec(src)
        if (m?.[1]) want.add(m[1])
      }
    }
    const got = new Set<string>()
    for (const e of input.elements) {
      if (e.type === 'image') got.add(e.fileId.replace(/\.p[1-9][0-9]{0,3}$/, ''))
      const file = e.customData?.lobby?.file as { versionId?: string } | undefined
      if (file?.versionId) got.add(file.versionId)
    }
    const failed = [...new Set([...want, ...got])].filter((v) => want.has(v) !== got.has(v)).sort()
    checks.push(result('asset-set', want.size, failed))
  }

  // 4. object refs (comment anchors, vote targets) resolve to a live element
  {
    const anchors = input.anchors ?? [...shapes.keys()]
    const failed = anchors.filter((ref) => {
      if (!ref.startsWith('shape:')) return true
      const s = shapes.get(ref)
      if (s?.type === 'group') return !groupIdsCarried.has(idOf(ref))
      return !byId.has(idOf(ref))
    })
    checks.push(
      result(
        'anchors',
        anchors.length,
        failed,
        input.anchors ? undefined : 'structural: every shape id as an anchor',
      ),
    )
  }

  // resolve each shape's innermost frame and page transform with the diff's own walk
  const walk = (s: TlRecord): { frame: string | null; m: M; page: string | null } => {
    const chain: TlRecord[] = [s]
    let page: string | null = null
    for (let cur = s, i = 0; i < 64; i++) {
      const parent = str(cur.parentId)
      if (pageIds.has(parent) || parent.startsWith('page:')) {
        page = parent
        break
      }
      const next = shapes.get(parent)
      if (!next || chain.includes(next)) break
      chain.push(next)
      cur = next
    }
    let m: M = [1, 0, 0, 1, 0, 0]
    const off = page ? input.legacyPages[page] : undefined
    if (off) m = [1, 0, 0, 1, off.dx, off.dy]
    let frame: string | null = null
    for (let i = chain.length - 1; i >= 0; i--) {
      const r = chain[i] as TlRecord
      const c = Math.cos(num(r.rotation, 0))
      const sn = Math.sin(num(r.rotation, 0))
      m = mulM(m, [c, sn, -sn, c, num(r.x, 0), num(r.y, 0)])
      if (i > 0 && r.type === 'frame') frame = idOf(r.id)
    }
    return { frame, m, page }
  }

  // 5. frame membership (except nested-frame)
  {
    const failed: string[] = []
    let total = 0
    for (const s of shapes.values()) {
      if (s.type === 'group' || lossyById.get(s.id)?.has('nested-frame')) continue
      const { frame } = walk(s)
      const id = idOf(s.id)
      const els = byOwner.get(id) ?? []
      if (!els.length) continue
      total++
      const want = s.type === 'frame' ? null : frame
      if (els.some((e) => e.frameId !== want)) failed.push(s.id)
    }
    checks.push(result('frame-membership', total, failed))
  }

  // 6. bounds: notes within 2 px, other boxes within 1% (+0.5 px), by centre and size
  {
    const failed: string[] = []
    let total = 0
    for (const s of shapes.values()) {
      const p = isObj(s.props) ? s.props : {}
      const codes = lossyById.get(s.id)
      if (codes?.size && [...codes].some((c) => c !== 'rich-text-formatting' && c !== 'serif-font')) continue
      let w: number
      let h: number
      if (s.type === 'note') {
        w = 200 * num(p.scale, 1)
        h = (200 + num(p.growY, 0)) * num(p.scale, 1)
      } else if (s.type === 'geo') {
        w = num(p.w, 0)
        h = num(p.h, 0) + num(p.growY, 0)
      } else if (['frame', 'image', 'video', 'dr-file-card'].includes(String(s.type))) {
        w = num(p.w, 0)
        h = num(p.h, 0)
      } else continue
      const el = byId.get(idOf(s.id))
      if (!el) continue
      total++
      const { m } = walk(s)
      const cx = m[0] * (w / 2) + m[2] * (h / 2) + m[4]
      const cy = m[1] * (w / 2) + m[3] * (h / 2) + m[5]
      const tol = (v: number) => (s.type === 'note' ? 2 : Math.max(0.5, Math.abs(v) * 0.01))
      const ecx = el.x + el.width / 2
      const ecy = el.y + el.height / 2
      // a note grows downwards (anchor top) when its text needs more height than tldraw gave it
      const grown = s.type === 'note' ? Math.max(0, el.height - h) : 0
      const bad =
        Math.abs(el.width - w) > tol(w) ||
        Math.abs(el.height - grown - h) > tol(h) ||
        Math.hypot(ecx - cx, ecy - grown / 2 - cy) >
          (s.type === 'note' ? 2 : Math.max(0.5, 0.01 * Math.hypot(w, h))) + (grown ? 0.5 : 0)
      if (bad) failed.push(s.id)
    }
    checks.push(result('bounds', total, failed))
  }

  // 7. limits: every element passes the server's own element check
  {
    const failed = input.elements.filter((e) => !checkElement(e).ok).map((e) => e.id)
    checks.push(result('limits', input.elements.length, failed))
  }

  // 8. local mode: each record converted alone equals its elements in the whole board, apart from `index`
  if (input.localMode) {
    const snap = indexSnapshot(input.records)
    const failed: string[] = []
    let total = 0
    const strip = (e: WireElement) => JSON.stringify({ ...e, index: null })
    for (const s of shapes.values()) {
      if (s.type === 'group') continue
      total++
      const alone = convertRecords(snap, [s.id], { ...input.localMode, legacyPages: input.legacyPages })
      const got = (alone.elements.get(s.id) ?? []).map(strip)
      const id = idOf(s.id)
      const want = (byOwner.get(id) ?? []).map(strip)
      if (got.length !== want.length || got.some((g) => !want.includes(g))) failed.push(s.id)
    }
    checks.push(result('local-mode', total, failed))
  } else checks.push(result('local-mode', 0, [], 'not requested'))

  return { ok: checks.every((c) => c.pass), checks }
}
