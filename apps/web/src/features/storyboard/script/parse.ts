// OWNER: WS2 (wave T, Script to boards). A pasted script as storyboard beats, with no AI (the precedent:
// ../../mindmap/outline-parse.ts). It recognises:
//  - an AV two-column script: rows of VIDEO and AUDIO, pasted from a spreadsheet or a document table (tabs), a
//    Markdown table (pipes) or a CSV file with a header that names the columns;
//  - a screenplay or Fountain: scene headings (INT. / EXT.), action paragraphs, an UPPERCASE character cue and its
//    dialogue (V.O. and O.S. kept), transitions (CUT TO:) between beats, Fountain's notes and boneyard dropped;
//  - a shot list: numbered or bulleted lines ("3. CU - hands on pad. VO: Every day starts here. (3s)");
//  - anything else: one beat per paragraph (or per sentence for a single paragraph).
// Each beat has camera words (from the shot words it starts with: WIDE, MS, CU, ECU, OTS, POV, PAN, TRACK,
// DOLLY, …), the action, the dialogue or VO, a sound line and a duration: a hint in the text ("(3s)", "0:03", "36f"),
// else the dialogue's words at 2.5 words a second (1.5 s at least), else none (the storyboard's default). At most
// SCRIPT_MAX_BEATS beats (`truncated` says when more were there). Pure: Node tests run it on golden scripts.
import { parseDuration } from '@draftroom/canvas-schema/planning'

export const SCRIPT_FORMATS = ['av', 'screenplay', 'shot-list', 'prose'] as const
export type ScriptFormat = (typeof SCRIPT_FORMATS)[number]
export const SCRIPT_FORMAT_LABELS: Readonly<Record<ScriptFormat, string>> = {
  av: 'AV script (video and audio columns)',
  screenplay: 'Screenplay or Fountain',
  'shot-list': 'Shot list',
  prose: 'Paragraphs',
}

/** The most beats one paste makes (the preview's cap; the AI's is 60). */
export const SCRIPT_MAX_BEATS = 200
/** Words of dialogue a second, for a duration the script does not give. */
export const WORDS_PER_SECOND = 2.5
export const MIN_SPOKEN_MS = 1_500

export interface Beat {
  camera: string
  action: string
  dialogue: string
  sfx: string
  /** from a hint or the dialogue; null: the storyboard's default */
  durationMs: number | null
}

export interface ParsedScript {
  readonly format: ScriptFormat
  readonly beats: Beat[]
  /** more beats than SCRIPT_MAX_BEATS were there */
  readonly truncated: boolean
}

const blankBeat = (): Beat => ({ camera: '', action: '', dialogue: '', sfx: '', durationMs: null })

// ---- shot words -----------------------------------------------------------------------------------------------

/** Shot sizes and angles, longest first (a phrase is matched before its words), and the abbreviation shown. */
const SHOT_PHRASES: readonly [RegExp, string][] = [
  [/^extreme\s+close[\s-]?ups?\b/i, 'ECU'],
  [/^extreme\s+wide(?:\s+shot)?\b/i, 'EWS'],
  [/^extreme\s+long\s+shot\b/i, 'ELS'],
  [/^medium\s+close[\s-]?ups?\b/i, 'MCU'],
  [/^medium\s+wide(?:\s+shot)?\b/i, 'MWS'],
  [/^medium\s+long\s+shot\b/i, 'MLS'],
  [/^(?:big\s+)?close[\s-]?ups?\b/i, 'CU'],
  [/^close\s+on\b/i, 'CU'],
  [/^(?:medium|mid)(?:\s+shot)?\b/i, 'MS'],
  [/^wide(?:\s+shot)?\b/i, 'WIDE'],
  [/^long\s+shot\b/i, 'LS'],
  [/^full\s+shot\b/i, 'FS'],
  [/^establishing(?:\s+shot)?\b/i, 'EST'],
  [/^over[\s-]the[\s-]shoulders?\b/i, 'OTS'],
  [/^point[\s-]of[\s-]view\b/i, 'POV'],
  [/^two[\s-]shot\b/i, '2-SHOT'],
  [/^angle\s+on\b/i, 'ANGLE ON'],
  [/^insert(?:\s+shot)?\b/i, 'INSERT'],
  [/^bird'?s[\s-]eye(?:\s+view)?\b/i, "BIRD'S EYE"],
  [/^low[\s-]angle\b/i, 'LOW ANGLE'],
  [/^high[\s-]angle\b/i, 'HIGH ANGLE'],
  [/^dutch(?:\s+angle)?\b/i, 'DUTCH'],
  [/^push[\s-]in\b/i, 'PUSH IN'],
  [/^pull[\s-](?:out|back)\b/i, 'PULL OUT'],
  [/^(?:hand[\s-]?held)\b/i, 'HANDHELD'],
  [/^steadicam\b/i, 'STEADICAM'],
  [/^(?:aerial|drone)(?:\s+shot)?\b/i, 'AERIAL'],
  [/^tracking(?:\s+shot)?\b/i, 'TRACK'],
  [/^(?:EWS|ELS|ECU|XCU|BCU|MCU|MWS|MLS|CU|MS|WS|LS|FS|OTS|POV|EST|2S)\b/, ''],
  [/^(?:pan|tilt|track|dolly|crane|zoom|whip\s+pan|rack\s+focus|jib|orbit|static|locked[\s-]off)\b/i, ''],
]
/** Words that may sit between shot words ("WIDE, slow PUSH IN"). */
const FILLERS = /^(?:slow|slowly|fast|quick|gentle|and|then|with|a|to|in|on|left|right|up|down)\b/i
const SEPARATORS = /^\s*(?:[-–—:/,+&]|\.\s|\.$)\s*/

/**
 * The camera words `text` starts with, normalised (CU, WIDE, PUSH IN…), and the rest: "CU - hands on pad" →
 * { camera: 'CU', rest: 'hands on pad' }; "Wide shot of the city" → { camera: 'WIDE', rest: 'of the city' }.
 */
export function cameraOf(text: string): { camera: string; rest: string } {
  const found: string[] = []
  let rest = text.trim()
  let pendingFiller = ''
  for (let guard = 0; guard < 8 && rest; guard++) {
    let hit: string | null = null
    for (const [re, abbr] of SHOT_PHRASES) {
      const m = re.exec(rest)
      if (!m) continue
      hit = abbr || m[0].toUpperCase().replace(/\s+/g, ' ')
      rest = rest.slice(m[0].length)
      break
    }
    if (hit !== null) {
      if (pendingFiller && found.length) found.push(pendingFiller.toLowerCase())
      pendingFiller = ''
      found.push(hit)
      const sep = SEPARATORS.exec(rest)
      if (sep) rest = rest.slice(sep[0].length)
      else rest = rest.replace(/^\s+/, '')
      continue
    }
    const filler = found.length ? FILLERS.exec(rest) : null
    if (filler) {
      pendingFiller = filler[0]
      const after = rest.slice(filler[0].length).replace(/^\s+/, '')
      // a filler counts only when a shot word follows it
      if (SHOT_PHRASES.some(([re]) => re.test(after))) {
        rest = after
        continue
      }
    }
    break
  }
  const camera = found.join(' ').trim()
  if (!camera) return { camera: '', rest: text.trim() }
  return { camera, rest: rest.replace(/^(?:of|on)\s+/i, '').trim() }
}

// ---- durations ------------------------------------------------------------------------------------------------

const HINT_IN_BRACKETS = /[([]\s*([^()[\]]{1,14}?)\s*[)\]]/g
const HINT_AT_END =
  /(?:^|[\s,;–—-])((?:\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds?))|(?:\d+:[0-5]\d(?:\.\d+)?)|(?:\d+\s*f))\.?\s*$/i
const HINT_LABEL = /\b(?:dur(?:ation)?|length|time)\s*[:=]\s*([0-9:.]+\s*(?:s|sec|secs|seconds?|f)?)/i

/** A duration hint in `text` ("(3s)", "[0:03]", "… 2.5s", "Duration: 4s", "36f") and the text without it. */
export function durationHint(text: string, fps = 24): { ms: number | null; rest: string } {
  let ms: number | null = null
  let rest = text.replace(HINT_IN_BRACKETS, (all, inner: string) => {
    if (ms !== null) return all
    const v = parseDuration(inner.replace(/^(?:dur(?:ation)?|length|time)\s*[:=]?\s*/i, ''), fps)
    if (v === null) return all
    ms = v
    return ''
  })
  if (ms === null) {
    const label = HINT_LABEL.exec(rest)
    const v = label ? parseDuration(label[1] ?? '', fps) : null
    if (label && v !== null) {
      ms = v
      rest = rest.replace(label[0], '')
    }
  }
  if (ms === null) {
    const end = HINT_AT_END.exec(rest)
    const v = end ? parseDuration(end[1] ?? '', fps) : null
    if (end && v !== null) {
      ms = v
      rest = rest.slice(0, end.index)
    }
  }
  return { ms, rest: tidy(rest) }
}

/** How long `dialogue` takes to say (2.5 words a second, 1.5 s at least), or null with no words. */
export function spokenMs(dialogue: string): number | null {
  const words = dialogue
    .replace(/^[A-Z][A-Z0-9 .'’-]{0,30}:\s*/gm, '')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  if (!words) return null
  return Math.max(MIN_SPOKEN_MS, Math.round(((words / WORDS_PER_SECOND) * 1000) / 100) * 100)
}

const tidy = (s: string) =>
  s
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/^[\s.,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim()

// ---- audio parts ("VO: …", "SFX: …", "MUSIC: …") ---------------------------------------------------------------

const AUDIO_TAG =
  /\b(VO|V\.O\.|VOICE[\s-]?OVER|NARRATOR|DIALOGUE|DIALOG|SFX|FX|SOUND|MUSIC|MX|AUDIO|SUPER)\s*[:–—-]\s*/gi

/** `text` split into what we see, the dialogue/VO and the sound (by their tags), each tidied. */
export function audioParts(text: string): { action: string; dialogue: string; sfx: string } {
  const parts: { tag: string; at: number; len: number }[] = []
  for (const m of text.matchAll(AUDIO_TAG))
    parts.push({ tag: (m[1] ?? '').toUpperCase(), at: m.index ?? 0, len: m[0].length })
  if (!parts.length) return { action: tidy(text), dialogue: '', sfx: '' }
  const action = text.slice(0, parts[0]?.at ?? 0)
  const dialogue: string[] = []
  const sfx: string[] = []
  parts.forEach((p, i) => {
    const words = tidy(text.slice(p.at + p.len, parts[i + 1]?.at ?? text.length))
    if (!words) return
    if (/^(SFX|FX|SOUND)$/.test(p.tag)) sfx.push(words)
    else if (/^(MUSIC|MX)$/.test(p.tag)) sfx.push(`Music: ${words}`)
    else if (p.tag === 'SUPER') dialogue.push(`SUPER: ${words}`)
    else if (/^(VO|V\.O\.|VOICE[\s-]?OVER|NARRATOR)$/.test(p.tag)) dialogue.push(`VO: ${words}`)
    else dialogue.push(words)
  })
  return { action: tidy(action), dialogue: dialogue.join('\n'), sfx: sfx.join('; ') }
}

/** A beat from free words (a shot list item, a paragraph, an AV video cell): camera, action, audio, duration. */
export function beatOf(text: string, fps = 24): Beat {
  const hint = durationHint(text.replace(/\s*\n\s*/g, ' '), fps)
  const audio = audioParts(hint.rest)
  const cam = cameraOf(audio.action)
  const beat: Beat = {
    camera: cam.camera,
    action: capitalise(tidy(cam.rest)),
    dialogue: audio.dialogue,
    sfx: audio.sfx,
    durationMs: hint.ms,
  }
  beat.durationMs ??= spokenMs(beat.dialogue)
  return beat
}

const capitalise = (s: string) => (s ? s[0]?.toLocaleUpperCase() + s.slice(1) : s)
const hasWords = (b: Beat) => !!(b.camera || b.action || b.dialogue || b.sfx)

// ---- format detection -----------------------------------------------------------------------------------------

const SCENE_HEADING = /^(?:\.(?!\.)\S|(?:INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s])/i
const TRANSITION = /^(?:>\s*)?[A-Z][A-Z ]*(?:TO:|OUT\.?|IN:?)\s*$|^(?:FADE IN:?|FADE OUT\.?|CUT TO BLACK\.?)$/
const LIST_ITEM = /^\s*(?:(?:shot|sh|scene|#)\s*\d+[a-z]?\s*[:.)-]?|\d+[a-z]?\s*[.)\]:-]|[-*•–]\s+)/i
const CUE =
  /^@?(?=[^a-z]*[A-Z])[A-Z0-9][A-Z0-9 .'’\-#]{0,36}(?:\s*\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D|CONT’D|[A-Z .']{1,20})\))*\s*\^?$/

const nonEmpty = (lines: readonly string[]) => lines.filter((l) => l.trim())

function looksTabular(lines: readonly string[]): 'tab' | 'pipe' | null {
  const ne = nonEmpty(lines)
  if (!ne.length) return null
  const tabs = ne.filter((l) => l.includes('\t')).length
  if (tabs >= Math.max(1, ne.length * 0.5)) return 'tab'
  const pipes = ne.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length
  if (pipes >= Math.max(2, ne.length * 0.6)) return 'pipe'
  return null
}

function csvHeader(lines: readonly string[]): boolean {
  const first = nonEmpty(lines)[0] ?? ''
  if (!first.includes(',')) return false
  const cells = splitCsvLine(first).map((c) => c.trim().toLowerCase())
  return cells.some((c) => VIDEO_HEAD.test(c)) && cells.some((c) => AUDIO_HEAD.test(c))
}

/** The format `text` looks like. */
export function detectFormat(text: string): ScriptFormat {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (looksTabular(lines) || csvHeader(lines)) return 'av'
  const ne = nonEmpty(lines).map((l) => l.trim())
  if (!ne.length) return 'prose'
  const headings = ne.filter((l) => SCENE_HEADING.test(l) && l === l.toUpperCase()).length
  const cues = ne.filter(
    (l, i) => CUE.test(l) && !SCENE_HEADING.test(l) && !TRANSITION.test(l) && i + 1 < ne.length,
  ).length
  const items = ne.filter((l) => LIST_ITEM.test(l)).length
  if (headings >= 1 || (cues >= 2 && items < ne.length / 2)) return 'screenplay'
  if (items >= Math.max(2, ne.length * 0.3)) return 'shot-list'
  return 'prose'
}

// ---- AV scripts ------------------------------------------------------------------------------------------------

const VIDEO_HEAD = /^(?:video|visuals?|picture|image|vision|action|description|on[\s-]?screen|what we see)$/
const AUDIO_HEAD = /^(?:audio|sound|vo|v\.o\.|voice[\s-]?over|dialog(?:ue)?|script|copy|what we hear)$/
const CAMERA_HEAD = /^(?:camera|framing|shot\s*(?:size|type)|angle|lens)$/
const TIME_HEAD = /^(?:time|dur(?:ation)?|length|secs?|seconds|tc|timing)$/
const NUMBER_HEAD = /^(?:#|no\.?|num(?:ber)?|shot\s*#?|scene|sc\.?|panel)$/
const SFX_HEAD = /^(?:sfx|fx|music|mx|effects?)$/

export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cell)
      cell = ''
    } else cell += c
  }
  out.push(cell)
  return out
}

/** CSV rows with quoted cells that may hold line breaks. */
function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  rows.push(row)
  return rows.filter((r) => r.some((c) => c.trim()))
}

function tableRows(text: string): string[][] {
  const lines = text.split('\n')
  const kind = looksTabular(lines)
  if (kind === 'tab') return nonEmpty(lines).map((l) => l.split('\t'))
  if (kind === 'pipe')
    return nonEmpty(lines)
      .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|'))
      .filter((cells) => !cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c)))
  return csvRows(text)
}

type Role = 'video' | 'audio' | 'camera' | 'time' | 'number' | 'sfx' | 'other'

function roleOf(head: string): Role | null {
  const h = head.trim().toLowerCase().replace(/[*_]/g, '')
  if (VIDEO_HEAD.test(h)) return 'video'
  if (AUDIO_HEAD.test(h)) return 'audio'
  if (CAMERA_HEAD.test(h)) return 'camera'
  if (TIME_HEAD.test(h)) return 'time'
  if (NUMBER_HEAD.test(h)) return 'number'
  if (SFX_HEAD.test(h)) return 'sfx'
  return null
}

function parseAv(text: string, fps: number): Beat[] {
  const rows = tableRows(text)
  if (!rows.length) return []
  const head = rows[0] as string[]
  const named = head.map(roleOf)
  let roles: Role[]
  let body = rows
  if (named.includes('video') || named.includes('audio')) {
    roles = named.map((r) => r ?? 'other')
    body = rows.slice(1)
  } else {
    // no header: two columns are VIDEO | AUDIO; a first column of numbers is the shot number
    const width = Math.max(...rows.map((r) => r.length))
    const numbered = rows.every((r) => /^\s*(?:#?\d+[a-z]?\.?)?\s*$/i.test(r[0] ?? ''))
    roles = Array.from({ length: width }, (_, i): Role => {
      if (numbered && width >= 3) return i === 0 ? 'number' : i === 1 ? 'video' : i === 2 ? 'audio' : 'other'
      return i === 0 ? 'video' : i === 1 ? 'audio' : 'other'
    })
  }
  const beats: Beat[] = []
  for (const row of body) {
    const cell = (role: Role) =>
      row
        .map((c, i) => (roles[i] === role ? c.trim() : ''))
        .filter(Boolean)
        .join('\n')
    const video = cell('video')
    const audio = cell('audio')
    if (!video && !audio && !cell('camera')) continue
    const fromVideo = beatOf(video, fps)
    const camWords = cell('camera')
    const audioText = audio.replace(/\s*\n\s*/g, ' ')
    const tagged = audioParts(audioText)
    const untagged = tagged.action
    const beat: Beat = {
      camera: camWords ? cameraOf(camWords).camera || camWords.toUpperCase() : fromVideo.camera,
      action: fromVideo.action,
      // the AUDIO column: tagged parts as they are; untagged words are the VO
      dialogue: [
        untagged ? (/^[A-Z][A-Z0-9 .'’-]{0,30}:/.test(untagged) ? untagged : `VO: ${untagged}`) : '',
        tagged.dialogue,
        fromVideo.dialogue,
      ]
        .filter(Boolean)
        .join('\n'),
      sfx: [cell('sfx'), tagged.sfx, fromVideo.sfx].filter(Boolean).join('; '),
      durationMs: null,
    }
    const time = cell('time')
    beat.durationMs =
      (time ? parseDuration(time, fps) : null) ??
      fromVideo.durationMs ??
      durationHint(audioText, fps).ms ??
      null
    if (beat.dialogue) beat.dialogue = durationHint(beat.dialogue, fps).rest
    beat.durationMs ??= spokenMs(beat.dialogue)
    // a row with sound only continues the shot before it
    const prev = beats[beats.length - 1]
    if (prev && !video && !camWords && !beat.durationMs) {
      prev.dialogue = [prev.dialogue, beat.dialogue].filter(Boolean).join('\n')
      prev.sfx = [prev.sfx, beat.sfx].filter(Boolean).join('; ')
      continue
    }
    if (hasWords(beat)) beats.push(beat)
  }
  return beats
}

// ---- screenplays ----------------------------------------------------------------------------------------------

const PARENTHETICAL = /^\(.*\)$/

function stripFountain(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '') // boneyard
    .replace(/\[\[[\s\S]*?\]\]/g, '') // notes
    .split('\n')
    .filter((l) => !/^\s*(?:#|=(?!=)|title:|credit:|author:|source:|draft date:|contact:)/i.test(l))
    .join('\n')
}

function parseScreenplay(text: string, fps: number): Beat[] {
  const lines = stripFountain(text).split('\n')
  const beats: Beat[] = []
  let scene = ''
  let cur: Beat | null = null
  const flush = () => {
    if (cur && hasWords(cur)) {
      cur.durationMs ??= spokenMs(cur.dialogue)
      beats.push(cur)
    }
    cur = null
  }
  const start = (camera = ''): Beat => {
    flush()
    const b = blankBeat()
    b.camera = camera
    cur = b
    return b
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.trim()
    if (!line) continue
    if (SCENE_HEADING.test(line) && (line === line.toUpperCase() || line.startsWith('.'))) {
      flush()
      scene = line.replace(/^\./, '').trim()
      // the scene's first shot establishes it, unless the next line names a shot of its own
      const b = start('WIDE')
      b.action = sceneLabel(scene)
      continue
    }
    if (TRANSITION.test(line) || /^>.*<$/.test(line)) {
      flush()
      continue
    }
    const next = (lines[i + 1] ?? '').trim()
    const isCue = CUE.test(line) && !!next && !SCENE_HEADING.test(line) && line.replace(/^@/, '').length <= 40
    if (isCue) {
      const speaker = line
        .replace(/^@/, '')
        .replace(/\s*\^$/, '')
        .replace(/\s*\((?:CONT'?D|CONT’D)\)/gi, '')
        .trim()
      const vo = /\((?:V\.?O\.?)\)/i.test(speaker)
      const name = speaker.replace(/\s*\([^)]*\)/g, '').trim()
      const words: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const l = (lines[j] ?? '').trim()
        if (!l) break
        if (PARENTHETICAL.test(l)) {
          j++
          continue
        }
        words.push(l)
        j++
      }
      i = j - 1
      const said = tidy(words.join(' '))
      const hint = durationHint(said, fps)
      const lineOf = `${vo ? `${name} (VO)` : name}: ${hint.rest}`
      // a second speaker in the same shot gets a shot of their own (a reaction or a reverse)
      const b: Beat = cur && !(cur as Beat).dialogue ? cur : start(cur ? 'MS' : '')
      b.dialogue = b.dialogue ? `${b.dialogue}\n${lineOf}` : lineOf
      if (hint.ms !== null) b.durationMs = hint.ms
      continue
    }
    // an action paragraph: consecutive lines until a blank line, a heading or a cue
    const para: string[] = [line.replace(/^!/, '')]
    let j = i + 1
    while (j < lines.length) {
      const l = (lines[j] ?? '').trim()
      if (!l || SCENE_HEADING.test(l) || TRANSITION.test(l)) break
      if (CUE.test(l) && (lines[j + 1] ?? '').trim()) break
      para.push(l)
      j++
    }
    i = j - 1
    const beat = beatOf(para.join(' '), fps)
    // the establishing shot of a scene takes its first action paragraph
    const c = cur as Beat | null
    if (c && c.camera === 'WIDE' && c.action === sceneLabel(scene) && !c.dialogue && !beat.camera) {
      c.action = `${c.action}. ${beat.action}`.trim()
      c.sfx = beat.sfx
      if (beat.durationMs !== null && !beat.dialogue) c.durationMs = beat.durationMs
      if (beat.dialogue) c.dialogue = beat.dialogue
      continue
    }
    const b = start(beat.camera)
    Object.assign(b, beat)
  }
  flush()
  return beats
}

/** "INT. KITCHEN - DAY" as words for a panel: "Int. Kitchen – day". */
function sceneLabel(heading: string): string {
  const lower = heading.toLowerCase()
  return lower
    .replace(/(^|[\s./-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .replace(/\s+-\s+/g, ' – ')
}

// ---- shot lists and prose -------------------------------------------------------------------------------------

function parseShotList(text: string, fps: number): Beat[] {
  const items: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (LIST_ITEM.test(line)) items.push(line.replace(LIST_ITEM, '').trim())
    else if (items.length) items[items.length - 1] += ` ${line}`
    // words before the first item (a title) are left out
  }
  return items.map((t) => beatOf(t, fps)).filter(hasWords)
}

function parseProse(text: string, fps: number): Beat[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const pieces =
    paras.length > 1
      ? paras
      : (paras[0] ?? '')
          .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
          .map((s) => s.trim())
          .filter(Boolean)
  return pieces.map((p) => beatOf(p, fps)).filter(hasWords)
}

/** `text` as beats (see the header), in the format given or the one it looks like. */
export function parseScript(text: string, opts: { format?: ScriptFormat; fps?: number } = {}): ParsedScript {
  const clean = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ')
  const fps = opts.fps ?? 24
  const format = opts.format ?? detectFormat(clean)
  const beats =
    format === 'av'
      ? parseAv(clean, fps)
      : format === 'screenplay'
        ? parseScreenplay(clean, fps)
        : format === 'shot-list'
          ? parseShotList(clean, fps)
          : parseProse(clean, fps)
  return { format, beats: beats.slice(0, SCRIPT_MAX_BEATS), truncated: beats.length > SCRIPT_MAX_BEATS }
}
