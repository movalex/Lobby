// Security audit L5: the sync's log sites pass {name, message, code}, never the error object (its stack and
// properties). The sites: http/router.ts `[http error]`, http/internal.ts `[access] re-check error`, app.ts
// `room open failed`, rooms.ts `[room warn]` / `[room error]` (tldraw sync-core's forwarded arguments).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { errorSummary, logSafe } from './log-error.ts'

describe('errorSummary (L5)', () => {
  it('keeps the name, the message and a string or number code, nothing else', () => {
    const sqlite = Object.assign(new Error('unable to open database file'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 14,
      stack: 'Error: unable to open database file\n    at C:\\Users\\someone\\boards\\b-1.sqlite:1:1',
    })
    const s = errorSummary(sqlite)
    expect(s).toEqual({ name: 'Error', message: 'unable to open database file', code: 'ERR_SQLITE_ERROR' })
    expect(Object.keys(s)).toEqual(['name', 'message', 'code'])
    expect(JSON.stringify(s)).not.toContain('Users')
    const numeric = Object.assign(new TypeError('x'), { code: 7 })
    expect(errorSummary(numeric)).toEqual({ name: 'TypeError', message: 'x', code: '7' })
    expect(errorSummary(new RangeError('no code'))).toEqual({ name: 'RangeError', message: 'no code' })
  })

  it('a non-Error throw is summarised too; a long message is cut', () => {
    expect(errorSummary('boom')).toEqual({ name: 'string', message: 'boom' })
    expect(errorSummary(undefined)).toEqual({ name: 'undefined', message: 'undefined' })
    expect(errorSummary(new Error('m'.repeat(1_000))).message.length).toBe(300)
  })

  it('logSafe summarises an Error argument and passes anything else through', () => {
    const e = new Error('e')
    expect(logSafe(e)).toEqual({ name: 'Error', message: 'e' })
    expect(logSafe('text')).toBe('text')
    expect(logSafe(42)).toBe(42)
  })

  it('no sync log site passes a caught error object any more (the audit\u2019s four sites)', () => {
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
    expect(src('./http/router.ts')).toContain("deps.log('[http error]', req.method, path, errorSummary(e))")
    expect(src('./http/internal.ts')).toContain("deps.log('[access] re-check error', errorSummary(e))")
    expect(src('./app.ts')).toContain("log('room open failed', boardId, errorSummary(e))")
    for (const p of ['./http/router.ts', './http/internal.ts', './app.ts'])
      expect(src(p), p).not.toMatch(/log\((?:[^()]|\([^()]*\))*\b(?:e|err|error)\)/)
  })
})
