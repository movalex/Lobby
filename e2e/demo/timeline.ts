// What the recording hands to the composer (out/timeline.json), and the narration it is cut to.
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export interface NarrationScene {
  id: string
  caption: string
  text: string
  /** Absolute path of the clip (narration.json stores it relative to itself). */
  audio: string
  durationSec: number
}

export function loadNarration(file: string): NarrationScene[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { scenes: NarrationScene[] }
  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) throw new Error(`${file}: no scenes`)
  return raw.scenes.map((s) => ({
    ...s,
    audio: isAbsolute(s.audio) ? s.audio : join(dirname(file), s.audio),
  }))
}

/** One recorded page: its video file and the wall-clock time (epoch ms) of the video's first frame. */
export interface Track {
  id: 'alex' | 'sam' | 'phone'
  file: string
  createdAt: number
  width: number
  height: number
}

export type SceneStatus = 'recorded' | 'skipped' | 'partial'

export interface SceneWindow {
  id: string
  /** 'card' scenes are drawn by the composer; 'split' scenes cut Alex (left) and Sam (right). */
  kind: 'card' | 'split'
  status: SceneStatus
  note: string
  /** Wall-clock window of a split scene (epoch ms). */
  start?: number
  end?: number
  /** When the phone is shown as an inset (epoch ms, inside the scene's window). */
  phone?: { start: number; end: number }
  /**
   * Waits inside the scene that are cut out of the video (epoch ms, inside the window, in order): a
   * board loading, a PDF rendering. The composer joins the pieces around each with a short dissolve.
   */
  cuts?: Array<{ start: number; end: number }>
  /** Card scenes: how long the card runs, in seconds. */
  durationSec?: number
}

export interface Timeline {
  tracks: Track[]
  scenes: SceneWindow[]
  /** Each person's presence colour as the app drew it (for the name labels). */
  colors?: Partial<Record<Track['id'], string>>
}

/** Seconds of picture every scene gets beyond its narration (the brief asks for about 1.5 s). */
export const TAIL_SEC = 1.5
/** Cross-fade between scenes, in seconds. */
export const FADE_SEC = 0.6
/** The dissolve that hides a jump cut inside a scene, in seconds. */
export const CUT_FADE_SEC = 0.24
/** A cut shorter than this is not worth a jump: it stays in the video. */
export const MIN_CUT_SEC = 0.6
/** The narration starts this long after the scene's cut. */
export const LEAD_SEC = 0.45

/** The cuts of a scene the composer will make (long enough, inside the window, not overlapping). */
export function effectiveCuts(w: SceneWindow): Array<{ start: number; end: number }> {
  if (w.start === undefined || w.end === undefined) return []
  const out: Array<{ start: number; end: number }> = []
  let floor = w.start + 300
  for (const c of [...(w.cuts ?? [])].sort((a, b) => a.start - b.start)) {
    const start = Math.max(c.start, floor)
    const end = Math.min(c.end, w.end - 300)
    if ((end - start) / 1000 < MIN_CUT_SEC) continue
    out.push({ start, end })
    floor = end + 400
  }
  return out
}

/** How long a scene runs in the video (seconds): its window without its cuts and their dissolves. */
export function composedSec(w: SceneWindow, now = Date.now()): number {
  if (w.start === undefined) return 0
  const end = w.end ?? now
  let sec = (end - w.start) / 1000
  for (const c of effectiveCuts({ ...w, end })) sec -= (c.end - c.start) / 1000 + CUT_FADE_SEC
  return sec
}

/** The shortest a scene may run so its narration, the fade in and the tail all fit. */
export const minSceneSec = (n: NarrationScene) => n.durationSec + LEAD_SEC + TAIL_SEC + FADE_SEC
