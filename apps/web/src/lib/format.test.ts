import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatRelativeTime } from './format.ts'

describe('formatRelativeTime', () => {
  // Local time, so "today"/"yesterday" follow the viewer's calendar in any test timezone.
  const now = new Date(2026, 8, 26, 15, 0, 0)
  const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi).toISOString()

  it('reads naturally from seconds to years', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 20_000).toISOString(), now)).toBe('just now')
    expect(formatRelativeTime(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('5 min ago')
    expect(formatRelativeTime(at(2026, 8, 26, 9), now)).toBe('6 h ago')
    expect(formatRelativeTime(at(2026, 8, 25, 23, 30), now)).toBe('yesterday')
    expect(formatRelativeTime(at(2026, 8, 22), now)).toBe('4 days ago')
    expect(formatRelativeTime(at(2026, 8, 12), now)).toBe('Sep 12')
    expect(formatRelativeTime(at(2025, 11, 31), now)).toBe('Dec 31, 2025')
  })

  it('treats clock skew as "just now" and bad input as empty', () => {
    expect(formatRelativeTime(new Date(now.getTime() + 90_000).toISOString(), now)).toBe('just now')
    expect(formatRelativeTime('not a date', now)).toBe('')
    expect(formatRelativeTime(null, now)).toBe('')
  })
})

describe('existing formatters', () => {
  it('still format sizes and durations', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatDuration(83_000)).toBe('1:23')
  })
})
