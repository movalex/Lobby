// OWNER: WS3 (wave S, media comments). Timecodes for the review viewer's video transport, its scrubber markers, the
// threads list and the exports (docs/WAVE-S-CONTRACTS.md §4). Pure: unit-tested.
//
//   formatClock(ms)            "00:12.4" (mm:ss.d; "1:02:03.4" past an hour): the buttons and the list
//   formatTimecode(ms, fps)    "00:00:12:10" (hh:mm:ss:ff, non-drop frame at the nominal rate) when the rate is known,
//                              else formatClock
//   parseTimecode(text, fps)   either form (and "mm:ss", "hh:mm:ss") back to milliseconds, or null
//   stepFrame(ms, dir, fps)    the next or previous frame on the frame grid
import { MEDIA_COMMENT_RULES } from '@draftroom/contracts'

/** A usable frame rate (1..240), else null. */
export function frameRateOrNull(fps: unknown): number | null {
  return typeof fps === 'number' && Number.isFinite(fps) && fps >= 1 && fps <= 240 ? fps : null
}

/** The frame rate frame steps use: the probe's, else MEDIA_COMMENT_RULES.defaultFrameRate (25). */
export const stepRate = (fps: unknown): number => frameRateOrNull(fps) ?? MEDIA_COMMENT_RULES.defaultFrameRate

const two = (n: number) => String(n).padStart(2, '0')
const whole = (ms: number) => (Number.isFinite(ms) && ms > 0 ? ms : 0)

/** "00:12.4": minutes, seconds and tenths (rounded down: the frame you are on), hours only past an hour. */
export function formatClock(ms: number): string {
  const tenths = Math.floor(whole(ms) / 100)
  const d = tenths % 10
  const totalSeconds = Math.floor(tenths / 10)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  return h > 0 ? `${h}:${two(m)}:${two(s)}.${d}` : `${two(m)}:${two(s)}.${d}`
}

/** The frame a time is on (frame k covers [k, k+1) / fps). A hair of slack so 1000/30*3 ms is frame 3, not 2. */
export const frameAt = (ms: number, fps: number): number => Math.floor((whole(ms) * fps) / 1000 + 1e-6)

/**
 * "hh:mm:ss:ff": SMPTE-style, non-drop frame, counted at the nominal rate (29.97 counts 30 frames a second, as
 * editing tools do for NDF). Without a known rate: formatClock.
 */
export function formatTimecode(ms: number, fps: number | null | undefined): string {
  const rate = frameRateOrNull(fps)
  if (rate === null) return formatClock(ms)
  const nominal = Math.round(rate)
  const frames = frameAt(ms, rate)
  const ff = frames % nominal
  const totalSeconds = Math.floor(frames / nominal)
  return `${two(Math.floor(totalSeconds / 3600))}:${two(Math.floor(totalSeconds / 60) % 60)}:${two(totalSeconds % 60)}:${two(ff)}`
}

/**
 * A typed timecode back to milliseconds: "hh:mm:ss:ff" (needs a rate: the given one, else 25), "mm:ss.d",
 * "h:mm:ss.d", "mm:ss" or "hh:mm:ss". Null when it is not one (or a field is out of range).
 */
export function parseTimecode(text: string, fps?: number | null): number | null {
  const t = text.trim()
  const frames = /^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/.exec(t)
  if (frames) {
    const [h, m, s, f] = frames.slice(1).map(Number) as [number, number, number, number]
    const rate = stepRate(fps)
    const nominal = Math.round(rate)
    if (m > 59 || s > 59 || f >= nominal) return null
    const total = (h * 3600 + m * 60 + s) * nominal + f
    return Math.round((total * 1000) / rate)
  }
  const clock = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(t)
  if (!clock) return null
  const h = clock[1] ? Number(clock[1]) : 0
  const m = Number(clock[2])
  const s = Number(clock[3])
  if (s > 59 || (clock[1] !== undefined && m > 59)) return null
  const frac = clock[4] ? Number(clock[4].padEnd(3, '0')) : 0
  return (h * 3600 + m * 60 + s) * 1000 + frac
}

/** One frame earlier (dir -1) or later (+1), on the frame grid of `fps` (or 25), never below 0 or past `max`. */
export function stepFrame(
  ms: number,
  dir: 1 | -1,
  fps: number | null | undefined,
  max = Number.POSITIVE_INFINITY,
) {
  const rate = stepRate(fps)
  const frame = Math.max(0, frameAt(ms, rate) + dir)
  // the middle of the frame, so the browser's seek lands on it whatever its rounding
  const at = ((frame + 0.5) * 1000) / rate
  return Math.min(Math.max(0, max), Math.max(0, Math.round(at * 1000) / 1000))
}

/** ±1 s, clamped to [0, max]. */
export const stepSecond = (ms: number, dir: 1 | -1, max = Number.POSITIVE_INFINITY) =>
  Math.min(Math.max(0, max), Math.max(0, whole(ms) + dir * 1000))
