// OWNER: WS5 (wave T). The settings strip of a selected timeline frame: the scale (days, weeks, months), the lanes
// (none, status, assignee, tag), the tag it shows, its range and "Today". Each change writes the frame's one
// `timeline` key (validated with canvas-schema's TimelineValue before it is sent) in one transaction, one undo step.
// Only the person who changes a setting writes; the strip is shown only where `planningOffered` says planning writes
// are taken (a rev-14 room, an editor).
import {
  addDays,
  snapDate,
  TIMELINE_KEY,
  TIMELINE_MAX_DAYS,
  type TimelineLanes,
  type TimelineScale,
  TimelineValue,
  timelineDays,
} from '@draftroom/canvas-schema/planning'
import { useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { boardTagsOf } from '../tags/ported/model.ts'
import { todayOf } from './dates.ts'

const SCALES: readonly { readonly id: TimelineScale; readonly label: string }[] = [
  { id: 'day', label: 'Days' },
  { id: 'week', label: 'Weeks' },
  { id: 'month', label: 'Months' },
]
const LANES: readonly { readonly id: TimelineLanes; readonly label: string }[] = [
  { id: 'none', label: 'No lanes' },
  { id: 'status', label: 'By status' },
  { id: 'assignee', label: 'By assignee' },
  { id: 'tag', label: 'By tag' },
]

/** Why this range is not a timeline's, in words, or null. */
export function rangeProblem(start: string, end: string): string | null {
  if (!start || !end) return 'Pick a start and an end date.'
  if (end < start) return 'The end must be on or after the start.'
  if (!TimelineValue.safeParse({ start, end, scale: 'week', lanes: 'none' }).success)
    return `A timeline can show up to two years (${TIMELINE_MAX_DAYS} days).`
  return null
}

/**
 * The range that has `today` a quarter of the way in, keeping the length; weekly and monthly timelines start on the
 * Monday of that week.
 */
export function rangeAroundToday(value: TimelineValue, today: string): { start: string; end: string } | null {
  const days = timelineDays(value)
  const back = Math.floor(days / 4)
  const raw = addDays(today, -back)
  const start = raw === null ? null : snapDate(raw, value.scale)
  const end = start === null ? null : addDays(start, days - 1)
  return start && end ? { start, end } : null
}

/** Writes a new `timeline` value to the frame (one transaction). Returns whether it was valid and written. */
export function writeTimeline(ctx: CanvasFeatureContext, frameId: string, next: unknown): boolean {
  const parsed = TimelineValue.safeParse(next)
  if (!parsed.success) return false
  if (ctx.canvas.readOnly() || ctx.canvas.isLocked(frameId)) return false
  ctx.canvas.transact('Change timeline', (tx) =>
    tx.update(frameId, { customData: { lobby: { [TIMELINE_KEY]: parsed.data } } }),
  )
  return true
}

export function TimelineControls({
  ctx,
  frameId,
  value,
  at,
}: {
  ctx: CanvasFeatureContext
  frameId: string
  value: TimelineValue
  at: { x: number; y: number }
}) {
  const { canvas } = ctx
  const tags = useValue(
    'timeline.board-tags',
    () =>
      [...boardTagsOf(canvas.doc.entries('tagDef:')).values()].sort((a, b) => a.name.localeCompare(b.name)),
    [canvas],
  )
  const room = useValue('timeline.room', () => canvas.viewport.screenRect(), [canvas])
  const locked = useValue('timeline.locked', () => canvas.isLocked(frameId), [canvas, frameId])
  const [problem, setProblem] = useState<string | null>(null)

  const set = (patch: Partial<TimelineValue> & { tag?: string | undefined }) => {
    const next: Record<string, unknown> = { ...value, ...patch }
    if (next.tag === undefined) delete next.tag
    if (!writeTimeline(ctx, frameId, next)) setProblem('That setting is not allowed.')
    else setProblem(null)
  }
  const setRange = (start: string, end: string) => {
    const why = rangeProblem(start, end)
    setProblem(why)
    if (!why) set({ start, end })
  }

  const top = Math.max(8, Math.min(at.y, room.height - 56))
  const left = Math.max(8, Math.min(at.x, room.width - 320))
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of controls (a fieldset is a form group)
    <div
      className="dr-tl-controls"
      data-testid="timeline-controls"
      role="group"
      aria-label="Timeline settings"
      style={{ left, top }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a group of buttons (a fieldset is a form group) */}
      <div className="dr-tl-seg" role="group" aria-label="Scale">
        {SCALES.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`timeline-scale-${s.id}`}
            aria-pressed={value.scale === s.id}
            disabled={locked}
            onClick={() => set({ scale: s.id })}
          >
            {s.label}
          </button>
        ))}
      </div>
      <label className="dr-tl-field">
        <span>Lanes</span>
        <select
          data-testid="timeline-lanes"
          value={value.lanes}
          disabled={locked}
          onChange={(e) => set({ lanes: e.target.value as TimelineLanes })}
        >
          {LANES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="dr-tl-field">
        <span>Tag</span>
        <select
          data-testid="timeline-tag"
          value={value.tag ?? ''}
          disabled={locked}
          onChange={(e) => set({ tag: e.target.value || undefined })}
        >
          <option value="">Any tag</option>
          {value.tag && !tags.some((t) => t.key === value.tag) ? (
            <option value={value.tag}>{value.tag}</option>
          ) : null}
          {tags.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="dr-tl-field">
        <span>From</span>
        <input
          type="date"
          data-testid="timeline-start"
          value={value.start}
          min="2000-01-01"
          max="2100-12-31"
          disabled={locked}
          onChange={(e) => setRange(e.target.value, value.end)}
        />
      </label>
      <label className="dr-tl-field">
        <span>To</span>
        <input
          type="date"
          data-testid="timeline-end"
          value={value.end}
          min="2000-01-01"
          max="2100-12-31"
          disabled={locked}
          onChange={(e) => setRange(value.start, e.target.value)}
        />
      </label>
      <button
        type="button"
        className="dr-tl-today"
        data-testid="timeline-today"
        disabled={locked}
        onClick={() => {
          const r = rangeAroundToday(value, todayOf())
          if (r) setRange(r.start, r.end)
        }}
      >
        Go to today
      </button>
      {problem ? (
        <p className="dr-tl-problem" role="alert" data-testid="timeline-problem">
          {problem}
        </p>
      ) : null}
    </div>
  )
}
