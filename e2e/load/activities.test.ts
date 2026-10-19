// OWNER: WS1 (wave V). The pure parts of the live activities load test (./activities.ts): percentiles, the events per
// window count (start, close and reveal events are not windowed), the burst spread and the verdict.
import { describe, expect, it } from 'vitest'
import {
  burstOffsets,
  maxEventsPerWindow,
  percentile,
  type SeenEvent,
  summarize,
  verdict,
} from './activities.ts'

const ev = (at: number, status = 'open', activityId = 'act_a', answered = 0): SeenEvent => ({
  at,
  activityId,
  status,
  answered,
})

describe('the load report', () => {
  it('nearest-rank percentiles and summaries', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(v, 50)).toBe(50)
    expect(percentile(v, 95)).toBe(95)
    expect(percentile([], 95)).toBeNaN()
    expect(summarize([3, 1, 2])).toEqual({ n: 3, p50: 2, p95: 3, p99: 3, max: 3 })
  })

  it('counts windowed events per window per activity, leaving the start and the final events out', () => {
    const W = 5_000
    expect(
      maxEventsPerWindow([ev(100), ev(5_030), ev(10_040), ev(10_900, 'closed'), ev(11_000, 'revealed')], W),
    ).toEqual({
      act_a: 1,
    })
    expect(maxEventsPerWindow([ev(100), ev(5_030), ev(6_000)], W)).toEqual({ act_a: 2 })
    // two activities are counted apart
    expect(
      maxEventsPerWindow([ev(0), ev(0, 'open', 'act_b'), ev(5_010), ev(5_020, 'open', 'act_b')], W),
    ).toEqual({
      act_a: 1,
      act_b: 1,
    })
  })

  it('a burst spreads its answers over the burst', () => {
    let s = 1
    const rnd = () => {
      s = (s * 16807) % 2147483647
      return s / 2147483647
    }
    const o = burstOffsets(200, 10_000, rnd)
    expect(o).toHaveLength(200)
    expect(Math.min(...o)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...o)).toBeLessThan(10_000)
  })

  it('the verdict: p95 under 1 s, one event a window, every answer counted, no 5xx, no leak', () => {
    const ok = {
      answerAck: { poll: summarize([10, 20, 900]) },
      maxEventsPerWindow: 1,
      counted: { poll: { expected: 200, answered: 200 } },
      serverErrors: 0,
      wireLeaks: 0,
    }
    expect(verdict(ok)).toEqual({ pass: true, reasons: [] })
    expect(verdict({ ...ok, answerAck: { poll: summarize([1000]) } }).pass).toBe(false)
    expect(verdict({ ...ok, maxEventsPerWindow: 2 }).pass).toBe(false)
    expect(verdict({ ...ok, counted: { poll: { expected: 200, answered: 199 } } }).pass).toBe(false)
    expect(verdict({ ...ok, serverErrors: 1 }).pass).toBe(false)
    expect(verdict({ ...ok, wireLeaks: 1 }).reasons).toEqual(['1 events carried a participant id or name'])
  })
})
