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
export const TAIL_SEC = 1.6
/** Cross-fade between scenes, in seconds. */
export const FADE_SEC = 0.6
/** The narration starts this long after the scene's cut. */
export const LEAD_SEC = 0.45

/** The shortest a scene may run so its narration, the fade in and the tail all fit. */
export const minSceneSec = (n: NarrationScene) => n.durationSec + LEAD_SEC + TAIL_SEC + FADE_SEC
