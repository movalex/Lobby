// OWNER: 3f. The Voting panel's export gate rule (the sharing feature's exportAllowedWith, restated).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { exportStateOf } from '../../sharing/ported/export-policy.ts'
import { exportAllowedWith, useExportAllowed } from './export-gate.ts'

describe('the vote CSV export gate', () => {
  it('closed for a viewer while the policy is unknown (wave K.1), and follows the policy by role and guest kind', () => {
    expect(exportAllowedWith(null, 'editors', true)).toBe(true)
    expect(exportAllowedWith('viewer', null, null)).toBe(false)
    expect(exportAllowedWith('editor', null, false)).toBe(true)
    expect(exportAllowedWith('viewer', 'everyone', null)).toBe(true)
    expect(exportAllowedWith('viewer', 'editors', null)).toBe(false)
    expect(exportAllowedWith('commenter', 'editors', false)).toBe(false)
    expect(exportAllowedWith('editor', 'editors', false)).toBe(true)
    expect(exportAllowedWith('editor', 'editors', true)).toBe(false) // a name-only guest is limited
    expect(exportAllowedWith('owner', 'editors', null)).toBe(true)
    expect(exportAllowedWith('editor', 'everyone', true)).toBe(false) // under 'everyone' too (audit L3)
    expect(exportAllowedWith('editor', 'everyone-including-guests', true)).toBe(true) // the owner's explicit choice
  })
})

describe('the gate reads the shared export-policy store (K3-6, K1-4)', () => {
  const Probe = ({ boardId }: { boardId: string }) =>
    String(useExportAllowed({ board: { id: boardId } as never }))
  const render = (boardId: string) => renderToStaticMarkup(createElement(Probe, { boardId }))

  it('follows what the sharing feature stored for the board, and asks the api nothing itself', () => {
    const id = 'b-k3gate00001'
    // nothing known yet: closed (wave K.1: before the first answer only the owner and editors)
    expect(render(id)).toBe('false')
    const s = exportStateOf(id)
    s.role.set('viewer')
    s.guest.set(false)
    s.policy.set('editors')
    expect(render(id)).toBe('false')
    s.role.set('editor')
    expect(render(id)).toBe('true')
    s.guest.set(true) // a name-only guest editor is limited under 'editors'
    expect(render(id)).toBe('false')
    // another board has its own entry (nothing known there: closed)
    expect(render('b-k3gate00002')).toBe('false')
  })
})
