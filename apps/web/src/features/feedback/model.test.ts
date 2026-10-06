// The pure part of the Send feedback button: the context block, the limits and the words for failures.
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client.ts'
import { APP_BUILD } from './build-info.ts'
import {
  buildContext,
  type ContextSources,
  canSend,
  contextRows,
  countChars,
  FEEDBACK_TEXT_MAX,
  sendErrorMessage,
  toInput,
} from './model.ts'

const NOW = new Date('2026-10-05T10:20:30.456Z')
const sources = (over: Partial<ContextSources> = {}): ContextSources => ({
  pathname: '/w/wsp_abcdefghij/all',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0',
  width: 1440.4,
  height: 900,
  build: 'edf27c2',
  now: NOW,
  board: null,
  ...over,
})

describe('buildContext', () => {
  it('the page path, browser, window, build and time; no board off a board', () => {
    expect(buildContext(sources())).toEqual({
      path: '/w/wsp_abcdefghij/all',
      boardId: null,
      boardTitle: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0',
      viewport: { width: 1440, height: 900 },
      build: 'edf27c2',
      at: '2026-10-05T10:20:30.456Z',
    })
  })

  it('names the board by id and title when on one', () => {
    const c = buildContext(
      sources({ pathname: '/b/b-abc1234567', board: { id: 'b-abc1234567', title: 'Q4 plan' } }),
    )
    expect(c).toMatchObject({ path: '/b/b-abc1234567', boardId: 'b-abc1234567', boardTitle: 'Q4 plan' })
  })

  it('never carries a query string or a fragment, which can hold tokens', () => {
    expect(buildContext(sources({ pathname: '/b/b-abc1234567?token=secret#comment=1' })).path).toBe(
      '/b/b-abc1234567',
    )
    expect(buildContext(sources({ pathname: '/?returnTo=/b/x' })).path).toBe('/')
    expect(buildContext(sources({ pathname: '' })).path).toBe('/')
  })
})

describe('contextRows (what the dialog lists before sending)', () => {
  const fmt = (iso: string) => `at ${iso}`
  it('lists page, browser, window, build and time; the board only on a board', () => {
    expect(contextRows(buildContext(sources()), fmt).map((r) => [r.key, r.value])).toEqual([
      ['page', '/w/wsp_abcdefghij/all'],
      ['browser', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0'],
      ['viewport', '1440 × 900'],
      ['build', 'edf27c2'],
      ['time', 'at 2026-10-05T10:20:30.456Z'],
    ])
    const onBoard = contextRows(
      buildContext(sources({ board: { id: 'b-abc1234567', title: 'Q4 plan' } })),
      fmt,
    )
    expect(onBoard.find((r) => r.key === 'board')?.value).toBe('Q4 plan (b-abc1234567)')
  })

  it('every value that is sent is a value that is listed', () => {
    const c = buildContext(sources({ board: { id: 'b-abc1234567', title: 'Q4 plan' } }))
    const shown = contextRows(c, (iso) => iso)
      .map((r) => r.value)
      .join('\n')
    for (const sent of [c.path, c.boardId, c.boardTitle, c.userAgent, c.build, c.at])
      expect(shown, String(sent)).toContain(String(sent))
    expect(shown).toContain(`${c.viewport.width} × ${c.viewport.height}`)
  })
})

describe('what can be sent', () => {
  it('needs something to say, and nothing over the limit', () => {
    expect(canSend('', '')).toBe(false)
    expect(canSend('  \n ', '')).toBe(false)
    expect(canSend('It broke', '')).toBe(true)
    expect(canSend('It broke', 'e'.repeat(FEEDBACK_TEXT_MAX))).toBe(true)
    expect(canSend('It broke', 'e'.repeat(FEEDBACK_TEXT_MAX + 1))).toBe(false)
    expect(canSend('t'.repeat(FEEDBACK_TEXT_MAX), '')).toBe(true)
    expect(canSend('t'.repeat(FEEDBACK_TEXT_MAX + 1), '')).toBe(false)
    // padding is not counted, as on the api
    expect(canSend(`  ${'t'.repeat(FEEDBACK_TEXT_MAX)}  `, '')).toBe(true)
  })

  it('counts characters, not UTF-16 units: an emoji is one', () => {
    expect(countChars('abc')).toBe(3)
    expect(countChars('😀😀')).toBe(2)
    expect(canSend('😀'.repeat(FEEDBACK_TEXT_MAX), '')).toBe(true)
  })

  it('builds the request: trimmed text, an expectation only when there is one', () => {
    const context = buildContext(sources())
    expect(toInput('  It broke \n', '', context)).toEqual({ text: 'It broke', context })
    expect(toInput('It broke', '   ', context)).toEqual({ text: 'It broke', context })
    expect(toInput('It broke', ' It works ', context)).toEqual({
      text: 'It broke',
      expected: 'It works',
      context,
    })
  })
})

describe('sendErrorMessage', () => {
  const err = (kind: ConstructorParameters<typeof ApiError>[0], status: number, message: string) =>
    new ApiError(kind, status, 'CODE', message)

  it('says what happened and that what was written is still there', () => {
    expect(sendErrorMessage(err('network', 0, 'x'))).toMatch(/Can’t reach Lobby.*still here/)
    expect(sendErrorMessage(err('server', 500, 'x'))).toMatch(/problem.*still here/)
    expect(sendErrorMessage(err('unauthorized', 401, 'x'))).toMatch(/session has ended.*still here/)
    expect(sendErrorMessage(err('not-found', 404, 'Not found.'))).toMatch(/not available.*still here/)
    expect(sendErrorMessage(new Error('boom'))).toMatch(/still here/)
  })

  it('uses the server’s own words for a refusal it explains', () => {
    expect(sendErrorMessage(err('rate-limited', 429, 'You have sent a lot of feedback.'))).toBe(
      'You have sent a lot of feedback.',
    )
    expect(sendErrorMessage(err('invalid', 400, 'Tell us what happened: this can’t be empty.'))).toBe(
      'Tell us what happened: this can’t be empty.',
    )
  })

  it('never shows a stack or the error object', () => {
    expect(sendErrorMessage(new Error('secret internals'))).not.toContain('secret')
  })
})

describe('build-info', () => {
  it('reads "dev" where the build did not define a commit (tests, an undefined define)', () => {
    expect(APP_BUILD).toBe('dev')
  })
})
