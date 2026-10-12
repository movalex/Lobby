// Wave N (WS1, the review): the four speed parts' shipped values and a dev-auth page's overrides (./flags.ts).
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHUNKED_APPLY,
  DIFF_APPLY,
  SIZE_AWARE_LOD,
  SPEED_FLAGS,
  setSpeedFlagOverrides,
  speedFlag,
  WORKER_DECODE,
} from './flags.ts'

afterEach(() => {
  setSpeedFlagOverrides({})
})

describe('the speed parts (sync/flags.ts)', () => {
  it('ship as their gates allow: the worker decode and (wave N.1) the chunked install on, the other two off until their speed targets pass', () => {
    expect({ WORKER_DECODE, DIFF_APPLY, CHUNKED_APPLY, SIZE_AWARE_LOD }).toEqual({
      WORKER_DECODE: true,
      DIFF_APPLY: false,
      CHUNKED_APPLY: true,
      SIZE_AWARE_LOD: false,
    })
    for (const name of Object.keys(SPEED_FLAGS) as (keyof typeof SPEED_FLAGS)[])
      expect(speedFlag(name), name).toBe(SPEED_FLAGS[name])
  })

  it('a page’s overrides switch a part either way; unknown names and non-boolean values are ignored', () => {
    const taken = setSpeedFlagOverrides({
      DIFF_APPLY: true,
      WORKER_DECODE: false,
      CHUNKED_APPLY: 'yes',
      NOT_A_PART: true,
      toString: true,
    })
    expect(taken).toEqual({ DIFF_APPLY: true, WORKER_DECODE: false })
    expect(speedFlag('DIFF_APPLY')).toBe(true)
    expect(speedFlag('WORKER_DECODE')).toBe(false)
    expect(speedFlag('CHUNKED_APPLY')).toBe(CHUNKED_APPLY)
    expect(speedFlag('SIZE_AWARE_LOD')).toBe(SIZE_AWARE_LOD)
  })

  it('anything that is not an object clears them (a missing or unreadable localStorage value)', () => {
    setSpeedFlagOverrides({ DIFF_APPLY: true })
    for (const raw of [null, undefined, 'DIFF_APPLY', 1, true]) {
      expect(setSpeedFlagOverrides(raw)).toEqual({})
      expect(speedFlag('DIFF_APPLY')).toBe(DIFF_APPLY)
    }
  })
})
