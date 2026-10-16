// OWNER: WS3 (wave T). The image sequence's hand-off files (the design §3.2), pure:
//   frame names   <stem>_0001.png … one per panel, in storyboard order;
//   timings.csv   one row per panel: shot, file, start and end timecodes, duration in seconds and frames, name,
//                 camera, action, dialogue, SFX, music (UTF-8 with a BOM, CRLF, every cell escaped against formula
//                 injection with the review viewer's csvCell);
//   animatic.edl  a CMX3600 EDL at 24, 25 or 30 fps, non-drop frame: one video event per panel (reel AX, the frame
//                 file as its clip name), record times back to back from 00:00:00:00, so Premiere and Resolve rebuild
//                 the animatic with its timings; the sound track, when there is one, as a note.
// Frame counts are rounded at each boundary (cumulative), never per panel, so the cut never drifts from the running
// time; every panel lasts at least one frame.
import { csvCell, cutText, oneLine } from '../../review-viewer/export/exports.ts'
import type { StoryboardView } from '../../storyboard-play/model.ts'
import { shotLabel } from '../../storyboard-play/model.ts'

export type SequenceFps = 24 | 25 | 30
export const SEQUENCE_FPS: readonly SequenceFps[] = [24, 25, 30]

export interface FrameSpan {
  readonly first: number
  /** exclusive */
  readonly end: number
}

/** Each panel's frames at `fps`: boundaries rounded from the running time, at least one frame each. */
export function frameSpans(
  panels: readonly { startMs: number; durationMs: number }[],
  fps: number,
): FrameSpan[] {
  const out: FrameSpan[] = []
  let at = 0
  for (const p of panels) {
    const first = Math.max(at, Math.round((p.startMs * fps) / 1000))
    const end = Math.max(first + 1, Math.round(((p.startMs + p.durationMs) * fps) / 1000))
    out.push({ first, end })
    at = end
  }
  return out
}

const two = (n: number) => String(n).padStart(2, '0')

/** "hh:mm:ss:ff" of a frame count at `fps` (non-drop). */
export function timecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.floor(frames))
  const s = Math.floor(f / fps)
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(f % fps)}`
}

/** The frame files' names: `<stem>_0001.png` (four digits, more past 9,999). */
export function frameName(stem: string, n: number): string {
  return `${stem}_${String(n).padStart(4, '0')}.png`
}

export const TIMINGS_HEADER = [
  'Shot',
  'File',
  'Start',
  'End',
  'Duration (s)',
  'Duration (frames)',
  'Name',
  'Camera',
  'Action',
  'Dialogue',
  'SFX',
  'Music',
] as const

const csvLine = (cells: readonly (string | number)[]) => cells.map(csvCell).join(',')
const seconds = (ms: number) => String(Math.round(ms) / 1000)

/** timings.csv */
export function timingsCsv(view: StoryboardView, stem: string, fps: SequenceFps): string {
  const spans = frameSpans(view.panels, fps)
  const lines = [csvLine(TIMINGS_HEADER)]
  view.panels.forEach((p, i) => {
    const s = spans[i] as FrameSpan
    lines.push(
      csvLine([
        p.number,
        frameName(stem, i + 1),
        timecode(s.first, fps),
        timecode(s.end, fps),
        seconds(p.durationMs),
        s.end - s.first,
        oneLine(p.name),
        oneLine(p.fields.camera),
        oneLine(p.fields.action),
        oneLine(p.fields.dialogue),
        oneLine(p.fields.sfx),
        oneLine(p.fields.music),
      ]),
    )
  })
  return `﻿${lines.join('\r\n')}\r\n`
}

/** animatic.edl (CMX3600) */
export function animaticEdl(view: StoryboardView, stem: string, fps: SequenceFps): string {
  const spans = frameSpans(view.panels, fps)
  const out = [`TITLE: ${cutText(view.title, 70) || 'Animatic'}`, 'FCM: NON-DROP FRAME', '']
  view.panels.forEach((p, i) => {
    const s = spans[i] as FrameSpan
    const n = String(i + 1).padStart(3, '0')
    const srcIn = timecode(0, fps)
    const srcOut = timecode(s.end - s.first, fps)
    out.push(
      `${n}  ${'AX'.padEnd(8)} ${'V'.padEnd(5)} ${'C'.padEnd(8)} ${srcIn} ${srcOut} ${timecode(s.first, fps)} ${timecode(s.end, fps)}`,
    )
    out.push(`* FROM CLIP NAME: ${frameName(stem, i + 1)}`)
    const words = [shotLabel(p.number), p.name, p.fields.dialogue].map((w) => oneLine(w)).filter(Boolean)
    out.push(`* COMMENT: ${cutText(words.join(' - '))}`)
    out.push('')
  })
  if (view.audio) {
    const at = view.audio.offsetMs
    const where =
      at === 0
        ? 'from the start'
        : at > 0
          ? `starting ${seconds(at)} s in`
          : `with its first ${seconds(-at)} s skipped`
    out.push(`* SOUND: ${cutText(view.audio.name || 'sound track', 60)} (${where})`)
    out.push('')
  }
  return out.join('\r\n')
}
