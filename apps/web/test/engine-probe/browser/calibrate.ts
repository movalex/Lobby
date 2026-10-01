/**
 * Measures the server text-metrics table in Chromium (plan §2.11): advance widths, pair kerning and
 * per-class widths, with Excalidraw's own canvas provider (`getLineWidth`, element `index.js:5731-5759`)
 * and the fonts Excalidraw registered from the installed package.
 *
 * Output shape: `TextMetricsTable` in `packages/canvas-schema/src/engine/text-metrics.ts`.
 */
import { getFontString } from '@excalidraw/common'
import { getLineWidth } from '@excalidraw/element'

const SIZE = 100

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i))

/** Characters with their own advance (ASCII, Latin-1, typographic punctuation, common symbols). */
export const ADV_CHARS = [
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff),
  ...'ŒœŠšŽžŸıƒ‐‑‒–—―‘’‚“”„†‡•…‰′″‹›€™−→←↑↓↔✓✗●○■□◆◇▪▫©®°±×÷≈≠≤≥∞'.split(''),
  // regional indicator letters: a flag is two of them, drawn as two letters by Segoe UI Emoji
  ...range(0x1f1e6, 0x1f1ff),
]

/** Characters whose pairs are measured for kerning. */
export const KERN_CHARS = [
  ...range(0x20, 0x7e),
  ...range(0xc0, 0xff).filter((c) => c !== '×' && c !== '÷'),
  ...'‘’“”–—…•'.split(''),
]

/** Class samples. The runner drops any sample character that the A3 corpus uses (held-out test). */
export const CLASS_SAMPLES: Record<string, string[]> = {
  han: Array.from(
    '一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利',
  ),
  kana: Array.from(
    'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
  ),
  hangul: Array.from(
    '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후',
  ),
  fullwidth: Array.from('，。、；：？！「」『』（）【】《》〈〉～・　＃＆＊＋－／＝＠'),
  emoji: Array.from(
    new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(
      '😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚🐶🐱🐭🐹🐰🦊🐻🐼🍎🍐🍊🍋🍌🍉🍇🍓⚽🏀🏈⚾🎾',
    ),
  ).map((s) => s.segment),
  flag: Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment('🇫🇷🇩🇪🇮🇹🇪🇸🇬🇧🇨🇦🇲🇽🇰🇷🇨🇳🇮🇳')).map(
    (s) => s.segment,
  ),
  other: Array.from('абвгдежзийклмнопрстуфхцчшщыэюяΑΒΓΔΕΖΗΘΙΚΛΜαβγδεζηθικλμνξοπρστυφχψω'),
}

/** Lobby's families (canvas-schema LOBBY_FONT_FAMILIES); 7 Lilita One since CONTRACTS_REV 7 (D3). */
export const FAMILIES = [
  { id: 5, name: 'Excalifont' },
  { id: 6, name: 'Nunito' },
  { id: 7, name: 'Lilita One' },
  { id: 8, name: 'Comic Shanns' },
]

const r5 = (n: number) => Math.round(n * 1e5) / 1e5

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2
}

export const loadFontsFor = async (text: string) => {
  for (const fam of FAMILIES)
    await document.fonts.load(getFontString({ fontFamily: fam.id, fontSize: 20 } as never), text)
}

export interface CalibrationResult {
  table: unknown
  spread: Record<string, Record<string, { min: number; max: number; median: number; n: number }>>
  excludedSamples: Record<string, number>
  linearity: { family: number; size: number; text: string; measured: number; scaled: number }[]
}

/** `only`: measure just these family ids (the runner merges them into the existing table). */
export const calibrate = async (
  heldOut: Set<string>,
  only?: readonly number[],
): Promise<CalibrationResult> => {
  const samples: Record<string, string[]> = {}
  const excludedSamples: Record<string, number> = {}
  for (const [cls, list] of Object.entries(CLASS_SAMPLES)) {
    const kept = list.filter((g) => !Array.from(g).some((ch) => heldOut.has(ch)))
    excludedSamples[cls] = list.length - kept.length
    samples[cls] = kept
  }
  const everything = [...ADV_CHARS, ...Object.values(samples).flat()].join('')
  await loadFontsFor(everything)
  await document.fonts.ready

  const families: Record<string, unknown> = {}
  const spread: CalibrationResult['spread'] = {}
  const linearity: CalibrationResult['linearity'] = []
  for (const fam of FAMILIES.filter((f) => !only || only.includes(f.id))) {
    const font = getFontString({ fontFamily: fam.id, fontSize: SIZE } as never)
    const w = (s: string) => getLineWidth(s, font as never) / SIZE
    const adv: Record<string, number> = {}
    for (const ch of ADV_CHARS) adv[ch] = r5(w(ch))
    const kern: Record<string, number> = {}
    for (const a of KERN_CHARS) {
      for (const b of KERN_CHARS) {
        const d = w(a + b) - w(a) - w(b)
        if (Math.abs(d) >= 5e-5) kern[a + b] = r5(d)
      }
    }
    const classes: Record<string, number> = {}
    spread[fam.id] = {}
    for (const [cls, list] of Object.entries(samples)) {
      const ws = list.map((g) => w(g))
      classes[cls] = r5(median(ws))
      spread[fam.id] = {
        ...spread[fam.id],
        [cls]: { min: r5(Math.min(...ws)), max: r5(Math.max(...ws)), median: r5(median(ws)), n: ws.length },
      }
    }
    families[String(fam.id)] = { name: fam.name, adv, kern, classes }
    for (const size of [16, 20, 24, 28, 36]) {
      const f = getFontString({ fontFamily: fam.id, fontSize: size } as never)
      for (const text of [
        'The quick brown fox jumps over the lazy dog',
        'AVATAR Typography WAVE',
        'minimum illumination',
      ]) {
        linearity.push({
          family: fam.id,
          size,
          text,
          measured: getLineWidth(text, f as never),
          scaled: w(text) * size,
        })
      }
    }
  }
  return {
    table: {
      version: 1,
      engine: '@excalidraw/excalidraw 0.18.0-1118751 (element, common at the same version)',
      measuredWith: `${navigator.userAgent} | fonts: Excalidraw's own registration from dist/prod/fonts`,
      measuredAt: new Date().toISOString(),
      sizePx: SIZE,
      families,
    },
    spread,
    excludedSamples,
    linearity,
  }
}
