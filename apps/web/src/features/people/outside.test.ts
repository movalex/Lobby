// Wave J: the board's outside list as the page uses it (cursor labels, the people list, the @mention
// picker, the "Shared outside" marker), and the words of the tags. Pure: the store gets a fake fetcher.
import type { BoardOutsidePeople } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  cursorExternalSuffix,
  externalTagText,
  externalTagTitle,
  isGuestName,
  OutsideStore,
  outsiderJoinedText,
  outsideTag,
  UNKNOWN_REFETCH_MS,
} from './outside.ts'

function fakeFetcher(answers: BoardOutsidePeople[]) {
  const calls: string[] = []
  const fetcher = async (boardId: string) => {
    calls.push(boardId)
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (!next) throw new Error('no answer')
    return next
  }
  return { fetcher, calls }
}

const answer = (
  people: { userId: string; emailDomain: string | null }[],
  sharedOutside = people.length > 0,
) => ({
  sharedOutside,
  internalOnly: null,
  people,
})

describe('OutsideStore', () => {
  it('knows who is outside after its first answer, and tells its listeners', async () => {
    const { fetcher } = fakeFetcher([answer([{ userId: 'usr_pat', emailDomain: 'client.example' }])])
    const store = new OutsideStore('b-1', { fetcher })
    let told = 0
    store.subscribe(() => told++)
    expect(store.getSnapshot().loaded).toBe(false)
    await store.refresh()
    expect(told).toBe(1)
    const snap = store.getSnapshot()
    expect(snap).toMatchObject({ loaded: true, sharedOutside: true })
    expect(store.isExternal('usr_pat')).toBe(true)
    expect(store.domainOf('usr_pat')).toBe('client.example')
    expect(store.isExternal('usr_ann')).toBe(false)
  })

  it('a newcomer makes it fetch again, at most once every 10 s; known people never do', async () => {
    let t = 0
    const { fetcher, calls } = fakeFetcher([
      answer([]),
      answer([{ userId: 'usr_pat', emailDomain: null }]),
      answer([{ userId: 'usr_pat', emailDomain: null }]),
    ])
    const store = new OutsideStore('b-1', { fetcher, now: () => t })
    store.noticeUsers(['usr_x']) // before the first answer: nothing
    expect(calls).toHaveLength(0)
    await store.refresh()
    store.noticeUsers(['usr_pat'])
    await Promise.resolve()
    expect(calls).toHaveLength(2)
    expect(store.isExternal('usr_pat')).toBe(true)
    // someone already seen, again: nothing
    store.noticeUsers(['usr_pat'])
    // a second newcomer inside the window: no fetch yet
    t += UNKNOWN_REFETCH_MS - 1
    store.noticeUsers(['usr_quinn'])
    expect(calls).toHaveLength(2)
    t += 2
    store.noticeUsers(['usr_rex'])
    expect(calls).toHaveLength(3)
  })

  it('a failed fetch keeps the last answer', async () => {
    let fail = false
    const store = new OutsideStore('b-1', {
      fetcher: async () => {
        if (fail) throw new Error('down')
        return answer([{ userId: 'usr_pat', emailDomain: null }])
      },
    })
    await store.refresh()
    fail = true
    await store.refresh()
    expect(store.isExternal('usr_pat')).toBe(true)
  })
})

describe('the words', () => {
  it('External, with the domain where the viewer may see it; never for name-only guests', () => {
    expect(externalTagText(null)).toBe('External')
    expect(externalTagText('client.example')).toBe('External · client.example')
    expect(externalTagTitle('client.example')).toBe(
      'Outside Dark Burn and Trailer Park Group (client.example)',
    )
    const snap = {
      loaded: true,
      sharedOutside: true,
      internalOnly: null,
      people: new Map([['usr_pat', null]]),
    }
    expect(cursorExternalSuffix(snap, 'usr_pat', false)).toBe(' · External')
    expect(cursorExternalSuffix(snap, 'usr_pat', true)).toBeNull()
    expect(cursorExternalSuffix(snap, 'usr_ann', false)).toBeNull()
    expect(isGuestName('Dana (guest)')).toBe(true)
  })

  it('manager tags: External, Not confirmed, or nothing (creators, an older api, guests)', () => {
    expect(outsideTag(true, 'client.example')).toMatchObject({
      kind: 'external',
      text: 'External · client.example',
    })
    expect(outsideTag('unconfirmed', 'darkburn.com')).toMatchObject({
      kind: 'unconfirmed',
      text: 'Not confirmed',
    })
    expect(outsideTag(false, 'darkburn.com')).toBeNull()
    expect(outsideTag(undefined, null)).toBeNull()
    expect(outsideTag(true, null, true)).toBeNull()
  })

  it('the bell line of an outsider notice', () => {
    expect(outsiderJoinedText({ boardTitle: 'Launch' }, false)).toBe('opened Launch for the first time')
    expect(outsiderJoinedText({ boardTitle: 'Launch' }, true)).toBe('opened this board for the first time')
  })
})
