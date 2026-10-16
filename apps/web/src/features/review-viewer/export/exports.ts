// OWNER: WS3 (wave S, media comments). "Export comments" of the review viewer (docs/WAVE-S-CONTRACTS.md §4): built in
// the browser from the threads the person may see, and saved as a download (the export policy decides whether the
// button is there; team-only threads only for the team, and only when they tick the box). Pure: unit-tested.
//
//   commentsCsv     one row per comment: thread, version, timecode, page, spot, author ("(guest)", "· External"),
//                   status, the comment, when; every cell escaped against spreadsheet formula injection
//   markersCsv      a Premiere-style marker list (Marker Name, Description, In, Out, Duration, Marker Type), one
//                   marker per thread with a time on the version shown
//   commentsEdl     a CMX3600 EDL with one event and a locator per thread with a time on the version shown
//
// Marker and EDL texts are one line, at most EXPORT_TEXT_CHARS characters.
import type { CommentThread, ThreadComment } from '@draftroom/contracts'
import { commentPlainText } from '@draftroom/contracts'
import { formatTimecode, stepRate } from '../video/timecode.ts'

/** Comments in the marker list and the EDL are cut to this many characters (one line). */
export const EXPORT_TEXT_CHARS = 120

/** What the exports need of a thread: its comments, where it is, and its version's label ("v2", or an id). */
export interface ExportThread {
  readonly thread: CommentThread
  readonly versionLabel: string
}

/**
 * A cell as a spreadsheet must read it: text that starts with `=`, `+`, `-` or `@` (or a tab or carriage return,
 * which some spreadsheets skip before those) gets a leading apostrophe, so it is never a formula; then RFC 4180
 * quoting for commas, quotes and line breaks.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const csvLine = (cells: readonly (string | number | null | undefined)[]) => cells.map(csvCell).join(',')

/** Control, bidi and zero-width characters out, whitespace (newlines too) folded to single spaces. */
export function oneLine(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** One line, at most `max` characters (an ellipsis when cut). */
export function cutText(text: string, max = EXPORT_TEXT_CHARS): string {
  const chars = Array.from(oneLine(text))
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** An author as the exports write them: a guest's name already ends in " (guest)"; an outside account " · External". */
export function authorLabel(author: ThreadComment['author']): string {
  const name = oneLine(author.name) || 'Someone'
  return author.external ? `${name} · External` : name
}

const plain = (body: string) => oneLine(commentPlainText(body))

export const COMMENTS_CSV_HEADER = [
  'Thread',
  'Version',
  'Timecode',
  'Page',
  'Spot',
  'Author',
  'Status',
  'Comment',
  'Posted',
] as const

/** The comments of every thread, one row per comment, threads in the given order (UTF-8 with a BOM, CRLF). */
export function commentsCsv(threads: readonly ExportThread[], fps: number | null): string {
  const lines = [csvLine(COMMENTS_CSV_HEADER)]
  threads.forEach(({ thread, versionLabel }, n) => {
    const a = thread.anchor.kind === 'asset' ? thread.anchor : null
    const spot = thread.spot ? `${Math.round(thread.spot.u * 100)}%, ${Math.round(thread.spot.v * 100)}%` : ''
    for (const c of thread.comments) {
      lines.push(
        csvLine([
          n + 1,
          versionLabel,
          a?.timeMs !== undefined ? formatTimecode(a.timeMs, fps) : '',
          a?.page ?? '',
          spot,
          authorLabel(c.author),
          thread.status === 'resolved' ? 'Resolved' : 'Open',
          plain(c.body),
          c.createdAt,
        ]),
      )
    }
  })
  return `﻿${lines.join('\r\n')}\r\n`
}

/** The threads with a time, earliest first (the marker list and the EDL). */
function timed(threads: readonly ExportThread[]) {
  return threads
    .flatMap(({ thread }) =>
      thread.anchor.kind === 'asset' && thread.anchor.timeMs !== undefined
        ? [{ thread, timeMs: thread.anchor.timeMs }]
        : [],
    )
    .sort((a, b) => a.timeMs - b.timeMs || a.thread.id.localeCompare(b.thread.id))
}

/** The marker's words: the first comment, with its author, and how many replies follow. */
function markerText(thread: CommentThread): { name: string; description: string } {
  const first = thread.comments[0]
  const replies = thread.comments.length - 1
  const author = first ? authorLabel(first.author) : 'Someone'
  const words = first ? plain(first.body) : ''
  return {
    name: cutText(author, 60),
    description: cutText(
      replies > 0 ? `${words} (+${replies} ${replies === 1 ? 'reply' : 'replies'})` : words,
    ),
  }
}

/** A Premiere-style marker list: In and Out are hh:mm:ss:ff at the file's rate (25 when unknown), Duration 0. */
export function markersCsv(threads: readonly ExportThread[], fps: number | null): string {
  const rate = stepRate(fps)
  const lines = [csvLine(['Marker Name', 'Description', 'In', 'Out', 'Duration', 'Marker Type'])]
  for (const { thread, timeMs } of timed(threads)) {
    const { name, description } = markerText(thread)
    const tc = formatTimecode(timeMs, rate)
    lines.push(csvLine([name, description, tc, tc, '00:00:00:00', 'Comment']))
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

/** The next frame's timecode (an EDL event lasts one frame). */
const nextFrame = (ms: number, rate: number) => formatTimecode(ms + 1000 / rate, rate)

/**
 * A CMX3600 EDL: a title, non-drop frame, and per thread with a time one one-frame event (source = record, reel
 * "AX") with a `* LOC:` locator holding the comment and a `* FROM CLIP NAME:` line, all on one line each.
 */
export function commentsEdl(
  threads: readonly ExportThread[],
  opts: { readonly title: string; readonly clipName: string; readonly fps: number | null },
): string {
  const rate = stepRate(opts.fps)
  const out = [`TITLE: ${cutText(opts.title, 70) || 'Comments'}`, 'FCM: NON-DROP FRAME', '']
  timed(threads).forEach(({ thread, timeMs }, i) => {
    const n = String(i + 1).padStart(3, '0')
    const tcIn = formatTimecode(timeMs, rate)
    const tcOut = nextFrame(timeMs, rate)
    const { name, description } = markerText(thread)
    out.push(`${n}  ${'AX'.padEnd(8)} ${'V'.padEnd(5)} ${'C'.padEnd(8)} ${tcIn} ${tcOut} ${tcIn} ${tcOut}`)
    out.push(`* FROM CLIP NAME: ${cutText(opts.clipName, 60)}`)
    out.push(`* LOC: ${tcIn} YELLOW  ${cutText(`${name}: ${description}`)}`)
    out.push('')
  })
  return out.join('\r\n')
}

/** A file name's stem, safe on every system ("Trailer v2 (final).mp4" -> "Trailer v2 (final)"). */
export function exportStem(name: string): string {
  const base = oneLine(name).replace(/\.[A-Za-z0-9]{1,8}$/, '')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: file names must not hold control characters
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '')
  return Array.from(safe).slice(0, 80).join('') || 'file'
}

export type ExportKind = 'csv' | 'markers' | 'edl'

/** The download's name and type for each export. */
export function exportFile(kind: ExportKind, fileName: string): { name: string; type: string } {
  const stem = exportStem(fileName)
  switch (kind) {
    case 'csv':
      return { name: `${stem} - comments.csv`, type: 'text/csv;charset=utf-8' }
    case 'markers':
      return { name: `${stem} - markers.csv`, type: 'text/csv;charset=utf-8' }
    case 'edl':
      return { name: `${stem}.edl`, type: 'text/plain;charset=utf-8' }
  }
}
