/**
 * Fractional index helpers shared by the server (`apps/sync` assigns and validates `index`, plan
 * §2.4.3 step 11) and the web client's index pre-pass (plan §2.5.5 E2).
 *
 * Keys come from `@excalidraw/fractional-indexing` at the pinned version (CC0), the same generator
 * `@excalidraw/element` uses in `syncInvalidIndices` (element `index.js:12616-12860`).
 */
import { generateKeyBetween, generateNKeysBetween, validateOrderKey } from '@excalidraw/fractional-indexing'

/** A key `validateOrderKey` accepts (Excalidraw's `isValidFractionalIndex` step 1). */
export const isValidIndexKey = (key: unknown): key is string => {
  if (typeof key !== 'string' || key.length === 0) return false
  try {
    validateOrderKey(key)
    return true
  } catch {
    return false
  }
}

/** A key strictly between `lo` and `hi` (either may be null for an open end). */
export const indexKeyBetween = (lo: string | null | undefined, hi: string | null | undefined): string =>
  generateKeyBetween(lo ?? null, hi ?? null)

/** `n` sorted keys strictly between `lo` and `hi`. */
export const indexKeysBetween = (lo: string | null | undefined, hi: string | null | undefined, n: number) =>
  generateNKeysBetween(lo ?? null, hi ?? null, n)

/**
 * Excalidraw's order: by `index` (string compare), ties broken by `id` (`orderByFractionalIndex`,
 * element `index.js:12686-12697`). SQLite's `ORDER BY idx, id` matches it for valid keys.
 */
export const compareByIndex = (
  a: { readonly index: string | null; readonly id: string },
  b: { readonly index: string | null; readonly id: string },
): number => {
  const ai = a.index ?? ''
  const bi = b.index ?? ''
  if (ai < bi) return -1
  if (ai > bi) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
