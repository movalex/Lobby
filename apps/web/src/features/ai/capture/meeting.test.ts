// Wave N (WS5, N5-4): a meeting as a frame (./meeting.ts): "Meeting — <title or date>", three columns (Themes with
// each theme's name over its notes, Decisions, Actions as "Owner: text"), counts that match the result, the `ai`
// provenance on every element, and one undo step.
import type { CaptureResult } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { fakeFlowCanvas, testId } from '../../flow/test-canvas.ts'
import { CAPTURE_PHOTO_NOTICE, meetingFrameName } from '../copy.ts'
import {
  applyMeeting,
  MEETING_COLUMNS,
  MEETING_PAD,
  meetingSize,
  planMeeting,
  type TextLayout,
} from './meeting.ts'

type Meeting = Extract<CaptureResult, { kind: 'transcript' }>

/** The canned meeting of the e2e kit: 3 themes, 2 decisions, 3 actions. */
const MEETING: Meeting = {
  kind: 'transcript',
  themes: [
    { name: 'Schedule', notes: ['Shoot moves to the 14th', 'Edit needs two more days'] },
    { name: 'Budget', notes: ['Travel is over by 10%', 'Drop the second location'] },
    { name: 'Team', notes: ['Sam joins as editor'] },
  ],
  decisions: ['We shoot on the 14th', 'One location only'],
  actions: [
    { text: 'Book the studio for the 14th', owner: 'Ana' },
    { text: 'Send the revised budget', owner: 'Bo' },
    { text: 'Share the shot list' },
  ],
}

const layout: TextLayout = (text, fontSize) => ({
  text,
  width: text.length * 9,
  height: Math.ceil(fontSize * 1.25),
})
const plan = () =>
  planMeeting(MEETING, {
    origin: { x: 100, y: 200 },
    name: meetingFrameName('Launch sync', new Date('2026-10-11T10:00:00Z')),
    by: 'usr_me000000001',
    runId: 'air_run',
    newId: () => testId('m'),
    layout,
  })

describe('the meeting frame', () => {
  it('is named for the meeting, else for the day', () => {
    expect(meetingFrameName('Launch sync', new Date())).toBe('Meeting — Launch sync')
    expect(meetingFrameName('  ', new Date('2026-10-11T10:00:00Z'))).toBe('Meeting — 11 Oct 2026')
    expect(meetingFrameName(undefined, new Date('2026-01-02T10:00:00Z'))).toBe('Meeting — 2 Jan 2026')
  })

  it('holds three columns whose contents and counts match the result', () => {
    const p = plan()
    const frame = p.creates[0]
    expect(frame?.kind).toBe('frame')
    expect(frame?.props.name).toBe('Meeting — Launch sync')
    const roles = (r: string) => p.creates.filter((c) => c.role === r)
    expect(roles('column').map((c) => c.props.originalText)).toEqual(['Themes', 'Decisions', 'Actions'])
    expect(roles('theme').map((c) => c.props.originalText)).toEqual(['Schedule', 'Budget', 'Team'])
    expect(roles('theme-note').map((c) => c.props.text)).toEqual([
      'Shoot moves to the 14th',
      'Edit needs two more days',
      'Travel is over by 10%',
      'Drop the second location',
      'Sam joins as editor',
    ])
    expect(roles('decision').map((c) => c.props.text)).toEqual(['We shoot on the 14th', 'One location only'])
    expect(roles('action').map((c) => c.props.text)).toEqual([
      'Ana: Book the studio for the 14th',
      'Bo: Send the revised budget',
      'Share the shot list',
    ])
    // each column at its own x, inside the frame
    const x0 = 100 + MEETING_PAD
    for (const c of roles('theme-note')) expect(Number(c.props.x)).toBeGreaterThanOrEqual(x0)
    for (const c of roles('decision')) expect(Number(c.props.x)).toBe(x0 + MEETING_COLUMNS.themes + 64)
    for (const c of roles('action'))
      expect(Number(c.props.x)).toBe(x0 + MEETING_COLUMNS.themes + 64 + MEETING_COLUMNS.decisions + 64)
    for (const c of p.creates.slice(1)) {
      expect(Number(c.props.y)).toBeLessThan(200 + p.bounds.h)
      expect((c.props.customData as { lobby: { ai: unknown; kind: string } }).lobby.ai).toEqual({
        by: 'usr_me000000001',
        run: 'air_run',
      })
    }
    expect(p.noteIds).toHaveLength(5 + 2 + 3)
    expect(p.preview.summary).toBe('Adds 3 themes (5 notes), 2 decisions and 3 actions')
    expect(p.preview.groups).toEqual([
      { name: 'Schedule', count: 2 },
      { name: 'Budget', count: 2 },
      { name: 'Team', count: 1 },
    ])
    expect(meetingSize(MEETING, layout, 'Meeting — Launch sync')).toEqual({ w: p.bounds.w, h: p.bounds.h })
    // the transcript itself is in none of it (the notice's words neither)
    expect(JSON.stringify(p.creates)).not.toContain(CAPTURE_PHOTO_NOTICE)
  })

  it('applies as one undo step, the notes in the frame', () => {
    const f = fakeFlowCanvas()
    const before = f.snapshot()
    const p = plan()
    applyMeeting(f.canvas, p)
    const notes = f.live().filter((e) => e.type === 'stickynote')
    expect(notes).toHaveLength(10)
    expect(notes.every((n) => n.frameId === p.frameId)).toBe(true)
    expect(
      f
        .live()
        .filter((e) => e.type === 'text' && !e.containerId)
        .every((t) => t.frameId === p.frameId),
    ).toBe(true)
    expect(f.steps()).toBe(1)
    expect(f.selected).toEqual([p.frameId])
    f.undo()
    expect(f.snapshot()).toBe(before)
  })
})
