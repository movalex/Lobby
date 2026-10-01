/**
 * Server-side text metrics for Excalidraw's wrapping and sticky-note fit (plan §2.11).
 *
 * The sync process has no canvas, so `@excalidraw/element` falls back to whatever provider is
 * installed with `setCustomTextMetricsProvider` (element `dist/dev/index.js:5727-5759`). This provider
 * reproduces Chromium's `measureText` from a table measured in Chromium from Excalidraw's own font
 * files (`apps/web/test/engine-probe/browser`, mode `calibrate`):
 *
 * - `adv`: the advance width of each listed character, in em;
 * - `kern`: the pair adjustment `w(ab) - w(a) - w(b)` for listed pairs (non-zero only), in em —
 *   Chromium's shaping applies the fonts' kerning, and a plain per-character sum misses it;
 * - `classes`: the width of one grapheme for characters outside the table: Han, kana, Hangul,
 *   full-width forms, emoji and flags (these fall back to Xiaolai, a system CJK font or Segoe UI Emoji
 *   in the browser, so they are measured per class, never per character).
 *
 * The widths are linear in the font size: `width(text, size) = size * sum(em)`.
 */
import { raw } from './raw.ts'
import table from './text-metrics-table.json' with { type: 'json' }
import type { LobbyFontFamily, TextMetricsProvider } from './types.ts'

export type GlyphClass = 'han' | 'kana' | 'hangul' | 'fullwidth' | 'emoji' | 'flag' | 'other'

export interface FamilyMetrics {
  /** the font-family name Excalidraw puts first in the font string (`getFontFamilyString`) */
  name: string
  adv: Record<string, number>
  kern: Record<string, number>
  classes: Record<GlyphClass, number>
}

export interface TextMetricsTable {
  version: 1
  engine: string
  measuredWith: string
  measuredAt: string
  sizePx: number
  families: Record<string, FamilyMetrics>
}

export interface TableMetricsOptions {
  /** apply the measured pair kerning (default true) */
  kerning?: boolean
}

export interface ServerTextMetrics extends TextMetricsProvider {
  /** width in px of one line of `text` in `family` at `sizePx` */
  width(text: string, family: LobbyFontFamily, sizePx: number): number
  readonly stats: {
    calls: number
    /** graphemes that used a class width instead of the per-character table */
    classGlyphs: Record<GlyphClass, number>
    /** font strings whose family is not in the table (measured as Nunito) */
    unknownFamilies: number
  }
}

const HAN = /\p{Script=Han}/u
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const HANGUL = /\p{Script=Hangul}/u
const FULLWIDTH = /[　-〿＀-￯]/u
const REGIONAL_INDICATOR = /\p{RI}/u
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u
const COMBINING_ONLY = /^\p{M}+$/u

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

export const classifyGrapheme = (g: string): GlyphClass => {
  if (REGIONAL_INDICATOR.test(g)) return 'flag'
  if (PICTOGRAPHIC.test(g) || g.includes('⃣')) return 'emoji'
  if (HAN.test(g)) return 'han'
  if (KANA.test(g)) return 'kana'
  if (HANGUL.test(g)) return 'hangul'
  if (FULLWIDTH.test(g)) return 'fullwidth'
  return 'other'
}

/** `"20px Nunito, sans-serif, Segoe UI Emoji"` → size 20, first family `Nunito`. */
export const parseFontString = (font: string): { sizePx: number; familyName: string } => {
  const m = /^\s*([\d.]+)px\s+(.+)$/.exec(font)
  if (!m?.[1] || !m[2]) return { sizePx: Number.parseFloat(font) || 20, familyName: '' }
  const first = m[2].split(',')[0] ?? ''
  return { sizePx: Number(m[1]), familyName: first.trim().replace(/^["']|["']$/g, '') }
}

export const createTableTextMetrics = (
  metricsTable: TextMetricsTable = table as TextMetricsTable,
  opts: TableMetricsOptions = {},
): ServerTextMetrics => {
  const kerning = opts.kerning ?? true
  const byName = new Map<string, FamilyMetrics>()
  for (const fam of Object.values(metricsTable.families)) byName.set(fam.name, fam)
  const fallback = metricsTable.families['6'] ?? Object.values(metricsTable.families)[0]
  if (!fallback) throw new Error('text metrics table has no families')
  const stats: ServerTextMetrics['stats'] = {
    calls: 0,
    classGlyphs: { han: 0, kana: 0, hangul: 0, fullwidth: 0, emoji: 0, flag: 0, other: 0 },
    unknownFamilies: 0,
  }

  const emWidth = (text: string, fam: FamilyMetrics): number => {
    let em = 0
    let prev: string | null = null
    for (const { segment } of segmenter.segment(text)) {
      const a = fam.adv[segment]
      if (a !== undefined) {
        em += a
        if (kerning && prev !== null) em += fam.kern[prev + segment] ?? 0
        prev = segment
        continue
      }
      prev = null
      if (COMBINING_ONLY.test(segment)) continue
      // a listed base letter with combining marks (not NFC-composable): the base letter's advance
      const base = segment.normalize('NFC')
      const b = fam.adv[base] ?? fam.adv[Array.from(base)[0] ?? '']
      if (b !== undefined && classifyGrapheme(segment) === 'other') {
        em += b
        continue
      }
      const cls = classifyGrapheme(segment)
      stats.classGlyphs[cls]++
      if (cls === 'flag') {
        // a flag is a pair of regional indicators; per-letter advances when the table has them
        const letters = Array.from(segment)
        if (letters.every((l) => fam.adv[l] !== undefined)) {
          for (const l of letters) em += fam.adv[l] ?? 0
          continue
        }
      }
      em += fam.classes[cls]
    }
    return em
  }

  const familyFor = (name: string): FamilyMetrics => {
    const fam = byName.get(name)
    if (fam) return fam
    stats.unknownFamilies++
    return fallback
  }

  return {
    stats,
    getLineWidth(text, fontString) {
      stats.calls++
      const { sizePx, familyName } = parseFontString(fontString)
      return emWidth(text, familyFor(familyName)) * sizePx
    },
    width(text, family, sizePx) {
      const fam = metricsTable.families[String(family)] ?? fallback
      return emWidth(text, fam) * sizePx
    },
  }
}

let installed: ServerTextMetrics | null = null

/**
 * Install the table provider into `@excalidraw/element` (process-wide). Call once at sync start-up,
 * before any layout. Returns the installed provider (for its stats).
 */
export const installServerTextMetrics = (provider: ServerTextMetrics = createTableTextMetrics()) => {
  raw.setCustomTextMetricsProvider(provider)
  installed = provider
  return provider
}

export const installedServerTextMetrics = () => installed

export const textMetricsTable = table as TextMetricsTable
