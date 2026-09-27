// The single place the web client imports the shared permission rules from.
//
// The client only uses these to decide what UI to show. The API and sync server enforce them.
export {
  BOARD_ROLES,
  BOARD_VISIBILITIES,
  type BoardAction,
  type BoardRole,
  type BoardStatus,
  type BoardVisibility,
  can,
  canCreateInWorkspace,
  canManageWorkspace,
  roleAtLeast,
  type WorkspaceRole,
} from '@draftroom/permissions'
