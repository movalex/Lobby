// OWNER: WS2 (wave S). What the chip, the version list and the viewer say about versions (pure: model.test.ts).
import {
  type AssetVersionEntry,
  type ListAssetVersionsResponse,
  REVIEW_STATUS_LABELS,
  reviewActorLabel,
} from '@draftroom/contracts'
import type { AssetVersionMeta, DerivativeRecord } from '../../../assets/contract.ts'
import { usableDerivatives } from '../../../assets/contract.ts'
import { formatBytes, pluralize } from '../../../lib/format.ts'

/** "v3" for a version the list knows, else null. */
export function versionLabel(list: ListAssetVersionsResponse | null, versionId: string): string | null {
  const n = list?.versions.find((v) => v.versionId === versionId)?.n
  return n ? `v${n}` : null
}

/** The chip's text: "v3" when the deliverable has more than one version here, else nothing. */
export function chipText(list: ListAssetVersionsResponse | null, versionId: string): string | null {
  if (!list || list.versions.length < 2) return null
  return versionLabel(list, versionId)
}

/**
 * The pair compare opens with: the version shown (B) against the one before it (A); for the first version, against
 * the one after it. Null when the list has one version (nothing to compare).
 */
export function defaultPair(
  list: ListAssetVersionsResponse | null,
  shown: string,
): { a: string; b: string } | null {
  const vs = list?.versions ?? []
  if (vs.length < 2) return null
  const i = vs.findIndex((v) => v.versionId === shown)
  if (i < 0) {
    const last = vs[vs.length - 1] as AssetVersionEntry
    const before = vs[vs.length - 2] as AssetVersionEntry
    return { a: before.versionId, b: last.versionId }
  }
  if (i === 0) return { a: shown, b: (vs[1] as AssetVersionEntry).versionId }
  return { a: (vs[i - 1] as AssetVersionEntry).versionId, b: shown }
}

const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/** One row's second line: "Ana (guest) · Oct 16, 3:04 PM · 2.1 MB". */
export function entryDetail(v: AssetVersionEntry): string {
  const when = Number.isNaN(Date.parse(v.createdAt)) ? '' : DATE.format(new Date(v.createdAt))
  return [reviewActorLabel(v.uploadedBy), when, formatBytes(v.sizeBytes)].filter(Boolean).join(' · ')
}

/** One row's third line: comments and the status it got ("2 comments · Approved"), or null. */
export function entryFacts(v: AssetVersionEntry): string | null {
  const parts: string[] = []
  const comments = v.threads.open + v.threads.resolved
  if (comments) parts.push(pluralize(comments, 'comment'))
  if (v.review) parts.push(REVIEW_STATUS_LABELS[v.review.status])
  return parts.length ? parts.join(' · ') : null
}

/** The picture compare shows of an image version: the display rendering (≤ 2,048 px), else the thumb. */
export function displayDerivative(meta: AssetVersionMeta | null): DerivativeRecord | null {
  if (meta?.status !== 'ready') return null
  const all = usableDerivatives(meta)
  return all.find((d) => d.role === 'display') ?? all.find((d) => d.role === 'thumb') ?? null
}

/** The pixel size of an image version (its probe, else its rendering), or null. */
export function pictureSize(meta: AssetVersionMeta | null): { w: number; h: number } | null {
  const w = meta?.probe?.width
  const h = meta?.probe?.height
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) return { w, h }
  const d = displayDerivative(meta)
  return d && d.width > 0 && d.height > 0 ? { w: d.width, h: d.height } : null
}

const KIND_NAME = { image: 'an image', pdf: 'a document', video: 'a video', other: 'a file' } as const

/** Why two versions cannot be compared here (null: they can). */
export function compareRefusal(
  a: Pick<AssetVersionMeta, 'kind'> & { label: string },
  b: Pick<AssetVersionMeta, 'kind'> & { label: string },
): string | null {
  if (a.kind !== b.kind)
    return `${a.label} is ${KIND_NAME[a.kind]} and ${b.label} is ${KIND_NAME[b.kind]}: they can't be compared side by side.`
  if (a.kind === 'other') return 'These files have no preview to compare. Download them to compare.'
  return null
}

/** "v2 has 14 pages, v3 has 16." when the page counts differ, else null. */
export function pageCountNote(
  a: { label: string; pages: number },
  b: { label: string; pages: number },
): string | null {
  if (a.pages === b.pages) return null
  return `${a.label} has ${pluralize(a.pages, 'page')}, ${b.label} has ${pluralize(b.pages, 'page')}.`
}
