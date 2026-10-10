// OWNER: W5 (wave M, M5-1; landed by the wave M foundation): the stub hands out nothing, so every feature's
// first fetch is what it was before wave M.
import { OPEN_STATE_PARTS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { takeOpenState } from './open-state.ts'

describe('takeOpenState (the foundation stub)', () => {
  it('returns undefined for every part of every board, every time', () => {
    for (const part of OPEN_STATE_PARTS) {
      expect(takeOpenState('b-main00001', part)).toBeUndefined()
      expect(takeOpenState('b-main00001', part)).toBeUndefined()
    }
  })

  it('makes no request', () => {
    const g = globalThis as { fetch?: unknown }
    const before = g.fetch
    let called = 0
    g.fetch = () => {
      called++
      return Promise.reject(new Error('no'))
    }
    try {
      takeOpenState('b-main00001', 'ai')
      expect(called).toBe(0)
    } finally {
      g.fetch = before
    }
  })
})
