// Browser-safe milestone-0 asset contract (ids, limits, URL builders, meta types).
export * from '@draftroom/dev-assets/shared'

import { type AssetVersionMeta, type DerivativeRecord, isId } from '@draftroom/dev-assets/shared'

/** Derivatives whose ids are safe to put in a URL path (meta comes from the network: never trust it). */
export const usableDerivatives = (meta: AssetVersionMeta): DerivativeRecord[] =>
  Array.isArray(meta.derivatives) ? meta.derivatives.filter((d) => isId('drv', d?.id)) : []
