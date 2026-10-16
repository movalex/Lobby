// A copy of an assigned card (Ctrl+D, Alt-drag, paste, the storyboard's duplicate) made by a name-only guest drops
// its assignee: a guest never assigns, and the room would strip it anyway (an ack fix). Anyone else's copy keeps it
// (the room keeps it only when that person has access to the board).
import { describe, expect, it } from 'vitest'
import { duplicateLobbyData } from '../../canvas/board/tx.ts'
import { cardWhoOnCopy } from './write.ts'

const LOBBY = { 'card:status': 'doing', 'card:who': 'usr_ann', 'card:due': '2026-10-30' }

describe('a copy of an assigned card', () => {
  it('made by a guest: no assignee; made by an account: the assignee kept', () => {
    let guest = true
    const handlers = [cardWhoOnCopy(() => guest)]
    expect(duplicateLobbyData(LOBBY, new Map(), handlers)).toEqual({
      'card:status': 'doing',
      'card:due': '2026-10-30',
    })
    guest = false
    expect(duplicateLobbyData(LOBBY, new Map(), handlers)).toEqual(LOBBY)
  })
})
