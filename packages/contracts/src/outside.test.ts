// Wave J (outside markers): the shared shapes and texts. Every new field is optional or defaulted, so an
// api from before wave J still parses in this web (no tag, no marker, nothing asked), and the cleaning
// of typed names and messages drops exactly the invisible characters.
import { describe, expect, it } from 'vitest'
import {
  AccessRequest,
  BoardOutsidePeople,
  CommentUserRef,
  CreateAccessRequestInput,
  cleanDisplayText,
  DevLoginInput,
  INTERNAL_ONLY_CODE,
  INTERNAL_ONLY_MESSAGES,
  InternalOnlySettings,
  ListBoardsWithThumbnailsResponse,
  ListNotificationsResponse,
  NOTIFICATION_KINDS_SINCE_REV2,
  outsideConfirmText,
  SetInternalOnlyInput,
  ShareMember,
  ShareState,
  TEAM_ONLY_HINT,
  User,
  WorkspaceMember,
} from './index.ts'

const ch = (...codes: number[]) => String.fromCodePoint(...codes)
const user = { id: 'usr_0123456789', name: 'Pat', handle: null, color: '#123456', avatarUrl: null }

describe('cleanDisplayText', () => {
  it('drops control, bidi and zero-width characters; keeps real text', () => {
    for (const cp of [
      0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066,
      0x2067, 0x2068, 0x2069, 0x2028, 0x2029, 0xfeff, 0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f,
    ])
      expect(cleanDisplayText(`Ca${ch(cp)}rol`), cp.toString(16)).toBe('Carol')
    expect(cleanDisplayText(`line one\nline\ttwo\r\n`)).toBe('line one line two')
    expect(cleanDisplayText('  a   b  ')).toBe('a b')
    expect(cleanDisplayText('Zoë Ålund – 設計 تقرير 🎨')).toBe('Zoë Ålund – 設計 تقرير 🎨')
    expect(cleanDisplayText(ch(0x202e, 0x200b))).toBe('')
  })

  it('keeps the joiners (ZWJ, ZWNJ) that are part of emoji and non-Latin spelling; drops the rest', () => {
    const zwj = ch(0x200d)
    const zwnj = ch(0x200c)
    // Emoji sequences: a person and a laptop, a skin tone, a flag with its variation selector.
    for (const emoji of [
      ch(0x1f469, 0x200d, 0x1f4bb),
      ch(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb),
      ch(0x1f3f3, 0xfe0f, 0x200d, 0x1f308),
      ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
    ])
      expect(cleanDisplayText(`Ana ${emoji}`)).toBe(`Ana ${emoji}`)
    // Persian (ZWNJ inside a word) and Devanagari (ZWJ, ZWNJ after a virama).
    const persian = ch(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645)
    expect(cleanDisplayText(persian)).toBe(persian)
    const devanagari = `${ch(0x0915, 0x094d)}${zwj}${ch(0x0937)} ${ch(0x0915, 0x094d)}${zwnj}${ch(0x0937)}`
    expect(cleanDisplayText(devanagari)).toBe(devanagari)
    // Inside a Latin look-alike, at an end, next to a space or another invisible character: removed.
    expect(cleanDisplayText(`Bo${zwj}b`)).toBe('Bob')
    expect(cleanDisplayText(`Bo${zwnj}b`)).toBe('Bob')
    expect(cleanDisplayText(`${zwj}${ch(0x1f4bb)}${zwj}`)).toBe(ch(0x1f4bb))
    expect(cleanDisplayText(`${ch(0x1f469)} ${zwj}${ch(0x1f4bb)}`)).toBe(`${ch(0x1f469)} ${ch(0x1f4bb)}`)
    // A bidi control between the two goes; the joiner then joins them, once.
    expect(cleanDisplayText(`${ch(0x1f469)}${ch(0x202e)}${zwj}${ch(0x1f4bb)}`)).toBe(
      `${ch(0x1f469)}${zwj}${ch(0x1f4bb)}`,
    )
    expect(cleanDisplayText(`${ch(0x1f469)}${zwj}${zwj}${ch(0x1f4bb)}`)).toBe(
      `${ch(0x1f469)}${zwj}${ch(0x1f4bb)}`,
    )
  })

  it('applies to an access request message and to a dev sign-in name on input', () => {
    expect(CreateAccessRequestInput.parse({ message: `  lost ${ch(0x202e)}access ` })).toEqual({
      role: 'editor',
      message: 'lost access',
    })
    expect(CreateAccessRequestInput.safeParse({ message: 'x'.repeat(301) }).success).toBe(false)
    // invisible characters do not count toward the limit
    expect(
      CreateAccessRequestInput.safeParse({ message: `${'x'.repeat(300)}${ch(0x200b).repeat(5)}` }).success,
    ).toBe(true)
    expect(DevLoginInput.parse({ handle: 'bob', name: `Bo${ch(0x200d)}b` }).name).toBe('Bob')
    expect(DevLoginInput.safeParse({ handle: 'bob', name: ch(0x202e) }).success).toBe(false)
  })
})

describe('older api responses still parse (every new field optional or defaulted)', () => {
  it('access requests, share members, workspace members and comment authors without the fields', () => {
    const request = AccessRequest.parse({
      id: 'acr_0123456789',
      boardId: 'b-1',
      user,
      roleRequested: 'editor',
      message: null,
      status: 'pending',
      createdAt: 'x',
      updatedAt: 'x',
      currentRole: null,
      decidedAt: null,
      roleGranted: null,
    })
    expect(request.outside).toBeUndefined()
    const member = ShareMember.parse({
      user,
      role: 'editor',
      source: 'grant',
      grant: 'editor',
      workspaceRole: 'guest',
      withoutGrant: null,
      viaReviewLink: false,
      linkEndsAt: null,
    })
    expect([member.outside, member.emailDomain, member.emailHint]).toEqual([undefined, undefined, undefined])
    expect(WorkspaceMember.parse({ user, role: 'member' }).outside).toBeUndefined()
    expect(CommentUserRef.parse({ id: user.id, name: 'Pat', color: '#000' }).external).toBeUndefined()
    // User itself never gained a field.
    expect(Object.keys(User.shape).sort()).toEqual(['avatarUrl', 'color', 'handle', 'id', 'name'])
  })

  it('the share state and the dashboard lists may lack sharedOutside (read as false)', () => {
    expect(
      ShareState.parse({ visibility: 'private', links: [], directCount: 0, pendingRequests: null })
        .sharedOutside,
    ).toBeUndefined()
    const board = {
      id: 'b-1',
      workspaceId: 'wsp_0123456789',
      projectId: null,
      title: 'T',
      visibility: 'private',
      status: 'active',
      trashedAt: null,
      createdBy: user.id,
      createdAt: 'x',
      updatedAt: 'x',
      lastOpenedAt: null,
      role: 'owner',
    }
    expect(
      ListBoardsWithThumbnailsResponse.parse({ boards: [board] }).boards[0]?.sharedOutside,
    ).toBeUndefined()
    expect(
      ListBoardsWithThumbnailsResponse.parse({ boards: [{ ...board, sharedOutside: true }] }).boards[0]
        ?.sharedOutside,
    ).toBe(true)
  })

  it('the board outside list defaults internalOnly and emailDomain', () => {
    expect(BoardOutsidePeople.parse({ sharedOutside: true, people: [{ userId: user.id }] })).toEqual({
      sharedOutside: true,
      internalOnly: null,
      people: [{ userId: user.id, emailDomain: null }],
    })
  })
})

describe('outsider_joined and the texts', () => {
  it('a revision-2 kind with the outsider domain', () => {
    expect(NOTIFICATION_KINDS_SINCE_REV2).toEqual(['outsider_joined'])
    const item = ListNotificationsResponse.parse({
      notifications: [
        {
          id: 'ntf_0123456789',
          kind: 'outsider_joined',
          boardId: 'b-1',
          boardTitle: 'Q3',
          threadId: null,
          commentId: null,
          actor: { id: user.id, name: 'Pat', color: '#000', external: true },
          snippet: null,
          outsiderJoined: { emailDomain: 'client.example.test' },
          createdAt: 'x',
          readAt: null,
        },
      ],
      unreadCount: 1,
    }).notifications[0]
    expect(item).toMatchObject({
      kind: 'outsider_joined',
      outsiderJoined: { emailDomain: 'client.example.test' },
    })
  })

  it('the confirm, the team-only hint and the internal-only refusal say what the owner asked for', () => {
    expect(outsideConfirmText('x@client.example.test')).toBe(
      'x@client.example.test is outside Dark Burn and Trailer Park Group. They will only see this board.',
    )
    expect(TEAM_ONLY_HINT).toBe('People outside Dark Burn / TPG won’t see it')
    expect(INTERNAL_ONLY_CODE).toBe('INTERNAL_ONLY')
    expect(INTERNAL_ONLY_MESSAGES.workspace).toMatch(/^This workspace is internal only/)
    expect(INTERNAL_ONLY_MESSAGES.project).toMatch(/^This project is internal only/)
    expect(SetInternalOnlyInput.safeParse({ internalOnly: true, extra: 1 }).success).toBe(false)
    expect(
      InternalOnlySettings.parse({
        workspace: false,
        projects: [],
        canChange: false,
        canTurnOff: false,
        outsideAccess: null,
      }).outsideAccess,
    ).toBeNull()
    // The pending outside invitations came later: an answer without them reads as none.
    expect(
      InternalOnlySettings.parse({
        workspace: true,
        projects: [],
        canChange: true,
        canTurnOff: true,
        outsideAccess: { people: [], links: [] },
      }).outsideAccess?.invitations,
    ).toEqual([])
  })
})
