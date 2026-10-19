// The wave V foundation's contracts (docs/WAVE-V-CONTRACTS.md): the kill switches and rules shared by the wave, live
// activities (polls, scales, word clouds: the text rules, the setup and answer bounds, the pure tallies), breakouts,
// join codes, the join-cap fix's constants, the event names, the optional open-state parts and the pending palette ids.
// The element kinds against the frozen readers are in packages/canvas-schema/src/wave-v-kinds.test.ts.
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_FACILITATOR_ROUTE_KEYS,
  ACTIVITY_LIMITS,
  ACTIVITY_ROUTE_KEYS,
  ACTIVITY_RULES,
  ACTIVITY_TALLY_WINDOW_MS,
  ActivityAnswer,
  ActivityPrompt,
  ActivityResults,
  ActivityState,
  AnswerActivityInput,
  AssignBreakoutInput,
  AuthConfig,
  activityActionPath,
  activityPath,
  activityTallyWindowMs,
  answerProblem,
  BREAKOUT_EVENTS,
  BREAKOUT_FACILITATOR_ROUTE_KEYS,
  BREAKOUT_LIMITS,
  BREAKOUT_ROUTE_KEYS,
  BREAKOUT_RULES,
  BreakoutBroadcastInput,
  BreakoutGroupId,
  BreakoutGroupName,
  type BreakoutState,
  breakoutActionPath,
  breakoutGroupId,
  breakoutSummonApplies,
  formatJoinCode,
  GUEST_JOINS_PER_ADDRESS,
  GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS,
  GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK,
  GUEST_JOINS_PER_LINK,
  GUEST_JOINS_PER_WORKSHOP_LINK,
  GUESTS_PER_LINK,
  HideWordInput,
  hasForbiddenActivityChar,
  isNewerBreakoutState,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_CREATOR_ROUTE_KEYS,
  JOIN_CODE_LENGTH,
  JOIN_CODE_ROUTE_KEYS,
  JoinCode,
  joinCodeCreatePath,
  joinCodeFromBytes,
  joinCodeResolvePath,
  joinCodeWebPath,
  LIVE_ACTIVITY_EVENTS,
  LIVE_ELEMENT_KINDS,
  LIVE_SWITCH_ENV,
  LIVE_SWITCHES,
  LIVE_SWITCHES_OFF,
  LiveActivity,
  LiveSwitches,
  normalizeJoinCode,
  normalizeWord,
  OPEN_STATE_PARTS,
  OPEN_STATE_PENDING_PARTS,
  OpenStateBody,
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
  PollConfig,
  PollOptionText,
  ResolvedJoinCode,
  ReviewLinkCreated,
  rankActivityResults,
  ScaleConfig,
  ScaleLabel,
  StartActivityInput,
  StartBreakoutsInput,
  tallyPoll,
  tallyScale,
  tallyWords,
  WAVE_V_PALETTE_COMMAND_IDS,
  WORKSHOP_EVENTS,
  WordsAnswer,
  WordsConfig,
  WordText,
  WorkshopActivityEvent,
  WorkshopActivityResultsEvent,
  WorkshopBreakoutBroadcastEvent,
} from './index.ts'

const cp = (n: number) => String.fromCodePoint(n)
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success
const U1 = 'usr_0123456789'
const U2 = 'usr_abcdefghij'
const AID = 'act_0123456789abcdefghij'
const BRK = 'brk_0123456789abcdefghij'

describe('the wave V switches and rules', () => {
  it('three api switches, each with its env name; AuthConfig.live is optional (an older api sends none)', () => {
    expect([...LIVE_SWITCHES]).toEqual(['activities', 'joinCodes', 'breakouts'])
    expect(LIVE_SWITCH_ENV).toEqual({
      activities: 'DRAFTROOM_LIVE_ACTIVITIES',
      joinCodes: 'DRAFTROOM_JOIN_CODES',
      breakouts: 'DRAFTROOM_BREAKOUTS',
    })
    expect(Object.values(LIVE_SWITCHES_OFF).every((v) => v === false)).toBe(true)
    expect(Object.keys(LIVE_SWITCHES_OFF).sort()).toEqual([...LIVE_SWITCHES].sort())
    expect(AuthConfig.parse({ providers: ['dev'] }).live).toBeUndefined()
    const on = { activities: true, joinCodes: false, breakouts: true }
    expect(AuthConfig.parse({ providers: ['dev'], live: on }).live).toEqual(on)
    // not strict: a later switch is additive for this web
    expect(ok(LiveSwitches, { ...on, later: true })).toBe(true)
    expect(ok(LiveSwitches, { activities: true })).toBe(false)
  })

  it('the element kinds are short lowercase words (canvas-schema KindValue)', () => {
    for (const k of Object.values(LIVE_ELEMENT_KINDS)) expect(k).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
    expect(Object.values(LIVE_ELEMENT_KINDS)).toEqual(['poll-chart', 'word-cloud', 'breakout-frame'])
  })

  it('the event names are new, under workshop., and listed in WORKSHOP_EVENTS', () => {
    const names = [...Object.values(LIVE_ACTIVITY_EVENTS), ...Object.values(BREAKOUT_EVENTS)]
    expect(names).toEqual([
      'workshop.activity',
      'workshop.activity.results',
      'workshop.breakout',
      'workshop.breakout.broadcast',
      'workshop.breakout.summon',
    ])
    const all = Object.values(WORKSHOP_EVENTS) as string[]
    for (const n of names) expect(all, n).toContain(n)
    expect(new Set(all).size).toBe(all.length)
  })

  it('the open-state parts of wave V are optional and answered (in OPEN_STATE_PARTS since the integration)', () => {
    expect(OPEN_STATE_PARTS as readonly string[]).toContain('activity')
    expect(OPEN_STATE_PARTS as readonly string[]).toContain('breakouts')
    expect([...OPEN_STATE_PENDING_PARTS]).toEqual([])
    const allNull = Object.fromEntries(OPEN_STATE_PARTS.map((p) => [p, null]))
    expect(OpenStateBody.safeParse(allNull).success).toBe(true)
    expect(OpenStateBody.safeParse({ ...allNull, activity: null, breakouts: null }).success).toBe(true)
    // an api before wave V sends neither: still a body
    const { activity: _a, breakouts: _b, ...older } = allNull
    expect(OpenStateBody.safeParse(older).success).toBe(true)
  })

  it('wave V palette commands are listed and none is pending (all registered since the integration)', () => {
    const landed: readonly string[] = [...WAVE_V_PALETTE_COMMAND_IDS]
    expect([...WAVE_V_PALETTE_COMMAND_IDS]).toEqual([
      'activities.start',
      'join.show-code',
      'breakouts.start',
      'session-summary.csv',
    ])
    for (const id of WAVE_V_PALETTE_COMMAND_IDS) {
      expect(PALETTE_COMMAND_IDS as readonly string[], id).toContain(id)
      if (landed.includes(id)) expect(PENDING_PALETTE_COMMAND_IDS as readonly string[], id).not.toContain(id)
      else expect(PENDING_PALETTE_COMMAND_IDS as readonly string[], id).toContain(id)
    }
  })
})

describe('live activity text', () => {
  it('a prompt is one line: whitespace collapses, 1 to 200 code points (an emoji or a CJK character counts one)', () => {
    expect(ActivityPrompt.parse('  What   went\nwell?\t ')).toBe('What went well?')
    expect(ok(ActivityPrompt, '   ')).toBe(false)
    expect(ok(ActivityPrompt, '😀'.repeat(200))).toBe(true)
    expect(ok(ActivityPrompt, '😀'.repeat(201))).toBe(false)
    expect(ok(ActivityPrompt, '漢'.repeat(200))).toBe(true)
    expect(ok(ActivityPrompt, 'a'.repeat(201))).toBe(false)
  })

  it('refuses control, bidi and zero-width characters (newlines and tabs only collapse)', () => {
    for (const bad of [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f, 0x202e, 0x2066, 0x200b, 0x200d, 0xfeff, 0x061c])
      expect(ok(WordText, `ab${cp(bad)}c`), bad.toString(16)).toBe(false)
    expect(WordText.parse(`a${cp(0x0a)}b`)).toBe('a b')
    expect(WordText.parse(`a${cp(0x3000)}b`)).toBe('a b')
  })

  it('takes ZWJ and ZWNJ where they join (emoji sequences, a Persian word) and the variation selectors; refuses them anywhere else (review m7)', () => {
    const s = (...cps: number[]) => String.fromCodePoint(...cps)
    const coder = s(0x1f469, 0x200d, 0x1f4bb) // a woman and a laptop
    const rainbow = s(0x1f3f3, 0xfe0f, 0x200d, 0x1f308) // the rainbow flag (with its variation selector)
    const family = s(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    const persian = s(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645) // "I want", with a ZWNJ
    const heart = s(0x2764, 0xfe0f)
    for (const text of [coder, rainbow, family, persian, heart, `${coder} Devs`, `${rainbow} Team`]) {
      for (const schema of [WordText, ActivityPrompt, PollOptionText, ScaleLabel, BreakoutGroupName])
        expect(schema.parse(text), text).toBe(text)
      expect(hasForbiddenActivityChar(text), text).toBe(false)
    }
    expect(ok(WordsAnswer, { kind: 'words', words: [coder, persian] })).toBe(true)
    // still refused: a joiner next to ASCII, a space or an end, two in a row, and every other invisible character
    for (const bad of [
      `Bo${s(0x200d)}b`,
      `Bo${s(0x200c)}b`,
      `${s(0x200d)}${s(0x1f4bb)}`,
      `${s(0x1f469)}${s(0x200d)}`,
      `${s(0x1f469)} ${s(0x200d)}${s(0x1f4bb)}`,
      `${s(0x1f469)}${s(0x200d, 0x200d)}${s(0x1f4bb)}`,
      `${s(0x1f469)}${s(0x200b)}${s(0x1f4bb)}`,
      `${s(0x1f469)}${s(0x202e)}${s(0x200d)}${s(0x1f4bb)}`,
      `a${s(0x2060)}b`,
    ]) {
      expect(ok(WordText, bad), JSON.stringify(bad)).toBe(false)
      expect(ok(BreakoutGroupName, bad), JSON.stringify(bad)).toBe(false)
    }
    expect(ok(WordText, `a${s(0xfeff)}b`)).toBe(false)
    // a group name folds every whitespace (the BOM counts as one there) into a plain space, as before
    expect(BreakoutGroupName.parse(`a${s(0xfeff)}b`)).toBe('a b')
  })

  it('a word is 1 to 30 code points, emoji and CJK included', () => {
    expect(ok(WordText, '🎉'.repeat(30))).toBe(true)
    expect(ok(WordText, '🎉'.repeat(31))).toBe(false)
    expect(ok(WordText, '協力'.repeat(15))).toBe(true)
    expect(ok(WordText, 'x'.repeat(31))).toBe(false)
    expect(ok(WordText, '')).toBe(false)
  })

  it('normalizeWord groups case, NFKC forms and whitespace, and keeps scripts apart', () => {
    expect(normalizeWord('Agile')).toBe('agile')
    expect(normalizeWord('  AGILE ')).toBe('agile')
    expect(normalizeWord('ＡＧＩＬＥ')).toBe('agile') // fullwidth
    expect(normalizeWord('ﬁne')).toBe('fine') // the fi ligature
    expect(normalizeWord('team   spirit')).toBe('team spirit')
    expect(normalizeWord('Café')).toBe(normalizeWord('Cafe\u0301'))
    expect(normalizeWord('協力')).toBe('協力')
    expect(normalizeWord('🎉')).toBe('🎉')
  })
})

describe('live activity setup', () => {
  it('a poll has 2 to 12 distinct options of up to 80 code points, and at most as many choices as options', () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => `Option ${i + 1}`)
    expect(ok(PollConfig, { options: opts(1) })).toBe(false)
    expect(ok(PollConfig, { options: opts(2) })).toBe(true)
    expect(ok(PollConfig, { options: opts(12) })).toBe(true)
    expect(ok(PollConfig, { options: opts(13) })).toBe(false)
    expect(PollConfig.parse({ options: opts(3) }).maxChoices).toBe(1)
    expect(ok(PollConfig, { options: opts(3), maxChoices: 3 })).toBe(true)
    expect(ok(PollConfig, { options: opts(3), maxChoices: 4 })).toBe(false)
    expect(ok(PollConfig, { options: ['Yes', ' yes '] })).toBe(false)
    expect(ok(PollConfig, { options: ['Yes', 'x'.repeat(81)] })).toBe(false)
    expect(ok(PollConfig, { options: ['Yes', 'No'], extra: 1 })).toBe(false)
  })

  it('a scale is 1-5, 1-7 or 0-10, with optional end labels of up to 40 code points', () => {
    for (const [min, max] of [
      [1, 5],
      [1, 7],
      [0, 10],
    ])
      expect(ok(ScaleConfig, { min, max }), `${min}-${max}`).toBe(true)
    for (const [min, max] of [
      [0, 5],
      [1, 10],
      [1, 6],
      [2, 7],
    ])
      expect(ok(ScaleConfig, { min, max }), `${min}-${max}`).toBe(false)
    expect(ScaleConfig.parse({ min: 1, max: 5 })).toEqual({ min: 1, max: 5, minLabel: null, maxLabel: null })
    expect(ok(ScaleConfig, { min: 1, max: 5, minLabel: 'x'.repeat(41) })).toBe(false)
  })

  it('a word cloud takes 1 to 5 words a person (3 by default)', () => {
    expect(WordsConfig.parse({}).maxWords).toBe(3)
    expect(ok(WordsConfig, { maxWords: 0 })).toBe(false)
    expect(ok(WordsConfig, { maxWords: 5 })).toBe(true)
    expect(ok(WordsConfig, { maxWords: 6 })).toBe(false)
  })

  it('the start input is strict, anonymous by default, results not live, no end time unless asked', () => {
    const v = StartActivityInput.parse({ kind: 'words', prompt: 'One word for today', config: {} })
    expect(v).toMatchObject({
      anonymous: true,
      resultsLive: false,
      durationMs: null,
      config: { maxWords: 3 },
    })
    expect(ok(StartActivityInput, { kind: 'words', prompt: 'x', config: {}, actor: U1 })).toBe(false)
    expect(ok(StartActivityInput, { kind: 'quiz', prompt: 'x', config: {} })).toBe(false)
    expect(ok(StartActivityInput, { kind: 'poll', prompt: 'x', config: { maxWords: 3 } })).toBe(false)
    for (const [ms, good] of [
      [ACTIVITY_LIMITS.durationMinMs - 1, false],
      [ACTIVITY_LIMITS.durationMinMs, true],
      [ACTIVITY_LIMITS.durationMaxMs, true],
      [ACTIVITY_LIMITS.durationMaxMs + 1, false],
    ] as const)
      expect(
        ok(StartActivityInput, { kind: 'words', prompt: 'x', config: {}, durationMs: ms }),
        String(ms),
      ).toBe(good)
  })
})

describe('live activity answers', () => {
  const poll = {
    kind: 'poll' as const,
    config: PollConfig.parse({ options: ['A', 'B', 'C'], maxChoices: 2 }),
  }
  const scale = { kind: 'scale' as const, config: ScaleConfig.parse({ min: 1, max: 5 }) }
  const words = { kind: 'words' as const, config: WordsConfig.parse({ maxWords: 2 }) }

  it('the schema holds each value; answerProblem holds it to the activity', () => {
    expect(ok(AnswerActivityInput, { answer: { kind: 'poll', choices: [0, 0] } })).toBe(false)
    expect(ok(AnswerActivityInput, { answer: { kind: 'poll', choices: [] } })).toBe(false)
    expect(ok(AnswerActivityInput, { answer: { kind: 'scale', value: 3 }, userId: U1 })).toBe(false)
    expect(ok(ActivityAnswer, { kind: 'words', words: ['Agile', 'agile'] })).toBe(false)
    const a = (v: unknown) => ActivityAnswer.parse(v)
    expect(answerProblem(poll, a({ kind: 'poll', choices: [0, 2] }))).toBeNull()
    expect(answerProblem(poll, a({ kind: 'poll', choices: [3] }))).toMatch(/does not exist/)
    expect(answerProblem(poll, a({ kind: 'poll', choices: [0, 1, 2] }))).toMatch(/at most 2/)
    expect(answerProblem(scale, a({ kind: 'scale', value: 0 }))).toMatch(/1 to 5/)
    expect(answerProblem(scale, a({ kind: 'scale', value: 5 }))).toBeNull()
    expect(answerProblem(words, a({ kind: 'words', words: ['a', 'b', 'c'] }))).toMatch(/at most 2/)
    expect(answerProblem(words, a({ kind: 'scale', value: 1 }))).toMatch(/another kind/)
  })

  it('tallyPoll counts each person once per option, zeros kept, in option order', () => {
    expect(tallyPoll(3, [[0], [0, 2], [2], [2, 2]])).toEqual({ kind: 'poll', answered: 4, counts: [2, 0, 3] })
    expect(rankActivityResults([2, 0, 3, 2])).toEqual([
      { option: 2, count: 3, rank: 1 },
      { option: 0, count: 2, rank: 2 },
      { option: 3, count: 2, rank: 2 },
      { option: 1, count: 0, rank: 4 },
    ])
  })

  it('tallyScale: a histogram, the mean and the median (the middle two averaged)', () => {
    expect(tallyScale(1, 5, [])).toEqual({
      kind: 'scale',
      answered: 0,
      counts: [0, 0, 0, 0, 0],
      mean: null,
      median: null,
    })
    expect(tallyScale(1, 5, [1, 2, 4, 5])).toEqual({
      kind: 'scale',
      answered: 4,
      counts: [1, 1, 0, 1, 1],
      mean: 3,
      median: 3,
    })
    expect(tallyScale(0, 10, [10, 9, 2])).toMatchObject({
      mean: 7,
      median: 9,
      counts: [0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1],
    })
    expect(tallyScale(1, 7, [1, 2, 2]).mean).toBe(1.67)
  })

  it('tallyWords groups spellings, counts a person once, shows the most frequent spelling, hides words, is stable', () => {
    const answers = [['Agile', 'Trust'], ['agile'], ['agile', 'AGILE '], ['Trust'], ['ＡＧＩＬＥ'], ['zeal']]
    const r = tallyWords(answers)
    expect(r).toEqual({
      kind: 'words',
      answered: 6,
      words: [
        { text: 'agile', count: 4 },
        { text: 'Trust', count: 2 },
        { text: 'zeal', count: 1 },
      ],
      distinct: 3,
      hidden: 0,
    })
    // a tie between spellings: code-point order ('A' < 'a')
    expect(tallyWords([['agile'], ['Agile']])).toMatchObject({ words: [{ text: 'Agile', count: 2 }] })
    // hidden by any spelling; counted as hidden, never shown
    expect(tallyWords(answers, ['TRUST'])).toMatchObject({ distinct: 2, hidden: 1 })
    // ties between words: code-point order of the shown text; the limit cuts the list, not `distinct`
    const many = tallyWords([['b'], ['a'], ['c']], [], 2)
    expect(many).toMatchObject({ words: [{ text: 'a' }, { text: 'b' }], distinct: 3 })
    // the same input in another order gives the same answer
    expect(tallyWords([...answers].reverse())).toEqual(r)
  })

  it('results and events are aggregates: no key that could name a person', () => {
    const PERSONAL = /^(userId|user|name|by|author|authors|who|voters|participants|ids)$/
    const keysOf = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) for (const x of v) keysOf(x, out)
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          out.push(k)
          keysOf(x, out)
        }
      return out
    }
    const activity = LiveActivity.parse({
      kind: 'words',
      config: { maxWords: 3 },
      id: AID,
      boardId: 'b-0123456789',
      prompt: 'One word',
      anonymous: true,
      resultsLive: true,
      status: 'open',
      createdBy: U1,
      createdAt: '2026-10-18T10:00:00.000Z',
      endsAt: null,
      closedAt: null,
      revealedAt: null,
      placedAt: null,
    })
    const results = ActivityResults.parse(tallyWords([['Agile'], ['Trust']]))
    const event = WorkshopActivityEvent.parse({ activity, answered: 2, results })
    const final = WorkshopActivityResultsEvent.parse({ activityId: AID, results })
    for (const [body, ids] of [
      [results, []],
      [event, [U1]],
      [final, []],
    ] as const) {
      for (const k of keysOf(body)) expect(k).not.toMatch(PERSONAL)
      // the only account id anywhere is the starter's (a facilitator, never a participant)
      expect(JSON.stringify(body).match(/usr_[0-9A-Za-z]+/g) ?? []).toEqual(ids)
    }
    // the caller's state carries their own answer only
    expect(Object.keys(ActivityState.shape).sort()).toEqual(
      [
        'activity',
        'answered',
        'canManage',
        'hiddenWords',
        'myAnswer',
        'results',
        'serverNow',
        'starterLeft',
      ].sort(),
    )
  })

  it('the tally window: 1 s only for a named activity without live results, else 5 s', () => {
    expect(activityTallyWindowMs({ anonymous: false, resultsLive: false })).toBe(
      ACTIVITY_TALLY_WINDOW_MS.named,
    )
    expect(activityTallyWindowMs({ anonymous: false, resultsLive: true })).toBe(5_000)
    expect(activityTallyWindowMs({ anonymous: true, resultsLive: false })).toBe(5_000)
    expect(activityTallyWindowMs({ anonymous: true, resultsLive: true })).toBe(5_000)
  })

  it('a word to hide is a word; the routes, rules and paths', () => {
    expect(HideWordInput.parse({ word: ' Agile ' })).toEqual({ word: 'Agile', hidden: true })
    expect(new Set(ACTIVITY_ROUTE_KEYS).size).toBe(ACTIVITY_ROUTE_KEYS.length)
    expect(Object.keys(ACTIVITY_RULES).sort()).toEqual([...ACTIVITY_ROUTE_KEYS].sort())
    expect([...ACTIVITY_FACILITATOR_ROUTE_KEYS].sort()).toEqual(
      [
        'POST /api/boards/:bid/activities',
        'POST /api/activities/:aid/close',
        'POST /api/activities/:aid/reveal',
        'POST /api/activities/:aid/extend',
        'POST /api/activities/:aid/cancel',
        'POST /api/activities/:aid/hide',
        'POST /api/activities/:aid/placed',
        'GET /api/activities/:aid/answers',
      ].sort(),
    )
    expect(activityPath('b-1 x')).toBe('/api/boards/b-1%20x/activity')
    expect(activityActionPath(AID, 'reveal')).toBe(`/api/activities/${AID}/reveal`)
  })
})

describe('breakouts', () => {
  const groups = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `Group ${i + 1}`, frameId: `shape:f${i}` }))

  it('2 to 20 groups, each with its own frame; a cap only when people choose', () => {
    expect(ok(StartBreakoutsInput, { groups: groups(1), mode: 'auto' })).toBe(false)
    expect(ok(StartBreakoutsInput, { groups: groups(2), mode: 'auto' })).toBe(true)
    expect(ok(StartBreakoutsInput, { groups: groups(20), mode: 'manual' })).toBe(true)
    expect(ok(StartBreakoutsInput, { groups: groups(21), mode: 'auto' })).toBe(false)
    const same = [groups(2)[0], { name: 'Two', frameId: 'shape:f0' }]
    expect(ok(StartBreakoutsInput, { groups: same, mode: 'auto' })).toBe(false)
    expect(ok(StartBreakoutsInput, { groups: groups(2), mode: 'choose', groupCap: 5 })).toBe(true)
    expect(ok(StartBreakoutsInput, { groups: groups(2), mode: 'auto', groupCap: 5 })).toBe(false)
    expect(
      ok(StartBreakoutsInput, {
        groups: [{ name: 'x'.repeat(41), frameId: 'shape:a' }, groups(2)[1]],
        mode: 'auto',
      }),
    ).toBe(false)
    expect(ok(StartBreakoutsInput, { groups: groups(2), mode: 'auto', actor: U1 })).toBe(false)
  })

  it('group ids are g1 to g20', () => {
    expect(breakoutGroupId(0)).toBe('g1')
    expect(breakoutGroupId(BREAKOUT_LIMITS.groupsMax - 1)).toBe('g20')
    for (const good of ['g1', 'g9', 'g10', 'g19', 'g20']) expect(ok(BreakoutGroupId, good), good).toBe(true)
    for (const bad of ['g0', 'g21', 'g01', 'G1', 'g', 'grp_1'])
      expect(ok(BreakoutGroupId, bad), bad).toBe(false)
  })

  it('a group summon applies only to that group of that session, never to its summoner', () => {
    const ev = { sessionId: BRK, userId: U1, groupId: 'g2' }
    expect(breakoutSummonApplies(ev, { userId: U2, sessionId: BRK, groupId: 'g2' })).toBe(true)
    expect(breakoutSummonApplies(ev, { userId: U2, sessionId: BRK, groupId: 'g1' })).toBe(false)
    expect(breakoutSummonApplies(ev, { userId: U2, sessionId: BRK, groupId: null })).toBe(false)
    expect(
      breakoutSummonApplies(ev, { userId: U2, sessionId: 'brk_another000000000000', groupId: 'g2' }),
    ).toBe(false)
    expect(breakoutSummonApplies(ev, { userId: U2, sessionId: null, groupId: 'g2' })).toBe(false)
    expect(breakoutSummonApplies(ev, { userId: U1, sessionId: BRK, groupId: 'g2' })).toBe(false)
  })

  it('a newer state replaces an older one of the same session only', () => {
    const s = (id: string, rev: number) =>
      ({ session: { id, rev } }) as unknown as Pick<BreakoutState, 'session'>
    expect(isNewerBreakoutState(null, s(BRK, 0))).toBe(true)
    expect(isNewerBreakoutState(s(BRK, 3), s(BRK, 2))).toBe(false)
    expect(isNewerBreakoutState(s(BRK, 3), s(BRK, 3))).toBe(true)
    expect(isNewerBreakoutState(s(BRK, 3), s('brk_other00000000000000', 0))).toBe(true)
    expect(isNewerBreakoutState(s(BRK, 3), { session: null })).toBe(true)
    expect(isNewerBreakoutState(s(BRK, 3), null)).toBe(false)
  })

  it('moves name each person once; a broadcast is one line of up to 200 code points', () => {
    expect(ok(AssignBreakoutInput, { moves: [{ userId: U1, groupId: 'g1' }] })).toBe(true)
    expect(
      ok(AssignBreakoutInput, {
        moves: [
          { userId: U1, groupId: 'g1' },
          { userId: U1, groupId: 'g2' },
        ],
      }),
    ).toBe(false)
    expect(BreakoutBroadcastInput.parse({ text: ' Five\nminutes ', groupId: null }).text).toBe('Five minutes')
    expect(ok(BreakoutBroadcastInput, { text: 'x'.repeat(201), groupId: null })).toBe(false)
    expect(ok(BreakoutBroadcastInput, { text: `a${cp(0x202e)}b`, groupId: 'g1' })).toBe(false)
    expect(
      ok(WorkshopBreakoutBroadcastEvent, {
        sessionId: BRK,
        text: 'hi',
        from: { userId: U1, name: 'Ann' },
        groupId: 'g1',
        at: '2026-10-18T10:00:00.000Z',
      }),
    ).toBe(true)
  })

  it('the routes and rules; a guest is refused every facilitator route', () => {
    expect(Object.keys(BREAKOUT_RULES).sort()).toEqual([...BREAKOUT_ROUTE_KEYS].sort())
    expect([...BREAKOUT_FACILITATOR_ROUTE_KEYS].sort()).toEqual(
      BREAKOUT_ROUTE_KEYS.filter(
        (k) => !['GET /api/boards/:bid/breakouts', 'POST /api/breakouts/:brk/join'].includes(k),
      ).sort(),
    )
    expect(breakoutActionPath(BRK, 'summon')).toBe(`/api/breakouts/${BRK}/summon`)
  })
})

describe('join codes', () => {
  it('Crockford base 32: 32 distinct characters, no I, L, O or U', () => {
    expect(JOIN_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(JOIN_CODE_ALPHABET).size).toBe(32)
    for (const c of 'ILOU') expect(JOIN_CODE_ALPHABET).not.toContain(c)
    expect(JOIN_CODE_LENGTH).toBe(8)
  })

  it('40 bits make the code; known vectors', () => {
    expect(joinCodeFromBytes(new Uint8Array([0, 0, 0, 0, 0]))).toBe('00000000')
    expect(joinCodeFromBytes(new Uint8Array([255, 255, 255, 255, 255, 9]))).toBe('ZZZZZZZZ')
    // 0x0123456789: the 5-bit groups 0 4 17 20 10 25 28 9
    expect(joinCodeFromBytes(new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89]))).toBe('04HMASW9')
    expect(() => joinCodeFromBytes(new Uint8Array(4))).toThrow()
  })

  it('reads a code case- and dash-insensitively, I and L as 1, O as 0; anything else is null', () => {
    expect(normalizeJoinCode('abcd-2345')).toBe('ABCD2345')
    expect(normalizeJoinCode(' AB CD 23 45 ')).toBe('ABCD2345')
    expect(normalizeJoinCode('oiL0-1234')).toBe('01101234')
    expect(normalizeJoinCode('ABCD-234')).toBeNull()
    expect(normalizeJoinCode('ABCD-23456')).toBeNull()
    expect(normalizeJoinCode('ABCU-2345')).toBeNull()
    expect(normalizeJoinCode('ABCD_2345')).toBeNull()
    expect(normalizeJoinCode('x'.repeat(40))).toBeNull()
    expect(formatJoinCode('ABCD2345')).toBe('ABCD-2345')
  })

  it('shapes, routes and paths', () => {
    expect(
      ok(JoinCode, {
        code: 'ABCD2345',
        display: 'ABCD-2345',
        joinUrl: 'https://lobby.example/j/ABCD2345',
        expiresAt: '2026-10-18T13:00:00.000Z',
      }),
    ).toBe(true)
    expect(ok(JoinCode, { code: 'abcd2345', display: '', joinUrl: '', expiresAt: '' })).toBe(false)
    expect(ok(ResolvedJoinCode, { token: 'x'.repeat(43) })).toBe(true)
    expect([...JOIN_CODE_ROUTE_KEYS]).toEqual([
      'POST /api/boards/:bid/review-links/:id/code',
      'GET /api/join/:code',
    ])
    expect([...JOIN_CODE_CREATOR_ROUTE_KEYS]).toEqual(['POST /api/boards/:bid/review-links/:id/code'])
    expect(joinCodeCreatePath('b-1', 'inv_1')).toBe('/api/boards/b-1/review-links/inv_1/code')
    expect(joinCodeResolvePath('ABCD2345')).toBe('/api/join/ABCD2345')
    expect(joinCodeWebPath('ABCD2345')).toBe('/j/ABCD2345')
    // an older web strips the optional joinCode of a link
    const link = {
      id: 'inv_0123456789abcdefghij',
      url: 'https://lobby.example/invite/x',
      role: 'editor',
      expiresAt: '2026-10-18T13:00:00.000Z',
      maxUses: null,
    }
    expect(ReviewLinkCreated.parse(link).joinCode).toBeUndefined()
  })
})

describe('the join-cap fix (R1) constants', () => {
  it('a workshop link lets a whole room in; the other windows are unchanged', () => {
    expect(GUEST_JOINS_PER_WORKSHOP_LINK.max).toBe(GUESTS_PER_LINK)
    expect(GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK.max).toBe(GUESTS_PER_LINK)
    expect(GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS.max).toBe(2 * GUESTS_PER_LINK)
    for (const w of [
      GUEST_JOINS_PER_WORKSHOP_LINK,
      GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK,
      GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS,
    ])
      expect(w.windowMs).toBe(10 * 60 * 1000)
    expect(GUEST_JOINS_PER_ADDRESS).toEqual({ max: 60, windowMs: 600_000 })
    expect(GUEST_JOINS_PER_LINK).toEqual({ max: 60, windowMs: 600_000 })
  })
})
