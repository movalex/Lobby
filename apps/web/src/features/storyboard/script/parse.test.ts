// Script to boards (wave T, WS2): the parser on golden scripts of each format, and on junk.
import { describe, expect, it } from 'vitest'
import {
  audioParts,
  cameraOf,
  detectFormat,
  durationHint,
  parseScript,
  SCRIPT_MAX_BEATS,
  spokenMs,
} from './parse.ts'

export const AV_SCRIPT = [
  'VIDEO\tAUDIO',
  'WIDE - A city wakes up at dawn. (3s)\tMUSIC: soft piano',
  'CU - Hands pour coffee into a mug.\tVO: Every day starts with a choice.',
  'MS, slow PUSH IN on Ana at the window.\tANA: Not today.',
  '\tSFX: a door slams',
  'Logo on white. 0:02\tVO: Lobby. Plan it together.',
].join('\n')

export const SCREENPLAY = `Title: Morning
Author: Sam

INT. KITCHEN - DAY

Ana pours coffee. The radio hums.

ANA
(quietly)
Morning.

BEN (O.S.)
You're up early.

CUT TO:

EXT. STREET - NIGHT

CLOSE ON a bus window, rain running down it. (2.5s)

NARRATOR (V.O.)
Some days start twice.

[[a note for the director]]
/* an old scene
INT. NOWHERE - DAY
*/
`

export const SHOT_LIST = `Shot list: Coffee spot

1. WIDE - Kitchen at dawn, steam rising. (3s)
2. CU - hands on the mug. VO: Every day starts here.
3) OTS on Ana looking out. SFX: birds
- Logo on white, 2s
`

describe('format detection', () => {
  it('tells the four formats apart', () => {
    expect(detectFormat(AV_SCRIPT)).toBe('av')
    expect(detectFormat(SCREENPLAY)).toBe('screenplay')
    expect(detectFormat(SHOT_LIST)).toBe('shot-list')
    expect(detectFormat('A quiet morning. Then the storm.')).toBe('prose')
    expect(detectFormat('| VIDEO | AUDIO |\n|---|---|\n| Wide city | VO: hello |')).toBe('av')
    expect(detectFormat('Shot,Video,Audio\n1,Wide city,VO: hello')).toBe('av')
  })
})

describe('the pieces', () => {
  it('camera words: abbreviations, phrases and moves; the rest is the action', () => {
    expect(cameraOf('CU - hands on pad')).toEqual({ camera: 'CU', rest: 'hands on pad' })
    expect(cameraOf('Wide shot of the city')).toEqual({ camera: 'WIDE', rest: 'the city' })
    expect(cameraOf('Extreme close-up: an eye')).toEqual({ camera: 'ECU', rest: 'an eye' })
    expect(cameraOf('MS, slow PUSH IN on Ana')).toEqual({ camera: 'MS slow PUSH IN', rest: 'Ana' })
    expect(cameraOf('Over the shoulder on Ben')).toEqual({ camera: 'OTS', rest: 'Ben' })
    expect(cameraOf('Ana walks in')).toEqual({ camera: '', rest: 'Ana walks in' })
    expect(cameraOf('Panic in the room').camera).toBe('')
  })

  it('duration hints in brackets, at the end, or labelled; else the dialogue at 2.5 words a second', () => {
    expect(durationHint('A city wakes (3s)')).toEqual({ ms: 3000, rest: 'A city wakes' })
    expect(durationHint('Logo on white. 0:02')).toEqual({ ms: 2000, rest: 'Logo on white.' })
    expect(durationHint('Logo, 2.5s')).toEqual({ ms: 2500, rest: 'Logo' })
    expect(durationHint('Run [36f]').ms).toBe(1500)
    expect(durationHint('Duration: 4s. A beat').ms).toBe(4000)
    expect(durationHint('Shot 3 of the day').ms).toBeNull()
    expect(spokenMs('VO: one two three four five')).toBe(2000)
    expect(spokenMs('Hi.')).toBe(1500)
    expect(spokenMs('')).toBeNull()
  })

  it('audio tags split what we see from what we hear', () => {
    expect(audioParts('Hands on the mug. VO: Every day starts here. SFX: birds')).toEqual({
      action: 'Hands on the mug.',
      dialogue: 'VO: Every day starts here.',
      sfx: 'birds',
    })
    expect(audioParts('Logo. MUSIC: sting').sfx).toBe('Music: sting')
  })
})

describe('golden scripts', () => {
  it('an AV script: a row a shot; sound-only rows join the shot before; header skipped', () => {
    const r = parseScript(AV_SCRIPT)
    expect(r.format).toBe('av')
    expect(r.beats).toEqual([
      { camera: 'WIDE', action: 'A city wakes up at dawn.', dialogue: '', sfx: 'Music: soft piano', durationMs: 3000 },
      {
        camera: 'CU',
        action: 'Hands pour coffee into a mug.',
        dialogue: 'VO: Every day starts with a choice.',
        sfx: '',
        durationMs: 2400,
      },
      // the sound-only row below it joins this shot
      {
        camera: 'MS slow PUSH IN',
        action: 'Ana at the window.',
        dialogue: 'ANA: Not today.',
        sfx: 'a door slams',
        durationMs: 1500,
      },
      { camera: '', action: 'Logo on white.', dialogue: 'VO: Lobby. Plan it together.', sfx: '', durationMs: 2000 },
    ])
  })

  it('an AV script as a CSV with a header and a markdown table', () => {
    const csv = parseScript('Shot,Video,Audio,Time\n1,"Wide city, dawn",VO: Hello,3\n2,CU coffee,"SFX: pour",')
    expect(csv.beats.map((b) => [b.camera, b.action, b.dialogue, b.sfx, b.durationMs])).toEqual([
      ['WIDE', 'City, dawn', 'VO: Hello', '', 3000],
      ['CU', 'Coffee', '', 'pour', null],
    ])
    const md = parseScript('| Video | Audio |\n| --- | --- |\n| Wide city | Hello there |\n| CU cup | |')
    expect(md.beats.map((b) => [b.camera, b.action, b.dialogue])).toEqual([
      ['WIDE', 'City', 'VO: Hello there'],
      ['CU', 'Cup', ''],
    ])
  })

  it('a screenplay: scene headings establish, dialogue under its speaker, a second speaker a shot of its own', () => {
    const r = parseScript(SCREENPLAY)
    expect(r.format).toBe('screenplay')
    expect(r.beats.map((b) => [b.camera, b.action, b.dialogue, b.durationMs])).toEqual([
      ['WIDE', 'Int. Kitchen – Day. Ana pours coffee. The radio hums.', 'ANA: Morning.', 1500],
      ['MS', '', "BEN: You're up early.", 1500],
      ['WIDE', 'Ext. Street – Night', '', null],
      ['CU', 'A bus window, rain running down it.', 'NARRATOR (VO): Some days start twice.', 2500],
    ])
  })

  it('a shot list: numbered and bulleted items, a title line left out', () => {
    const r = parseScript(SHOT_LIST)
    expect(r.format).toBe('shot-list')
    expect(r.beats.map((b) => [b.camera, b.action, b.dialogue, b.sfx, b.durationMs])).toEqual([
      ['WIDE', 'Kitchen at dawn, steam rising.', '', '', 3000],
      ['CU', 'Hands on the mug.', 'VO: Every day starts here.', '', 1600],
      ['OTS', 'Ana looking out.', '', 'birds', null],
      ['', 'Logo on white', '', '', 2000],
    ])
  })

  it('prose: a beat per paragraph, or per sentence', () => {
    expect(parseScript('A quiet morning.\n\nThen the storm.').beats.map((b) => b.action)).toEqual([
      'A quiet morning.',
      'Then the storm.',
    ])
    expect(parseScript('A quiet morning. Then the storm!').beats).toHaveLength(2)
  })

  it('junk and caps: nothing from blanks, at most 200 beats', () => {
    expect(parseScript('   \n\n  ').beats).toEqual([])
    expect(parseScript('\t\t\n\t').beats).toEqual([])
    const many = Array.from({ length: 250 }, (_, i) => `${i + 1}. CU shot ${i + 1}`).join('\n')
    const r = parseScript(many)
    expect(r.beats).toHaveLength(SCRIPT_MAX_BEATS)
    expect(r.truncated).toBe(true)
    // a forced format is used as given
    expect(parseScript(SHOT_LIST, { format: 'prose' }).format).toBe('prose')
  })
})
