// WS3 (wave S): the video transport's timecodes both ways, frame steps, and the scrubber's marker clustering.
import { describe, expect, it } from 'vitest'
import { clusterMarkers, MARKER_CLUSTER_PX, timeAtX, trackX } from './markers.ts'
import {
  formatClock,
  formatTimecode,
  frameAt,
  frameRateOrNull,
  parseTimecode,
  stepFrame,
  stepRate,
  stepSecond,
} from './timecode.ts'

describe('timecodes', () => {
  it('mm:ss.d, tenths rounded down, hours past an hour', () => {
    expect(formatClock(0)).toBe('00:00.0')
    expect(formatClock(12_400)).toBe('00:12.4')
    expect(formatClock(12_499)).toBe('00:12.4')
    expect(formatClock(42_000)).toBe('00:42.0')
    expect(formatClock(61_050)).toBe('01:01.0')
    expect(formatClock(3_723_400)).toBe('1:02:03.4')
    expect(formatClock(-5)).toBe('00:00.0')
    expect(formatClock(Number.NaN)).toBe('00:00.0')
  })

  it('hh:mm:ss:ff at a known rate (non-drop, nominal frames), else the clock', () => {
    expect(formatTimecode(12_400, 25)).toBe('00:00:12:10')
    expect(formatTimecode((1000 / 30) * 3, 30)).toBe('00:00:00:03')
    expect(formatTimecode(3_600_000 + 59_000, 30)).toBe('01:00:59:00')
    // 29.97 counts 30 frames a second (NDF): 1001 frames are 33.4 s of wall clock, labelled 00:00:33:11
    expect(formatTimecode((1001 / 29.97) * 1000, 29.97)).toBe('00:00:33:11')
    expect(formatTimecode(12_400, null)).toBe('00:12.4')
    expect(formatTimecode(12_400, 0)).toBe('00:12.4')
  })

  it('parses both forms back (round trips on the frame grid)', () => {
    expect(parseTimecode('00:12.4')).toBe(12_400)
    expect(parseTimecode('1:02:03.4')).toBe(3_723_400)
    expect(parseTimecode('00:42')).toBe(42_000)
    expect(parseTimecode('00:00:12:10', 25)).toBe(12_400)
    expect(parseTimecode('00:00:12:10')).toBe(12_400) // 25 when the rate is unknown
    for (const ms of [0, 1_000, 12_400, 59_960, 3_600_040]) {
      expect(parseTimecode(formatTimecode(ms, 25), 25)).toBe(ms)
      expect(parseTimecode(formatClock(ms))).toBe(Math.floor(ms / 100) * 100)
    }
    for (const bad of ['', '12', 'aa:bb', '00:60', '00:00:12:25', '00:61:00:00', '1:2:3:4:5'])
      expect(parseTimecode(bad, 25), bad).toBeNull()
  })

  it('frame steps land inside the next or previous frame; seconds clamp to the clip', () => {
    expect(frameRateOrNull(29.97)).toBe(29.97)
    expect(frameRateOrNull(0)).toBeNull()
    expect(frameRateOrNull(500)).toBeNull()
    expect(stepRate(null)).toBe(25)
    expect(frameAt(stepFrame(0, 1, 25), 25)).toBe(1)
    expect(frameAt(stepFrame(stepFrame(0, 1, 25), 1, 25), 25)).toBe(2)
    expect(frameAt(stepFrame(1_000, -1, 30), 30)).toBe(29)
    expect(stepFrame(0, -1, 25)).toBe(20) // the middle of frame 0
    expect(stepFrame(4_990, 1, 25, 5_000)).toBe(5_000)
    expect(stepSecond(500, -1)).toBe(0)
    expect(stepSecond(4_500, 1, 5_000)).toBe(5_000)
    expect(stepSecond(1_000, 1)).toBe(2_000)
  })
})

describe('scrubber markers', () => {
  it('places times on the track and back', () => {
    expect(trackX(2_500, 5_000, 400)).toBe(200)
    expect(trackX(9_000, 5_000, 400)).toBe(400)
    expect(trackX(1, 0, 400)).toBe(0)
    expect(timeAtX(100, 5_000, 400)).toBe(1_250)
    expect(timeAtX(-10, 5_000, 400)).toBe(0)
    expect(timeAtX(900, 5_000, 400)).toBe(5_000)
  })

  it('clusters markers closer than 6 px (chained), in time order', () => {
    expect(MARKER_CLUSTER_PX).toBe(6)
    // 1000 px for 10 s: 1 px = 10 ms
    const out = clusterMarkers(
      [
        { id: 'c', timeMs: 5_000 },
        { id: 'a', timeMs: 1_000 },
        { id: 'b', timeMs: 1_050 }, // 5 px after a: joins
        { id: 'd', timeMs: 5_060 }, // 6 px after c: its own
        { id: 'e', timeMs: 1_100 }, // 5 px after b: joins (chained)
        { id: 'x', timeMs: -1 },
      ],
      10_000,
      1_000,
    )
    expect(out).toEqual([
      { x: 100, timeMs: 1_000, ids: ['a', 'b', 'e'] },
      { x: 500, timeMs: 5_000, ids: ['c'] },
      { x: 506, timeMs: 5_060, ids: ['d'] },
    ])
    expect(clusterMarkers([], 10_000, 1_000)).toEqual([])
    // a narrow track: everything is one cluster
    expect(
      clusterMarkers(
        [
          { id: 'a', timeMs: 0 },
          { id: 'b', timeMs: 9_000 },
        ],
        10_000,
        5,
      )[0]?.ids,
    ).toEqual(['a', 'b'])
  })
})
