// OWNER: 3h. The AI overlay on the Excalidraw board page (a `screen` layer of the overlay root; the tldraw
// twin is ../Overlay.tsx, with the same copy, test ids and keyboard rules):
//  - the AI popover: the four actions for the target, the "Sends the selected text to OpenAI" notice the
//    first time, the "Generate ideas" prompt, and, for workspace owners, "AI budget used today: N%";
//  - the busy pill ("Grouping into themes…" with Cancel) while a request runs;
//  - the summary panel (everyone's summary opens here first; editors add it to the board from it).
// Everything is driven by the signals in ./runtime.ts (useValue, narrow selectors); nothing runs per frame.

import { AI_IDEAS_DEFAULT, AI_IDEAS_MAX, AI_PROMPT_MAX_CHARS, AI_SETTINGS_EVENT } from '@draftroom/contracts'
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  type CanvasFeatureContext,
  type LobbyCanvas,
  useCanvasFeatureContext,
} from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { isTextEntry, onFocusLeave, trapTab, tryFocus } from '../../../ui/focus.ts'
import { budgetLine, groupNames, themesHint } from '../copy.ts'
import { ActionIcon, SparkIcon, Spinner } from '../icons.tsx'
import { addSummaryToBoard, cancelAiJob, closeAiMenu, refreshAiStatus, runAi } from './actions.ts'
import {
  ACTION_LABELS,
  type AiMenuState,
  type AiPanelState,
  type AiRequest,
  aiJob,
  aiMenu,
  aiOpener,
  aiPanel,
  aiStatus,
  BUSY_LABELS,
  setAiCtx,
} from './runtime.ts'

const docOf = (canvas: LobbyCanvas) => canvas.container()?.ownerDocument ?? document

/** Keeps pointer, wheel and key events inside our UI from reaching the canvas (keys arrive natively). */
function useIsolated<T extends HTMLElement>(onKey?: (e: KeyboardEvent) => void) {
  const ref = useRef<T>(null)
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => e.stopPropagation()
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      keyRef.current?.(e)
    }
    el.addEventListener('keydown', key)
    el.addEventListener('keyup', stop)
    el.addEventListener('pointerdown', stop)
    el.addEventListener('mousedown', stop)
    el.addEventListener('wheel', stop, { passive: true })
    return () => {
      el.removeEventListener('keydown', key)
      el.removeEventListener('keyup', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('mousedown', stop)
      el.removeEventListener('wheel', stop)
    }
  }, [])
  return ref
}

const EDGE = 12

/** Below the anchor when it fits, else above; always inside the canvas. */
function usePlacement(canvas: LobbyCanvas, at: AiMenuState['at'], ref: React.RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const box = canvas.container()?.getBoundingClientRect()
    if (!el || !box) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(EDGE, Math.min(box.width - w - EDGE, at.x - w / 2))
    const below = at.bottom + 10
    const above = at.top - 10 - h
    const top =
      below + h <= box.height - EDGE || above < 56
        ? Math.max(56, Math.min(below, box.height - h - EDGE))
        : above
    if (!pos || Math.abs(pos.left - left) > 0.5 || Math.abs(pos.top - top) > 0.5) setPos({ left, top })
  })
  return pos
}

/** The popover closed from the keyboard (Escape, ×, Cancel): the focus goes back where it came from. */
function returnFocus(canvas: LobbyCanvas, opener: HTMLElement | null = aiOpener.get(canvas)) {
  aiOpener.clear(canvas)
  if (tryFocus(opener)) return
  canvas.focus({ preventScroll: true })
}

function AiPopover({ menu }: { menu: AiMenuState }) {
  const { canvas, registries } = useCanvasFeatureContext()
  const status = useValue('lobby-ai-pop-status', () => aiStatus(canvas).get(), [canvas])
  const close = (refocus: boolean) => {
    closeAiMenu(canvas, false)
    if (refocus) returnFocus(canvas)
    else aiOpener.clear(canvas)
  }
  const ref = useIsolated<HTMLDivElement>((e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
      return
    }
    // A11Y-15: Tab stays inside while it is open (Escape is the way out).
    if (e.key === 'Tab') {
      if (ref.current) trapTab(e, ref.current)
      return
    }
    // Arrow keys move between the actions (a menu), wrapping around.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])]
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    e.preventDefault()
    items[next]?.focus()
  })
  const pos = usePlacement(canvas, menu.at, ref)
  const titleId = useId()
  const closeRef = useRef(close)
  closeRef.current = close
  // A press anywhere else closes it.
  useEffect(() => {
    const doc = docOf(canvas)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || ref.current?.contains(t)) return
      if ((t as Element).closest?.('[data-testid="selection-ai"]')) return
      closeRef.current(false)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [canvas, ref])
  /** The popover has placed its first focus (focus moving out before that is the context menu's). */
  const settled = useRef(false)
  // A11Y-15: the focus moving elsewhere closes it too; the AI button that toggles it does not count.
  const enabled = status?.enabled === true
  useEffect(() => {
    const root = ref.current
    if (!root || !enabled) return
    return onFocusLeave(
      root,
      () => {
        if (settled.current) closeRef.current(false)
      },
      (el) => el.closest('[data-testid="selection-ai"]') !== null,
    )
  }, [ref, enabled])
  // Focus the first control when it opens, once the context menu (if any) has let go of the focus.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const focus = () => {
      if (registries.menusOpen.call() && tries++ < 60) {
        frame = requestAnimationFrame(focus)
        return
      }
      const root = ref.current
      // A11Y-08: an action or field first, never the header's ×.
      const controls = [...(root?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])]
      const el =
        root?.querySelector<HTMLElement>('[data-autofocus]') ??
        root?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])') ??
        controls.find((c) => !c.closest('.dr-ai-pop__head')) ??
        controls[0]
      el?.focus()
      frame = requestAnimationFrame(() => {
        settled.current = true
      })
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [registries, ref, menu.view])
  if (!status?.enabled) return null
  return (
    <div
      ref={ref}
      className="dr-ai-pop"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="ai-menu"
      data-view={menu.view}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}
    >
      {menu.view === 'menu' && <MenuView menu={menu} titleId={titleId} onClose={() => close(true)} />}
      {menu.view === 'ideas' && <IdeasView menu={menu} titleId={titleId} onClose={() => close(true)} />}
      {menu.view === 'notice' && <NoticeView menu={menu} titleId={titleId} onClose={() => close(true)} />}
      {menu.view === 'regroup' && <RegroupView menu={menu} titleId={titleId} onClose={() => close(true)} />}
    </div>
  )
}

function Head({ titleId, children, onClose }: { titleId: string; children: ReactNode; onClose(): void }) {
  return (
    <div className="dr-ai-pop__head">
      <span className="dr-ai-pop__badge" aria-hidden="true">
        <SparkIcon size={14} />
      </span>
      <h2 id={titleId} className="dr-ai-pop__title">
        {children}
      </h2>
      <button type="button" className="dr-iconbtn dr-iconbtn--sm" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
  )
}

function Item(props: {
  action: 'summarize' | 'themes' | 'actions' | 'ideas'
  hint: string
  disabled?: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="dr-ai-item"
      data-testid={`ai-${props.action}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="dr-ai-item__icon">
        <ActionIcon action={props.action} />
      </span>
      <span className="dr-ai-item__text">
        <span className="dr-ai-item__label">
          {ACTION_LABELS[props.action]}
          {props.action === 'ideas' ? '…' : ''}
        </span>
        <span className="dr-ai-item__hint">{props.hint}</span>
      </span>
    </button>
  )
}

function Budget() {
  const { canvas } = useCanvasFeatureContext()
  const budget = useValue('lobby-ai-budget', () => aiStatus(canvas).get()?.budget ?? null, [canvas])
  if (!budget) return null
  return (
    <p
      className="dr-ai-pop__budget"
      data-testid="ai-budget"
      title="Resets at midnight UTC. Only workspace owners see this."
    >
      <span className="dr-ai-meter" aria-hidden="true">
        <span
          style={{ width: `${Math.max(2, budget.usedPercent)}%` }}
          data-high={budget.usedPercent >= 80 || undefined}
        />
      </span>
      {budgetLine(budget.usedPercent)}
    </p>
  )
}

function MenuView({ menu, titleId, onClose }: { menu: AiMenuState; titleId: string; onClose(): void }) {
  const { canvas } = useCanvasFeatureContext()
  const status = useValue('lobby-ai-menu-status', () => aiStatus(canvas).get(), [canvas])
  const readOnly = useValue('lobby-ai-menu-readonly', () => canvas.readOnly(), [canvas])
  const { target } = menu
  const insert = !!status?.canInsert && !readOnly
  const run = (req: AiRequest) => void runAi(canvas, req, target, { at: menu.at })
  return (
    <>
      <Head titleId={titleId} onClose={onClose}>
        AI <span className="dr-ai-pop__about">· {target.label}</span>
      </Head>
      <div role="menu" aria-label="AI actions" className="dr-ai-pop__items">
        <Item
          action="summarize"
          hint={
            target.texts === 0
              ? 'Nothing with text selected'
              : insert
                ? 'Read it first, then add it to the board'
                : 'A short summary, just for you'
          }
          disabled={target.texts === 0}
          onClick={() => run({ action: 'summarize' })}
        />
        {insert && (
          <>
            <Item
              action="themes"
              hint={themesHint(target.notes, target.prompts)}
              disabled={target.notes < 2}
              onClick={() =>
                target.groups.length
                  ? aiMenu(canvas).set({ ...menu, view: 'regroup' })
                  : run({ action: 'themes' })
              }
            />
            <Item
              action="actions"
              hint={target.texts === 0 ? 'Nothing with text selected' : 'Next steps and owners as new notes'}
              disabled={target.texts === 0}
              onClick={() => run({ action: 'actions' })}
            />
            <Item
              action="ideas"
              hint="New sticky notes from a short prompt"
              onClick={() => aiMenu(canvas).set({ ...menu, view: 'ideas' })}
            />
          </>
        )}
      </div>
      <Budget />
      <p className="dr-ai-pop__foot">Uses OpenAI. Comments, private notes and files are never sent.</p>
    </>
  )
}

function IdeasView({ menu, titleId, onClose }: { menu: AiMenuState; titleId: string; onClose(): void }) {
  const { canvas } = useCanvasFeatureContext()
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState(AI_IDEAS_DEFAULT)
  const inputId = useId()
  const countId = useId()
  const trimmed = prompt.trim()
  const submit = () => {
    if (!trimmed) return
    void runAi(canvas, { action: 'ideas', prompt: trimmed, count }, menu.target, { at: menu.at })
  }
  return (
    <>
      <Head titleId={titleId} onClose={onClose}>
        Generate ideas
      </Head>
      <form
        className="dr-ai-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label htmlFor={inputId} className="dr-ai-form__label">
          What should the ideas be about?
        </label>
        <input
          id={inputId}
          className="dr-ai-form__input"
          data-testid="ai-ideas-prompt"
          data-autofocus
          value={prompt}
          maxLength={AI_PROMPT_MAX_CHARS}
          placeholder="e.g. names for the launch party"
          autoComplete="off"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="dr-ai-form__row">
          <label htmlFor={countId} className="dr-ai-form__label">
            How many
          </label>
          <select
            id={countId}
            className="dr-ai-form__select"
            data-testid="ai-ideas-count"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          >
            {[3, 4, 6, 8, 10, AI_IDEAS_MAX].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="dr-ai-form__spacer" />
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            onClick={() => aiMenu(canvas).set({ ...menu, view: 'menu' })}
          >
            Back
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="ai-ideas-go"
            disabled={!trimmed}
          >
            Generate
          </button>
        </div>
      </form>
      {menu.target.texts > 0 && (
        <p className="dr-ai-pop__foot">The selected text is sent along as context.</p>
      )}
    </>
  )
}

/** Before regrouping notes that already sit in groups (DANA-10): say so, and let them keep the groups. */
function RegroupView({ menu, titleId, onClose }: { menu: AiMenuState; titleId: string; onClose(): void }) {
  const { canvas } = useCanvasFeatureContext()
  return (
    <>
      <Head titleId={titleId} onClose={onClose}>
        These notes are already grouped
      </Head>
      <div className="dr-ai-notice" data-testid="ai-regroup">
        <p>
          They sit under {groupNames(menu.target.groups)}. Grouping into themes adds new labelled groups
          beside those boxes, which stay where they are.
        </p>
        <p className="dr-ai-notice__muted">One Ctrl+Z puts every note back.</p>
        <div className="dr-ai-notice__actions">
          <button type="button" className="dr-btn dr-btn--sm" data-autofocus onClick={onClose}>
            Keep the groups
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="ai-regroup-go"
            onClick={() => void runAi(canvas, { action: 'themes' }, menu.target, { at: menu.at })}
          >
            Group anyway
          </button>
        </div>
      </div>
    </>
  )
}

function NoticeView({ menu, titleId, onClose }: { menu: AiMenuState; titleId: string; onClose(): void }) {
  const { canvas } = useCanvasFeatureContext()
  const pending = menu.pending
  const what =
    menu.target.kind === 'none'
      ? 'your prompt'
      : `the text of ${menu.target.label}${pending?.action === 'ideas' ? ' and your prompt' : ''}`
  return (
    <>
      <Head titleId={titleId} onClose={onClose}>
        Sends the selected text to OpenAI
      </Head>
      <div className="dr-ai-notice" data-testid="ai-notice">
        <p>
          To {pending ? ACTION_LABELS[pending.action].toLowerCase() : 'do this'}, Lobby sends {what} to
          OpenAI, which writes the answer.
        </p>
        <p className="dr-ai-notice__muted">
          Comments, private brainstorm notes, files and who wrote what are never sent. You’ll see this once
          per workspace.
        </p>
        <div className="dr-ai-notice__actions">
          <button type="button" className="dr-btn dr-btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="ai-notice-continue"
            data-autofocus
            onClick={() => {
              if (pending) void runAi(canvas, pending, menu.target, { acknowledged: true, at: menu.at })
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </>
  )
}

function Busy() {
  const { canvas } = useCanvasFeatureContext()
  const job = useValue('lobby-ai-job', () => aiJob(canvas).get(), [canvas])
  const ref = useIsolated<HTMLDivElement>()
  if (!job) return null
  return (
    <div
      ref={ref}
      className="dr-ai-busy"
      role="status"
      aria-live="polite"
      data-testid="ai-busy"
      data-action={job.action}
    >
      <Spinner size={16} />
      <span className="dr-ai-busy__text">{BUSY_LABELS[job.action]}</span>
      <button
        type="button"
        className="dr-btn dr-btn--sm"
        data-testid="ai-cancel"
        onClick={() => cancelAiJob(canvas)}
      >
        Cancel
      </button>
    </div>
  )
}

/**
 * A11Y2-03: whether the last thing the person did was a key press (not a pointer press). The summary
 * arrives a moment after Summarize or Continue; when that was pressed from the keyboard, the panel
 * takes the focus, else the pointer user keeps theirs (the live region still says it is ready).
 */
let lastInputKeyboard = false

function useInputModality(doc: Document) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta')
        lastInputKeyboard = true
    }
    const onPointer = () => {
      lastInputKeyboard = false
    }
    doc.addEventListener('keydown', onKey, true)
    doc.addEventListener('pointerdown', onPointer, true)
    return () => {
      doc.removeEventListener('keydown', onKey, true)
      doc.removeEventListener('pointerdown', onPointer, true)
    }
  }, [doc])
}

/** Escape closes the summary from anywhere, unless something above it (a menu, a dialog) owns Escape. */
function escapeIsOurs(ctx: CanvasFeatureContext, e: KeyboardEvent, panel: HTMLElement | null): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return false
  const t = e.target as Element | null
  if (panel && t && panel.contains(t)) return true
  const { canvas } = ctx
  if (ctx.registries.menusOpen.call() || canvas.editingId() !== null || aiMenu(canvas).get()) return false
  if (docOf(canvas).querySelector('dialog[open]')) return false
  // A field elsewhere (search, a comment, a dock panel) keeps its own Escape.
  return !(t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))
}

function SummaryPanel({ onAnnounce }: { onAnnounce(text: string): void }) {
  const { canvas } = useCanvasFeatureContext()
  const panel = useValue('lobby-ai-panel', () => aiPanel(canvas).get(), [canvas])
  const open = panel !== null
  const announce = useRef(onAnnounce)
  announce.current = onAnnounce
  useEffect(() => {
    if (!open) announce.current('')
  }, [open])
  // Mounted only while there is a summary, so its key isolation attaches to the panel.
  if (!panel) return null
  return <SummaryView panel={panel} onAnnounce={onAnnounce} />
}

function SummaryView({ panel, onAnnounce }: { panel: AiPanelState; onAnnounce(text: string): void }) {
  const ctx = useCanvasFeatureContext()
  const { canvas } = ctx
  const canAdd = useValue(
    'lobby-ai-panel-can-add',
    () => !canvas.readOnly() && aiStatus(canvas).get()?.canInsert === true,
    [canvas],
  )
  const ref = useIsolated<HTMLElement>()
  /**
   * Closes it; when the keyboard was in it, the keyboard goes back to the AI button that asked for the
   * summary (W5-47: the popover that recorded it closed long before), or the board.
   */
  const close = () => {
    const hadFocus = !!ref.current?.contains(docOf(canvas).activeElement)
    aiPanel(canvas).set(null)
    if (hadFocus) returnFocus(canvas, panel.opener)
  }
  const closeRef = useRef(close)
  closeRef.current = close
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const titleId = useId()
  const textId = useId()
  const [copied, setCopied] = useState(false)
  // A11Y2-03: Escape closes it even while the keyboard is on the board (the selection stays).
  useEffect(() => {
    const doc = docOf(canvas)
    const onKey = (e: KeyboardEvent) => {
      if (!escapeIsOurs(ctxRef.current, e, ref.current)) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    doc.addEventListener('keydown', onKey, true)
    return () => doc.removeEventListener('keydown', onKey, true)
  }, [canvas, ref])
  // A11Y2-03: opened from the keyboard, it takes the focus: on its main action, with the summary as
  // the dialog's description. Nothing is taken from a text field.
  const summary = panel.summary
  const announce = useRef(onAnnounce)
  announce.current = onAnnounce
  useEffect(() => {
    const root = ref.current
    const doc = docOf(canvas)
    const active = doc.activeElement
    const typing = !!active && active !== doc.body && isTextEntry(active) && !root?.contains(active)
    const target =
      root?.querySelector<HTMLElement>('[data-testid="ai-summary-add"]') ??
      root?.querySelector<HTMLElement>('[data-testid="ai-summary-copy"]')
    const moved = lastInputKeyboard && !typing && tryFocus(target)
    announce.current(moved ? 'Summary ready.' : `Summary ready: ${summary}`)
  }, [canvas, ref, summary])
  return (
    <section
      ref={ref}
      className="dr-ai-panel"
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      data-testid="ai-summary-panel"
    >
      <div className="dr-ai-pop__head">
        <span className="dr-ai-pop__badge" aria-hidden="true">
          <SparkIcon size={14} />
        </span>
        <h2 id={titleId} className="dr-ai-pop__title">
          Summary <span className="dr-ai-pop__about">· {panel.about}</span>
        </h2>
        <button
          type="button"
          className="dr-iconbtn dr-iconbtn--sm"
          aria-label="Close summary"
          onClick={close}
        >
          ×
        </button>
      </div>
      <p id={textId} className="dr-ai-panel__text" data-testid="ai-summary-text">
        {panel.summary}
      </p>
      {panel.truncated && (
        <p className="dr-ai-pop__foot">Only part of the selection fitted in one request.</p>
      )}
      <p className="dr-ai-pop__foot">
        {canAdd
          ? 'Only you can see this. Written by AI: check it before you add it to the board.'
          : 'Only you can see this. Written by AI: check before you rely on it.'}
      </p>
      <div className="dr-ai-panel__actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="ai-summary-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(panel.summary).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {canAdd && (
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="ai-summary-add"
            onClick={() => addSummaryToBoard(canvas)}
          >
            Add to board
          </button>
        )}
      </div>
    </section>
  )
}

export function AiOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  useLayoutEffect(() => {
    setAiCtx(ctx)
  })
  // What AI may do here: asked once per board and role (the api decides; hidden until it says yes).
  const boardId = ctx.board.id
  const role = ctx.role
  const status = ctx.board.status
  useEffect(() => {
    setAiCtx(ctx)
    const abort = new AbortController()
    void refreshAiStatus(canvas, abort.signal)
    return () => abort.abort()
  }, [canvas, boardId, role, status])
  // The owner turned AI on or off for this board (or its workspace default): ask again at once.
  const events = ctx.events
  useEffect(() => {
    const again = () => void refreshAiStatus(canvas)
    const offSettings = events.on(AI_SETTINGS_EVENT, again)
    return () => offSettings()
  }, [canvas, events])
  const menu = useValue('lobby-ai-menu', () => aiMenu(canvas).get(), [canvas])
  const enabled = useValue('lobby-ai-on', () => aiStatus(canvas).get()?.enabled === true, [canvas])
  useInputModality(docOf(canvas))
  // A11Y2-03: the summary is announced as it arrives (the region exists beforehand, so the change is heard).
  const [said, setSaid] = useState('')
  // A11Y-15: remember what had the keyboard as the popover opens (it takes the focus a frame later).
  const open = menu !== null
  useLayoutEffect(() => {
    if (!open) return
    const a = docOf(canvas).activeElement
    if (a instanceof HTMLElement && a !== a.ownerDocument.body && !a.closest('.dr-ai-pop'))
      aiOpener.set(canvas, a)
    else aiOpener.clear(canvas)
  }, [canvas, open])
  if (!enabled) return null
  return (
    <div className="dr-ai-overlay" data-testid="ai-overlay">
      {menu && <AiPopover key={`${menu.view}`} menu={menu} />}
      <Busy />
      <SummaryPanel onAnnounce={setSaid} />
      <p className="dr-sr-only" role="status" data-testid="ai-summary-status">
        {said}
      </p>
    </div>
  )
}
