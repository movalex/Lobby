// OWNER: WS5 (wave W). The workspace menu's way to the admin page (dashboard/WorkspaceMenu.tsx, one entry): shown to
// the workspace's owners and admins only, and only while the page is offered (its web switch AND the api's offer,
// features/formats/flags.ts). The api still answers everyone else 404.
import { adminWebPath } from '@draftroom/contracts'
import { navigate } from '../../lib/routing.ts'
import { useValue } from '../../lib/signals.ts'
import { formatsEnabled, formatsOffer } from '../formats/flags.ts'

type Role = 'owner' | 'admin' | 'member' | 'guest'

/** Whether the entry shows for this role here (a signal: the offer arrives with the session's config). */
export function useAdminEntryShown(role: Role): boolean {
  const offer = useValue(formatsOffer)
  return (role === 'owner' || role === 'admin') && formatsEnabled('admin', undefined, offer)
}

export function AdminMenuEntry({ workspaceId, onOpen }: { workspaceId: string; onOpen(): void }) {
  const to = adminWebPath(workspaceId)
  return (
    <div className="dr-wsmenu__section" data-testid="workspace-menu-admin">
      <button
        type="button"
        className="dr-wsmenu__item"
        data-testid="workspace-admin-link"
        onClick={() => {
          onOpen()
          navigate(to)
        }}
      >
        <span className="dr-wsmenu__name">Workspace admin</span>
        <span className="dr-wsmenu__role">Members, storage, audit</span>
      </button>
    </div>
  )
}
