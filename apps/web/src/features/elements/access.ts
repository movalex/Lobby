// OWNER: WS3 (wave Q). Who sees what of the Elements panel, from what the board page knows (docs/WAVE-Q-CONTRACTS.md
// §2.2). UI hints only: the api decides every library read and write again, and the room every insert.
//  - the panel: people who can edit the board (index.tsx; viewers, commenters and archived boards get none);
//  - built-in icons and shapes: everyone with the panel, name-only guests included (static, client-side);
//  - the Library tab, favourites and the save entries: a workspace owner, admin or member with an account (never a
//    name-only guest, a workspace guest or a board-only collaborator), while the api has the library;
//  - saving to the workspace library: a creator among them (an outsider saves to their personal library only).
import type { MeAccess } from '@draftroom/contracts'
import type { WorkspaceRole } from '@draftroom/permissions'

export interface AccessFacts {
  /** a name-only guest (invite/guest.tsx knownUserKind) */
  readonly nameOnlyGuest: boolean
  /** the caller's role in the board's workspace (Me.workspaces), null when they have none */
  readonly workspaceRole: WorkspaceRole | null
  readonly access: Pick<MeAccess, 'creator'>
  /** the api has the library for this workspace (client.ts libraryAvailable) */
  readonly libraryOnApi: boolean
}

export interface ElementsAccess {
  /** the Library tab, favourites and "Save to library" */
  readonly library: boolean
  /** may save, import and make folders in the workspace scope */
  readonly workspaceSave: boolean
  /** why not, in words the dialog shows (null when they may) */
  readonly workspaceSaveReason: string | null
}

const MEMBER_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'member']

export function elementsAccess(f: AccessFacts): ElementsAccess {
  const library =
    !f.nameOnlyGuest && f.libraryOnApi && f.workspaceRole !== null && MEMBER_ROLES.includes(f.workspaceRole)
  if (!library) return { library, workspaceSave: false, workspaceSaveReason: null }
  if (!f.access.creator)
    return {
      library,
      workspaceSave: false,
      workspaceSaveReason:
        'Saving to the workspace library needs a work address. You can save to your own library.',
    }
  return { library, workspaceSave: true, workspaceSaveReason: null }
}
