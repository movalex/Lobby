// Wave W (the review's nit 8): the invitations, links and guests lists go on past 100. The api pages them by cursor
// (contracts AdminCursor); the page asks for the next page with "Load more" and appends it, a row it already shows
// never twice. In Node: the requests (api.ts), the append (model.ts appendPage) and the lists as rendered before and
// after the second page. The click in a browser is e2e/excalidraw/w5-admin.spec.ts.
import type { AdminGuest, AdminInvitation, AdminLink } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { adminApi } from './api.ts'
import { GuestList, LinkList } from './LinksTab.tsx'
import { InvitationList } from './MembersTab.tsx'
import { appendPage } from './model.ts'

const WS = 'wsp_0123456789abcdefghij'
const id = (prefix: string, n: number) => `${prefix}_page${String(n).padStart(8, '0')}`
const CURSOR = '1792400000123456.inv_page00000100'

const invitation = (n: number): AdminInvitation => ({
  id: id('inv', n),
  scope: 'workspace',
  board: null,
  role: 'member',
  emailHint: 'p•••@client.example',
  invitedBy: null,
  createdAt: '2026-10-19T10:00:00.000Z',
  expiresAt: '2026-10-26T10:00:00.000Z',
})
const link = (n: number): AdminLink => ({
  id: id('inv', n),
  board: { id: 'b-0123456789', title: 'Launch' },
  kind: 'review',
  role: 'viewer',
  allowGuests: true,
  hasJoinCode: false,
  createdBy: null,
  createdAt: '2026-10-19T10:00:00.000Z',
  expiresAt: '2026-10-26T10:00:00.000Z',
  uses: 0,
  maxUses: null,
})
const guest = (n: number): AdminGuest => ({
  user: { id: id('usr', n), name: `G${n} (guest)` },
  grants: 1,
  boards: [{ id: 'b-0123456789', title: 'Launch' }],
  joinedAt: '2026-10-19T10:00:00.000Z',
})
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

function recorder() {
  const calls: string[] = []
  return {
    calls,
    client: {
      request: (async (_method: string, path: string) => {
        calls.push(path)
        return undefined
      }) as never,
    },
  }
}

const more = (next: string | null) => ({ next, busy: false, error: null, loadMore: () => undefined })

describe('the lists page on past 100', () => {
  it('asks for the page after a cursor: invitations by before, links and guests each by their own', async () => {
    const { calls, client } = recorder()
    const a = adminApi(WS, client)
    await a.invitations()
    await a.invitations({ before: CURSOR })
    await a.links()
    await a.links({ linksBefore: CURSOR })
    await a.links({ guestsBefore: '1792400000123456.usr_page00000100' })
    expect(calls).toEqual([
      `/api/workspaces/${WS}/admin/invitations`,
      `/api/workspaces/${WS}/admin/invitations?before=1792400000123456.inv_page00000100`,
      `/api/workspaces/${WS}/admin/links`,
      `/api/workspaces/${WS}/admin/links?linksBefore=1792400000123456.inv_page00000100`,
      `/api/workspaces/${WS}/admin/links?guestsBefore=1792400000123456.usr_page00000100`,
    ])
  })

  it('appends the next page in order, and a row it already shows never twice', () => {
    const key = (i: AdminInvitation) => i.id
    const shown = appendPage(range(1, 100).map(invitation), range(100, 150).map(invitation), key)
    expect(shown.map(key)).toEqual(range(1, 150).map((n) => id('inv', n)))
  })

  it('invitations: 100 and Load more; after it, the 101st is on the page and Load more is gone', () => {
    const api = adminApi(WS, recorder().client)
    const render = (items: AdminInvitation[], next: string | null) =>
      renderToStaticMarkup(
        createElement(InvitationList, { invitations: items, api, onChanged() {}, more: more(next) }),
      )
    const first = range(1, 100).map(invitation)
    const before = render(first, CURSOR)
    expect(before.match(/data-testid="admin-invitation"/g)?.length).toBe(100)
    expect(before).not.toContain(id('inv', 101))
    expect(before).toContain('data-testid="admin-invitations-more"')
    const after = render(
      appendPage(first, range(101, 150).map(invitation), (i) => i.id),
      null,
    )
    expect(after.match(/data-testid="admin-invitation"/g)?.length).toBe(150)
    expect(after).toContain(`data-invitation-id="${id('inv', 101)}"`)
    expect(after).not.toContain('data-testid="admin-invitations-more"')
  })

  it('links and guests: each its own Load more; after it, the 101st link and the 101st guest are there to revoke or remove', () => {
    const api = adminApi(WS, recorder().client)
    const viewer = { id: 'usr_0123456789abcdefghij', role: 'owner' as const, creator: true }
    const links = (items: AdminLink[], next: string | null) =>
      renderToStaticMarkup(
        createElement(LinkList, { links: items, api, viewer, onChanged() {}, more: more(next) }),
      )
    const guests = (items: AdminGuest[], next: string | null) =>
      renderToStaticMarkup(createElement(GuestList, { guests: items, api, onChanged() {}, more: more(next) }))
    const firstLinks = range(1, 100).map(link)
    expect(links(firstLinks, CURSOR)).toContain('data-testid="admin-links-more"')
    const allLinks = links(
      appendPage(firstLinks, range(101, 150).map(link), (l) => l.id),
      null,
    )
    expect(allLinks.match(/data-testid="admin-link"/g)?.length).toBe(150)
    expect(allLinks).toMatch(
      new RegExp(`data-link-id="${id('inv', 101)}"[\\s\\S]*?data-testid="admin-link-revoke"`),
    )
    expect(allLinks).not.toContain('data-testid="admin-links-more"')
    const firstGuests = range(1, 100).map(guest)
    expect(guests(firstGuests, CURSOR)).toContain('data-testid="admin-guests-more"')
    const allGuests = guests(
      appendPage(firstGuests, range(101, 150).map(guest), (g) => g.user.id),
      null,
    )
    expect(allGuests.match(/data-testid="admin-guest"/g)?.length).toBe(150)
    expect(allGuests).toContain(`data-user-id="${id('usr', 101)}"`)
    expect(allGuests).not.toContain('data-testid="admin-guests-more"')
  })
})
