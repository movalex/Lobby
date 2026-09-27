// Board search type filters (MAK-12) over board-ops `searchBoard` hits. Pure.

import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'

export type SearchFilter = 'all' | 'notes' | 'text' | 'shapes' | 'connectors' | 'frames' | 'files' | 'images'

export const SEARCH_FILTERS: readonly { id: SearchFilter; label: string; types: readonly string[] }[] = [
  { id: 'all', label: 'All', types: [] },
  { id: 'notes', label: 'Notes', types: ['note'] },
  { id: 'text', label: 'Text', types: ['text'] },
  { id: 'shapes', label: 'Shapes', types: ['geo'] },
  { id: 'connectors', label: 'Connectors', types: ['arrow'] },
  { id: 'frames', label: 'Frames', types: ['frame'] },
  { id: 'files', label: 'Files', types: [FILE_CARD_TYPE] },
  { id: 'images', label: 'Images', types: ['image', 'video'] },
]

export function matchesFilter(type: string, filter: SearchFilter): boolean {
  if (filter === 'all') return true
  return SEARCH_FILTERS.find((f) => f.id === filter)?.types.includes(type) ?? false
}

/** Short human label for a result's type. */
export function typeLabel(type: string): string {
  switch (type) {
    case 'note':
      return 'Note'
    case 'text':
      return 'Text'
    case 'geo':
      return 'Shape'
    case 'arrow':
      return 'Connector'
    case 'frame':
      return 'Frame'
    case FILE_CARD_TYPE:
      return 'File'
    case 'image':
      return 'Image'
    case 'video':
      return 'Video'
    default:
      return 'Object'
  }
}

/** Index of the next result for Enter / Shift+Enter / arrow keys, wrapping around. */
export function stepIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta >= 0 ? 0 : count - 1
  return (((current + delta) % count) + count) % count
}

/** Splits `snippet` into plain and matched parts for <mark> highlighting (case/diacritic-insensitive). */
export function highlightParts(snippet: string, query: string): { text: string; match: boolean }[] {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))]
  if (!terms.length || !snippet) return [{ text: snippet, match: false }]
  const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  // Fold per code unit group so indexes map back to the original snippet.
  const chars = [...snippet]
  const folded = chars.map((c) => fold(c))
  const flat = folded.join('')
  const owner: number[] = []
  folded.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) owner.push(i)
  })
  const hit = new Array<boolean>(chars.length).fill(false)
  for (const term of terms.map(fold)) {
    if (!term) continue
    let at = flat.indexOf(term)
    while (at !== -1) {
      for (let k = at; k < at + term.length; k++) {
        const o = owner[k]
        if (o !== undefined) hit[o] = true
      }
      at = flat.indexOf(term, at + term.length)
    }
  }
  const parts: { text: string; match: boolean }[] = []
  chars.forEach((c, i) => {
    const m = hit[i] === true
    const last = parts[parts.length - 1]
    if (last && last.match === m) last.text += c
    else parts.push({ text: c, match: m })
  })
  return parts
}
