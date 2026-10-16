// Wave R (WS4): the board menu's "Download backup (.lobby)" line, in the Export group after "Export as PDF…": a menu
// action of its own (no palette command), shown to read-only roles too (viewers export; the board's policy decides),
// hidden from a name-only guest and whenever exporting is off for this person.
import { describe, expect, it } from 'vitest'
import { feature } from './index.tsx'

describe('the board menu’s backup line', () => {
  it('is in the Export group after Export as PDF…, with its own action', () => {
    const menu = feature.mainMenu ?? []
    const line = menu.find((e) => e.id === 'backup')
    expect(line).toMatchObject({ group: 'export', label: 'Download backup (.lobby)' })
    expect(line?.command).toBeUndefined()
    expect(typeof line?.run).toBe('function')
    const pdf = menu.find((e) => e.id === 'print')
    expect((line?.order ?? 0) > (pdf?.order ?? 0)).toBe(true)
    expect(typeof line?.visible).toBe('function')
  })
})
