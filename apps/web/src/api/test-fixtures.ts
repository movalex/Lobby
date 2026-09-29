// Contract-shaped values for unit tests (docs/M1-CONTRACTS.md §5).
import type { Board, BoardMember, BoardWithRole, Me, User, WorkspaceMember } from '@draftroom/contracts'

export const WS_ID = 'wsp_0123456789abcdefghij'
export const WS2_ID = 'wsp_ZYXWVUTSRQponmlkjihg'
export const PRJ_ID = 'prj_0123456789ABCDEFGHIJ'
export const BOARD_ID = 'b-3k9x0q2m7a'

export function makeUser(handle: string, over: Partial<User> = {}): User {
  const body = `${handle}xxxxxxxxxxxxxxxxxxxx`.replace(/[^0-9A-Za-z]/g, 'x').slice(0, 20)
  return {
    id: `usr_${body}`,
    name: handle.charAt(0).toUpperCase() + handle.slice(1),
    handle,
    color: '#1d4ed8',
    avatarUrl: null,
    ...over,
  }
}

export function makeMe(over: Partial<Me> = {}): Me {
  return {
    user: makeUser('alice'),
    workspaces: [
      { id: WS_ID, name: 'Dev Studio', role: 'owner' },
      { id: WS2_ID, name: 'Alice (personal)', role: 'owner' },
    ],
    // Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §7): a handle-only dev sign-in is a creator.
    access: { creator: true, reason: 'dev', email: 'alice@dev.invalid' },
    ...over,
  }
}

export function makeBoard(over: Partial<BoardWithRole> = {}): BoardWithRole {
  return {
    id: BOARD_ID,
    workspaceId: WS_ID,
    projectId: null,
    title: 'Q3 planning',
    visibility: 'private',
    status: 'active',
    trashedAt: null,
    createdBy: makeUser('alice').id,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    lastOpenedAt: null,
    role: 'owner',
    ...over,
  }
}

export const plainBoard = (over: Partial<BoardWithRole> = {}): Board => {
  const { role: _role, ...board } = makeBoard(over)
  return board
}

export const member = (handle: string, role: BoardMember['role'], source: BoardMember['source'] = 'grant') =>
  ({ user: makeUser(handle), role, source }) satisfies BoardMember

export const wsMember = (handle: string, role: WorkspaceMember['role']) =>
  ({ user: makeUser(handle), role }) satisfies WorkspaceMember
