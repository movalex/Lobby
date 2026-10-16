// OWNER: WS2 (wave T, storyboards). The storyboard strip: a dock along the bottom of the board (a `screen` layer;
// a sheet on a phone) that opens when a panel, the head or anything in a panel is selected and stays until closed.
//  - the storyboard's title, panel count, running time and aspect; "Panels overlap · Arrange" when concurrent layouts
//    collided (never fixed by a receiving tab: the echo rule);
//  - the panels in order: a thumbnail, the shot number, the duration (typed "2.5", "0:03", "36f" at the head's fps,
//    or stepped by half a second) and the camera words; a click selects the panel on the board;
//  - reorder by dragging a card, or with Alt+Left / Alt+Right on a focused card (Left / Right move the focus, Enter
//    shows the panel, Home / End go to the ends); insert before / after, duplicate and delete the active panel;
//  - Arrange: one row or a grid of 3, 4 or 6 per row; Script to boards…; Put panels in review;
//  - Play animatic (wave T integration: WS3's player, for everyone who sees the strip, while `animatic` is on): the
//    strip covers the selection bar's "Play animatic" when the selected panel sits low on the screen.
// A person who cannot change the storyboard (a viewer, a room below 14) sees the strip without its write controls.
import {
  formatDuration,
  formatRunningTime,
  parseDuration,
  SB_DUR_MAX_MS,
  SB_DUR_MIN_MS,
  storyboardTimings,
} from '@draftroom/canvas-schema/planning'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type CanvasFeatureContext, items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { OBSTACLE_IDS } from '../../lib/overlay-obstacles.ts'
import { useValue } from '../../lib/signals.ts'
import { boardObstacles } from '../ai/board-chrome.ts'
import { inPopoverLayer, usePopoverLayer } from '../ai/board-popover.tsx'
import { planningShown } from '../planning/index.ts'
import { isPlayerOpen, openPlayer } from '../storyboard-play/state.ts'
import { anyOverlap, LAYOUTS, PICTURE_KIND, perRowOf, shotLabel } from './model.ts'
import { arrange, deletePanels, duplicatePanel, insertPanel, movePanel, type Sb, setDuration } from './ops.ts'
import { putPanelsInReview, reviewOffered } from './review.ts'
import {
  boardsOf,
  offered,
  panelWords,
  sbState,
  selectedPanelIndex,
  selectedStoryboard,
  shown,
  titleOf,
} from './state.ts'

/** Keeps the strip on the storyboard the selection enters (it stays when the selection leaves). */
export function followSelection(canvas: LobbyCanvas): () => void {
  const s = sbState(canvas)
  return canvas.on('selectionChanged', () => {
    if (!shown()) return
    const sb = selectedStoryboard(canvas)
    if (sb && s.strip.get() !== sb.id) s.strip.set(sb.id)
  })
}

export function StoryboardStripLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const s = sbState(canvas)
  const sb = useValue('storyboard.strip-board', () => {
    const id = s.strip.get()
    if (!id || !shown()) return null
    const board = boardsOf(canvas).get(id)
    return board?.panels.length || board?.head ? board : null
  }, [canvas])
  const host = usePopoverLayer(canvas)
  if (!sb) return null
  return <>{inPopoverLayer(canvas, host, <Strip ctx={ctx} sb={sb} />)}</>
}

/**
 * The strip's bottom edge in the canvas region: just above the bottom toolbar (it stays usable), re-measured on
 * every render and when the window changes size.
 */
function useStripBottom(canvas: LobbyCanvas): number {
  const [bottom, setBottom] = useState(12)
  const [, bump] = useState(0)
  useEffect(() => {
    const win = canvas.container()?.ownerDocument.defaultView
    if (!win) return
    const on = () => bump((n) => n + 1)
    win.addEventListener('resize', on)
    return () => win.removeEventListener('resize', on)
  }, [canvas])
  useLayoutEffect(() => {
    const root = canvas.container()
    if (!root) return
    const box = root.getBoundingClientRect()
    const bar = boardObstacles(root.ownerDocument).find((o) => o.id === OBSTACLE_IDS.bottomToolbar)
    const next =
      bar && bar.rect.y > box.top + box.height / 2
        ? Math.max(12, Math.round(box.bottom - bar.rect.y + 10))
        : 12
    if (next !== bottom) setBottom(next)
  })
  return bottom
}

function Strip({ ctx, sb }: { ctx: CanvasFeatureContext; sb: Sb }) {
  const { canvas } = ctx
  const s = sbState(canvas)
  const titleId = useId()
  const canEdit = useValue('storyboard.strip-edit', () => offered(canvas), [canvas])
  const active = useValue('storyboard.strip-active', () => selectedPanelIndex(canvas, sb), [canvas, sb])
  const title = useValue('storyboard.strip-title', () => titleOf(canvas, sb), [canvas, sb])
  const overlap = useValue('storyboard.strip-overlap', () => {
    const boxes = sb.panels
      .map((p) => canvas.get(p.id))
      .filter((f): f is NonNullable<typeof f> => !!f && !f.isDeleted)
      .map((f) => ({ x: f.x, y: f.y, w: f.width, h: f.height }))
    return anyOverlap(boxes)
  }, [canvas, sb])
  const timings = useMemo(() => storyboardTimings(sb), [sb])
  const listRef = useRef<HTMLOListElement>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const [drag, setDrag] = useState<{ from: number; to: number; x: number } | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const fps = sb.settings?.fps ?? 24
  const n = sb.panels.length
  const bottom = useStripBottom(canvas)

  const focusCard = (i: number) => {
    const at = Math.max(0, Math.min(n - 1, i))
    setFocusIndex(at)
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.focus({ preventScroll: false }),
    )
  }
  const show = (i: number) => {
    const p = sb.panels[i]
    if (!p) return
    canvas.select([p.id])
    canvas.viewport.ensureVisible([p.id], { animate: true, margin: 80 })
  }
  const move = (from: number, to: number) => {
    if (!canEdit) return
    const panel = sb.panels[from]
    // a locked panel keeps its place (it takes no write: the room refuses it); the others move around it
    if (panel && canvas.isLocked(panel.id)) {
      ctx.notify({
        key: 'storyboard',
        text: `${shotLabel(from + 1)} is locked. Unlock it to move it.`,
        testId: 'sb-locked-notice',
      })
      return
    }
    if (movePanel(canvas, sb, from, to)) {
      const p = sb.panels[from]
      if (p) canvas.select([p.id])
      focusCard(to)
    }
  }
  const run = (what: string, fn: () => unknown) => {
    try {
      if (fn() === null)
        ctx.notify({ key: 'storyboard', tone: 'error', text: `${what} did not work. Try again.` })
    } catch (e) {
      console.error('storyboard', e)
      ctx.notify({ key: 'storyboard', tone: 'error', text: `${what} did not work. Try again.` })
    }
  }
  const current = active >= 0 ? active : -1
  const currentLocked = current >= 0 && canvas.isLocked(sb.panels[current]?.id ?? '')

  // dragging a card: its new place follows the pointer over the cards' middles
  const dropIndex = (clientX: number): number => {
    const cards = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? [])]
    let to = cards.length - 1
    for (let i = 0; i < cards.length; i++) {
      const r = (cards[i] as HTMLElement).getBoundingClientRect()
      if (clientX < r.left + r.width / 2) {
        to = i
        break
      }
    }
    return to
  }

  return (
    <section
      className="dr-sb-strip"
      aria-labelledby={titleId}
      data-testid="sb-strip"
      data-storyboard-id={sb.id}
      style={{ bottom }}
      data-collapsed={collapsed ? 'true' : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <header className="dr-sb-strip__head">
        <div className="dr-sb-strip__title">
          <span className="dr-sb-strip__eyebrow">Storyboard</span>
          <h2 id={titleId} className="dr-sb-strip__name" data-testid="sb-strip-title">
            {title}
          </h2>
          <span className="dr-sb-strip__meta" data-testid="sb-strip-meta">
            {n} {n === 1 ? 'panel' : 'panels'} · {formatRunningTime(timings.totalMs)} ·{' '}
            {sb.settings?.aspect ?? '16:9'}
          </span>
        </div>
        {overlap && canEdit && (
          <button
            type="button"
            className="dr-sb-warn"
            data-testid="sb-overlap"
            onClick={() => run('Arrange', () => arrange(canvas, sb))}
          >
            Panels overlap · Arrange
          </button>
        )}
        <div className="dr-sb-strip__tools">
          {n > 0 && planningShown('animatic') && (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-btn--ghost"
              data-testid="sb-play"
              title="Play the panels in order with their durations"
              onClick={() => {
                if (!isPlayerOpen(canvas)) openPlayer(canvas, sb.id)
              }}
            >
              Play animatic
            </button>
          )}
          {canEdit && (
            <>
              <button
                type="button"
                className="dr-btn dr-btn--sm"
                data-testid="sb-add"
                onClick={() =>
                  run('Adding a panel', () => insertPanel(canvas, sb, current >= 0 ? current + 1 : n))
                }
              >
                Add panel
              </button>
              <ArrangeMenu ctx={ctx} sb={sb} />
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-btn--ghost"
                data-testid="sb-open-script"
                onClick={() => s.dialog.set({ kind: 'script', draft: emptyDraft(sb) })}
              >
                Script to boards…
              </button>
              {reviewOffered(canvas) && (
                <button
                  type="button"
                  className="dr-btn dr-btn--sm dr-btn--ghost"
                  data-testid="sb-review"
                  onClick={() => void putPanelsInReview(ctx, sb)}
                >
                  Put panels in review
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="dr-iconbtn dr-iconbtn--sm"
            aria-label={collapsed ? 'Show the panels' : 'Hide the panels'}
            aria-expanded={!collapsed}
            data-testid="sb-strip-collapse"
            onClick={() => setCollapsed((v) => !v)}
          >
            <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true" focusable="false">
              <path
                d={collapsed ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="dr-iconbtn dr-iconbtn--sm"
            aria-label="Close the storyboard strip"
            data-testid="sb-strip-close"
            onClick={() => s.strip.set(null)}
          >
            ×
          </button>
        </div>
      </header>
      <ol
        ref={listRef}
        className="dr-sb-strip__list"
        aria-label={`Panels of ${title}`}
        data-testid="sb-strip-list"
        data-dragging={drag ? 'true' : undefined}
      >
        {sb.panels.map((p, i) => (
          <li
            key={p.id}
            className="dr-sb-card"
            data-index={i}
            data-testid="sb-strip-card"
            data-panel-id={p.id}
            data-shot={i + 1}
            data-active={i === current ? 'true' : undefined}
            data-drop-before={drag && drag.to === i && drag.from > i ? 'true' : undefined}
            data-drop-after={drag && drag.to === i && drag.from < i ? 'true' : undefined}
            data-dragged={drag?.from === i ? 'true' : undefined}
            data-locked={canvas.isLocked(p.id) ? 'true' : undefined}
            tabIndex={i === (current >= 0 ? current : focusIndex) ? 0 : -1}
            aria-label={`${shotLabel(i + 1)}, ${formatDuration(timings.panels[i]?.durationMs ?? 0)}${i === current ? ', selected' : ''}`}
            aria-current={i === current ? 'true' : undefined}
            onFocus={() => setFocusIndex(i)}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('input, button')) return
              show(i)
            }}
            onKeyDown={(e) => {
              if ((e.target as HTMLElement).closest('input')) return
              const k = e.key
              let handled = true
              if (k === 'ArrowLeft' && e.altKey) move(i, i - 1)
              else if (k === 'ArrowRight' && e.altKey) move(i, i + 1)
              else if (k === 'ArrowLeft') focusCard(i - 1)
              else if (k === 'ArrowRight') focusCard(i + 1)
              else if (k === 'Home') focusCard(0)
              else if (k === 'End') focusCard(n - 1)
              else if (k === 'Enter' || k === ' ') show(i)
              else handled = false
              if (handled) {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
            onPointerDown={(e) => {
              if (!canEdit || e.button !== 0 || (e.target as HTMLElement).closest('input, button')) return
              // a locked panel is not dragged (it keeps its place)
              if (canvas.isLocked(p.id)) return
              const startX = e.clientX
              const el = e.currentTarget
              let started = false
              const onMove = (ev: PointerEvent) => {
                if (!started && Math.abs(ev.clientX - startX) < 6) return
                started = true
                setDrag({ from: i, to: dropIndex(ev.clientX), x: ev.clientX })
              }
              const onUp = (ev: PointerEvent) => {
                el.removeEventListener('pointermove', onMove)
                el.removeEventListener('pointerup', onUp)
                el.removeEventListener('pointercancel', onCancel)
                setDrag(null)
                if (started) move(i, dropIndex(ev.clientX))
              }
              const onCancel = () => {
                el.removeEventListener('pointermove', onMove)
                el.removeEventListener('pointerup', onUp)
                el.removeEventListener('pointercancel', onCancel)
                setDrag(null)
              }
              try {
                el.setPointerCapture(e.pointerId)
              } catch {
                // a synthetic pointer: the listeners still follow it
              }
              el.addEventListener('pointermove', onMove)
              el.addEventListener('pointerup', onUp)
              el.addEventListener('pointercancel', onCancel)
            }}
          >
            <Thumb canvas={canvas} panelId={p.id} n={i + 1} />
            <div className="dr-sb-card__row">
              <span className="dr-sb-card__num">{String(i + 1).padStart(2, '0')}</span>
              <Duration
                ms={timings.panels[i]?.durationMs ?? 0}
                fps={fps}
                shot={i + 1}
                disabled={!canEdit || canvas.isLocked(p.id)}
                onSet={(ms) => setDuration(canvas, p.id, ms)}
              />
            </div>
            <CameraLine canvas={canvas} panelId={p.id} />
          </li>
        ))}
      </ol>
      {canEdit && current >= 0 && (
        <div
          className="dr-sb-strip__actions"
          role="toolbar"
          aria-label={`Shot ${current + 1}`}
          data-testid="sb-actions"
        >
          <span className="dr-sb-strip__which">
            {shotLabel(current + 1)} of {n}
          </span>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="sb-move-left"
            disabled={current === 0 || currentLocked}
            onClick={() => move(current, current - 1)}
          >
            ← Move
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="sb-move-right"
            disabled={current === n - 1 || currentLocked}
            onClick={() => move(current, current + 1)}
          >
            Move →
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="sb-insert-before-btn"
            onClick={() => run('Adding a panel', () => insertPanel(canvas, sb, current))}
          >
            Insert before
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="sb-insert-after-btn"
            onClick={() => run('Adding a panel', () => insertPanel(canvas, sb, current + 1))}
          >
            Insert after
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="sb-duplicate"
            onClick={() => run('Duplicating the panel', () => duplicatePanel(canvas, sb, current))}
          >
            Duplicate
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--danger-ghost"
            data-testid="sb-delete"
            onClick={() => {
              const p = sb.panels[current]
              if (p) deletePanels(canvas, sb, [p.id])
              if (n > 1) focusCard(Math.min(current, n - 2))
            }}
          >
            Delete
          </button>
        </div>
      )}
    </section>
  )
}

function emptyDraft(sb: Sb) {
  return {
    text: '',
    format: null,
    aspect: sb.settings?.aspect ?? ('16:9' as const),
    title: 'Storyboard',
    beats: null,
    ai: null,
  }
}

function ArrangeMenu({ ctx, sb }: { ctx: CanvasFeatureContext; sb: Sb }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const per = perRowOf(sb.settings?.perRow)
  useEffect(() => {
    if (!open) return
    const doc = ref.current?.ownerDocument
    const off = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    doc?.addEventListener('pointerdown', off, true)
    return () => doc?.removeEventListener('pointerdown', off, true)
  }, [open])
  return (
    <div className="dr-sb-menu" ref={ref}>
      <button
        type="button"
        className="dr-btn dr-btn--sm dr-btn--ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="sb-arrange"
        onClick={() => setOpen((v) => !v)}
      >
        Arrange ▾
      </button>
      {open && (
        <div
          id={menuId}
          className="dr-sb-menu__list"
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            }
          }}
        >
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitemradio"
              aria-checked={per === l.perRow}
              className="dr-sb-menu__item"
              data-testid={`sb-layout-${l.id}`}
              onClick={() => {
                setOpen(false)
                arrange(ctx.canvas, sb, l.perRow)
              }}
            >
              {l.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="dr-sb-menu__item"
            data-testid="sb-arrange-again"
            onClick={() => {
              setOpen(false)
              arrange(ctx.canvas, sb)
            }}
          >
            Tidy up
          </button>
        </div>
      )}
    </div>
  )
}

function Duration({
  ms,
  fps,
  shot,
  disabled,
  onSet,
}: {
  ms: number
  fps: number
  shot: number
  disabled: boolean
  onSet(ms: number): void
}) {
  const [text, setText] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const commit = () => {
    if (text === null) return
    const v = parseDuration(text, fps)
    if (v === null) {
      setBad(true)
      return
    }
    setBad(false)
    setText(null)
    if (v !== ms) onSet(v)
  }
  const step = (d: number) => {
    const v = Math.max(SB_DUR_MIN_MS, Math.min(SB_DUR_MAX_MS, Math.round((ms + d) / 100) * 100))
    if (v !== ms) onSet(v)
  }
  return (
    <span className="dr-sb-dur" data-bad={bad ? 'true' : undefined}>
      {!disabled && (
        <button
          type="button"
          className="dr-sb-dur__step"
          aria-label={`Half a second shorter, shot ${shot}`}
          onClick={() => step(-500)}
        >
          −
        </button>
      )}
      <input
        className="dr-sb-dur__input"
        data-testid="sb-duration"
        aria-label={`Duration of shot ${shot}`}
        aria-invalid={bad || undefined}
        title='Seconds ("2.5"), minutes ("0:03") or frames ("36f")'
        value={text ?? formatDuration(ms)}
        readOnly={disabled}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          if (!disabled) e.currentTarget.select()
        }}
        onBlur={() => {
          commit()
          setText(null)
          setBad(false)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            setText(null)
            setBad(false)
            e.currentTarget.blur()
          }
        }}
      />
      {!disabled && (
        <button
          type="button"
          className="dr-sb-dur__step"
          aria-label={`Half a second longer, shot ${shot}`}
          onClick={() => step(500)}
        >
          +
        </button>
      )}
    </span>
  )
}

function CameraLine({ canvas, panelId }: { canvas: LobbyCanvas; panelId: string }) {
  const words = useValue('storyboard.card-words', () => panelWords(canvas, panelId), [canvas, panelId])
  const line = words['sb-camera'] || words['sb-action'] || ''
  return (
    <span className="dr-sb-card__words" title={line || undefined}>
      {line || <span className="dr-sb-card__empty">No shot notes yet</span>}
    </span>
  )
}

// ---- thumbnails ----------------------------------------------------------------------------------------------

/** One export at a time, the newest request for a panel first. */
let thumbQueue: Promise<void> = Promise.resolve()

/** What a panel's picture depends on: the frame's and its children's versions. */
function signatureOf(canvas: LobbyCanvas, panelId: string): string {
  const f = canvas.get(panelId)
  if (!f) return ''
  let sig = `${f.version}:${Math.round(f.width)}x${Math.round(f.height)}`
  for (const c of canvas.index.byFrame(panelId)) sig += `|${c.id}:${c.version}`
  return sig
}

function Thumb({ canvas, panelId, n }: { canvas: LobbyCanvas; panelId: string; n: number }) {
  const sig = useValue('storyboard.thumb-sig', () => signatureOf(canvas, panelId), [canvas, panelId])
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!sig) return
    let cancelled = false
    let made: string | null = null
    const timer = setTimeout(() => {
      thumbQueue = thumbQueue.then(async () => {
        if (cancelled) return
        try {
          // the picture only (its slot, where a dropped image goes), else the whole panel
          const slot = canvas.index.byFrame(panelId).find((c) => items.lobbyValue(c, 'kind') === PICTURE_KIND)
          const blob = await canvas.export.png(
            slot
              ? {
                  bounds: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
                  maxSide: 320,
                  padding: 0,
                  background: true,
                }
              : { frameId: panelId, maxSide: 320, padding: 0, background: true },
          )
          if (cancelled) return
          made = URL.createObjectURL(blob)
          setUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return made
          })
        } catch {
          // no picture: the card shows its number
        }
      })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [canvas, panelId, sig])
  useEffect(
    () => () => {
      setUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return null
      })
    },
    [],
  )
  return (
    <div className="dr-sb-card__thumb" data-testid="sb-thumb" data-ready={url ? 'true' : undefined}>
      {url ? <img src={url} alt="" draggable={false} /> : <span aria-hidden="true">{shotLabel(n)}</span>}
    </div>
  )
}
