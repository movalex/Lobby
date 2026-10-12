// OWNER: WS5 (wave N, N5-4). A meeting transcript as the text the capture sends: pasted, or opened from a .txt, .vtt,
// .srt or .md file (Teams and Zoom export .vtt; many tools .srt; meeting notes are often .md or .txt). Cue numbers,
// timestamps, the WEBVTT header and its NOTE, STYLE and REGION blocks, and caption markup go; speaker names stay
// ("<v Ana Lopez>We should…</v>" is "Ana Lopez: We should…"); a caption a player repeated line by line is kept once.
// Nothing is stored: the text goes in the capture request's body and nowhere else. Pure.

import { CAPTURE_TRANSCRIPT_MAX_CHARS } from '@draftroom/contracts'
import { truncationNotice } from '../copy.ts'

export type TranscriptFormat = 'vtt' | 'srt' | 'md' | 'txt'

/** The files the "Open file" button takes. */
export const TRANSCRIPT_ACCEPT = '.txt,.vtt,.srt,.md,text/plain,text/vtt,text/markdown,application/x-subrip'
/** A transcript file larger than this is not read (the capture uses 60,000 characters at most). */
export const TRANSCRIPT_FILE_MAX_BYTES = 2 * 1024 * 1024

/** The format of a file by its name, else by its first line. */
export function formatOf(name: string, text: string): TranscriptFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase()
  if (ext === 'vtt' || ext === 'srt' || ext === 'md' || ext === 'txt') return ext
  if (/^﻿?WEBVTT/.test(text)) return 'vtt'
  if (/^﻿?\d+\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text)) return 'srt'
  return 'txt'
}

/** A cue timing line: `00:00:01.000 --> 00:00:04.000 align:start` (vtt) or `00:00:01,000 --> 00:00:04,000` (srt). */
const TIMING = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}.*$/
/** A leading timestamp in a plain transcript: `[00:01:02]`, `00:01:02 -`, `(1:02)`. */
const LEADING_TIME = /^\s*[[(]?(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?[\])]?\s*[-–—|:]?\s*/

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** One caption's text without its markup; a voice tag's speaker becomes "Name: ". */
function cueText(raw: string): string {
  let speaker: string | null = null
  const voiced = raw.replace(/<v(?:\.[^\s>]*)?\s+([^>]+)>/gi, (_m, name: string) => {
    speaker ??= clean(name)
    return ''
  })
  const plain = clean(
    voiced
      .replace(/<\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}>/g, '') // karaoke timestamps
      .replace(/<\/?[a-z][^>]*>/gi, '') // <c>, <i>, <b>, <u>, <lang>, <ruby>, </v>
      .replace(/\{\\[^}]*\}/g, '') // SRT/ASS positioning such as {\an8}
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' '),
  )
  if (!plain) return ''
  return speaker ? `${speaker}: ${plain}` : plain
}

/** The blocks of a caption file (separated by blank lines). */
const blocks = (text: string) =>
  text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)

function vtt(text: string): string[] {
  const out: string[] = []
  for (const block of blocks(text)) {
    const lines = block.split('\n')
    const first = lines[0]?.trim() ?? ''
    if (/^WEBVTT/.test(first) || /^(NOTE|STYLE|REGION)\b/.test(first)) continue
    const t = lines.findIndex((l) => TIMING.test(l))
    // the lines before the timing are the cue's identifier; without a timing it is no cue
    if (t < 0) continue
    const words = cueText(lines.slice(t + 1).join(' '))
    if (words) out.push(words)
  }
  return out
}

function srt(text: string): string[] {
  const out: string[] = []
  for (const block of blocks(text)) {
    const lines = block.split('\n')
    const t = lines.findIndex((l) => TIMING.test(l))
    if (t < 0) {
      // not a cue: a stray paragraph is kept as it is
      const words = cueText(lines.filter((l) => !/^\s*\d+\s*$/.test(l)).join(' '))
      if (words) out.push(words)
      continue
    }
    const words = cueText(lines.slice(t + 1).join(' '))
    if (words) out.push(words)
  }
  return out
}

function plain(text: string, markdown: boolean): string[] {
  const out: string[] = []
  for (const raw of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
    let l = raw.replace(LEADING_TIME, '')
    if (markdown) l = l.replace(/^\s*(#{1,6}|[-*+]|>)\s+/, '').replace(/\*\*|__|`/g, '')
    l = l.replace(/[ \t]+/g, ' ').trim()
    out.push(l)
  }
  // runs of blank lines become one
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
}

/** Consecutive repeats go (a rolling caption shows the same line again and again). */
function once(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const l of lines) if (!l || out.at(-1) !== l) out.push(l)
  return out
}

/** The transcript's text as the capture sends it (see the header). */
export function parseTranscript(text: string, format: TranscriptFormat): string {
  const lines = format === 'vtt' ? vtt(text) : format === 'srt' ? srt(text) : plain(text, format === 'md')
  return once(lines).join('\n').trim()
}

/**
 * About what the api reads of a transcript at its default settings, in UTF-8 bytes (apps/api capture.ts: at most 4
 * parts of about 34,000 bytes each, the AI input cap's estimate of 3 bytes a token, a part never splitting a line that
 * fits), with room for where the parts' lines end. Writing in Latin letters reaches the 60,000-character limit first;
 * text of 3 bytes a character (Chinese, Japanese, Korean) reaches this one at about 44,000 characters, so the dialog
 * says how much will be used instead of the api leaving the rest out unsaid. (A very long paragraph with no line
 * breaks, or a lower input cap on the api, can still leave a little more out.)
 */
export const TRANSCRIPT_READ_BYTES = 132_000

/** How many UTF-16 units of `t` fit in `maxBytes` UTF-8 bytes (never half a surrogate pair). */
function fitBytes(t: string, maxBytes: number): number {
  let bytes = 0
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < t.length
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3
    if (bytes + n > maxBytes) return i
    bytes += n
    if (pair) i++
  }
  return t.length
}

export interface TranscriptLimit {
  /** what is sent: at most `max` characters, and at most TRANSCRIPT_READ_BYTES */
  readonly text: string
  readonly length: number
  readonly truncated: boolean
  /** "Only the first 60,000 characters will be used." past the limit (with the number that fits), else null */
  readonly notice: string | null
}

/** The transcript within the capture's limits, and the notice past them. */
export function transcriptLimit(
  text: string,
  max: number = CAPTURE_TRANSCRIPT_MAX_CHARS,
  maxBytes: number = TRANSCRIPT_READ_BYTES,
): TranscriptLimit {
  const t = text.trim()
  // never half a surrogate pair at the cut
  let cutAt = Math.min(t.length, max)
  const code = t.charCodeAt(cutAt - 1)
  if (cutAt < t.length && code >= 0xd800 && code <= 0xdbff) cutAt--
  cutAt = Math.min(cutAt, fitBytes(t, maxBytes))
  if (cutAt >= t.length) return { text: t, length: t.length, truncated: false, notice: null }
  const kept = t.slice(0, cutAt).trimEnd()
  return {
    text: kept,
    length: t.length,
    truncated: true,
    notice: truncationNotice(cutAt === max ? max : kept.length),
  }
}
