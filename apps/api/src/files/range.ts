export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Parses a single `Range: bytes=...` spec (`a-b`, `a-`, `-n`) against a resource of `size` bytes.
 * Returns inclusive offsets, 'unsatisfiable' (-> 416), or null to ignore the header and send the
 * whole body. Multi-range and malformed headers are ignored, which RFC 9110 §14.2 permits.
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m) return null
  const [, a = '', b = ''] = m
  if (a === '' && b === '') return null
  if (a === '') {
    const suffix = Number(b)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(a)
  if (b !== '' && Number(b) < start) return null // invalid spec: ignore, per RFC
  if (start >= size) return 'unsatisfiable'
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  return { start, end }
}
