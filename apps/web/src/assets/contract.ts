// The browser-safe milestone-0 asset contract (ids, limits, URL builders, meta types) lives in
// packages/dev-assets/src/shared.ts. apps/web does not declare `@draftroom/dev-assets` as a workspace
// dependency yet (dependency lists are owned by the integration owner), so it is imported by path.
// Replace this with `export * from '@draftroom/dev-assets/shared'` once the dependency is added.
export * from '../../../../packages/dev-assets/src/shared.ts'

import {
  type AssetVersionMeta,
  type DerivativeRecord,
  isId,
} from '../../../../packages/dev-assets/src/shared.ts'

/** Derivatives whose ids are safe to put in a URL path (meta comes from the network: never trust it). */
export const usableDerivatives = (meta: AssetVersionMeta): DerivativeRecord[] =>
  Array.isArray(meta.derivatives) ? meta.derivatives.filter((d) => isId('drv', d?.id)) : []
