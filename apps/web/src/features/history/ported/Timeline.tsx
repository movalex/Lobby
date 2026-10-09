// The time-travel scrubber (wave L, L7-1; owner W7): one slider over the board's checkpoints, oldest on the
// left, each a tick with its reason's icon. Keyboard: Left/Down older, Right/Up newer, Home the oldest, End the
// newest, Page Up/Down five at a time; a pointer drags along the track or clicks a tick. One focusable control
// (role="slider", its value spoken as the checkpoint's name and age): the ticks are its picture.

import type { BoardCheckpoint, CheckpointReason } from '@draftroom/contracts'
import { useRef } from 'react'
import { checkpointTitle } from '../checkpoints-model.ts'
import { tickForKey, tickText } from './time-travel.ts'

type Glyph = 'bookmark' | 'clock' | 'door' | 'undo' | 'inbox' | 'eye' | 'spark' | 'swap'
const GLYPH_OF: Record<CheckpointReason, Glyph> = {
  hourly: 'clock',
  session_end: 'door',
  before_restore: 'undo',
  import: 'inbox',
  before_reveal: 'eye',
  before_ai_themes: 'spark',
  engine_migration: 'swap',
}
export const glyphOf = (c: Pick<BoardCheckpoint, 'kind' | 'reason'>): Glyph =>
  c.kind === 'manual'
    ? 'bookmark'
    : c.kind === 'pre_restore'
      ? 'undo'
      : c.reason
        ? GLYPH_OF[c.reason]
        : 'clock'

const PATHS: Record<Glyph, string> = {
  bookmark: 'M7 4h10v16l-5-4-5 4z',
  clock: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v4l3 2',
  door: 'M6 4h9v16H6zM15 12h4M17 10l2 2-2 2',
  undo: 'M8 7L4 11l4 4M4 11h10a5 5 0 0 1 0 10h-3',
  inbox: 'M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5',
  eye: 'M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  swap: 'M5 8h12l-3-3M19 16H7l3 3',
}

export function ReasonIcon({ glyph }: { glyph: Glyph }) {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d={PATHS[glyph]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Timeline({
  ticks,
  index,
  onChange,
  now,
}: {
  ticks: readonly BoardCheckpoint[]
  index: number
  onChange(index: number): void
  now: Date
}) {
  const track = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const n = ticks.length
  const current = ticks[index]
  const at = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  const indexAtX = (clientX: number) => {
    const r = track.current?.getBoundingClientRect()
    if (!r || n <= 1) return 0
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return Math.round(f * (n - 1))
  }
  return (
    <div className="dr-tt">
      <span className="dr-tt__end" aria-hidden="true">
        Older
      </span>
      <div
        className="dr-tt__slider"
        role="slider"
        tabIndex={0}
        aria-label="Checkpoint to show"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, n)}
        aria-valuenow={index + 1}
        aria-valuetext={current ? tickText(current, index, n, now) : undefined}
        aria-orientation="horizontal"
        data-testid="history-timeline"
        data-index={index}
        onKeyDown={(e) => {
          const next = tickForKey(e.key, index, n)
          if (next === null) return
          e.preventDefault()
          e.stopPropagation()
          if (next !== index) onChange(next)
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          dragging.current = e.pointerId
          e.currentTarget.setPointerCapture(e.pointerId)
          const i = indexAtX(e.clientX)
          if (i !== index) onChange(i)
        }}
        onPointerMove={(e) => {
          if (dragging.current !== e.pointerId) return
          const i = indexAtX(e.clientX)
          if (i !== index) onChange(i)
        }}
        onPointerUp={(e) => {
          if (dragging.current === e.pointerId) dragging.current = null
        }}
        onPointerCancel={() => {
          dragging.current = null
        }}
      >
        <div className="dr-tt__track" ref={track}>
          <div className="dr-tt__line" />
          {ticks.map((c, i) => (
            <span
              key={c.id}
              className={`dr-tt__tick${i === index ? ' dr-tt__tick--current' : ''}${c.kind === 'manual' ? ' dr-tt__tick--named' : ''}`}
              style={{ left: `${at(i)}%` }}
              title={`${checkpointTitle(c)}`}
              data-testid="history-timeline-tick"
              data-snapshot-id={c.id}
              data-current={i === index ? 'true' : 'false'}
            >
              <ReasonIcon glyph={glyphOf(c)} />
            </span>
          ))}
        </div>
      </div>
      <span className="dr-tt__end" aria-hidden="true">
        Newer
      </span>
    </div>
  )
}
