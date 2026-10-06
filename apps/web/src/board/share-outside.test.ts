// Wave J: what the Share dialog asks and says about people outside Dark Burn / TPG (share-model.ts).
import { describe, expect, it } from 'vitest'
import { wsMember } from '../api/test-fixtures.ts'
import {
  asksBeforeGiving,
  internalOnlyNote,
  outsideConfirmFor,
  outsideWho,
  pickerOptionText,
  raisesAccess,
} from './share-model.ts'

describe('the one-time confirm', () => {
  it('asks for outside and unconfirmed accounts only (never for creators or an older api)', () => {
    expect(asksBeforeGiving(true)).toBe(true)
    expect(asksBeforeGiving('unconfirmed')).toBe(true)
    expect(asksBeforeGiving(false)).toBe(false)
    expect(asksBeforeGiving(undefined)).toBe(false)
  })

  it('says the owner’s sentence, naming the account with its masked address', () => {
    expect(outsideWho('Pat Client', 'p•••@client.example')).toBe('Pat Client (p•••@client.example)')
    expect(outsideWho('Pat Client', null)).toBe('Pat Client')
    expect(outsideConfirmFor('x@client.example', true)).toBe(
      'x@client.example is outside Dark Burn and Trailer Park Group. They will only see this board.',
    )
    expect(outsideConfirmFor('Erin', 'unconfirmed')).toMatch(
      /^Lobby couldn’t confirm whether Erin is at Dark Burn/,
    )
  })

  it('asks before a new or higher grant, never before lowering or keeping one', () => {
    expect(raisesAccess(null, 'viewer')).toBe(true)
    expect(raisesAccess('viewer', 'editor')).toBe(true)
    expect(raisesAccess('editor', 'editor')).toBe(false)
    expect(raisesAccess('editor', 'commenter')).toBe(false)
    expect(raisesAccess('owner', 'editor')).toBe(false)
  })
})

describe('the picker and the internal-only note', () => {
  it('an outside account says so in the "pick someone" option text', () => {
    const outside = { ...wsMember('pat', 'guest'), outside: true as const, emailDomain: 'client.example' }
    expect(pickerOptionText(outside)).toBe('Pat (@pat) · External · client.example')
    expect(pickerOptionText({ ...outside, emailDomain: null })).toBe('Pat (@pat) · External')
    expect(pickerOptionText(wsMember('ann', 'member'))).toBe('Ann (@ann)')
    expect(pickerOptionText({ ...wsMember('ann', 'member'), outside: 'unconfirmed' })).toBe('Ann (@ann)')
  })

  it('names the scope', () => {
    expect(internalOnlyNote('workspace')).toMatch(/^This workspace is internal only/)
    expect(internalOnlyNote('project')).toMatch(/project is internal only/)
  })
})
