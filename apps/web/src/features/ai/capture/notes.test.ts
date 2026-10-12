// Wave N (WS5, N5-3): notes from a photo (./notes.ts): the wall's layout kept with no two notes overlapping, the
// photo's colours as Lobby's note colours (yellow is Butter), groups as frames only where a frame is clean, and the
// whole result written in one undo step with the `ai` provenance on every element.

import { LOBBY_PALETTE } from '@draftroom/board-ops/elements'
import { lobbyKeySpec } from '@draftroom/canvas-schema/custom-data'
import { AI_COLOR_NAMES, type CaptureResult } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { fakeFlowCanvas, testId } from '../../flow/test-canvas.ts'
import { collides } from '../layout.ts'
import {
  applyCaptureNotes,
  CAPTURE_NOTE_GAP,
  CAPTURE_NOTE_SIZE,
  groupFrames,
  layoutNoteBoxes,
  noteColourOf,
  planCaptureNotes,
} from './notes.ts'

type Notes = Extract<CaptureResult, { kind: 'notes' }>
const box = (x: number, y: number, w = 0.14, h = 0.14) => ({ x, y, w, h })

/** The canned wall of the e2e kit: two columns of three. */
const WALL: Notes = {
  kind: 'notes',
  notes: [
    { text: 'Shorter stand-ups', color: 'yellow', box: box(0.06, 0.08) },
    { text: 'Demo every Friday', color: 'yellow', box: box(0.06, 0.28) },
    { text: 'Pair on reviews', color: 'light-green', box: box(0.06, 0.48) },
    { text: 'Too many meetings', color: 'light-red', box: box(0.55, 0.08) },
    { text: 'Unclear priorities', color: 'light-red', box: box(0.55, 0.28) },
    { text: 'Slow builds', color: 'orange', box: box(0.55, 0.48) },
  ],
  groups: [
    { name: 'Keep', notes: [0, 1, 2] },
    { name: 'Change', notes: [3, 4, 5] },
  ],
}

const noOverlaps = (rs: readonly { x: number; y: number; w: number; h: number }[], gap: number) => {
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      expect(collides(rs[i] as never, rs[j] as never, gap - 0.5), `${i} and ${j}`).toBe(false)
}

describe('the layout from the photo’s boxes', () => {
  it('keeps the wall’s columns and rows, a note the board’s size, the top-left at 0,0', () => {
    const rs = layoutNoteBoxes(WALL.notes)
    expect(rs.every((r) => r.w === CAPTURE_NOTE_SIZE && r.h === CAPTURE_NOTE_SIZE)).toBe(true)
    expect(Math.min(...rs.map((r) => r.x))).toBe(0)
    expect(Math.min(...rs.map((r) => r.y))).toBe(0)
    // left column left of the right one, each column top to bottom
    const [a, b, c, d, e, f] = rs as [
      (typeof rs)[0],
      (typeof rs)[0],
      (typeof rs)[0],
      (typeof rs)[0],
      (typeof rs)[0],
      (typeof rs)[0],
    ]
    for (const l of [a, b, c]) for (const r of [d, e, f]) expect(l.x).toBeLessThan(r.x)
    expect(a.y).toBeLessThan(b.y)
    expect(b.y).toBeLessThan(c.y)
    expect(d.y).toBeLessThan(e.y)
    noOverlaps(rs, CAPTURE_NOTE_GAP)
    // snapped to the board grid
    for (const r of rs) expect([r.x % 20, r.y % 20]).toEqual([0, 0])
  })

  it('has no overlaps however the boxes crowd: a pile of notes in one spot, and notes with no box', () => {
    const pile: Notes['notes'] = Array.from({ length: 30 }, (_, i) => ({
      text: `n${i}`,
      color: 'yellow',
      box: box(0.4 + (i % 3) * 0.01, 0.4 + (i % 2) * 0.01, 0.1, 0.1),
    }))
    const none: Notes['notes'] = Array.from({ length: 7 }, (_, i) => ({
      text: `z${i}`,
      color: 'blue',
      box: box(0, 0, 0, 0),
    }))
    for (const notes of [pile, none, [...pile.slice(0, 5), ...none.slice(0, 3)]]) {
      const rs = layoutNoteBoxes(notes)
      expect(rs).toHaveLength(notes.length)
      noOverlaps(rs, CAPTURE_NOTE_GAP)
    }
  })
})

describe('colours', () => {
  it('a photo’s colour lands as the note colour its word names (M3-4): yellow is Butter, black is never ink', () => {
    expect(noteColourOf('yellow')).toBe('black') // Butter, the default note
    expect(noteColourOf('black')).toBe('black')
    expect(noteColourOf('light-red')).toBe('light-red')
    expect(noteColourOf('orange')).toBe('orange')
    expect(noteColourOf('light-green')).toBe('light-green')
    expect(noteColourOf('white')).toBe('white')
    for (const name of AI_COLOR_NAMES)
      expect(LOBBY_PALETTE[noteColourOf(name)].noteFill).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('the plan and its one undo step', () => {
  const plan = (frames = true) =>
    planCaptureNotes(WALL, {
      origin: { x: 1000, y: 500 },
      by: 'usr_me000000001',
      runId: 'air_run',
      newId: () => testId('c'),
      frames,
    })

  it('groups become frames when the frames are clean; every element has the ai provenance', () => {
    const p = plan()
    expect(p.frameIds).toHaveLength(2)
    expect(p.noteIds).toHaveLength(6)
    expect(p.creates.map((c) => c.kind)).toEqual([
      'frame',
      'frame',
      'note',
      'note',
      'note',
      'note',
      'note',
      'note',
    ])
    expect(p.framed.map((f) => f.noteIds.length)).toEqual([3, 3])
    const spec = lobbyKeySpec('ai')
    expect(spec?.class).toBe('create-only')
    for (const c of p.creates) {
      const lobby = (c.props.customData as { lobby: { ai: unknown; kind: string } }).lobby
      expect(lobby.ai).toEqual({ by: 'usr_me000000001', run: 'air_run' })
      expect(lobby.kind).toMatch(/^ai-capture-(note|group)$/)
    }
    // the Butter notes are Butter's fill; Blush is light-red's
    const fills = p.creates.filter((c) => c.kind === 'note').map((c) => c.props.backgroundColor)
    expect(fills[0]).toBe(LOBBY_PALETTE.black.noteFill)
    expect(fills[3]).toBe(LOBBY_PALETTE['light-red'].noteFill)
    expect(p.preview.summary).toBe('Adds 6 notes in 2 groups; each group is a frame')
    expect(p.preview.groups).toEqual([
      { name: 'Keep', count: 3 },
      { name: 'Change', count: 3 },
    ])
    expect(p.bounds.x).toBe(1000)
    expect(p.bounds.y).toBe(500)
    // everything inside the bounds
    for (const c of p.creates) {
      const x = Number(c.props.x)
      const y = Number(c.props.y)
      expect(x).toBeGreaterThanOrEqual(p.bounds.x)
      expect(y).toBeGreaterThanOrEqual(p.bounds.y)
    }
    expect(plan(false).frameIds).toEqual([])
    expect(plan(false).preview.summary).toBe('Adds 6 notes in 2 groups')
  })

  it('a group whose frame would hold another group’s note gets no frame', () => {
    const rs = layoutNoteBoxes(WALL.notes)
    // a group of the top-left and the bottom-right note: its frame would take in the notes between them
    const frames = groupFrames(rs, [
      { name: 'Across', notes: [0, 5] },
      { name: 'Keep', notes: [1] },
    ])
    expect(frames.map((f) => f.name)).toEqual(['Keep'])
  })

  it('applies as one undo step: one undo removes every note and frame', () => {
    const f = fakeFlowCanvas()
    const before = f.snapshot()
    const made = applyCaptureNotes(f.canvas, plan())
    expect(f.live().filter((e) => e.type === 'stickynote')).toHaveLength(6)
    expect(f.live().filter((e) => e.type === 'frame')).toHaveLength(2)
    expect(made).toHaveLength(8)
    // the notes are in their frames (the second, joined write)
    const notes = f.live().filter((e) => e.type === 'stickynote')
    expect(new Set(notes.map((n) => n.frameId)).size).toBe(2)
    expect(f.transacts.map((t) => t.joined)).toEqual([false, true])
    expect(f.steps()).toBe(1)
    f.undo()
    expect(f.snapshot()).toBe(before)
  })
})
