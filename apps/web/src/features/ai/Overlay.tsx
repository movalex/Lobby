// The AI overlay (a child of <Tldraw>, docs/WAVE4-CONTRACTS.md §4 ai-assist):
//  - the AI popover: the four actions for the target, the "Sends the selected text to OpenAI" notice the
//    first time, the "Generate ideas" prompt, and, for workspace owners, "AI budget used today: N%";
//  - the busy pill ("Grouping into themes…" with Cancel) while a request runs;
//  - the summary panel for people who cannot edit (their summary is shown, not inserted).
// Everything is driven by the atoms in runtime.ts (useValue, narrow selectors); nothing runs per frame.

import { AI_IDEAS_DEFAULT, AI_IDEAS_MAX, AI_PROMPT_MAX_CHARS } from '@draftroom/contracts'
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { type Editor, useEditor, useValue } from 'tldraw'
import type { FeatureContext } from '../types.ts'
import { cancelAiJob, closeAiMenu, refreshAiStatus, runAi } from './actions.ts'
import { budgetLine } from './copy.ts'
import { ActionIcon, SparkIcon, Spinner } from './icons.tsx'
import {
  ACTION_LABELS,
  type AiMenuState,
  type AiRequest,
  aiJob,
  aiMenu,
  aiPanel,
  aiStatus,
  BUSY_LABELS,
  setAiCtx,
} from './runtime.ts'

/** Keeps pointer, wheel and key events inside our UI from reaching tldraw (keys arrive natively). */
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

/** Below the anchor when it fits, else above; always inside the editor. */
function usePlacement(editor: Editor, at: AiMenuState['at'], ref: React.RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const c = editor.getContainer().getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = Math.max(EDGE, Math.min(c.width - w - EDGE, at.x - w / 2))
    const below = at.bottom + 10
    const above = at.top - 10 - h
    const top =
      below + h <= c.height - EDGE || above < 56 ? Math.max(56, Math.min(below, c.height - h - EDGE)) : above
    if (!pos || Math.abs(pos.left - left) > 0.5 || Math.abs(pos.top - top) > 0.5) setPos({ left, top })
  })
  return pos
}

function AiPopover({ menu }: { menu: AiMenuState }) {
  const editor = useEditor()
  const status = useValue('dr-ai-pop-status', () => aiStatus(editor).get(), [editor])
  const close = (refocus: boolean) => closeAiMenu(editor, refocus)
  const ref = useIsolated<HTMLDivElement>((e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
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
  const pos = usePlacement(editor, menu.at, ref)
  const titleId = useId()
  const closeRef = useRef(close)
  closeRef.current = close
  // A press anywhere else closes it.
  useEffect(() => {
    const doc = editor.getContainer().ownerDocument
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t || ref.current?.contains(t)) return
      if ((t as Element).closest?.('[data-testid="selection-ai"]')) return
      closeRef.current(false)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [editor, ref])
  // Focus the first control when it opens, once the context menu (if any) has let go of the focus.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const focus = () => {
      if (editor.menus.hasAnyOpenMenus() && tries++ < 60) {
        frame = requestAnimationFrame(focus)
        return
      }
      const root = ref.current
      const el =
        root?.querySelector<HTMLElement>('[data-autofocus]') ??
        root?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]), input, button:not([disabled])')
      el?.focus()
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [editor, ref, menu.view])
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
  const editor = useEditor()
  const budget = useValue('dr-ai-budget', () => aiStatus(editor).get()?.budget ?? null, [editor])
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
  const editor = useEditor()
  const status = useValue('dr-ai-menu-status', () => aiStatus(editor).get(), [editor])
  const { target } = menu
  const insert = !!status?.canInsert && !editor.getIsReadonly()
  const run = (req: AiRequest) => void runAi(editor, req, target, { at: menu.at })
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
                ? 'A short summary beside it'
                : 'A short summary, just for you'
          }
          disabled={target.texts === 0}
          onClick={() => run({ action: 'summarize' })}
        />
        {insert && (
          <>
            <Item
              action="themes"
              hint={
                target.notes < 2
                  ? 'Needs two or more sticky notes'
                  : `Sorts ${target.notes} notes into labelled groups`
              }
              disabled={target.notes < 2}
              onClick={() => run({ action: 'themes' })}
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
              onClick={() => aiMenu(editor).set({ ...menu, view: 'ideas' })}
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
  const editor = useEditor()
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState(AI_IDEAS_DEFAULT)
  const inputId = useId()
  const countId = useId()
  const trimmed = prompt.trim()
  const submit = () => {
    if (!trimmed) return
    void runAi(editor, { action: 'ideas', prompt: trimmed, count }, menu.target, { at: menu.at })
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
            onClick={() => aiMenu(editor).set({ ...menu, view: 'menu' })}
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

function NoticeView({ menu, titleId, onClose }: { menu: AiMenuState; titleId: string; onClose(): void }) {
  const editor = useEditor()
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
              if (pending) void runAi(editor, pending, menu.target, { acknowledged: true, at: menu.at })
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
  const editor = useEditor()
  const job = useValue('dr-ai-job', () => aiJob(editor).get(), [editor])
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
        onClick={() => cancelAiJob(editor)}
      >
        Cancel
      </button>
    </div>
  )
}

function SummaryPanel() {
  const editor = useEditor()
  const panel = useValue('dr-ai-panel', () => aiPanel(editor).get(), [editor])
  const close = () => aiPanel(editor).set(null)
  const ref = useIsolated<HTMLElement>((e) => {
    if (e.key === 'Escape') close()
  })
  const [copied, setCopied] = useState(false)
  if (!panel) return null
  return (
    <section ref={ref} className="dr-ai-panel" aria-label="AI summary" data-testid="ai-summary-panel">
      <div className="dr-ai-pop__head">
        <span className="dr-ai-pop__badge" aria-hidden="true">
          <SparkIcon size={14} />
        </span>
        <h2 className="dr-ai-pop__title">
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
      <p className="dr-ai-panel__text" data-testid="ai-summary-text">
        {panel.summary}
      </p>
      {panel.truncated && (
        <p className="dr-ai-pop__foot">Only part of the selection fitted in one request.</p>
      )}
      <div className="dr-ai-panel__actions">
        <span className="dr-ai-pop__foot">Written by AI: check before you rely on it.</span>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          onClick={() => {
            void navigator.clipboard?.writeText(panel.summary).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </section>
  )
}

export function AiOverlay({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  useLayoutEffect(() => {
    setAiCtx(editor, ctx)
  })
  // What AI may do here: asked once per board and role (the api decides; hidden until it says yes).
  const boardId = ctx.board.id
  const role = ctx.role
  const status = ctx.board.status
  useEffect(() => {
    const abort = new AbortController()
    void refreshAiStatus(editor, abort.signal)
    return () => abort.abort()
  }, [editor, boardId, role, status])
  const menu = useValue('dr-ai-menu', () => aiMenu(editor).get(), [editor])
  const enabled = useValue('dr-ai-on', () => aiStatus(editor).get()?.enabled === true, [editor])
  if (!enabled) return null
  return (
    <div className="dr-ai-overlay" data-testid="ai-overlay">
      {menu && <AiPopover key={`${menu.view}`} menu={menu} />}
      <Busy />
      <SummaryPanel />
    </div>
  )
}
