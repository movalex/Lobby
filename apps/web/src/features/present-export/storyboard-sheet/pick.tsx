// OWNER: WS3 (wave T). What the two storyboard sections of the Export dialog share: the board's storyboards (live), the
// one they start on (the selection's, else the first), its picker, the date words and the file names.
import { useState } from 'react'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { planningShown } from '../../planning/flags.ts'
import { oneLine } from '../../review-viewer/export/exports.ts'
import { storyboardOfIds, storyboardViews } from '../../storyboard-play/model.ts'

export interface StoryboardChoice {
  readonly id: string
  readonly title: string
  readonly panels: number
}

/** Whether the board holds a storyboard with a panel (the sections are offered then, with their switch). */
export const hasStoryboard = (canvas: LobbyCanvas): boolean =>
  planningShown('storyboardExports') && storyboardViews(canvas).length > 0

/** The board's storyboards (live) and the chosen one. */
export function useStoryboardChoice(canvas: LobbyCanvas, selectedIds: readonly string[]) {
  const boards = useValue(
    'lobby-sb-export-boards',
    () =>
      storyboardViews(canvas)
        .map((v): StoryboardChoice => ({ id: v.id, title: v.title, panels: v.panels.length }))
        .map((c) => JSON.stringify(c))
        .join('\n'),
    [canvas],
  )
  const list: StoryboardChoice[] = boards
    ? boards.split('\n').map((s) => JSON.parse(s) as StoryboardChoice)
    : []
  const [chosen, setChosen] = useState<string>(
    () => storyboardOfIds(canvas, selectedIds) ?? list[0]?.id ?? '',
  )
  const current = list.find((b) => b.id === chosen) ?? list[0] ?? null
  return { list, current, setChosen }
}

export function StoryboardPicker({
  list,
  current,
  onChange,
  disabled,
  testId,
}: {
  list: readonly StoryboardChoice[]
  current: StoryboardChoice | null
  onChange(id: string): void
  disabled: boolean
  testId: string
}) {
  if (list.length < 2) return null
  return (
    <label className="dr-pe-inline">
      Storyboard
      <select
        data-testid={testId}
        value={current?.id ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {list.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title} ({b.panels} {b.panels === 1 ? 'panel' : 'panels'})
          </option>
        ))}
      </select>
    </label>
  )
}

/** "16 Oct 2026" */
export const sheetDate = (at: Date = new Date()) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(at)

/** A title as a file name's stem, safe on every system (no extension is stripped: "Spot v1.2" stays). */
export function fileStem(title: string): string {
  const safe = oneLine(title)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: file names must not hold control characters
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return Array.from(safe).slice(0, 80).join('') || 'storyboard'
}

/** A storyboard export's file name: "<title> - <what>.<ext>". */
export const storyboardFileName = (title: string, what: string, ext: string) =>
  `${fileStem(title)} - ${what}.${ext}`

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/**
 * A section's own Cancel and progress words (the dialog's Cancel is its PDF section's): `wrap` runs a task with a
 * signal that aborts with the dialog's (closing it) or with this section's Cancel.
 */
export function useSectionTask() {
  const [running, setRunning] = useState<{ abort: AbortController; words: string } | null>(null)
  const wrap =
    (task: (signal: AbortSignal, progress: (words: string) => void) => Promise<string>) =>
    async (outer: AbortSignal): Promise<string> => {
      const abort = new AbortController()
      const forward = () => abort.abort()
      outer.addEventListener('abort', forward, { once: true })
      setRunning({ abort, words: '' })
      try {
        return await task(abort.signal, (words) => setRunning((r) => (r ? { ...r, words } : r)))
      } finally {
        outer.removeEventListener('abort', forward)
        setRunning(null)
      }
    }
  return {
    running: running !== null,
    words: running?.words ?? '',
    cancel: () => running?.abort.abort(),
    wrap,
  }
}

export function SectionProgress({
  task,
  testId,
}: {
  task: ReturnType<typeof useSectionTask>
  testId: string
}) {
  if (!task.running) return null
  return (
    <div className="dr-pe-progress">
      <span data-testid={`${testId}-progress`}>{task.words || 'Starting…'}</span>
      <button
        type="button"
        className="dr-btn dr-btn--sm"
        data-testid={`${testId}-cancel`}
        onClick={task.cancel}
      >
        Cancel
      </button>
    </div>
  )
}
