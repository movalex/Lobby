// K5-5: the Share dialog's "Invite people" field, rendered to markup (Node + react-dom/server; the real
// browser behaviour, typing, the keys and picking, is e2e/excalidraw/k5-share.spec.ts):
//  - the hint under the field is one line, said once (it used to say "No one matches" twice);
//  - the suggestions are a real listbox (role=listbox / option, aria-activedescendant on the combobox field),
//    not a datalist;
//  - the keys: ArrowDown / ArrowUp move (wrapping), Enter picks, Escape closes the list (and only the list),
//    Tab leaves.
import type { BoardMember, WorkspaceMember } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { makeUser, member, wsMember } from '../../api/test-fixtures.ts'
import { InvitePeople } from '../../board/ShareDialog.tsx'
import { ASK_EMAIL_PROMPT, INVITE_IDLE_HINT, OWN_ADDRESS_MESSAGE } from '../../board/share-model.ts'
import { CLOSED, InviteInput, optionId, SuggestionList, suggestionKey } from './InviteField.tsx'

const carolS: WorkspaceMember = {
  user: makeUser('carols', { name: 'Carol Smith', handle: null }),
  role: 'member',
}
const WS: WorkspaceMember[] = [wsMember('bob', 'member'), wsMember('carol', 'member'), carolS]
const BOARD: BoardMember[] = [member('alice', 'owner', 'grant'), member('carol', 'viewer', 'grant')]

const render = (text: string, over: Partial<Parameters<typeof InvitePeople>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(InvitePeople, {
      boardId: 'b-abc1234567',
      workspaceName: 'Dev Studio',
      workspaceMembers: WS,
      boardMembers: BOARD,
      addable: [],
      canEmail: false,
      ownEmail: 'alice@dev.invalid',
      onGrant: async () => true,
      onLinkCreated: () => {},
      initialText: text,
      ...over,
    }),
  )

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('the invite field', () => {
  it('a prefix of a handle: one hint naming the person, and the listbox with them in it', () => {
    const html = render('@bo')
    expect(count(html, 'Pick Bob (@bob) from the list.')).toBe(1)
    expect(count(html, 'data-testid="share-invite-hint"')).toBe(1)
    expect(html).not.toContain('No one in')
    // a combobox field, its list open, the keyboard on the first option
    expect(html).toMatch(/<input[^>]*role="combobox"[^>]*aria-expanded="true"/)
    expect(html).toMatch(/<input[^>]*aria-autocomplete="list"/)
    const list = html.match(/<div id="([^"]+)" role="listbox"[^>]*data-testid="share-invite-suggestions"/)
    expect(list).not.toBeNull()
    const listId = list?.[1] ?? ''
    expect(html).toContain(`aria-controls="${listId}"`)
    expect(html).toContain(`aria-activedescendant="${optionId(listId, 0)}"`)
    expect(count(html, 'role="option"')).toBe(1)
    expect(html).toMatch(/role="option"[^>]*aria-selected="true"[^>]*data-testid="share-invite-suggestion"/)
    // never a datalist any more
    expect(html).not.toContain('<datalist')
    expect(html).not.toMatch(/<input[^>]*\blist="/)
  })

  it('a name prefix lists everyone it starts; someone already on the board says so', () => {
    const html = render('car')
    expect(count(html, 'role="option"')).toBe(2)
    expect(count(html, '2 people in Dev Studio match. Pick one from the list.')).toBe(1)
    // the people without a grant first: Carol Smith, then carol (a viewer already)
    expect(html.indexOf('Carol Smith')).toBeLessThan(html.indexOf('@carol'))
    expect(html).toContain('@carol · has access')
  })

  it('nothing it starts: the one line asking for their address, and no list', () => {
    const html = render('Someone New')
    expect(count(html, `No one in Dev Studio matches. ${ASK_EMAIL_PROMPT}`)).toBe(1)
    expect(count(html, ASK_EMAIL_PROMPT)).toBe(1)
    expect(html).not.toContain('role="listbox"')
    expect(html).toMatch(/<input[^>]*aria-expanded="false"/)
  })

  it('an exact handle: the grant line, no list', () => {
    const html = render('@bob')
    expect(count(html, 'Bob is in Dev Studio: they get access right away.')).toBe(1)
    expect(html).not.toContain('role="listbox"')
  })

  it('the inviter’s own address: said once, while typing', () => {
    const html = render('alice@dev.invalid')
    expect(count(html, OWN_ADDRESS_MESSAGE)).toBe(1)
    expect(count(html, 'data-testid="share-invite-hint"')).toBe(1)
  })

  it('empty: the usual line, no list, the hint tied to the field', () => {
    const html = render('')
    expect(count(html, INVITE_IDLE_HINT)).toBe(1)
    const hintId = html.match(/<p id="([^"]+)"[^>]*data-testid="share-invite-hint"/)?.[1]
    expect(hintId).toBeTruthy()
    expect(html).toContain(`aria-describedby="${hintId}"`)
  })
})

describe('P-022: one field, no second row to pick someone from the workspace', () => {
  const bob = WS[0] as WorkspaceMember
  it('has no "Or pick someone" select, with people to add or without', () => {
    for (const html of [render(''), render('', { addable: [bob] })]) {
      expect(html).not.toContain('share-add-member')
      expect(html).not.toContain('Or pick someone')
      expect(html).not.toContain('share-add-submit')
      // one role select, one Invite button
      expect(count(html, '<select')).toBe(1)
      expect(count(html, 'data-testid="share-invite-submit"')).toBe(1)
    }
  })

  it('an empty field with people who can be added lists them when it is opened (a click), and not before', () => {
    const closed = render('', { addable: [bob] })
    expect(closed).toMatch(/<input[^>]*aria-expanded="false"/)
    expect(closed).not.toContain('role="listbox"')
    const open = render('', { addable: [bob], initialOpen: true })
    expect(open).toMatch(/<input[^>]*aria-expanded="true"/)
    expect(count(open, 'role="option"')).toBe(1)
    expect(open).toContain(`data-user-id="${bob.user.id}"`)
    // nobody to add: nothing to open
    expect(render('', { addable: [], initialOpen: true })).not.toContain('role="listbox"')
  })
})

describe('SuggestionList and InviteInput markup', () => {
  it('options carry the person and the active one is marked; a closed list renders nothing', () => {
    const open = renderToStaticMarkup(
      createElement(SuggestionList, {
        id: 'L',
        members: WS,
        state: { open: true, active: 2 },
        hasAccess: (id: string) => id === WS[1]?.user.id,
        onPick: () => {},
        onHover: () => {},
      }),
    )
    expect(count(open, 'role="option"')).toBe(3)
    expect(open).toContain(`id="${optionId('L', 2)}"`)
    expect(count(open, 'aria-selected="true"')).toBe(1)
    expect(open).toMatch(/aria-selected="true"[^>]*data-user-id="usr_carols/)
    expect(
      renderToStaticMarkup(
        createElement(SuggestionList, {
          id: 'L',
          members: WS,
          state: CLOSED,
          hasAccess: () => false,
          onPick: () => {},
          onHover: () => {},
        }),
      ),
    ).toBe('')
  })

  it('the field points at the active option only while the list is open and has options', () => {
    const field = (state: { open: boolean; active: number }, n: number) =>
      renderToStaticMarkup(
        createElement(InviteInput, {
          id: 'I',
          listId: 'L',
          hintId: 'H',
          value: 'ca',
          state,
          count: n,
          onChange: () => {},
          onKey: () => {},
          onBlur: () => {},
        }),
      )
    expect(field({ open: true, active: 1 }, 2)).toContain(`aria-activedescendant="${optionId('L', 1)}"`)
    expect(field({ open: true, active: 1 }, 0)).not.toContain('aria-activedescendant')
    expect(field(CLOSED, 2)).not.toContain('aria-activedescendant')
    expect(field(CLOSED, 2)).toContain('aria-expanded="false"')
  })
})

describe('suggestionKey: arrow keys, Enter to pick, Escape to close', () => {
  it('ArrowDown opens on the first option, then moves down and wraps', () => {
    let r = suggestionKey(CLOSED, 'ArrowDown', 3)
    expect(r).toEqual({ state: { open: true, active: 0 }, pick: null, handled: true })
    r = suggestionKey(r.state, 'ArrowDown', 3)
    expect(r.state.active).toBe(1)
    r = suggestionKey({ open: true, active: 2 }, 'ArrowDown', 3)
    expect(r.state.active).toBe(0)
  })

  it('ArrowUp moves up and wraps; from closed it opens on the last', () => {
    expect(suggestionKey({ open: true, active: 0 }, 'ArrowUp', 3).state.active).toBe(2)
    expect(suggestionKey({ open: true, active: 2 }, 'ArrowUp', 3).state.active).toBe(1)
    expect(suggestionKey(CLOSED, 'ArrowUp', 3).state).toEqual({ open: true, active: 2 })
  })

  it('Enter picks the active option and closes the list (the form is not submitted)', () => {
    expect(suggestionKey({ open: true, active: 1 }, 'Enter', 3)).toEqual({
      state: CLOSED,
      pick: 1,
      handled: true,
    })
    // a list that shrank under the keyboard: the last option
    expect(suggestionKey({ open: true, active: 5 }, 'Enter', 2).pick).toBe(1)
    // closed: Enter is the form's (Invite)
    expect(suggestionKey(CLOSED, 'Enter', 3)).toMatchObject({ pick: null, handled: false })
  })

  it('Escape closes an open list and is handled (the dialog stays); a closed list lets the dialog have it', () => {
    expect(suggestionKey({ open: true, active: 1 }, 'Escape', 3)).toEqual({
      state: { open: false, active: 1 },
      pick: null,
      handled: true,
    })
    expect(suggestionKey(CLOSED, 'Escape', 3).handled).toBe(false)
  })

  it('Tab closes without taking the key; other keys and an empty list change nothing', () => {
    expect(suggestionKey({ open: true, active: 1 }, 'Tab', 3)).toMatchObject({
      state: { open: false },
      handled: false,
    })
    expect(suggestionKey({ open: true, active: 1 }, 'a', 3)).toMatchObject({ handled: false, pick: null })
    expect(suggestionKey({ open: true, active: 1 }, 'ArrowDown', 0)).toEqual({
      state: CLOSED,
      pick: null,
      handled: false,
    })
  })
})
