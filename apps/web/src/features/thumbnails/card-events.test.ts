import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  announceThumbnail,
  onThumbnailUpdated,
  RECENT_ANNOUNCEMENT_MS,
  recentThumbnail,
} from './card-events.ts'

describe('card events (N1-THUMBS: an announcement made before the card exists)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('a card made after the upload was answered still gets its version', () => {
    // the upload's answer, with no card listening yet (the board list is still on its way)
    announceThumbnail('b-early', 'aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(recentThumbnail('b-early')).toEqual({ version: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(recentThumbnail('b-other')).toBeNull()
  })

  it('a removal counts too, and the latest announcement wins', () => {
    announceThumbnail('b-gone', 'bbbbbbbbbbbbbbbbbbbbbbbb')
    announceThumbnail('b-gone', null)
    expect(recentThumbnail('b-gone')).toEqual({ version: null })
  })

  it('only for a while well inside the api window', () => {
    announceThumbnail('b-old', 'cccccccccccccccccccccccc')
    vi.advanceTimersByTime(RECENT_ANNOUNCEMENT_MS - 1)
    expect(recentThumbnail('b-old')).toEqual({ version: 'cccccccccccccccccccccccc' })
    vi.advanceTimersByTime(1)
    expect(recentThumbnail('b-old')).toBeNull()
    expect(RECENT_ANNOUNCEMENT_MS).toBeLessThanOrEqual(10_000)
  })

  it('a card already listening hears it as before', () => {
    const heard: (string | null)[] = []
    const off = onThumbnailUpdated('b-live', (v) => heard.push(v))
    announceThumbnail('b-live', 'dddddddddddddddddddddddd')
    announceThumbnail('b-elsewhere', 'eeeeeeeeeeeeeeeeeeeeeeee')
    off()
    announceThumbnail('b-live', null)
    expect(heard).toEqual(['dddddddddddddddddddddddd'])
  })
})
