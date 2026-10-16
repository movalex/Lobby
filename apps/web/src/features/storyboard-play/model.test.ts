// Wave T (WS3): what the player and the exports read of a storyboard (WS2's elements as the contracts give them): the
// panels in order with derived numbers, starts and durations, each panel's fields and picture, the title, the sound.
import { describe, expect, it } from 'vitest'
import {
  audioTrackOf,
  shotLabel,
  storyboardById,
  storyboardIdAt,
  storyboardOfIds,
  storyboardViews,
  UNTITLED_STORYBOARD,
} from './model.ts'
import { sceneOf, storyboardEls } from './test-kit.ts'

const PANELS = [
  { id: 'p3', pos: 'a2', dur: 1500, fields: { dialogue: 'Third' }, sketch: true },
  {
    id: 'p1',
    pos: 'a0',
    dur: 2000,
    name: 'Open',
    fields: { camera: 'WIDE', dialogue: 'Hello there' },
    image: true,
  },
  { id: 'p2', pos: 'a1', fields: { action: 'She turns', sfx: 'Door' }, slot: true },
  { id: 'p4', pos: 'a3', dur: 600 },
]

describe('the storyboard as WS3 reads it', () => {
  it('panels in sb:pos order, numbered 1..N, back to back, the head default for a panel without sb:dur', () => {
    const scene = sceneOf(storyboardEls('h1', PANELS, { aspect: '9:16', defaultMs: 2500, fps: 25 }))
    const v = storyboardById(scene, 'h1')
    expect(v?.title).toBe('Spot 30')
    expect(v?.aspect).toBe('9:16')
    expect(v?.ratio).toBeCloseTo(9 / 16)
    expect(v?.fps).toBe(25)
    expect(v?.panels.map((p) => [p.id, p.number, p.startMs, p.durationMs])).toEqual([
      ['p1', 1, 0, 2000],
      ['p2', 2, 2000, 2500],
      ['p3', 3, 4500, 1500],
      ['p4', 4, 6000, 600],
    ])
    expect(v?.totalMs).toBe(6600)
    expect(v?.panels[0]?.name).toBe('Open')
  })

  it('reads the fields from the labelled boxes by kind', () => {
    const v = storyboardById(sceneOf(storyboardEls('h1', PANELS)), 'h1')
    expect(v?.panels[0]?.fields).toEqual({
      camera: 'WIDE',
      action: '',
      dialogue: 'Hello there',
      sfx: '',
      music: '',
    })
    expect(v?.panels[1]?.fields.sfx).toBe('Door')
  })

  it('the picture: the largest image (with what is drawn over it), else the slot, else the sketch; an empty panel has none', () => {
    const v = storyboardById(sceneOf(storyboardEls('h1', PANELS)), 'h1')
    const [p1, p2, p3, p4] = v?.panels ?? []
    expect(p1?.picture?.bounds).toEqual({ x: 450, y: 10, width: 380, height: 214 })
    expect(p1?.picture?.ids).toEqual(['p1.img'])
    // the fields and their labels are never part of the picture
    expect(p2?.picture?.bounds).toEqual({ x: 890, y: 10, width: 380, height: 214 })
    expect(p2?.picture?.ids).not.toContain('p2.action')
    expect(p3?.picture?.bounds).toEqual({ x: 50, y: 40, width: 100, height: 80 })
    expect(p4?.picture).toBeNull()
  })

  it('a picture signature changes when what it draws changes', () => {
    const els = storyboardEls('h1', PANELS)
    const scene = sceneOf(els)
    const before = storyboardById(scene, 'h1')?.panels[0]?.picture?.sig
    const img = els.find((e) => e.id === 'p1.img') as unknown as { version: number }
    img.version = 2
    expect(storyboardById(scene, 'h1')?.panels[0]?.picture?.sig).not.toBe(before)
  })

  it('a deleted head leaves an untitled storyboard that still plays; a storyboard needs a panel', () => {
    const scene = sceneOf(storyboardEls('h1', PANELS.slice(0, 2), { aspect: '16:9' }, { withHead: false }))
    const v = storyboardById(scene, 'h1')
    expect(v?.title).toBe(UNTITLED_STORYBOARD)
    expect(v?.panels).toHaveLength(2)
    expect(storyboardById(sceneOf(storyboardEls('h2', [])), 'h2')).toBeNull()
    expect(storyboardViews(sceneOf(storyboardEls('h2', [])))).toEqual([])
  })

  it('finds the storyboard of a selection: the head, a panel, or something in a panel', () => {
    const scene = sceneOf([...storyboardEls('h1', PANELS), ...storyboardEls('h9', [{ id: 'q1', pos: 'a0' }])])
    expect(storyboardIdAt(scene, 'h1')).toBe('h1')
    expect(storyboardIdAt(scene, 'p2')).toBe('h1')
    expect(storyboardIdAt(scene, 'p1.img')).toBe('h1')
    expect(storyboardIdAt(scene, 'q1')).toBe('h9')
    expect(storyboardOfIds(scene, ['nope', 'q1'])).toBe('h9')
    expect(storyboardOfIds(scene, ['nope'])).toBeNull()
    expect(
      storyboardViews(scene)
        .map((v) => v.id)
        .sort(),
    ).toEqual(['h1', 'h9'])
  })

  it('the sound: a video card or a byte-checked audio attachment, with its offset; anything else is no sound', () => {
    const card = (id: string, kind: string, mimeType: string) => ({
      ...storyboardEls('x', [])[0],
      id,
      type: 'image',
      customData: {
        lobby: {
          file: { assetId: 'ast_a', versionId: `ver_${id}`, kind, name: `${id}.bin`, mimeType, sizeBytes: 1 },
        },
      },
    })
    const scene = sceneOf([
      card('mp3', 'other', 'audio/mpeg'),
      card('vid', 'video', 'video/mp4'),
      card('zip', 'other', 'application/octet-stream'),
      card('png', 'image', 'image/png'),
    ] as never)
    expect(audioTrackOf(scene, { aspect: '16:9', audio: 'mp3', audioOffsetMs: -1500 })).toMatchObject({
      source: 'audio',
      versionId: 'ver_mp3',
      offsetMs: -1500,
    })
    expect(audioTrackOf(scene, { aspect: '16:9', audio: 'vid' })).toMatchObject({
      source: 'video',
      offsetMs: 0,
    })
    expect(audioTrackOf(scene, { aspect: '16:9', audio: 'zip' })).toBeNull()
    expect(audioTrackOf(scene, { aspect: '16:9', audio: 'png' })).toBeNull()
    expect(audioTrackOf(scene, { aspect: '16:9', audio: 'gone' })).toBeNull()
    expect(audioTrackOf(scene, { aspect: '16:9' })).toBeNull()
  })

  it('shot labels', () => {
    expect(shotLabel(3)).toBe('SH 03')
    expect(shotLabel(120)).toBe('SH 120')
  })
})
