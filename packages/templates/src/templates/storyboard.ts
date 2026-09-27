import type { TLFrameShape } from '@tldraw/tlschema'
import { CONTENT_Y, createBoardBuilder, PAD } from '../builder.ts'
import type { TemplateDefinition } from '../types.ts'

const PANEL_W = 400
const PANEL_H = 540
const PANEL_GAP = 80
const PANELS_Y = 540
const INSET = 24
const NOTE_SCALE = 0.8

const BEATS: ReadonlyArray<{ beat: string; shot: string; time: string }> = [
  { beat: 'Set the scene', shot: 'Shot: wide, establishing\nMove: slow push in', time: '0:00 – 0:05' },
  { beat: 'Meet the hero', shot: 'Shot: medium on the hero\nMove: static', time: '0:05 – 0:10' },
  { beat: 'The problem', shot: 'Shot: close-up on the problem\nMove: handheld', time: '0:10 – 0:15' },
  { beat: 'The turn', shot: 'Shot: reveal or reaction\nMove: pan or rack focus', time: '0:15 – 0:20' },
  { beat: 'The payoff', shot: 'Shot: the product or moment\nMove: slow orbit', time: '0:20 – 0:25' },
  { beat: 'The sign-off', shot: 'Shot: end card with logo\nMove: locked off', time: '0:25 – 0:30' },
]
const PANEL_COUNT = BEATS.length

const BRIEF = 'Brief'
const panelName = (i: number) => `Panel ${i + 1}`
const SECTIONS = [BRIEF, ...BEATS.map((_, i) => panelName(i))]

export const storyboard: TemplateDefinition = {
  id: 'storyboard',
  name: 'Storyboard',
  description: 'Plan a short film or ad beat by beat: six panels with image slots, shot notes and timings.',
  category: 'visual',
  sections: SECTIONS,
  build(ctx) {
    const b = createBoardBuilder(ctx)
    const totalW = PANEL_COUNT * PANEL_W + (PANEL_COUNT - 1) * PANEL_GAP

    const brief = b.section({
      x: 0,
      y: 0,
      w: totalW,
      h: 420,
      name: BRIEF,
      heading: 'Storyboard: working title',
      intro:
        'Fill in the brief, then sketch one beat per panel. ' +
        'Keep shot notes short: shot size, camera move, length.',
    })
    const briefNotes = b.noteGrid(brief, { x: PAD, y: CONTENT_Y - 10, cols: 6 }, [
      { text: 'Logline: the story in one sentence', color: 'yellow' },
      { text: "Audience, and where they'll watch it", color: 'light-blue' },
      { text: 'Length and format: e.g. 30s, 16:9', color: 'light-green' },
      { text: 'Tone and references', color: 'light-violet' },
      { text: 'Music and sound', color: 'orange' },
      { text: 'End card or call to action', color: 'light-red' },
    ])
    // Reference strip fills the rest of the brief row.
    const refX = PAD + briefNotes.length * 220 + 20
    b.imageSlot(brief, {
      x: refX,
      y: CONTENT_Y - 10,
      w: totalW - PAD - refX,
      h: 200,
      label: 'Reference frames: films, ads or photos that set the look',
    })

    const panels: TLFrameShape[] = []
    BEATS.forEach((beat, i) => {
      const panel = b.section({
        x: i * (PANEL_W + PANEL_GAP),
        y: PANELS_Y,
        w: PANEL_W,
        h: PANEL_H,
        name: panelName(i),
        heading: `${i + 1} · ${beat.beat}`,
        headingSize: 'm',
      })
      const imageW = PANEL_W - INSET * 2
      const imageH = Math.round((imageW * 9) / 16)
      b.imageSlot(panel, { x: INSET, y: 84, w: imageW, h: imageH, label: 'Sketch or frame grab' })
      const notesY = 84 + imageH + 24
      const noteW = 200 * NOTE_SCALE
      b.note(panel, { x: INSET, y: notesY, text: beat.shot, color: 'yellow', scale: NOTE_SCALE })
      b.note(panel, {
        x: PANEL_W - INSET - noteW,
        y: notesY,
        text: 'We see…\nWe hear…',
        color: 'light-blue',
        scale: NOTE_SCALE,
      })
      b.text(panel, {
        x: INSET,
        y: notesY + noteW + 24,
        w: imageW,
        text: `Time: ${beat.time}`,
        size: 's',
        color: 'grey',
      })
      panels.push(panel)
    })

    b.chain(panels, { size: 'l' })

    return { records: b.finish() }
  },
}
