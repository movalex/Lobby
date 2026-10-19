// OWNER: WS5 (wave W, the workspace admin page; docs/WAVE-W-CONTRACTS.md §7 W5-3). What the audit log viewer shows of
// each row's `detail`: only the keys its action's entry names, each of one kind, and only a value that passes that
// kind's check. Never the raw jsonb: an entry is an allowlist, so a field a writer adds later stays hidden until
// someone decides it may be shown here.
//
// What is never shown, whatever a writer stored: a token, a URL (a link's, a signed one, a webhook's), an email
// address or domain, a file's or a checkpoint's name, a link id list, the counts of an import's unknown keys. The
// kinds below cannot carry them: `word` is a short lowercase word (a role, a `via`, a provider), `id` is a Lobby id
// with its prefix, `date` an ISO time, `user` and `board` are replaced by the person's name or the board's title (as
// the admin sees them elsewhere: admins are owners of every board of their workspace), `count` is an array's length.
//
// Every AuditAction has an entry (a type error otherwise, and test/features/workspace-admin/audit-view.test.ts).

import type { AuditAction } from '../../audit.ts'

export type DetailKind = 'word' | 'number' | 'boolean' | 'date' | 'id' | 'user' | 'board' | 'count'

/** One action's allowlist: detail key → how it is shown. */
export type AuditViewEntry = Readonly<Record<string, DetailKind>>

const MEMBER_CHANGE: AuditViewEntry = {
  userId: 'user',
  role: 'word',
  previousRole: 'word',
  via: 'word',
  requestId: 'id',
  invitationId: 'id',
  userIds: 'count',
  invitationsToThemRevoked: 'number',
  accessRequestsDenied: 'number',
}
const BOARD_STATUS: AuditViewEntry = { from: 'word', to: 'word' }
const LIBRARY_SCOPE: AuditViewEntry = { scope: 'word' }

export const AUDIT_VIEW: Readonly<Record<AuditAction, AuditViewEntry>> = {
  'board.create': {
    via: 'word',
    fromBoard: 'board',
    fromSnapshot: 'id',
    keepSharing: 'boolean',
    outsideLeftOut: 'number',
    madePrivate: 'boolean',
    files: 'number',
    filesFenced: 'number',
    // an import's counts (Miro: items, connectors, files; a backup: elements, files)
    items: 'number',
    connectors: 'number',
    elements: 'number',
  },
  'board.visibility': BOARD_STATUS,
  'board.archive': BOARD_STATUS,
  'board.trash': BOARD_STATUS,
  'board.restore': BOARD_STATUS,
  // never the checkpoint's name (people name them)
  'board.checkpoint.delete': { snapshotId: 'id', kind: 'word', reason: 'word', createdAt: 'date' },
  'board.member.put': MEMBER_CHANGE,
  'board.member.remove': MEMBER_CHANGE,
  // never the invited address's domain
  'invitation.create': {
    boardId: 'board',
    role: 'word',
    via: 'word',
    multiUse: 'boolean',
    maxUses: 'number',
    allowGuests: 'boolean',
    landing: 'word',
    emailLocked: 'boolean',
  },
  'invitation.accept': { boardId: 'board', role: 'word', via: 'word', emailLocked: 'boolean' },
  'invitation.revoke': {
    boardId: 'board',
    multiUse: 'boolean',
    via: 'word',
    userId: 'user',
    invitee: 'boolean',
  },
  'invitation.extend': { boardId: 'board', from: 'date', to: 'date' },
  'invitation.update': { boardId: 'board', multiUse: 'boolean', allowGuests: 'boolean', joinCode: 'boolean' },
  'workspace.member.role': { userId: 'user', role: 'word', previousRole: 'word' },
  // never the ids of the links kept (their count is enough; the links tab lists them)
  'workspace.member.remove': {
    userId: 'user',
    previousRole: 'word',
    boardGrantsRemoved: 'number',
    invitationsRevoked: 'number',
    invitationsToThemRevoked: 'number',
    accessRequestsDenied: 'number',
    personalLibraryItemsDeleted: 'number',
    linksKept: 'number',
  },
  'library.item.create': { scope: 'word', sourceBoardId: 'board', elements: 'number', images: 'number' },
  'library.item.delete': LIBRARY_SCOPE,
  'library.item.restore': LIBRARY_SCOPE,
  'library.import': { scope: 'word', created: 'number', skipped: 'number' },
  'library.folder.create': LIBRARY_SCOPE,
  'library.folder.delete': LIBRARY_SCOPE,
  'board.import.start': { source: 'word', importRowId: 'id' },
  'board.import.discard': { reason: 'word', files: 'number' },
  // never a hook's URL or its hint; `changed` is a list of field names: its length only
  'chat_hook.create': { provider: 'word' },
  'chat_hook.update': { changed: 'count' },
  'chat_hook.delete': { provider: 'word' },
  // never the file's name
  'asset.gc_delete': {
    assetId: 'id',
    boardId: 'board',
    kind: 'word',
    bytes: 'number',
    unreferencedSince: 'date',
    uploadedAt: 'date',
  },
  'workspace.internal_only': { internalOnly: 'boolean' },
  'project.internal_only': { internalOnly: 'boolean' },
  // never the comment's body (the log never had it)
  'comment.moderate_delete': { commentId: 'id', threadId: 'id', authorId: 'user' },
}

/** The detail shown for an action this build does not know: nothing. */
const NO_ENTRY: AuditViewEntry = {}

export const auditViewOf = (action: string): AuditViewEntry =>
  Object.hasOwn(AUDIT_VIEW, action) ? AUDIT_VIEW[action as AuditAction] : NO_ENTRY

const WORD = /^[a-z][a-z0-9_-]{0,39}$/
const ID = /^[a-z]{2,5}_[0-9A-Za-z]{10,40}$/
const BOARD_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/
const USER_ID = /^usr_[0-9A-Za-z]{10,40}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

/** What the viewer needs to look up before it can show a page of rows: the people and the boards named. */
export interface DetailRefs {
  users: Set<string>
  boards: Set<string>
}

/** Collects the user and board ids a row's shown detail names (call before `showDetail`). */
export function collectRefs(action: string, detail: unknown, refs: DetailRefs): void {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return
  const d = detail as Record<string, unknown>
  for (const [key, kind] of Object.entries(auditViewOf(action))) {
    const v = d[key]
    if (typeof v !== 'string') continue
    if (kind === 'user' && USER_ID.test(v)) refs.users.add(v)
    if (kind === 'board' && BOARD_ID.test(v)) refs.boards.add(v)
  }
}

export type ShownValue = string | number | boolean | null

/**
 * The detail as the viewer shows it: the entry's keys present in `detail`, each value checked against its kind (a
 * value that fails is left out, never shown as it is). `names` and `titles` resolve people and boards; one not found
 * is shown as "Someone" / "A removed board".
 */
export function showDetail(
  action: string,
  detail: unknown,
  names: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
): Record<string, ShownValue> {
  const out: Record<string, ShownValue> = {}
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return out
  const d = detail as Record<string, unknown>
  for (const [key, kind] of Object.entries(auditViewOf(action))) {
    if (!Object.hasOwn(d, key)) continue
    const shown = showValue(kind, d[key], names, titles)
    if (shown !== undefined) out[key] = shown
  }
  return out
}

function showValue(
  kind: DetailKind,
  v: unknown,
  names: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
): ShownValue | undefined {
  switch (kind) {
    case 'word':
      return typeof v === 'string' && WORD.test(v) ? v : v === null ? null : undefined
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined
    case 'date':
      return typeof v === 'string' && ISO.test(v) ? v : undefined
    case 'id':
      return typeof v === 'string' && ID.test(v) ? v : undefined
    case 'count':
      return Array.isArray(v) ? v.length : undefined
    case 'user':
      if (v === null) return null
      return typeof v === 'string' && USER_ID.test(v) ? (names.get(v) ?? 'Someone') : undefined
    case 'board':
      if (v === null) return null
      return typeof v === 'string' && BOARD_ID.test(v) ? (titles.get(v) ?? 'A removed board') : undefined
  }
}
