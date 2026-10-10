// The wave M foundation's contracts (OWNER: W5 after the foundation): usage events, the open-state read,
// workspace templates, Ask across boards and the batched access recheck. Shapes, caps and the lists the
// other workstreams build on.
import { BOARD_ROLES } from '@draftroom/permissions'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_MANY_MAX_PAIRS,
  AccessManyRequest,
  AccessManyResponse,
  AddWorkspaceTemplateInput,
  AI_ACTIONS,
  AI_LEDGER_ACTION_PATTERN,
  AiStatus,
  BOARD_ID_PATTERN,
  FEEDBACK_PROMPT_GOOD_PREFIX,
  FEEDBACK_PROMPT_MOMENTS,
  FEEDBACK_TEXT_MAX,
  FeedbackInput,
  feedbackPromptGoodText,
  feedbackPromptIssuePrefill,
  InternalUsageQuery,
  InternalUsageResponse,
  isUsageEvent,
  OPEN_STATE_PARTS,
  OpenState,
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
  USAGE_AI_OPEN_KINDS,
  USAGE_BATCH_MAX_KEYS,
  USAGE_COUNT_CAP,
  USAGE_EVENT_PATTERN,
  USAGE_EVENTS,
  USAGE_FIXED_EVENTS,
  USAGE_PARAM_EVENTS,
  UsageBatch,
  type UsageEvent,
  UseWorkspaceTemplateInput,
  WORKSPACE_ASK_ELEMENT_ID_PATTERN,
  WORKSPACE_ASK_LEDGER_ACTION,
  WorkspaceAskRequest,
  WorkspaceAskResponse,
  WorkspaceTemplate,
  wsTemplateUsePath,
} from './index.ts'

describe('usage events (S3, M5-5)', () => {
  it('lists every event the plan names, each once, each matching the stored pattern', () => {
    expect(new Set(USAGE_EVENTS).size).toBe(USAGE_EVENTS.length)
    for (const e of USAGE_EVENTS) expect(USAGE_EVENT_PATTERN.test(e), e).toBe(true)
    const named: UsageEvent[] = [
      'palette.open:key',
      'palette.open:button',
      'palette.open:phone',
      'palette.run:command-palette.open',
      'palette.run:ai.askWorkspace',
      'palette.run:ws-templates.save',
      'mermaid.paste',
      'pieces.insert',
      'sort.run:colour',
      'runofshow.set',
      'present.justme',
      'present.everyone',
      'vote.join.banner',
      'spotlight.start',
      'template.pick:retrospective',
      'template.pick:workspace',
      'template.save',
      'ai.open:themes',
      'ai.ask.scope:board',
      'ai.ask.scope:all',
      'coach.shown',
      'coach.run',
      'feedback.prompt.shown',
      'feedback.prompt.good',
      'feedback.prompt.issue',
      'whatsnew.try:palette',
      'emptyhint.diagram',
      'emptyhint.palette',
      'selectionbar.style:note-colour',
      'open.cached',
      'open.cold',
      'timetravel.scrub',
      'timetravel.restore',
      'stalechunk.notice',
      'stalechunk.reload',
      'version.notice',
      'compass.click',
      'follow.pause',
    ]
    for (const e of named) expect(isUsageEvent(e), e).toBe(true)
  })

  it('is the fixed events plus every <name>:<value> of the parameter lists, and nothing else', () => {
    const params = Object.entries(USAGE_PARAM_EVENTS).flatMap(([n, vs]) => vs.map((v: string) => `${n}:${v}`))
    expect(USAGE_EVENTS).toEqual([...USAGE_FIXED_EVENTS, ...params])
    for (const bad of ['palette.run:nope', 'palette.run:', 'ai.open', 'template.pick:b-abc123', 'x', ''])
      expect(isUsageEvent(bad), bad).toBe(false)
  })

  it('palette commands are unique; the pending ones are listed; the AI kinds cover every AI action', () => {
    expect(new Set(PALETTE_COMMAND_IDS).size).toBe(PALETTE_COMMAND_IDS.length)
    for (const id of PENDING_PALETTE_COMMAND_IDS) expect(PALETTE_COMMAND_IDS).toContain(id)
    for (const a of AI_ACTIONS) expect(USAGE_AI_OPEN_KINDS as readonly string[]).toContain(a)
  })

  it('a batch: known events only, counts 1 to the cap, 1 to 40 events, nothing else in the body', () => {
    expect(UsageBatch.parse({ events: { 'coach.shown': 1, 'palette.open:key': USAGE_COUNT_CAP } })).toEqual({
      events: { 'coach.shown': 1, 'palette.open:key': USAGE_COUNT_CAP },
    })
    const bad = [
      { events: { 'coach.shown': 0 } },
      { events: { 'coach.shown': USAGE_COUNT_CAP + 1 } },
      { events: { 'coach.shown': 1.5 } },
      { events: { 'no.such.event': 1 } },
      { events: { 'coach.shown': 1, 'board:b-abc': 1 } },
      { events: {} },
      { events: { 'coach.shown': 1 }, userId: 'usr_0123456789' },
      { events: Object.fromEntries(USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS + 1).map((e) => [e, 1])) },
    ]
    for (const b of bad) expect(UsageBatch.safeParse(b).success, JSON.stringify(b).slice(0, 80)).toBe(false)
    const max = Object.fromEntries(USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS).map((e) => [e, 1]))
    expect(UsageBatch.safeParse({ events: max }).success).toBe(true)
  })

  it('internal usage: days 1-90 (default 7); rows hold day, event, role class and count only', () => {
    expect(InternalUsageQuery.parse({})).toEqual({ days: 7 })
    expect(InternalUsageQuery.parse({ days: '30' })).toEqual({ days: 30 })
    expect(InternalUsageQuery.safeParse({ days: '0' }).success).toBe(false)
    expect(InternalUsageQuery.safeParse({ days: '91' }).success).toBe(false)
    const row = { day: '2026-10-10', event: 'coach.shown', roleClass: 'member', count: 3 }
    expect(InternalUsageResponse.parse({ rows: [row] })).toEqual({ rows: [row] })
    expect(InternalUsageResponse.safeParse({ rows: [{ ...row, userId: 'usr_0123456789' }] }).success).toBe(
      false,
    )
    expect(InternalUsageResponse.safeParse({ rows: [{ ...row, roleClass: 'owner' }] }).success).toBe(false)
  })
})

describe('open-state (M5-1)', () => {
  it('has the eight parts the plan names, each nullable', () => {
    expect([...OPEN_STATE_PARTS].sort()).toEqual(Object.keys(OpenState.shape).sort())
    expect(OPEN_STATE_PARTS).toEqual([
      'exportPolicy',
      'outside',
      'sharing',
      'workshop',
      'presentation',
      'privateBrainstorm',
      'threads',
      'ai',
    ])
    const allNull = Object.fromEntries(OPEN_STATE_PARTS.map((p) => [p, null]))
    expect(OpenState.parse(allNull)).toEqual(allNull)
  })

  it('reuses the part routes’ own schemas (an AI status parses as the ai part)', () => {
    const ai: AiStatus = {
      enabled: false,
      reason: 'guest',
      canInsert: false,
      canSummarize: false,
      noticeAccepted: false,
      budget: null,
      settings: null,
    }
    const allNull = Object.fromEntries(OPEN_STATE_PARTS.map((p) => [p, null]))
    expect(OpenState.parse({ ...allNull, ai }).ai).toEqual(ai)
    expect(OpenState.shape.ai.unwrap()).toBe(AiStatus)
    expect(OpenState.safeParse({ ...allNull, ai: { enabled: 'yes' } }).success).toBe(false)
  })
})

describe('workspace templates (M8-3)', () => {
  it('add: a board id, a name, a category (default other); nothing else', () => {
    expect(AddWorkspaceTemplateInput.parse({ boardId: 'b-retro01', name: ' Our retro ' })).toEqual({
      boardId: 'b-retro01',
      name: 'Our retro',
      category: 'other',
    })
    for (const bad of [
      { boardId: 'B!', name: 'x' },
      { boardId: 'b-retro01', name: '' },
      { boardId: 'b-retro01', name: 'x'.repeat(81) },
      { boardId: 'b-retro01', name: 'x', category: 'sample' },
      { boardId: 'b-retro01', name: 'x', grants: [] },
    ])
      expect(AddWorkspaceTemplateInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('use: an optional project and title; a template lists who added it and when', () => {
    expect(UseWorkspaceTemplateInput.parse({})).toEqual({})
    expect(UseWorkspaceTemplateInput.parse({ projectId: null, title: 'Retro 12' })).toEqual({
      projectId: null,
      title: 'Retro 12',
    })
    expect(UseWorkspaceTemplateInput.safeParse({ keepSharing: true }).success).toBe(false)
    expect(
      WorkspaceTemplate.parse({
        boardId: 'b-retro01',
        name: 'Our retro',
        category: 'review',
        addedBy: { id: 'usr_0123456789', name: 'Alice' },
        addedAt: '2026-10-10T00:00:00.000Z',
      }).category,
    ).toBe('review')
    // a template whose author's account is gone (0030's added_by ON DELETE SET NULL) is still a template
    const orphan = {
      boardId: 'b-retro01',
      name: 'Our retro',
      category: 'review',
      addedBy: null,
      addedAt: '2026-10-10T00:00:00.000Z',
    }
    expect(WorkspaceTemplate.parse(orphan).addedBy).toBeNull()
    expect(WorkspaceTemplate.safeParse({ ...orphan, addedBy: undefined }).success).toBe(false)
    expect(wsTemplateUsePath('wsp_0123456789', 'b-retro01')).toBe(
      '/api/workspaces/wsp_0123456789/templates/b-retro01/use',
    )
  })
})

describe('Ask across boards (M8-2)', () => {
  it('a question of 1 to 300 characters; the answer cites boards and element ids', () => {
    expect(WorkspaceAskRequest.parse({ question: ' What did we decide? ' })).toEqual({
      question: 'What did we decide?',
    })
    expect(WorkspaceAskRequest.safeParse({ question: '' }).success).toBe(false)
    expect(WorkspaceAskRequest.safeParse({ question: 'x'.repeat(301) }).success).toBe(false)
    expect(WorkspaceAskRequest.safeParse({ question: 'x', boardIds: ['b-abc'] }).success).toBe(false)
    const answer = {
      answer: 'Ship on Friday [1].',
      found: 'yes',
      citations: [{ boardId: 'b-plan0001', boardTitle: 'Plan', elementIds: ['n1', 'shape:abc'] }],
      exportAllowed: false,
    }
    expect(WorkspaceAskResponse.parse(answer)).toEqual(answer)
    const bad = { ...answer, citations: [{ boardId: 'b-plan0001', boardTitle: 'Plan', elementIds: ['a,b'] }] }
    expect(WorkspaceAskResponse.safeParse(bad).success).toBe(false)
  })

  it('the ledger action fits the ledger pattern (element ids: apps/web workspace-ask/client.test.ts checks canvas-schema)', () => {
    expect(WORKSPACE_ASK_ELEMENT_ID_PATTERN.test('a,b')).toBe(false)
    expect(AI_LEDGER_ACTION_PATTERN.test(WORKSPACE_ASK_LEDGER_ACTION)).toBe(true)
  })
})

describe('the batched access recheck (M7-1)', () => {
  it('1 to 500 pairs of board and user ids; the answer has a role per pair and signedInSince per person', () => {
    const pair = { boardId: 'b-main00001', userId: 'usr_alice00000001' }
    expect(AccessManyRequest.parse({ pairs: [pair] })).toEqual({ pairs: [pair] })
    expect(AccessManyRequest.safeParse({ pairs: [] }).success).toBe(false)
    expect(
      AccessManyRequest.safeParse({ pairs: Array.from({ length: ACCESS_MANY_MAX_PAIRS + 1 }, () => pair) })
        .success,
    ).toBe(false)
    expect(AccessManyRequest.safeParse({ pairs: [{ ...pair, boardId: 'B!' }] }).success).toBe(false)
    const answer = {
      results: [
        { ...pair, role: 'editor' },
        { boardId: 'b-gone00001', userId: pair.userId, role: null },
      ],
      signedInSince: { [pair.userId]: 1_760_000_000_000 },
    }
    expect(AccessManyResponse.parse(answer)).toEqual(answer)
    expect(AccessManyResponse.safeParse({ ...answer, results: [{ ...pair, role: 'admin' }] }).success).toBe(
      false,
    )
  })

  it('uses the shared board id pattern and the board roles', () => {
    expect(AccessManyRequest.shape.pairs.element.shape.boardId.safeParse('b-main00001').success).toBe(
      BOARD_ID_PATTERN.test('b-main00001'),
    )
    for (const r of BOARD_ROLES)
      expect(
        AccessManyResponse.shape.results.element.shape.role.safeParse(r).success,
        `${r} is a board role`,
      ).toBe(true)
  })
})

describe('the end-of-moment feedback prompt (M2-5): text only, through POST /api/feedback as it is', () => {
  it('Good and the issue prefill name the moment in the text; a kind or moment key would be dropped', () => {
    expect(feedbackPromptGoodText('vote-reveal')).toBe('Good (after a vote reveal)')
    expect(feedbackPromptIssuePrefill('run-of-show-end')).toBe('After the run of show: ')
    for (const m of FEEDBACK_PROMPT_MOMENTS) {
      const good = feedbackPromptGoodText(m)
      expect(good.startsWith(FEEDBACK_PROMPT_GOOD_PREFIX)).toBe(true)
      expect(good.length).toBeLessThanOrEqual(FEEDBACK_TEXT_MAX)
      expect(feedbackPromptIssuePrefill(m).startsWith(FEEDBACK_PROMPT_GOOD_PREFIX)).toBe(false)
    }
    // why it is text: the input has no field for it, and the api's parse drops unknown keys without an error
    const parsed = FeedbackInput.parse({
      text: feedbackPromptGoodText('presentation-stop'),
      kind: 'praise',
      moment: 'x',
    })
    expect(parsed).toEqual({ text: 'Good (after a presentation)' })
  })
})
