import type { WorkshopVoteState } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  provideVoteResultsForExport,
  shownResults,
  viewBoxOf,
  voteBadgesSvg,
  voteResultsForExport,
  votesByShape,
  withVoteBadges,
} from './vote-export.ts'

const results = [
  { shapeId: 'shape:a', count: 5, rank: 1 },
  { shapeId: 'shape:b', count: 3, rank: 2 },
  { shapeId: 'shape:c', count: 1, rank: 4 },
]

const vote = (status: 'open' | 'closed' | 'revealed', withResults = true) =>
  ({ session: { status }, results: withResults ? results : null }) as unknown as WorkshopVoteState

describe('shownResults', () => {
  it('only a revealed vote whose badges this person shows', () => {
    expect(shownResults({ vote: vote('revealed'), showResults: true })).toEqual(results)
    expect(shownResults({ vote: vote('revealed'), showResults: false })).toBeNull()
    expect(shownResults({ vote: vote('open', false), showResults: true })).toBeNull()
    expect(shownResults({ vote: vote('closed', false), showResults: true })).toBeNull()
    expect(shownResults({ vote: null, showResults: true })).toBeNull()
  })
})

describe('the export registry', () => {
  it('reads what the editor’s provider returns, until it unregisters', () => {
    const editor = {}
    expect(voteResultsForExport(editor)).toBeNull()
    let current: typeof results | null = results
    const stop = provideVoteResultsForExport(editor, () => current)
    expect(voteResultsForExport(editor)).toEqual(results)
    current = null
    expect(voteResultsForExport(editor)).toBeNull()
    current = results
    stop()
    expect(voteResultsForExport(editor)).toBeNull()
  })
})

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="100 -50 800 600"><defs/><g/></svg>'

describe('badges in the exported SVG', () => {
  it('reads tldraw’s viewBox (page coordinates)', () => {
    expect(viewBoxOf(SVG)).toEqual({ minX: 100, minY: -50, width: 800, height: 600 })
    expect(viewBoxOf('<svg></svg>')).toBeNull()
  })

  it('draws each badge on its shape’s top-right corner, like the board: amber with the rank for the top 3', () => {
    const svg = withVoteBadges(SVG, [
      { x: 400, y: 100, rank: 1, n: 5 },
      { x: 600, y: 100, rank: 4, n: 1 },
    ])
    expect(svg.endsWith('</g></svg>')).toBe(true)
    expect(svg.startsWith(SVG.slice(0, SVG.lastIndexOf('</svg>')))).toBe(true)
    const top = /<g data-dr-vote-badge="1" transform="translate\(([\d.-]+) ([\d.-]+)\)">(.*?)<\/g>/.exec(svg)
    expect(top?.[1]).toBe('382')
    expect(top?.[2]).toBe('86')
    expect(top?.[3]).toContain('fill="#f0a53a"')
    expect(top?.[3]).toContain('>#1</tspan>')
    expect(top?.[3]).toContain('>5</tspan>')
    expect(top?.[3]).toContain('<title>5 votes, rank 1</title>')
    const rest = /<g data-dr-vote-badge="4"[^>]*>(.*?)<\/g>/.exec(svg)
    expect(rest?.[1]).toContain('fill="#1b2330"')
    expect(rest?.[1]).not.toContain('#4')
    expect(rest?.[1]).toContain('<title>1 vote, rank 4</title>')
    // Best rank last, so it is drawn on top.
    expect(svg.indexOf('data-dr-vote-badge="4"')).toBeLessThan(svg.indexOf('data-dr-vote-badge="1"'))
  })

  it('keeps a badge at the edge of the export inside it', () => {
    const layer = voteBadgesSvg([{ x: 900, y: -50, rank: 2, n: 12 }], viewBoxOf(SVG))
    const m = /translate\(([\d.-]+) ([\d.-]+)\)/.exec(layer)
    const x = Number(m?.[1])
    const y = Number(m?.[2])
    expect(y).toBe(-48)
    const w = Number(/width="([\d.]+)"/.exec(layer)?.[1]) + 2
    expect(x + w).toBeLessThanOrEqual(900 - 2 + 0.01)
  })

  it('leaves the SVG alone without badges', () => {
    expect(withVoteBadges(SVG, [])).toBe(SVG)
    expect(voteBadgesSvg([])).toBe('')
  })
})

describe('votesByShape', () => {
  it('gives each voted shape its count and every other shape an empty cell', () => {
    const cell = votesByShape(results)
    expect(cell('shape:a')).toBe('5')
    expect(cell('shape:c')).toBe('1')
    expect(cell('shape:z')).toBe('')
    expect(votesByShape(null)('shape:a')).toBe('')
  })
})
