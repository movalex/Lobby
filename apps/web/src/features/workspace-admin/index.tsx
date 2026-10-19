// OWNER: WS5 (wave W; docs/WAVE-W-CONTRACTS.md §7, §8.3). The 'workspace-admin' board feature: one palette command,
// 'workspace.admin' ("Workspace admin"), that opens this board's workspace admin page (/w/:wid/admin). Added by the
// wave W integration (the lead), so the frozen palette id is a live command rather than pending. Offered, as the
// workspace menu's entry (./AdminMenuEntry.tsx) is, only to the workspace's owners and admins and only while the page
// is offered (its web switch AND the api's offer); the api still answers everyone else 404. It writes nothing.
import { adminWebPath } from '@draftroom/contracts'
import type { CanvasFeature, CanvasFeatureContext, CommandSpec } from '../../canvas/api/index.ts'
import { navigate } from '../../lib/routing.ts'
import { formatsEnabled } from '../formats/flags.ts'

export const ADMIN_COMMAND_ID = 'workspace.admin'

/** Whether this person manages the board's workspace (owner or admin there; UI only: the api decides). */
export function managesWorkspace(ctx: Pick<CanvasFeatureContext, 'me' | 'workspace'>): boolean {
  const role = ctx.me.workspaces?.find((w) => w.id === ctx.workspace.id)?.role
  return role === 'owner' || role === 'admin'
}

const COMMANDS: readonly CommandSpec[] = [
  {
    id: ADMIN_COMMAND_ID,
    label: 'Workspace admin',
    group: 'Navigate',
    keywords: ['admin', 'members', 'storage', 'audit', 'links', 'retention', 'settings', 'workspace'],
    // a viewer of this board may still manage its workspace
    readOnlyAllowed: true,
    available: (ctx) => formatsEnabled('admin') && managesWorkspace(ctx),
    run: (ctx) => {
      if (formatsEnabled('admin') && managesWorkspace(ctx)) navigate(adminWebPath(ctx.workspace.id))
    },
  },
]

export const feature: CanvasFeature = {
  id: 'workspace-admin',
  commands: COMMANDS,
}
