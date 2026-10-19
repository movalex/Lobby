// Wave W (WS5): the workspace admin page in Node. The words it uses for the api's rows (model.ts), the routes it calls
// (api.ts: the seven reads, and only EXISTING routes for every change), and who sees the page at all (anyone but an
// owner or admin gets the unknown-address screen). The page in a browser, on a phone and with the keyboard, is
// e2e/excalidraw/w5-admin.spec.ts.
import { ADMIN_TABS, Me } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AdminPageView } from './AdminPage.tsx'
import { adminApi } from './api.ts'
import {
  ACTION_FILTERS,
  ACTION_LABELS,
  actionLabel,
  detailLabel,
  detailPairs,
  detailValue,
  quotaPercent,
  TAB_LABELS,
  tabFromSearch,
  usesText,
} from './model.ts'

const WS = 'wsp_0123456789abcdefghij'
const meWith = (role: 'owner' | 'admin' | 'member' | 'guest', workspaceId = WS) =>
  Me.parse({
    user: { id: 'usr_0123456789abcdefghij', name: 'Pat', handle: 'pat', color: '#000000', avatarUrl: null },
    workspaces: [{ id: workspaceId, name: 'Studio', role }],
    access: { creator: true, reason: 'domain', email: 'pat@darkburn.com' },
  })

/** A requester that records every call and answers with what the schema needs least (a test never reads it). */
function recorder() {
  const calls: { method: string; path: string; body?: unknown }[] = []
  return {
    calls,
    client: {
      request: (async (method: string, path: string, opts: { body?: unknown }) => {
        calls.push({ method, path, ...(opts.body === undefined ? {} : { body: opts.body }) })
        return undefined
      }) as never,
    },
  }
}

describe('the words of the page', () => {
  it('names every tab, and an audit action in words (an unknown one as it is)', () => {
    expect(ADMIN_TABS.map((t) => TAB_LABELS[t])).toEqual([
      'Members',
      'Storage',
      'Audit log',
      'Links and guests',
      'Retention',
    ])
    expect(actionLabel('workspace.member.role')).toBe('Changed a workspace role')
    expect(actionLabel('future.thing')).toBe('future.thing')
    expect(detailLabel('previousRole')).toBe('Before')
    expect(detailLabel('somethingNew')).toBe('somethingNew')
  })

  it('every action filter matches at least one known action', () => {
    for (const f of ACTION_FILTERS.filter((x) => x.value !== ''))
      expect(
        Object.keys(ACTION_LABELS).some((a) =>
          f.value.endsWith('.') ? a.startsWith(f.value) : a === f.value,
        ),
        f.value,
      ).toBe(true)
  })

  it('shows a detail value in words, and leaves out the board the row already names', () => {
    const fmt = { bytes: (n: number) => `${n} B`, date: (iso: string) => `on ${iso.slice(0, 10)}` }
    expect(detailValue('internalOnly', true, fmt)).toBe('yes')
    expect(detailValue('bytes', 2048, fmt)).toBe('2048 B')
    expect(detailValue('files', 12000, fmt)).toBe('12,000')
    expect(detailValue('to', '2026-10-19T10:00:00.000Z', fmt)).toBe('on 2026-10-19')
    expect(detailValue('via', 'review_link_revoked', fmt)).toBe('review link revoked')
    expect(detailValue('userId', null, fmt)).toBe('none')
    expect(
      detailPairs({ board: { id: 'b-1', title: 'Plan' }, detail: { boardId: 'Plan', role: 'viewer' } }),
    ).toEqual([['role', 'viewer']])
    expect(detailPairs({ board: null, detail: { boardId: 'Other' } })).toEqual([['boardId', 'Other']])
  })

  it('says uses, the quota share and the tab of an address', () => {
    expect(usesText(0, null)).toBe('Not used yet')
    expect(usesText(1, null)).toBe('1 use')
    expect(usesText(3, 10)).toBe('3 of 10 uses')
    expect(quotaPercent(512, 1024)).toBe(50)
    expect(quotaPercent(5000, 1024)).toBe(100)
    expect(quotaPercent(10, 0)).toBe(0)
    expect(tabFromSearch('?tab=audit', ADMIN_TABS)).toBe('audit')
    expect(tabFromSearch('?tab=nonsense', ADMIN_TABS)).toBe('members')
    expect(tabFromSearch('', ADMIN_TABS)).toBe('members')
  })
})

describe('the requests', () => {
  it('reads the seven admin routes and changes things only through the existing routes', async () => {
    const { calls, client } = recorder()
    const a = adminApi(WS, client)
    await a.members()
    await a.invitations()
    await a.storage('board')
    await a.storage('uploader')
    await a.audit({ before: 99, action: 'board.', actor: 'usr_0123456789abcdefghij', limit: 50 })
    await a.audit({})
    await a.links()
    await a.retention()
    await a.setRole('usr_x', 'admin')
    await a.removeMember('usr_x')
    await a.revokeInvitation('inv_x')
    await a.revokeLink('b-1', 'inv_y', true)
    await a.extendLink('b-1', 'inv_y')
    await a.removeFromBoard('b-1', 'usr_g')
    expect(calls).toEqual([
      { method: 'GET', path: `/api/workspaces/${WS}/admin/members` },
      { method: 'GET', path: `/api/workspaces/${WS}/admin/invitations` },
      { method: 'GET', path: `/api/workspaces/${WS}/admin/storage/by-board` },
      { method: 'GET', path: `/api/workspaces/${WS}/admin/storage/by-uploader` },
      {
        method: 'GET',
        path: `/api/workspaces/${WS}/admin/audit?before=99&action=board.&actor=usr_0123456789abcdefghij&limit=50`,
      },
      { method: 'GET', path: `/api/workspaces/${WS}/admin/audit` },
      { method: 'GET', path: `/api/workspaces/${WS}/admin/links` },
      { method: 'GET', path: `/api/workspaces/${WS}/admin/retention` },
      { method: 'PATCH', path: `/api/workspaces/${WS}/members/usr_x`, body: { role: 'admin' } },
      { method: 'DELETE', path: `/api/workspaces/${WS}/members/usr_x` },
      { method: 'DELETE', path: '/api/invitations/inv_x' },
      { method: 'POST', path: '/api/boards/b-1/review-links/inv_y/revoke', body: { removeAccess: true } },
      { method: 'POST', path: '/api/boards/b-1/review-links/inv_y/extend', body: { hours: 1 } },
      { method: 'DELETE', path: '/api/boards/b-1/members/usr_g' },
    ])
    // no admin write route exists: every change is a route the rest of Lobby already uses
    for (const c of calls) if (c.method !== 'GET') expect(c.path).not.toContain('/admin/')
  })
})

describe('who sees the page', () => {
  const render = (me: Me | null, initialTab?: (typeof ADMIN_TABS)[number]) =>
    renderToStaticMarkup(
      createElement(AdminPageView, { workspaceId: WS, me, api: adminApi(WS, recorder().client), initialTab }),
    )

  it('nobody signed in, a member, a guest, or someone of another workspace: the unknown-address screen', () => {
    for (const me of [null, meWith('member'), meWith('guest'), meWith('owner', 'wsp_another0123456789ab')]) {
      const html = render(me)
      expect(html).toContain('data-testid="workspace-admin-denied"')
      expect(html).toContain('Page not found')
      expect(html).not.toContain('Workspace admin')
    }
  })

  it('an owner or admin: five tabs in a tablist, one selected, its panel labelled by it', () => {
    for (const role of ['owner', 'admin'] as const) {
      const html = render(meWith(role))
      expect(html).toContain('data-testid="workspace-admin"')
      expect(html).toContain('role="tablist"')
      expect(html.match(/role="tab"/g)?.length).toBe(5)
      expect(html.match(/aria-selected="true"/g)?.length).toBe(1)
      expect(html).toMatch(
        /data-testid="admin-tab-members"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-testid="admin-tab-members"/,
      )
      expect(html).toContain('role="tabpanel"')
      expect(html).toContain('data-testid="admin-panel-members"')
      // only the selected tab is in the tab order
      expect(html.match(/tabindex="0"/g)?.length).toBe(1)
    }
    const retention = render(meWith('owner'), 'retention')
    expect(retention).toContain('data-tab="retention"')
    expect(retention).toContain('data-testid="admin-panel-retention"')
  })
})
