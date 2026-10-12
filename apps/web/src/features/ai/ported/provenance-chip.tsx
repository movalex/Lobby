// OWNER: W4 (wave M, M4-2, FTU-5 provenance). Provenance you can see: an "AI-made" chip in the selection bar
// (SelectionBarItemSpec AI_PROVENANCE_ITEM_ID) whenever the selection holds something AI made (`customData.lobby.ai`),
// opening a small card: "Made with AI · Group into themes · 8 Oct, 14:05" and "Remove this AI result" (./remove.ts:
// the run's own elements that nobody changed, locked or is typing in, in one transact, so one undo step and one
// change for everyone else). Everyone sees the chip (what AI made is on the board for everyone, as the lens says);
// only an editor in the tab that wrote the run gets Remove (the run's record is that tab's). Reads the board; the
// card's Remove is its only write.

import { memo, useEffect, useId, useRef, useState } from 'react'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  items,
  type LobbyCanvas,
  type SelectionBarItemSpec,
  useCanvasFeatureContext,
} from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { anchorRect } from '../board-chrome.ts'
import { InPopoverLayer, useBoardPlacement } from '../board-popover.tsx'
import { SparkIcon } from '../icons.tsx'
import { AI_PROVENANCE_ITEM_ID } from '../provenance-ids.ts'
import { lensDate } from './lens.tsx'
import { aiKindWord, aiOf, stampsOf } from './provenance.ts'
import { isThemesRun, recordedRunOf, removeResult } from './remove.ts'

/** What made each kind of AI element (the `ai-` kind words: ./apply.ts, ../recap/apply.ts, the diagram, sort, mind map). */
const KIND_ACTIONS: Readonly<Record<string, string>> = {
  'theme-label': 'Group into themes',
  summary: 'Summarize',
  idea: 'Generate ideas',
  'action-item': 'Action items',
  answer: 'Ask this board',
  recap: 'Wrap up',
  'recap-heading': 'Wrap up',
  'recap-item': 'Wrap up',
  'recap-table': 'Wrap up',
  'diagram-node': 'Diagram from words',
  'diagram-label': 'Diagram from words',
  'diagram-edge': 'Diagram from words',
  'sort-label': 'Sort by a lens',
  topic: 'Mind map',
}

/** What the card says of a selection's AI-made element. */
export interface ProvenanceInfo {
  /** the element (a label stands for its container) */
  readonly id: string
  /** its run (null: made before wave L, or by a path without one) */
  readonly run: string | null
  /** "Group into themes", "Action items", … ("AI" when it cannot tell) */
  readonly action: string
  /** "8 Oct, 14:05", or "just now" before the server stamped it */
  readonly when: string
  /** how many different runs the selection's AI-made elements come from */
  readonly runs: number
  /** this tab may remove the run: an editor, in the tab that wrote it */
  readonly removable: boolean
  /** a themes run: its notes are put back from History rather than removed */
  readonly themes: boolean
}

/** A server time as "8 Oct, 14:05" (the lens's date, and the time of day). */
export function provenanceTime(ms: number | null, now: number = Date.now()): string {
  if (ms === null) return 'just now'
  const time = new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${lensDate(ms, now)}, ${time}`
}

/** What made `el`: its kind's action; a heading says what its run's other elements are ("Action items"). */
export function actionOf(canvas: Pick<LobbyCanvas, 'items'>, el: CanvasElement): string {
  const kind = aiKindWord(el)
  const own = kind ? KIND_ACTIONS[kind] : undefined
  if (own) return own
  const run = aiOf(el)?.run
  if (run)
    for (const other of canvas.items()) {
      if (other.id === el.id || aiOf(other)?.run !== run) continue
      const k = aiKindWord(other)
      const a = k ? KIND_ACTIONS[k] : undefined
      if (a) return a
    }
  return 'AI'
}

/** The card's line: "Made with AI · Group into themes · 8 Oct, 14:05". */
export const provenanceLine = (info: Pick<ProvenanceInfo, 'action' | 'when' | 'runs'>): string =>
  info.runs > 1
    ? `Made with AI · ${info.runs} results`
    : `Made with AI${info.action === 'AI' ? '' : ` · ${info.action}`} · ${info.when}`

/**
 * The AI-made part of a selection (labels stand for their containers), or null when AI made none of it. Pure over the
 * canvas reads; `now` for the date's year.
 */
export function provenanceOfSelection(
  canvas: Pick<
    LobbyCanvas,
    'get' | 'items' | 'readOnly' | 'isLocked' | 'editingId' | 'leaseHolder' | 'saveStatus' | 'isHidden'
  >,
  ids: readonly string[],
  now: number = Date.now(),
): ProvenanceInfo | null {
  const get = (id: string) => canvas.get(id)
  let first: CanvasElement | null = null
  const runs = new Set<string>()
  let unnamed = 0
  for (const id of ids) {
    const raw = get(id)
    if (!raw || (raw as { isDeleted?: boolean }).isDeleted) continue
    const root = items.containerOf(raw, get)
    const ai = aiOf(root)
    if (!ai) continue
    first ??= root
    if (ai.run) runs.add(ai.run)
    else unnamed++
  }
  if (!first) return null
  const run = aiOf(first)?.run ?? null
  const many = runs.size + (unnamed > 0 ? 1 : 0)
  const recorded = runs.size === 1 && unnamed === 0 ? recordedRunOf(canvas as LobbyCanvas, first.id) : null
  return {
    id: first.id,
    run,
    action: actionOf(canvas, first),
    when: provenanceTime(stampsOf(first).createdAt, now),
    runs: Math.max(1, many),
    removable: !canvas.readOnly() && recorded !== null,
    themes: recorded ? isThemesRun(canvas as LobbyCanvas, recorded) : false,
  }
}

/** The words the chip shows. */
export const PROVENANCE_CHIP_TEXT = 'AI-made'

/** The chip's accessible name: it starts with the words it shows (WCAG 2.5.3), then says what pressing it opens. */
export const provenanceChipLabel = (): string => `${PROVENANCE_CHIP_TEXT}: details`

/** The chip's selection-bar entry: shown while the selection holds something AI made. */
export const PROVENANCE_ITEM: SelectionBarItemSpec = {
  id: AI_PROVENANCE_ITEM_ID,
  // right after the "AI" button (80)
  order: 81,
  visible: (ctx, selection) => selectionHasAi(ctx.canvas, selection),
  component: () => <ProvenanceChip />,
}

/** Whether AI made any of `ids` (a label stands for its container). */
export function selectionHasAi(canvas: Pick<LobbyCanvas, 'get'>, ids: readonly string[]): boolean {
  const get = (id: string) => canvas.get(id)
  return ids.some((id) => {
    const el = get(id)
    return !!el && aiOf(items.containerOf(el, get)) !== null
  })
}

const ProvenanceChip = memo(function ProvenanceChip() {
  const ctx = useCanvasFeatureContext()
  const { canvas } = ctx
  const json = useValue(
    'lobby-ai-provenance',
    () => JSON.stringify(provenanceOfSelection(canvas, canvas.selection)),
    [canvas],
  )
  const info = JSON.parse(json) as ProvenanceInfo | null
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  if (!info) return null
  return (
    <>
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        ref={ref}
        type="button"
        className="dr-cux-selbar__btn dr-ai-provchip"
        aria-label={provenanceChipLabel()}
        title={provenanceLine(info)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="ai-provenance-chip"
        onClick={() => setOpen((o) => !o)}
      >
        <SparkIcon size={13} />
        <span>{PROVENANCE_CHIP_TEXT}</span>
      </button>
      {open && (
        <InPopoverLayer canvas={canvas}>
          <ProvenanceCard ctx={ctx} info={info} chip={ref} onClose={() => setOpen(false)} />
        </InPopoverLayer>
      )}
    </>
  )
})

function ProvenanceCard({
  ctx,
  info,
  chip,
  onClose,
}: {
  ctx: CanvasFeatureContext
  info: ProvenanceInfo
  chip: React.RefObject<HTMLButtonElement | null>
  onClose(): void
}) {
  const { canvas } = ctx
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const pos = useBoardPlacement(canvas, ref, () => {
    const box = canvas.container()?.getBoundingClientRect()
    const r = chip.current?.getBoundingClientRect()
    const bar = chip.current?.closest('[data-testid="selection-bar"]')?.getBoundingClientRect() ?? r
    if (!box || !r || !bar) return null
    return anchorRect(box, {
      x: r.left + r.width / 2 - box.left,
      top: Math.min(r.top, bar.top) - box.top,
      bottom: Math.max(r.bottom, bar.bottom) - box.top,
    })
  })
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  // a press anywhere else closes it (the chip toggles it itself); the keyboard starts on its first button
  useEffect(() => {
    const doc = canvas.container()?.ownerDocument ?? document
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || ref.current?.contains(t) || chip.current?.contains(t)) return
      closeRef.current()
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [canvas, chip])
  const shown = pos !== null
  useEffect(() => {
    // A11Y-08: its action first, never the header's ×
    const root = ref.current
    if (!shown || !root) return
    const action = root.querySelector<HTMLElement>('[data-testid="ai-provenance-remove"]')
    ;(action ?? root.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true })
  }, [shown])
  const close = (refocus: boolean) => {
    onClose()
    if (refocus) chip.current?.focus({ preventScroll: true })
  }
  return (
    <div
      ref={ref}
      className="dr-ai-pop dr-ai-provcard"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="ai-provenance-card"
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
          : { visibility: 'hidden', left: 0, top: 0 }
      }
      // its keys and presses are its own (the selection bar around the chip in React's tree takes none of them)
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          close(true)
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="dr-ai-pop__head">
        <span className="dr-ai-pop__badge" aria-hidden="true">
          <SparkIcon size={14} />
        </span>
        <h2 id={titleId} className="dr-ai-pop__title" data-testid="ai-provenance-line">
          {provenanceLine(info)}
        </h2>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          aria-label="Close"
          onClick={() => close(true)}
        >
          ×
        </button>
      </div>
      {info.removable && info.run ? (
        <div className="dr-ai-panel__actions">
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="ai-provenance-remove"
            onClick={() => {
              const run = info.run
              close(false)
              if (run) removeResult(ctx, run)
              canvas.focus({ preventScroll: true })
            }}
          >
            {info.themes ? 'Put the notes back (History)…' : 'Remove this AI result'}
          </button>
        </div>
      ) : (
        <p className="dr-ai-pop__foot" data-testid="ai-provenance-note">
          {info.runs > 1
            ? 'Select one AI result to remove it.'
            : canvas.readOnly()
              ? 'Only editors can remove it.'
              : 'Remove it from the tab that made it, or delete it.'}
        </p>
      )}
    </div>
  )
}
