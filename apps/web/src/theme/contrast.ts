// WCAG 2.x contrast (used by tokens.test.ts to check the theme's colour pairs).

/** Relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = Number.parseInt(m[1] as string, 16)
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** Contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The custom properties declared directly in the first CSS rule whose selector is exactly `selector`
 * (values as written). Enough for styles.css's two token blocks; not a general CSS parser.
 */
export function customProperties(css: string, selector: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = withoutComments.split(/\n(?=\S)/).find((chunk) => chunk.trimStart().startsWith(`${selector} {`))
  if (!at) throw new Error(`no "${selector} {" rule`)
  const body = at.slice(at.indexOf('{') + 1, at.indexOf('}'))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim()
  return out
}
