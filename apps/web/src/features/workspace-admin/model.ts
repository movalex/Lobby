// OWNER: WS5 (wave W, the workspace admin page). What the page says about the api's rows: the tab names, an audit
// action in words, a detail key in words, a link's kind, a retention fact's source. Pure functions, tested in
// model.test.ts. An action, key or kind this build does not know is shown as it is (the api's `action` is a free
// string: a newer api may write actions this page never heard of).
import type { AdminAuditEvent, AdminLink, AdminRetentionFact, AdminTab } from '@draftroom/contracts'

export const TAB_LABELS: Readonly<Record<AdminTab, string>> = {
  members: 'Members',
  storage: 'Storage',
  audit: 'Audit log',
  links: 'Links and guests',
  retention: 'Retention',
}

/** Every audit action this page knows, in words (the api's own list: apps/api/src/audit.ts AUDIT_ACTIONS). */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'board.create': 'Made a board',
  'board.visibility': 'Changed who in the workspace can open a board',
  'board.archive': 'Archived a board',
  'board.trash': 'Moved a board to the trash',
  'board.restore': 'Restored a board',
  'board.checkpoint.delete': 'Deleted a checkpoint',
  'board.member.put': 'Gave or changed board access',
  'board.member.remove': 'Removed board access',
  'invitation.create': 'Made an invitation or link',
  'invitation.accept': 'Accepted an invitation or link',
  'invitation.revoke': 'Revoked an invitation or link',
  'invitation.extend': 'Extended a link',
  'invitation.update': 'Changed a link',
  'workspace.member.role': 'Changed a workspace role',
  'workspace.member.remove': 'Removed someone from the workspace',
  'library.item.create': 'Saved a library item',
  'library.item.delete': 'Deleted a library item',
  'library.item.restore': 'Restored a library item',
  'library.import': 'Imported a library',
  'library.folder.create': 'Made a library folder',
  'library.folder.delete': 'Deleted a library folder',
  'board.import.start': 'Started an import',
  'board.import.discard': 'An import was discarded',
  'chat_hook.create': 'Added a chat channel',
  'chat_hook.update': 'Changed a chat channel',
  'chat_hook.delete': 'Removed a chat channel',
  'asset.gc_delete': 'Deleted a file no board showed',
  'workspace.internal_only': 'Changed Internal only for the workspace',
  'project.internal_only': 'Changed Internal only for a project',
  'comment.moderate_delete': 'Deleted someone’s comment',
}

export const actionLabel = (action: string): string => ACTION_LABELS[action] ?? action

/** The filter's groups: a prefix the api matches (`board.`), or one exact action. */
export const ACTION_FILTERS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Every action' },
  { value: 'board.', label: 'Boards' },
  { value: 'board.member.', label: 'Board access' },
  { value: 'invitation.', label: 'Invitations and links' },
  { value: 'workspace.', label: 'Workspace' },
  { value: 'library.', label: 'Element library' },
  { value: 'chat_hook.', label: 'Chat channels' },
  { value: 'asset.', label: 'Files' },
  { value: 'comment.', label: 'Comments' },
]

const DETAIL_LABELS: Readonly<Record<string, string>> = {
  userId: 'Person',
  authorId: 'Author',
  boardId: 'Board',
  fromBoard: 'Copied from',
  sourceBoardId: 'From board',
  role: 'Role',
  previousRole: 'Before',
  via: 'How',
  from: 'From',
  to: 'To',
  multiUse: 'Link',
  maxUses: 'Most uses',
  allowGuests: 'Guests by name',
  landing: 'Opens',
  emailLocked: 'Locked to an address',
  joinCode: 'Join code',
  keepSharing: 'Kept sharing',
  madePrivate: 'Made private',
  outsideLeftOut: 'Outside people left out',
  files: 'Files',
  filesFenced: 'Files left behind',
  items: 'Items',
  connectors: 'Connectors',
  elements: 'Elements',
  images: 'Images',
  userIds: 'People',
  invitationsToThemRevoked: 'Invitations to them revoked',
  accessRequestsDenied: 'Requests denied',
  invitationsRevoked: 'Invitations revoked',
  boardGrantsRemoved: 'Board access removed',
  personalLibraryItemsDeleted: 'Personal library items deleted',
  linksKept: 'Links kept',
  scope: 'Library',
  created: 'Added',
  skipped: 'Left out',
  source: 'Source',
  reason: 'Why',
  provider: 'Service',
  changed: 'Fields changed',
  kind: 'Kind',
  bytes: 'Size',
  unreferencedSince: 'Unused since',
  uploadedAt: 'Uploaded',
  createdAt: 'Made',
  internalOnly: 'Internal only',
  invitee: 'Sent to them',
}

export const detailLabel = (key: string): string => DETAIL_LABELS[key] ?? key

const DATE_KEYS = new Set(['from', 'to', 'unreferencedSince', 'uploadedAt', 'createdAt'])
const ISO = /^\d{4}-\d{2}-\d{2}T/

/** One shown detail value in words: yes/no, a size, a date (in the viewer's locale), or the text itself. */
export function detailValue(
  key: string,
  value: AdminAuditEvent['detail'][string],
  fmt: { bytes(n: number): string; date(iso: string): string },
): string {
  if (value === null) return 'none'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return key === 'bytes' ? fmt.bytes(value) : value.toLocaleString('en-US')
  if (DATE_KEYS.has(key) && ISO.test(value)) return fmt.date(value)
  return value.replaceAll('_', ' ')
}

/** The detail's pairs in a stable order (the api's order), without the board the row already names. */
export function detailPairs(
  e: Pick<AdminAuditEvent, 'detail' | 'board'>,
): [key: string, value: AdminAuditEvent['detail'][string]][] {
  return Object.entries(e.detail).filter(
    ([k, v]) => !(k === 'boardId' && e.board !== null && v === e.board.title),
  )
}

export const LINK_KIND_LABELS: Readonly<Record<AdminLink['kind'], string>> = {
  review: 'Review link',
  workshop: 'Workshop link',
  landing: 'Client review page link',
  other: 'Link',
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  viewer: 'can view',
  commenter: 'can comment',
  editor: 'can edit',
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  guest: 'guest',
}
export const roleWords = (role: string): string => ROLE_WORDS[role] ?? role

export const SOURCE_LABELS: Readonly<Record<AdminRetentionFact['source'], string>> = {
  code: 'Built in',
  env: 'Set for this server',
  documented: 'As documented',
}

/** "3 of 10 uses", "3 uses", "Not used yet". */
export function usesText(uses: number, maxUses: number | null): string {
  if (maxUses !== null) return `${uses} of ${maxUses} uses`
  if (uses === 0) return 'Not used yet'
  return uses === 1 ? '1 use' : `${uses.toLocaleString('en-US')} uses`
}

/** The share of the quota used, 0..100 (a workspace can go past its quota: previews are not checked). */
export function quotaPercent(used: number, quota: number): number {
  if (!(quota > 0)) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

/**
 * A list with its next page appended (invitations, links, guests: the api pages them by cursor, newest first). A row
 * already shown is not added again, should the lists ever overlap.
 */
export function appendPage<T>(shown: readonly T[], page: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set(shown.map(key))
  return [...shown, ...page.filter((item) => !seen.has(key(item)))]
}

/** The tab a `?tab=` names, or the first. */
export function tabFromSearch(search: string, tabs: readonly AdminTab[]): AdminTab {
  const raw = new URLSearchParams(search).get('tab')
  return (tabs as readonly string[]).includes(raw ?? '') ? (raw as AdminTab) : (tabs[0] as AdminTab)
}
