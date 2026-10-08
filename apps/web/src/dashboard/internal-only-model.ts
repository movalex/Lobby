// Wave J: what the dashboard's "Internal only" UI says (pure; unit-tested in Node). The server sends the
// workspace's outside access once (GET /api/workspaces/:wid/internal-only); a project's view is the part
// of it that reaches that project's boards.
import type {
  InternalOnlySettings,
  OutsideAccessInvitation,
  OutsideAccessLink,
  OutsideAccessPerson,
} from '@draftroom/contracts'

export type OutsideScope = { kind: 'workspace' } | { kind: 'project'; projectId: string }

export interface OutsideAccess {
  people: OutsideAccessPerson[]
  links: OutsideAccessLink[]
  /** Pending invitations to outside addresses (nobody outside can accept them while it is on). */
  invitations: OutsideAccessInvitation[]
}

/**
 * The outside access in a scope: the whole workspace, or one project (its boards' grants, links and
 * pending invitations, and the outside members whose workspace role reaches its boards; a workspace
 * invitation belongs to the workspace only).
 */
export function outsideAccessIn(settings: InternalOnlySettings, scope: OutsideScope): OutsideAccess {
  const all = settings.outsideAccess ?? { people: [], links: [], invitations: [] }
  if (scope.kind === 'workspace')
    return { people: [...all.people], links: [...all.links], invitations: [...all.invitations] }
  const inProject = <T extends { projectId: string | null }>(x: T) => x.projectId === scope.projectId
  const people: OutsideAccessPerson[] = []
  for (const p of all.people) {
    const boards = p.boards.filter(inProject)
    if (boards.length || p.workspaceRole !== 'guest') people.push({ ...p, boards })
  }
  return {
    people,
    links: all.links.filter(inProject),
    invitations: all.invitations.filter((i) => i.boardId !== null && inProject(i)),
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * "2 outside people, 1 link and 1 invitation still have access. Review" (null when nothing reaches the
 * scope).
 */
export function outsideAccessSummary(access: OutsideAccess): string | null {
  const { people, links, invitations } = access
  if (!people.length && !links.length && !invitations.length) return null
  const parts = [
    people.length ? count(people.length, 'outside person', 'outside people') : null,
    links.length ? count(links.length, 'link', 'links') : null,
    invitations.length ? count(invitations.length, 'invitation', 'invitations') : null,
  ].filter((p): p is string => p !== null)
  const total = people.length + links.length + invitations.length
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')
  return `${joined} still ${total === 1 ? 'has' : 'have'} access. Review`
}

/** Whether this project is internal only (false for an unknown one, or before the settings load). */
export function projectInternalOnly(settings: InternalOnlySettings | null, projectId: string): boolean {
  return settings?.projects.some((p) => p.projectId === projectId && p.internalOnly) ?? false
}

export type ProjectMenuAction = 'rename' | 'internal-on' | 'internal-off' | 'internal-review'

/** The project menu: rename (creators), and the switch for owners and admins (off: creators too). */
export function projectMenuItems(opts: {
  canRename: boolean
  settings: InternalOnlySettings | null
  projectId: string
}): { action: ProjectMenuAction; label: string }[] {
  const items: { action: ProjectMenuAction; label: string }[] = []
  if (opts.canRename) items.push({ action: 'rename', label: 'Rename' })
  const s = opts.settings
  if (!s?.canChange) return items
  if (!projectInternalOnly(s, opts.projectId))
    items.push({ action: 'internal-on', label: 'Make internal only' })
  else {
    if (s.canTurnOff) items.push({ action: 'internal-off', label: 'Allow sharing outside' })
    if (s.outsideAccess) items.push({ action: 'internal-review', label: 'Review outside access' })
  }
  return items
}

/**
 * Whether the Internal only control has anything to show (wave K moved it into the workspace menu, so the
 * menu needs to know before it renders): owners and admins always (the switch), members only while it is on
 * for the workspace or for a project. A guest or an older api has no settings and sees nothing.
 */
export function internalOnlyShown(
  settings: InternalOnlySettings | null,
  projects: readonly { id: string }[],
): boolean {
  if (!settings) return false
  if (settings.canChange || settings.workspace) return true
  return projects.some((p) => projectInternalOnly(settings, p.id))
}
