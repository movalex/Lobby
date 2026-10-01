// Browser-safe milestone-0 asset contract (ids, limits, URL builders, meta types).
export * from '@draftroom/dev-assets/shared'

import { type AssetVersionMeta, type DerivativeRecord, isId } from '@draftroom/dev-assets/shared'

/** Derivatives whose ids are safe to put in a URL path (meta comes from the network: never trust it). */
export const usableDerivatives = (meta: AssetVersionMeta): DerivativeRecord[] =>
  Array.isArray(meta.derivatives) ? meta.derivatives.filter((d) => isId('drv', d?.id)) : []

/** Every rendering the worker made of `page` (the page image, and the thumb for the cover), smallest first. */
export function pageRenderings(meta: AssetVersionMeta, page: number): DerivativeRecord[] {
  if (meta.kind !== 'pdf') return []
  return usableDerivatives(meta)
    .filter(
      (d) => (d.role === 'page' || d.role === 'thumb') && d.page === page && d.width > 0 && d.height > 0,
    )
    .sort((a, b) => a.width - b.width)
}
