// OWNER: 3i. WCAG 2.2 contrast for the palette check (docs/EXCALIDRAW-MIGRATION.md §4.8 (5)). Pure.

/** Relative luminance of a `#rrggbb` (or `#rrggbbaa`, alpha ignored) colour. */
export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim())
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = Number.parseInt(m[1] as string, 16)
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** The contrast ratio of two colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** WCAG AA: 4.5:1 for text, 3:1 for large text and for graphics that carry meaning (1.4.11). */
export const AA_TEXT = 4.5
export const AA_NON_TEXT = 3
