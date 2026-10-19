// The cross-browser smoke's page-error collector (./page-errors.ts): WebKit's ResizeObserver loop notice, exactly as
// WebKit reports it, is left out; everything else, and anything merely like it, still counts.
import { EventEmitter } from 'node:events'
import type { Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { isBenignPageError, pageErrors } from './page-errors.ts'

const RO = 'ResizeObserver loop completed with undelivered notifications.'

/** A page stand-in: only `on('pageerror', ...)` is used by the collector. */
function fakePage() {
  const emitter = new EventEmitter()
  const page = { on: (event: string, fn: (e: unknown) => void) => emitter.on(event, fn) } as unknown as Page
  return { page, raise: (name: string, message: string) => emitter.emit('pageerror', { name, message }) }
}

describe('the smoke page-error collector', () => {
  it('leaves out WebKit ResizeObserver loop notice, as WebKit reports it (no name)', () => {
    const { page, raise } = fakePage()
    const errors = pageErrors(page)
    raise('', RO)
    raise('', RO)
    expect(errors).toEqual([])
  })

  it('still counts every other error, and anything only like the notice', () => {
    const { page, raise } = fakePage()
    const errors = pageErrors(page)
    raise('TypeError', 'undefined is not a function')
    raise('Error', RO) // a thrown Error with that text is not the browser notice
    raise('', 'ResizeObserver loop completed with undelivered notifications') // no full stop
    raise('', `${RO} `)
    raise('', 'ResizeObserver loop limit exceeded')
    raise('', 'Script error.')
    expect(errors).toEqual([
      'TypeError: undefined is not a function',
      `Error: ${RO}`,
      ': ResizeObserver loop completed with undelivered notifications',
      `: ${RO} `,
      ': ResizeObserver loop limit exceeded',
      ': Script error.',
    ])
    expect(isBenignPageError({ name: '', message: RO })).toBe(true)
  })
})
