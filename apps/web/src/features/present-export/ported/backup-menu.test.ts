// Wave R (WS4): the board menu's "Download backup (.lobby)" line, in the Export group after "Export as PDF…": it runs
// present-export.backup, which a read-only role may run (viewers export too; the board's policy decides), and is
// hidden from a name-only guest and whenever exporting is off for this person.
import { describe, expect, it } from 'vitest'
import { feature } from './index.tsx'

describe('the board menu’s backup line', () => {
  it('is in the Export group after Export as PDF…, and its command may run read-only', () => {
    const menu = feature.mainMenu ?? []
    const line = menu.find((e) => e.id === 'backup')
    expect(line).toMatchObject({
      group: 'export',
      label: 'Download backup (.lobby)',
      command: 'present-export.backup',
    })
    const pdf = menu.find((e) => e.id === 'print')
    expect((line?.order ?? 0) > (pdf?.order ?? 0)).toBe(true)
    expect(typeof line?.visible).toBe('function')
    const command = (feature.commands ?? []).find((c) => c.id === 'present-export.backup')
    expect(command).toMatchObject({ label: 'Download backup (.lobby)', readOnlyAllowed: true })
    expect(command?.kbd).toBeUndefined()
  })
})
