// Wave W (WS5): the workspace menu's entry to the admin page. Shown to owners and admins only, and only while the page
// is offered (its web switch AND the api's offer: features/formats/flags.ts formatsEnabled, stubbed here; its own
// tests are wave-w-stubs.test.ts). The shipped web switch is on (the integration); with the api's offer off the menu is
// exactly as before.
import type { WorkspaceSummary } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceMenu } from '../../dashboard/WorkspaceMenu.tsx'
import { FORMATS_FLAGS } from '../formats/flags.ts'

const offer = vi.hoisted(() => ({ admin: false }))
vi.mock('../formats/flags.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../formats/flags.ts')>()
  return { ...real, formatsEnabled: (flag: string) => flag === 'admin' && offer.admin }
})

const ws = (role: WorkspaceSummary['role']): WorkspaceSummary => ({
  id: 'wsp_0123456789abcdefghij',
  name: 'Studio',
  role,
})
const internal = {
  settings: null,
  error: null,
  setWorkspace: async () => {},
  setProject: async () => {},
  reload: () => {},
}
const menu = (role: WorkspaceSummary['role']) =>
  renderToStaticMarkup(
    createElement(WorkspaceMenu, {
      workspace: ws(role),
      workspaces: [ws(role)],
      projects: [],
      internal,
      defaultOpen: true,
    }),
  )

describe('the admin entry of the workspace menu', () => {
  it('is not there while the page is not offered (the api says off), whatever the role', () => {
    // the shipped web switch is on since the wave W integration: the api's offer decides
    expect(FORMATS_FLAGS.admin).toBe(true)
    offer.admin = false
    for (const role of ['owner', 'admin', 'member', 'guest'] as const)
      expect(menu(role), role).not.toContain('workspace-admin-link')
  })

  it('offered: owners and admins see it; members and guests never do', () => {
    offer.admin = true
    for (const role of ['owner', 'admin'] as const) {
      const html = menu(role)
      expect(html, role).toContain('data-testid="workspace-admin-link"')
      expect(html, role).toContain('Workspace admin')
    }
    for (const role of ['member', 'guest'] as const)
      expect(menu(role), role).not.toContain('workspace-admin-link')
    offer.admin = false
  })
})
