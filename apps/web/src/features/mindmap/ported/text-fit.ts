// The size a topic takes for its text, and its label's layout (pure; the measurer is passed in, in the
// browser `LobbyCanvas.text.measure`). The port of ../runtime.ts `fitSize`: the width follows the text
// within the level's range (./style.ts), the height holds the wrapped text.
//
// Excalidraw draws a bound label's stored `text` (the wrapped lines) at its stored position, and its own
// editor re-wraps and re-centres the label whenever someone types. A write that changes a topic's width
// or font outside the editor (a new map's placeholder, the fit after typing, a level change) therefore
// writes the label's wrapped text and position too, laid out as Excalidraw lays out a centred label in a
// rectangle: wrapped at the container's width minus BOUND_TEXT_PADDING on each side, centred both ways
// (@excalidraw/element redrawTextBoundingBox / computeBoundTextPosition). The wrapping here is a greedy
// word wrap on the same measurer; Excalidraw's own wrap may break a line differently in rare cases, and
// its editor re-wraps the label the next time anyone types in it.

/** Excalidraw's BOUND_TEXT_PADDING (@excalidraw/common): the gap between a container and its label. */
export const BOUND_TEXT_PADDING = 5

export type Measure = (text: string, fontSize: number) => { width: number; height: number }

const WORD_OR_SPACE = /\S+|\s+/gu

/** Breaks one word that is wider than `max` into pieces that fit (at least one character each). */
function breakWord(word: string, max: number, width: (s: string) => number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of [...word]) {
    if (cur && width(cur + ch) > max) {
      out.push(cur)
      cur = ch
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Wraps `text` at `maxWidth` (explicit line breaks kept; trailing spaces of a wrapped line dropped, as
 * Excalidraw's wrapText does). `width(s)` measures one line.
 */
export function wrapText(text: string, maxWidth: number, width: (s: string) => number): string {
  if (!(maxWidth > 0)) return text
  const lines: string[] = []
  for (const para of text.split('\n')) {
    if (width(para) <= maxWidth) {
      lines.push(para)
      continue
    }
    let cur = ''
    for (const token of para.match(WORD_OR_SPACE) ?? []) {
      if (/^\s+$/u.test(token)) {
        cur += token
        continue
      }
      if (width(cur + token) <= maxWidth) {
        cur += token
        continue
      }
      if (cur.trim()) lines.push(cur.trimEnd())
      cur = ''
      if (width(token) <= maxWidth) {
        cur = token
        continue
      }
      const pieces = breakWord(token, maxWidth, width)
      for (const p of pieces.slice(0, -1)) lines.push(p)
      cur = pieces[pieces.length - 1] ?? ''
    }
    lines.push(cur.trimEnd())
  }
  return lines.join('\n')
}

export interface LevelRange {
  minW: number
  maxW: number
  minH: number
}

export interface TopicFit {
  /** the container's size */
  width: number
  height: number
  /** the label's wrapped text and size (null: no label, the topic is empty) */
  label: { text: string; width: number; height: number } | null
}

/**
 * The size of a rectangle topic for `text` at `fontSize` within `range` (unscaled, as tldraw's fitSize):
 * an empty topic takes the minimum size; otherwise the width follows the widest line (plus padding)
 * between minW and maxW, and the height holds the wrapped lines.
 */
export function fitTopic(text: string, fontSize: number, range: LevelRange, measure: Measure): TopicFit {
  if (!text.trim()) return { width: range.minW, height: range.minH, label: null }
  const lineWidth = (s: string) => measure(s || ' ', fontSize).width
  const pad = BOUND_TEXT_PADDING * 2 + 2
  const natural = Math.max(...text.split('\n').map((l) => lineWidth(l)))
  const width = Math.min(range.maxW, Math.max(range.minW, Math.ceil(natural + pad)))
  const wrapped = wrapText(text, width - BOUND_TEXT_PADDING * 2, lineWidth)
  const m = measure(wrapped, fontSize)
  const height = Math.max(range.minH, Math.ceil(m.height + BOUND_TEXT_PADDING * 2))
  return { width, height, label: { text: wrapped, width: m.width, height: m.height } }
}

/** A centred label's top-left in a container (Excalidraw's computeBoundTextPosition, centre/middle). */
export function centredLabelAt(
  box: { x: number; y: number; width: number; height: number },
  label: { width: number; height: number },
): { x: number; y: number } {
  return { x: box.x + (box.width - label.width) / 2, y: box.y + (box.height - label.height) / 2 }
}
