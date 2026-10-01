import type { FileCardShapeProps } from '@draftroom/canvas-schema'
import {
  type AssetKind,
  type AssetVersionMeta,
  type DerivativeRecord,
  isId,
  usableDerivatives,
} from '../assets/contract.ts'

type Props = FileCardShapeProps
export type HintProps = Pick<Props, 'status' | 'pageCount' | 'durationMs' | 'posterDerivativeId'>

/** Card size on creation. The preview area is letterboxed, so the exact aspect ratio of the file does not matter. */
export const CARD_SIZE: Record<AssetKind, { w: number; h: number }> = {
  pdf: { w: 260, h: 356 },
  video: { w: 360, h: 276 },
  image: { w: 280, h: 260 },
  other: { w: 300, h: 92 },
}

const nonNegInt = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null

/** The image that represents the file on its card: video poster, PDF cover, image thumb. */
export function coverDerivative(meta: AssetVersionMeta | null): DerivativeRecord | null {
  if (meta?.status !== 'ready') return null
  const all = usableDerivatives(meta)
  const byRole = (role: DerivativeRecord['role']) => all.find((d) => d.role === role)
  switch (meta.kind) {
    case 'video':
      return byRole('poster') ?? byRole('thumb') ?? null
    case 'pdf':
      return byRole('thumb') ?? all.find((d) => d.role === 'page' && d.page === 1) ?? null
    case 'image':
      return byRole('thumb') ?? byRole('display') ?? null
    default:
      return null
  }
}

/** Eagerly rendered PDF pages after the cover, in page order (the page strip). */
export function stripPages(meta: AssetVersionMeta | null): DerivativeRecord[] {
  if (meta?.status !== 'ready' || meta.kind !== 'pdf') return []
  return usableDerivatives(meta)
    .filter((d) => d.role === 'page' && typeof d.page === 'number' && d.page > 1)
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
}

/** Hint props the uploading tab writes back into the synced shape (every tab still renders from meta). */
export function hintPropsFromMeta(meta: AssetVersionMeta): HintProps {
  const cover = coverDerivative(meta)
  return {
    status: meta.status,
    pageCount: nonNegInt(meta.probe.pageCount),
    durationMs: nonNegInt(meta.probe.durationMs),
    posterDerivativeId: cover && isId('drv', cover.id) ? cover.id : null,
  }
}

/** Only the hint props that differ, so a no-op poll never writes to the room. */
export function changedHints(current: Props, next: HintProps): Partial<HintProps> | null {
  const out: Partial<HintProps> = {}
  let changed = false
  for (const k of ['status', 'pageCount', 'durationMs', 'posterDerivativeId'] as const) {
    if (current[k] !== next[k]) {
      ;(out as Record<string, unknown>)[k] = next[k]
      changed = true
    }
  }
  return changed ? out : null
}

export interface CardView {
  status: Props['status']
  kind: Props['kind']
  name: string
  sizeBytes: number
  pageCount: number | null
  durationMs: number | null
  errorMessage: string | null
}

/** What a card shows: server meta when we have it, otherwise the (possibly stale) hint props. */
export function cardView(props: Props, meta: AssetVersionMeta | null): CardView {
  if (!meta) {
    return {
      status: props.status,
      kind: props.kind,
      name: props.name,
      sizeBytes: props.sizeBytes,
      pageCount: props.pageCount,
      durationMs: props.durationMs,
      errorMessage: null,
    }
  }
  return {
    status: meta.status,
    kind: meta.kind,
    name: meta.name || props.name,
    sizeBytes: meta.sizeBytes,
    pageCount: nonNegInt(meta.probe.pageCount) ?? props.pageCount,
    durationMs: nonNegInt(meta.probe.durationMs) ?? props.durationMs,
    errorMessage:
      meta.status === 'failed' ? String(meta.error?.message || 'Preview failed.').slice(0, 300) : null,
  }
}
