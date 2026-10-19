// Wave V (WS4): fixtures for the breakouts web tests.
import type { BreakoutState } from '@draftroom/contracts'

export const T0 = Date.parse('2026-10-18T10:00:00.000Z')
export const iso = (ms: number) => new Date(ms).toISOString()
export const ME = 'usr_me000000000001'
export const OTHER = 'usr_other000000001'
export const STARTER = 'usr_starter0000001'

export function sample(
  over: Partial<BreakoutState> = {},
  session: Partial<NonNullable<BreakoutState['session']>> = {},
): BreakoutState {
  return {
    session: {
      id: 'brk_0123456789abcdefghij',
      boardId: 'b-0123456789',
      groups: [
        { id: 'g1', name: 'Group 1', frameId: 'shape:f1' },
        { id: 'g2', name: 'Group 2', frameId: 'shape:f2' },
      ],
      mode: 'manual',
      groupCap: null,
      status: 'running',
      createdBy: STARTER,
      createdAt: iso(T0),
      endsAt: iso(T0 + 10 * 60_000),
      endedAt: null,
      rev: 1,
      ...session,
    },
    members: [
      { userId: ME, name: 'Me', groupId: 'g2' },
      { userId: OTHER, name: 'Other', groupId: 'g1' },
    ],
    myGroupId: 'g2',
    canManage: false,
    serverNow: iso(T0),
    ...over,
  }
}
