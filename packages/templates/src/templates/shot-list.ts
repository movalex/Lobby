// Shot list (wave K, K4-2): a shoot day on one board. A day-of-shoot frame for the facts (call time, place,
// crew, kit), then one frame per scene with four shots: an empty box for a sketch or a frame grab, and a
// card with the shot's size, lens, camera move and length. Frames, notes, boxes and text only; no images
// ship with the template.
import { CONTENT_Y, type LobbyColor, PAD } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const SECTIONS = ['1 · Shoot day', '2 · Scene 1', '3 · Scene 2', '4 · Scene 3'] as const

const GAP = 80
const SCENE_W = 620
const ROW_W = 3 * SCENE_W + 2 * GAP
const DAY_H = 440
const SCENES_Y = DAY_H + GAP
const SHOT_H = 117
const SHOT_STEP = SHOT_H + 33
const SHOTS = 4
const SCENE_H = CONTENT_Y + SHOTS * SHOT_STEP + 20
/** A 16:9 box beside each card, for a sketch or a frame grab. */
const SLOT_W = 208
const CARD_X = PAD + SLOT_W + 20

interface Scene {
  heading: string
  intro: string
  color: LobbyColor
  /** [shot name, lens and move, length] */
  shots: ReadonlyArray<readonly [string, string, string]>
}

const SCENES: readonly Scene[] = [
  {
    heading: 'Scene 1: opening',
    intro: 'Where are we, what time of day, who is in it?',
    color: 'light-blue',
    shots: [
      ['1A · Wide: set the scene', 'Lens: 24mm · Move: static', 'Length: 5 s'],
      ['1B · Medium: meet the hero', 'Lens: 35mm · Move: push in', 'Length: 4 s'],
      ['1C · Close-up: the detail', 'Lens: 85mm · Move: handheld', 'Length: 3 s'],
      ['1D · Insert: prop or product', 'Lens: macro · Move: slider', 'Length: 3 s'],
    ],
  },
  {
    heading: 'Scene 2: the turn',
    intro: 'Where does the story change? Note the new place or light.',
    color: 'light-violet',
    shots: [
      ['2A · Wide: the new place', 'Lens: 24mm · Move: pan', 'Length: 5 s'],
      ['2B · Two-shot: the exchange', 'Lens: 50mm · Move: static', 'Length: 6 s'],
      ['2C · Over the shoulder', 'Lens: 50mm · Move: handheld', 'Length: 4 s'],
      ['2D · Cutaway: the reaction', 'Lens: 85mm · Move: static', 'Length: 2 s'],
    ],
  },
  {
    heading: 'Scene 3: the payoff',
    intro: 'The moment people remember, then the end card.',
    color: 'light-green',
    shots: [
      ['3A · Hero shot: the moment', 'Lens: 35mm · Move: orbit', 'Length: 5 s'],
      ['3B · Close-up: the result', 'Lens: 85mm · Move: static', 'Length: 3 s'],
      ['3C · Wide: pull out', 'Lens: 24mm · Move: pull back', 'Length: 4 s'],
      ['3D · End card: logo', 'Lens: none · Move: locked off', 'Length: 3 s'],
    ],
  },
]

export const shotList: TemplateSource = {
  id: 'shot-list',
  name: 'Shot list',
  description:
    'List every shot of a shoot day by scene, with a box for a sketch, the lens, the camera move and the length.',
  category: 'plan',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    const day = b.section({
      x: 0,
      y: 0,
      w: ROW_W,
      h: DAY_H,
      name: SECTIONS[0],
      heading: 'Shoot day: working title',
      intro: 'Fill in the day first, then give every scene its shots. Keep each card to one line per detail.',
    })
    b.noteGrid(day, { x: PAD, y: CONTENT_Y - 10, cols: 6 }, [
      { text: 'Date and call time', color: 'yellow' },
      { text: 'Location and parking', color: 'light-blue' },
      { text: 'Cast and crew', color: 'light-violet' },
      { text: 'Camera, lenses and lights', color: 'light-green' },
      { text: 'Permits and releases', color: 'orange' },
      { text: 'Weather plan B', color: 'light-red' },
    ])

    SCENES.forEach((scene, s) => {
      const frame = b.section({
        x: s * (SCENE_W + GAP),
        y: SCENES_Y,
        w: SCENE_W,
        h: SCENE_H,
        name: SECTIONS[s + 1] ?? '',
        heading: scene.heading,
        intro: scene.intro,
      })
      scene.shots.forEach((shot, i) => {
        const y = CONTENT_Y + i * SHOT_STEP
        b.imageSlot(frame, { x: PAD, y, w: SLOT_W, h: SHOT_H, label: 'Sketch or frame grab' })
        b.geo(frame, {
          x: CARD_X,
          y,
          w: SCENE_W - PAD - CARD_X,
          h: SHOT_H,
          text: shot.join('\n'),
          color: scene.color,
          labelColor: 'black',
          fill: 'solid',
          size: 's',
          titled: true,
        })
      })
    })
  },
}
