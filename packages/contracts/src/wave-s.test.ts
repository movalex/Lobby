// The wave S foundation's contracts (docs/WAVE-S-CONTRACTS.md): review items, rounds and events, the actor label,
// versions, the comment spot, the review landing, the new bell and chat kinds behind LOBBY_CLIENT_REV 3, and the proof
// that a tab of the rev-2 build (fixtures/client-rev2.ts, frozen) still parses what a rev-3 api answers it.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Rev2ChatHookKind,
  Rev2ChatPrefsResponse,
  Rev2CommentThread,
  Rev2ListNotificationsResponse,
  Rev2NotificationKind,
} from './fixtures/client-rev2.ts'
import {
  AddReviewItemInput,
  ASSET_VERSION_ROUTE_KEYS,
  assetVersionsPath,
  CHAT_HOOK_KINDS,
  CHAT_HOOK_KINDS_SINCE_REV3,
  ChatHookKind,
  type ChatMessage,
  ChatPrefsResponse,
  CommentSpot,
  CommentThread,
  CreateReviewLinkInput,
  CreateThreadInput,
  chatMessageSentence,
  GetReviewResponse,
  knowsRev3,
  ListAssetVersionsResponse,
  ListBoardsWithThumbnailsResponse,
  ListNotificationsResponse,
  LOBBY_CLIENT_REV,
  NOTIFICATION_KINDS_SINCE_REV1,
  NOTIFICATION_KINDS_SINCE_REV2,
  NOTIFICATION_KINDS_SINCE_REV3,
  NotificationKind,
  PatchReviewItemInput,
  REVIEW_MANAGE_ROUTE_KEYS,
  REVIEW_ROUTE_KEYS,
  REVIEW_RULES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUSES,
  type ReviewItem,
  reviewActorLabel,
  reviewCounts,
  reviewEventsPath,
  reviewLandingPath,
  reviewPillText,
  reviewRoundCheckpointName,
  reviewRoundClosePath,
  reviewStatusPath,
  SetReviewStatusInput,
  StartReviewRoundInput,
  slackPayload,
  versionKindsCompatible,
} from './index.ts'

const USR = 'usr_0123456789abcdef'
const AST = 'ast_0123456789abcdef'
const VER = 'ver_0123456789abcdef'
const RVI = 'rvi_0123456789abcdef'

const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: RVI,
  boardId: 'b-pitch0001',
  elementId: 'frame-1',
  kind: 'frame',
  assetId: null,
  label: 'Key art B',
  position: null,
  roundId: null,
  status: 'approved',
  statusSeq: 3,
  statusBy: { id: USR, name: 'Ana', kind: 'guest', external: false },
  statusAt: '2026-10-16T10:00:00.000Z',
  statusVersionId: null,
  createdAt: '2026-10-16T09:00:00.000Z',
  removedAt: null,
  ...over,
})

describe('review: statuses, routes and rules', () => {
  it('three statuses with their words; every route has exactly one rule', () => {
    expect(REVIEW_STATUSES).toEqual(['pending', 'changes_requested', 'approved'])
    expect(Object.values(REVIEW_STATUS_LABELS)).toEqual(['Awaiting review', 'Changes requested', 'Approved'])
    expect(Object.keys(REVIEW_RULES).sort()).toEqual([...REVIEW_ROUTE_KEYS].sort())
    expect(REVIEW_ROUTE_KEYS).toHaveLength(8)
    expect([...REVIEW_MANAGE_ROUTE_KEYS].sort()).toEqual(
      [
        'DELETE /api/boards/:bid/review/items/:rvi',
        'PATCH /api/boards/:bid/review/items/:rvi',
        'POST /api/boards/:bid/review/items',
        'POST /api/boards/:bid/review/rounds',
        'POST /api/boards/:bid/review/rounds/:rvr/close',
      ].sort(),
    )
    expect(REVIEW_RULES['POST /api/boards/:bid/review/items/:rvi/status']).toBe('setStatus')
    expect(ASSET_VERSION_ROUTE_KEYS).toEqual(['GET /api/boards/:bid/asset-versions/:ast'])
  })

  it('paths encode their parts', () => {
    expect(reviewStatusPath('b-1x', RVI)).toBe(`/api/boards/b-1x/review/items/${RVI}/status`)
    expect(reviewEventsPath('b-1x', RVI, 42)).toBe(`/api/boards/b-1x/review/items/${RVI}/events?before=42`)
    expect(reviewRoundClosePath('b-1x', 'rvr_0123456789')).toBe(
      '/api/boards/b-1x/review/rounds/rvr_0123456789/close',
    )
    expect(assetVersionsPath('b-1x', AST)).toBe(`/api/boards/b-1x/asset-versions/${AST}`)
    expect(reviewLandingPath('b-1x')).toBe('/b/b-1x')
    expect(reviewLandingPath('b-1x', 'review')).toBe('/b/b-1x?view=review')
  })

  it('inputs are strict: nobody names the actor, a file item names its asset and a frame none', () => {
    const ok = { elementId: 'frame-1', kind: 'frame', label: '  Key art  ' }
    expect(AddReviewItemInput.parse(ok)).toEqual({ elementId: 'frame-1', kind: 'frame', label: 'Key art' })
    expect(AddReviewItemInput.safeParse({ ...ok, kind: 'file' }).success).toBe(false)
    expect(AddReviewItemInput.safeParse({ ...ok, assetId: AST }).success).toBe(false)
    expect(AddReviewItemInput.safeParse({ ...ok, kind: 'file', assetId: AST }).success).toBe(true)
    expect(AddReviewItemInput.safeParse({ ...ok, actor: USR }).success).toBe(false)
    expect(AddReviewItemInput.safeParse({ ...ok, label: '‮​' }).success).toBe(false)
    expect(AddReviewItemInput.safeParse({ ...ok, elementId: 'has space' }).success).toBe(false)
    expect(SetReviewStatusInput.safeParse({ status: 'approved', actorId: USR }).success).toBe(false)
    expect(SetReviewStatusInput.safeParse({ status: 'approved', actor: { kind: 'account' } }).success).toBe(
      false,
    )
    expect(SetReviewStatusInput.safeParse({ status: 'maybe' }).success).toBe(false)
    expect(
      SetReviewStatusInput.parse({ status: 'changes_requested', fromSeq: 2, note: ' Logo larger \r\n' }),
    ).toEqual({
      status: 'changes_requested',
      fromSeq: 2,
      note: 'Logo larger',
    })
    expect(PatchReviewItemInput.safeParse({}).success).toBe(false)
    expect(PatchReviewItemInput.safeParse({ position: null }).success).toBe(true)
    expect(StartReviewRoundInput.parse({})).toEqual({ keepApproved: true })
  })

  it('the actor label: a guest from its typed name, an outside account tagged, never a double suffix', () => {
    expect(reviewActorLabel({ name: 'Ana', kind: 'guest', external: false })).toBe('Ana (guest)')
    expect(reviewActorLabel({ name: 'Bo', kind: 'account', external: true })).toBe('Bo · External')
    expect(reviewActorLabel({ name: 'Cy', kind: 'account', external: false })).toBe('Cy')
    // bidi overrides and zero-width characters go; nothing left reads "Someone"
    expect(reviewActorLabel({ name: 'An‮a', kind: 'guest', external: false })).toBe('Ana (guest)')
    expect(reviewActorLabel({ name: '​', kind: 'account', external: false })).toBe('Someone')
    expect(reviewPillText(item())).toBe('Approved · Ana (guest)')
    expect(reviewPillText(item({ status: 'pending', statusBy: null }))).toBe('Awaiting review')
  })

  it('counts only live items; the round checkpoint name fits a checkpoint', () => {
    const items = [item(), item({ status: 'pending' }), item({ status: 'approved', removedAt: 'x' })]
    expect(reviewCounts(items)).toEqual({ pending: 1, changes_requested: 0, approved: 1 })
    expect(reviewRoundCheckpointName('Round 2')).toBe('Review round 2 sent')
    expect(reviewRoundCheckpointName('x'.repeat(80)).length).toBeLessThanOrEqual(120)
  })

  it('the review answer parses', () => {
    const r = { items: [item()], rounds: [], openRoundId: null, can: { setStatus: true, manage: false } }
    expect(GetReviewResponse.parse(r).items[0]?.statusBy?.kind).toBe('guest')
  })
})

describe('versions', () => {
  it('images replace images, the rest the rest', () => {
    expect(versionKindsCompatible('image', 'image')).toBe(true)
    expect(versionKindsCompatible('pdf', 'video')).toBe(true)
    expect(versionKindsCompatible('image', 'pdf')).toBe(false)
    expect(versionKindsCompatible('other', 'image')).toBe(false)
  })

  it('the list parses', () => {
    const v = {
      n: 1,
      versionId: VER,
      supersedes: null,
      name: 'cut.mov',
      kind: 'video',
      sizeBytes: 10,
      uploadedBy: { id: USR, name: 'Ana', kind: 'account', external: false },
      createdAt: '2026-10-16T10:00:00.000Z',
      status: 'ready',
      pageCount: null,
      durationMs: 12_400,
      threads: { open: 1, resolved: 0 },
      review: null,
    }
    expect(
      ListAssetVersionsResponse.parse({ assetId: AST, versions: [v], latestVersionId: VER }).versions,
    ).toHaveLength(1)
  })
})

describe('the comment spot', () => {
  it('is a strict (u, v) in [0, 1], accepted as an input next to the anchor', () => {
    expect(CommentSpot.safeParse({ u: 0.5, v: 1 }).success).toBe(true)
    expect(CommentSpot.safeParse({ u: 1.1, v: 0 }).success).toBe(false)
    expect(CommentSpot.safeParse({ u: 0, v: 0, w: 0 }).success).toBe(false)
    const anchor = { kind: 'asset', shapeId: 'shape:img-1', assetId: AST, versionId: VER, timeMs: 12_400 }
    expect(CreateThreadInput.parse({ anchor, body: 'here', spot: { u: 0.2, v: 0.3 } }).spot).toEqual({
      u: 0.2,
      v: 0.3,
    })
  })
})

// ---- LOBBY_CLIENT_REV 3 --------------------------------------------------------------------------------------------

const thread = {
  id: 'thr_0123456789abcdef',
  boardId: 'b-pitch0001',
  anchor: { kind: 'asset', shapeId: 'shape:img-1', assetId: AST, versionId: VER, page: 3 },
  status: 'open',
  createdBy: { id: USR, name: 'Ana (guest)', color: '#123456' },
  createdAt: '2026-10-16T10:00:00.000Z',
  updatedAt: '2026-10-16T10:00:00.000Z',
  resolvedBy: null,
  resolvedAt: null,
  visibility: 'everyone',
  spot: { u: 0.25, v: 0.75 },
  comments: [],
}

const bellItem = (kind: string, extra: Record<string, unknown> = {}) => ({
  id: 'ntf_0123456789abcdef',
  kind,
  boardId: 'b-pitch0001',
  boardTitle: 'Pitch wall',
  threadId: null,
  commentId: null,
  actor: { id: USR, name: 'Ana (guest)', color: '#123456' },
  snippet: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  readAt: null,
  ...extra,
})

describe('LOBBY_CLIENT_REV 3', () => {
  it('is 3; review_status is the one bell kind and the one chat kind a rev-2 build cannot read', () => {
    expect(LOBBY_CLIENT_REV).toBe(3)
    expect(knowsRev3(2)).toBe(false)
    expect(knowsRev3(3)).toBe(true)
    expect(NOTIFICATION_KINDS_SINCE_REV3).toEqual(['review_status'])
    const older = [...NOTIFICATION_KINDS_SINCE_REV1, ...NOTIFICATION_KINDS_SINCE_REV2]
    // the frozen rev-2 enum knows exactly the kinds before review_status
    for (const k of NotificationKind.options)
      expect(Rev2NotificationKind.safeParse(k).success, k).toBe(!NOTIFICATION_KINDS_SINCE_REV3.includes(k))
    expect(older.every((k) => Rev2NotificationKind.safeParse(k).success)).toBe(true)
    expect(CHAT_HOOK_KINDS_SINCE_REV3).toEqual(['review_status'])
    for (const k of ChatHookKind.options)
      expect(Rev2ChatHookKind.safeParse(k).success, k).toBe(!CHAT_HOOK_KINDS_SINCE_REV3.includes(k))
  })

  it('a review_status item would fail a rev-2 bell whole; without it the rev-3 answer parses there', () => {
    const review = {
      event: 'status',
      itemId: RVI,
      status: 'approved',
      reason: 'set',
      label: 'Key art B',
      roundTitle: null,
      itemCount: null,
    }
    const rev3 = {
      notifications: [bellItem('review_status', { review }), bellItem('mention', { threadId: thread.id })],
      unreadCount: 2,
    }
    expect(ListNotificationsResponse.parse(rev3).notifications[0]?.review?.status).toBe('approved')
    expect(Rev2ListNotificationsResponse.safeParse(rev3).success).toBe(false)
    const forRev2 = {
      notifications: rev3.notifications.filter(
        (n) => !NOTIFICATION_KINDS_SINCE_REV3.includes(n.kind as never),
      ),
      unreadCount: 1,
    }
    expect(Rev2ListNotificationsResponse.safeParse(forRev2).success).toBe(true)
    // a `review` key on another kind (never sent, but harmless): stripped by the old z.object
    expect(
      Rev2ListNotificationsResponse.safeParse({
        ...forRev2,
        notifications: [bellItem('mention', { review })],
      }).success,
    ).toBe(true)
  })

  it('chat preferences: a review_status kind fails the rev-2 answer; filtered, it parses', () => {
    const hook = { id: 'chk_0123456789abcdef', name: '#pitches', provider: 'slack', disabled: false }
    const rev3 = { hooks: [hook], prefs: [{ hookId: hook.id, kinds: ['mention', 'review_status'] }] }
    expect(ChatPrefsResponse.parse(rev3).prefs[0]?.kinds).toEqual(['mention', 'review_status'])
    expect(Rev2ChatPrefsResponse.safeParse(rev3).success).toBe(false)
    const forRev2 = {
      hooks: [hook],
      prefs: rev3.prefs.map((p) => ({
        ...p,
        kinds: p.kinds.filter((k) => !CHAT_HOOK_KINDS_SINCE_REV3.includes(k as never)),
      })),
    }
    expect(Rev2ChatPrefsResponse.safeParse(forRev2).success).toBe(true)
    expect(CHAT_HOOK_KINDS).toContain('review_status')
  })

  it('additive fields need no revision: a spot, board review counts and landings parse (stripped) in the old build', () => {
    expect(CommentThread.parse(thread).spot).toEqual({ u: 0.25, v: 0.75 })
    const old = Rev2CommentThread.parse(thread)
    expect('spot' in old).toBe(false)
    expect(old.anchor).toEqual(thread.anchor)
    // the board list: the old build's schema is the new one without `review` (a z.object)
    const board = {
      id: 'b-pitch0001',
      workspaceId: 'wsp_0123456789abcdef',
      projectId: null,
      title: 'Pitch wall',
      visibility: 'private',
      status: 'active',
      trashedAt: null,
      createdBy: USR,
      createdAt: 'x',
      updatedAt: 'x',
      lastOpenedAt: null,
      role: 'owner',
      review: { pending: 2, changes: 1, approved: 0 },
    }
    expect(ListBoardsWithThumbnailsResponse.parse({ boards: [board] }).boards[0]?.review?.pending).toBe(2)
    const oldList = z.object({
      boards: z.array(ListBoardsWithThumbnailsResponse.shape.boards.element.omit({ review: true })),
    })
    expect(oldList.safeParse({ boards: [board] }).success).toBe(true)
    // a review link's landing: an api of before wave S strips it (z.object), so the link opens the board
    expect(CreateReviewLinkInput.parse({ landing: 'review' })).toMatchObject({
      role: 'commenter',
      landing: 'review',
    })
    expect(CreateReviewLinkInput.safeParse({ landing: 'canvas' }).success).toBe(false)
  })
})

describe('the review_status chat message', () => {
  const base: ChatMessage = {
    kind: 'review_status',
    actor: 'Ana (guest)',
    boardTitle: 'Pitch wall',
    link: 'https://lobby.example/b/b-pitch0001',
    workspaceName: 'Studio',
  }

  it('says what happened; the label only when it was given (the hook’s snippet switch), cut to 60', () => {
    const status = { event: 'status', status: 'approved', reason: 'set' } as const
    expect(chatMessageSentence({ ...base, review: status })).toBe(
      'Ana (guest) approved an item on Pitch wall',
    )
    expect(chatMessageSentence({ ...base, review: { ...status, label: 'Key art B' } })).toBe(
      'Ana (guest) approved Key art B on Pitch wall',
    )
    expect(chatMessageSentence({ ...base, review: { ...status, status: 'changes_requested' } })).toBe(
      'Ana (guest) requested changes on an item on Pitch wall',
    )
    expect(chatMessageSentence({ ...base, review: { ...status, status: 'pending' } })).toBe(
      'Ana (guest) set an item on Pitch wall back to Awaiting review',
    )
    expect(
      chatMessageSentence({ ...base, review: { ...status, status: 'pending', reason: 'new_version' } }),
    ).toBe('Ana (guest) uploaded a new version of an item on Pitch wall: awaiting review')
    expect(chatMessageSentence({ ...base, review: { event: 'round_opened', itemCount: 6 } })).toBe(
      'Ana (guest) started a review round on Pitch wall (6 items)',
    )
    expect(
      chatMessageSentence({ ...base, review: { event: 'round_opened', itemCount: 1, label: 'Round 2' } }),
    ).toBe('Ana (guest) started Round 2 on Pitch wall (1 item)')
    const long = chatMessageSentence({ ...base, review: { ...status, label: 'x'.repeat(200) } })
    expect(long).toContain(`${'x'.repeat(59)}…`)
    expect(long).not.toContain('x'.repeat(60))
    expect(chatMessageSentence(base)).toBe('Ana (guest) updated a review on Pitch wall')
  })

  it('a label is text in Slack, never markup', () => {
    const p = slackPayload({
      ...base,
      review: { event: 'status', status: 'approved', reason: 'set', label: '<!channel>' },
    })
    expect(JSON.stringify(p)).not.toContain('<!channel>')
    expect(JSON.stringify(p)).toContain('&lt;!channel&gt;')
  })
})
