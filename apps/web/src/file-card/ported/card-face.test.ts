import { describe, expect, it } from 'vitest'
import { drawCardFace, FACE_THEMES, type FaceContext, fitText, statusLine } from './card-face.ts'
import type { CardView } from './model.ts'

/** A 2D context that records what is drawn (text, images, fills); 7 px per character. */
function recorder() {
  const texts: { text: string; fill: unknown; font: string }[] = []
  const images: { dw: number; dh: number }[] = []
  const fills: unknown[] = []
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    rect() {},
    roundRect() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {
      fills.push(this.fillStyle)
    },
    stroke() {},
    clip() {},
    fillRect() {
      fills.push(this.fillStyle)
    },
    fillText(text: string) {
      texts.push({ text, fill: this.fillStyle, font: this.font })
    },
    measureText: (s: string) => ({ width: s.length * 7 }),
    drawImage(_i: unknown, _x: number, _y: number, dw: number, dh: number) {
      images.push({ dw, dh })
    },
  }
  return { ctx: ctx as unknown as FaceContext, texts, images, fills }
}

const view = (extra: Partial<CardView> = {}): CardView => ({
  status: 'ready',
  kind: 'pdf',
  name: 'Q3 brief.pdf',
  sizeBytes: 2_400_000,
  pageCount: 4,
  durationMs: null,
  errorMessage: null,
  missing: false,
  ...extra,
})
const COVER = { image: {} as CanvasImageSource, width: 512, height: 662 }

describe('W5-14: a file card’s face as a bitmap (for exports)', () => {
  it('a PDF: its cover letterboxed above the footer, the pages chip, the type badge, the name and its size', () => {
    const r = recorder()
    drawCardFace(r.ctx, { view: view(), width: 260, height: 356, cover: COVER })
    expect(r.images).toHaveLength(1)
    const img = r.images[0] as { dw: number; dh: number }
    expect(img.dh).toBeCloseTo(356 - 56)
    expect(img.dw).toBeLessThanOrEqual(260)
    const words = r.texts.map((t) => t.text)
    expect(words).toContain('4 pages')
    expect(words).toContain('PDF')
    expect(words).toContain('Q3 brief.pdf')
    expect(words.some((w) => w.startsWith('2.3 MB') || w.startsWith('2.4 MB'))).toBe(true)
  })

  it('a video: the poster with a play button and its duration', () => {
    const r = recorder()
    drawCardFace(r.ctx, {
      view: view({ kind: 'video', name: 'teaser.mp4', pageCount: null, durationMs: 5_000 }),
      width: 360,
      height: 276,
      cover: COVER,
    })
    const words = r.texts.map((t) => t.text)
    expect(words).toContain('0:05')
    expect(words).toContain('MP4')
    expect(r.fills).toContain('rgba(20, 24, 32, 0.72)')
  })

  it('an attachment is its footer only; a failed card says why, in the theme’s danger colour', () => {
    const a = recorder()
    drawCardFace(a.ctx, {
      view: view({ kind: 'other', name: 'notes.zip', pageCount: null }),
      width: 300,
      height: 92,
    })
    expect(a.images).toHaveLength(0)
    expect(a.texts.map((t) => t.text)).toEqual(['ZIP', 'notes.zip', expect.stringContaining('Attachment')])
    const f = recorder()
    drawCardFace(f.ctx, {
      view: view({ status: 'failed', errorMessage: 'This PDF is password-protected.' }),
      width: 260,
      height: 356,
      theme: 'dark',
      cover: COVER,
    })
    expect(f.images).toHaveLength(0)
    const err = f.texts.find((t) => t.text.startsWith('This PDF'))
    expect(err?.fill).toBe(FACE_THEMES.dark.danger)
    expect(f.fills).toContain(FACE_THEMES.dark.surface)
  })

  it('long names are cut to fit; the status line matches the card on screen', () => {
    const r = recorder()
    expect(fitText(r.ctx, 'a-very-long-file-name-for-the-client.pdf', 70)).toBe('a-very-lo…')
    expect(statusLine(view({ status: 'queued' }))).toBe('Queued')
    expect(statusLine(view({ missing: true }))).toBe('Unavailable')
    expect(statusLine(view({ kind: 'other', pageCount: null }))).toBe('Attachment')
  })
})
