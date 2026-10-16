// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §6.5). The card popover, in the cards `screen` layer: the card's title
// (its label: read here, edited on the canvas under the text lease), its status, assignee, start and due dates, tags
// (the tags feature's own picker) and link, and Unmake card. Opened from a card's chips, the selection bar, the context
// menu, the card table and the timeline (`openCardPopover`, features/planning). Each change is one undo step. Keys and
// pointers inside it never reach the canvas (native listeners: ../tags/isolate.ts). Escape and a press outside close it.
//
// Who may do what is the room's to decide; the popover only offers it: a read-only role sees the fields, a locked card
// takes no write, a name-only guest may set the status and dates but is never offered the assignee picker (clearing
// an assignee stays allowed).
import { isAllowedLink } from '@draftroom/canvas-schema/limits'
import { cardOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import { type CSSProperties, useEffect, useId, useLayoutEffect, useState } from 'react'
import type { CanvasElement, CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { trapTab, tryFocus } from '../../ui/focus.ts'
import type { CardPopoverRequest } from '../planning/index.ts'
import { useIsolated } from '../tags/isolate.ts'
import { tagsOf } from '../tags/ported/bridge.ts'
import { displayTags } from '../tags/ported/model.ts'
import { type CardsState, cardsOf } from './bridge.ts'
import { CalendarIcon, LinkIcon, PersonIcon, StatusIcon } from './icons.tsx'
import {
  CARD_STATUSES,
  type CardFields,
  dueWords,
  initialsOf,
  PLANNING_DATE_MAX,
  PLANNING_DATE_MIN,
  statusWords,
  todayLocal,
} from './model.ts'
import { isGuest, type Person, personView } from './people.ts'
import { cardWritable, setDate, setLink, setStatus, setWho, unmakeCards } from './write.ts'
import './cards.css'

const POPOVER_W = 340

export function CardPopoverLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const s = useValue('cards.bridge', () => cardsOf(ctx.canvas), [ctx.canvas])
  return s ? <PopoverHost s={s} /> : null
}

function PopoverHost({ s }: { s: CardsState }) {
  const req = useValue('cards.popover', () => s.popover.get(), [s])
  const card = useValue('cards.popover-card', () => {
    if (!req) return null
    const el = s.ctx.canvas.get(req.id)
    if (!el || (el as { isDeleted?: boolean }).isDeleted) return null
    const fields = cardOf(el as PlanningElement)
    return fields ? { el, fields } : null
  }, [s, req])
  // the card went away (deleted, unmade here or by someone else): the popover closes
  useEffect(() => {
    if (req && !card) s.popover.set(null)
  }, [s, req, card])
  if (!req || !card) return null
  return <Popover key={req.id} s={s} req={req} el={card.el} card={card.fields} />
}

/** Where the popover goes in the overlay root: under the anchor (or the card), kept inside the canvas. */
function usePlacement(s: CardsState, req: CardPopoverRequest) {
  const canvas = s.ctx.canvas
  return useValue('cards.popover-at', () => {
    canvas.viewport.get() // the camera: it follows the card
    const screen = canvas.viewport.screenRect()
    if (req.anchor)
      return { x: req.anchor.x - screen.x, y: req.anchor.y + req.anchor.h - screen.y + 6, screen }
    const b = canvas.bounds(req.id)
    if (!b) return { x: 16, y: 64, screen }
    const p = canvas.sceneToOverlay({ x: b.x, y: b.y + b.height })
    return { x: p.x, y: p.y + 8, screen }
  }, [canvas, req])
}

function Popover({
  s,
  req,
  el,
  card,
}: {
  s: CardsState
  req: CardPopoverRequest
  el: CanvasElement
  card: CardFields
}) {
  const ctx = s.ctx
  const canvas = ctx.canvas
  const uid = useId()
  const close = () => s.popover.set(null)
  const ref = useIsolated<HTMLDivElement>((e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      canvas.focus({ preventScroll: true })
    } else if (e.key === 'Tab' && ref.current) trapTab(e, ref.current)
  })
  const writable = useValue('cards.popover-writable', () => cardWritable(canvas, el.id), [canvas, el.id])
  const title = useValue('cards.popover-title', () => canvas.text.of(el.id).trim(), [canvas, el.id])
  const at = usePlacement(s, req)
  const [problem, setProblem] = useState<string | null>(null)
  const today = todayLocal()

  // the focus moves into it when it opens (the requested field first)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const want = req.focus ? node.querySelector<HTMLElement>(`[data-card-field="${req.focus}"]`) : null
    tryFocus(want ?? node.querySelector<HTMLElement>('[aria-pressed="true"], button, input'))
  }, [ref, req.focus])

  // a press outside closes it (the chips toggle it themselves)
  useEffect(() => {
    const node = ref.current
    const doc = node?.ownerDocument
    if (!doc) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (node?.contains(t)) return
      if (t?.closest?.('[data-card-keep-popover], [data-dr-tag-picker]')) return
      s.popover.set(null)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [ref, s])

  const result = (r: { ok: true } | { ok: false; problem: string }) => setProblem(r.ok ? null : r.problem)
  const left = Math.max(8, Math.min(at.x, at.screen.width - POPOVER_W - 8))
  const top = Math.max(8, Math.min(at.y, at.screen.height - 120))
  const due = dueWords(card, today)

  return (
    <div
      ref={ref}
      className="dr-card-popover"
      role="dialog"
      aria-labelledby={`${uid}-title`}
      data-testid="card-popover"
      data-element-id={el.id}
      data-readonly={writable ? undefined : 'true'}
      style={{ left, top, maxHeight: Math.max(240, at.screen.height - top - 12) } as CSSProperties}
    >
      <header className="dr-card-popover__head">
        <span className="dr-card-popover__kicker">Card</span>
        <h3 id={`${uid}-title`} className="dr-card-popover__title" data-testid="card-popover-title">
          {title || <span className="dr-card-muted">Untitled card</span>}
        </h3>
        <button type="button" className="dr-card-iconbtn" aria-label="Close" onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <fieldset className="dr-card-field" disabled={!writable}>
        <legend className="dr-card-field__label">Status</legend>
        <div className="dr-card-statuses">
          {CARD_STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              className="dr-card-statusbtn"
              data-status={st}
              data-card-field={st === card.status ? 'status' : undefined}
              data-testid={`card-status-${st}`}
              aria-pressed={card.status === st}
              onClick={() => {
                setStatus(canvas, [el.id], st)
                setProblem(null)
              }}
            >
              <StatusIcon status={st} size={14} />
              {statusWords(st)}
            </button>
          ))}
        </div>
      </fieldset>

      <WhoField s={s} el={el} card={card} writable={writable} onResult={result} />

      <div className="dr-card-dates">
        <DateField
          label="Start"
          field="start"
          value={card.start}
          max={card.due ?? PLANNING_DATE_MAX}
          disabled={!writable}
          onChange={(v) => result(setDate(canvas, el.id, 'start', v))}
        />
        <DateField
          label="Due"
          field="due"
          value={card.due}
          min={card.start ?? PLANNING_DATE_MIN}
          disabled={!writable}
          onChange={(v) => result(setDate(canvas, el.id, 'due', v))}
          hint={due ? <span data-overdue={due.overdue || undefined}>{due.text}</span> : null}
        />
      </div>

      <TagsField s={s} el={el} />
      <LinkField s={s} el={el} writable={writable} onResult={result} />

      {problem && (
        <p className="dr-card-problem" role="alert" data-testid="card-problem">
          {problem}
        </p>
      )}

      {writable && (
        <footer className="dr-card-popover__foot">
          <button
            type="button"
            className="dr-card-linkbtn"
            data-testid="card-edit-title"
            disabled={!canvas.text.canEdit(el.id)}
            onClick={() => {
              close()
              canvas.select([el.id])
              canvas.viewport.ensureVisible([el.id], { margin: 80 })
              void canvas.text.edit(el.id, { via: 'api', caret: 'end' })
            }}
          >
            Edit title
          </button>
          <button
            type="button"
            className="dr-card-linkbtn dr-card-linkbtn--danger"
            data-testid="card-unmake"
            onClick={() => {
              unmakeCards(canvas, [el.id])
              close()
            }}
          >
            Unmake card
          </button>
        </footer>
      )}
    </div>
  )
}

function DateField({
  label,
  field,
  value,
  min,
  max,
  disabled,
  onChange,
  hint,
}: {
  label: string
  field: 'start' | 'due'
  value: string | null
  min?: string
  max?: string
  disabled: boolean
  onChange(v: string | null): void
  hint?: React.ReactNode
}) {
  const id = useId()
  return (
    <div className="dr-card-field">
      <label className="dr-card-field__label" htmlFor={id}>
        <CalendarIcon size={13} /> {label}
      </label>
      <div className="dr-card-date">
        <input
          id={id}
          type="date"
          className="dr-card-input"
          data-card-field={field}
          data-testid={`card-${field}`}
          value={value ?? ''}
          min={min ?? PLANNING_DATE_MIN}
          max={max ?? PLANNING_DATE_MAX}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
        />
        {value && !disabled && (
          <button
            type="button"
            className="dr-card-iconbtn dr-card-iconbtn--sm"
            aria-label={`Clear the ${label.toLowerCase()} date`}
            data-testid={`card-${field}-clear`}
            onClick={() => onChange(null)}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      {hint && <span className="dr-card-hint">{hint}</span>}
    </div>
  )
}

/** The assignee: a member picker (accounts with a role on the board); guests are not offered it. */
function WhoField({
  s,
  el,
  card,
  writable,
  onResult,
}: {
  s: CardsState
  el: CanvasElement
  card: CardFields
  writable: boolean
  onResult(r: { ok: true } | { ok: false; problem: string }): void
}) {
  const ctx = s.ctx
  const guest = useValue('cards.guest', () => isGuest(ctx), [ctx])
  const people = useValue('cards.people', () => s.people.list.get(), [s])
  const state = useValue('cards.people-state', () => s.people.state.get(), [s])
  const who = useValue('cards.who', () => (card.who ? personView(ctx, s.people, card.who) : null), [
    ctx,
    s,
    card.who,
  ])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listId = useId()
  const mayAssign = writable && !guest
  useEffect(() => {
    if (open) void s.people.refresh()
  }, [open, s])
  const q = query.trim().toLowerCase()
  const shown = q
    ? people.filter((p) => p.name.toLowerCase().includes(q) || (p.handle ?? '').toLowerCase().includes(q))
    : people
  const pick = (p: Person | null) => {
    onResult(setWho(ctx.canvas, el.id, p?.uid ?? null))
    setOpen(false)
    setQuery('')
  }
  return (
    <div className="dr-card-field" data-testid="card-who-field">
      <span className="dr-card-field__label">
        <PersonIcon size={13} /> Assignee
      </span>
      <div className="dr-card-who">
        {who ? (
          <span className="dr-card-person" data-testid="card-who" data-uid={card.who ?? undefined}>
            <span
              className="dr-card-avatar dr-card-avatar--lg"
              style={who.color ? ({ '--dr-card-avatar': who.color } as CSSProperties) : undefined}
              aria-hidden="true"
            >
              {initialsOf(who.name)}
            </span>
            <span>
              {who.name}
              {who.gone && <span className="dr-card-muted"> · No longer on this board</span>}
            </span>
          </span>
        ) : (
          <span className="dr-card-muted" data-testid="card-who">
            Unassigned
          </span>
        )}
        {mayAssign && (
          <button
            type="button"
            className="dr-card-btn"
            data-card-field="who"
            data-testid="card-assign"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            {who ? 'Change' : 'Assign'}
          </button>
        )}
        {writable && who && (
          <button
            type="button"
            className="dr-card-btn"
            data-testid="card-unassign"
            onClick={() => pick(null)}
          >
            Unassign
          </button>
        )}
      </div>
      {writable && guest && (
        <span className="dr-card-hint" data-testid="card-guest-hint">
          Guests can't assign people.
        </span>
      )}
      {open && mayAssign && (
        <div className="dr-card-picker" id={listId}>
          <input
            type="search"
            className="dr-card-input"
            placeholder="Find a person"
            aria-label="Find a person"
            data-testid="card-assign-search"
            value={query}
            // biome-ignore lint/a11y/noAutofocus: the picker opens on purpose, for typing
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]) {
                e.preventDefault()
                pick(shown[0])
              }
            }}
          />
          <ul className="dr-card-people" aria-label="People on this board">
            {shown.map((p) => (
              <li key={p.uid}>
                <button
                  type="button"
                  className="dr-card-personbtn"
                  data-testid="card-assign-option"
                  data-uid={p.uid}
                  aria-pressed={card.who === p.uid}
                  onClick={() => pick(p)}
                >
                  <span
                    className="dr-card-avatar"
                    style={{ '--dr-card-avatar': p.color } as CSSProperties}
                    aria-hidden="true"
                  >
                    {initialsOf(p.name)}
                  </span>
                  {p.name}
                  {p.uid === ctx.me.user.id && <span className="dr-card-muted"> (you)</span>}
                </button>
              </li>
            ))}
          </ul>
          {state === 'loading' && !people.length && <p className="dr-card-muted">Loading people…</p>}
          {state === 'failed' && <p className="dr-card-muted">Couldn't load the people on this board.</p>}
          {state === 'ready' && !shown.length && <p className="dr-card-muted">Nobody matches.</p>}
        </div>
      )}
    </div>
  )
}

function TagsField({ s, el }: { s: CardsState; el: CanvasElement }) {
  const canvas = s.ctx.canvas
  const tags = useValue('cards.tags', () => {
    const t = tagsOf(canvas)
    return t ? displayTags(canvas.get(el.id), t.rt.board.get()) : []
  }, [canvas, el.id])
  const t = useValue('cards.tags-bridge', () => tagsOf(canvas), [canvas])
  if (!t) return null
  return (
    <div className="dr-card-field">
      <span className="dr-card-field__label">Tags</span>
      <div className="dr-card-tags">
        {tags.length ? (
          tags.map((tag) => (
            <span key={tag.key} className="dr-tag-pill" data-dr-tag-color={tag.color} data-testid="card-tag">
              {tag.name}
            </span>
          ))
        ) : (
          <span className="dr-card-muted">No tags</span>
        )}
        {!canvas.readOnly() && (
          <button
            type="button"
            className="dr-card-btn"
            data-testid="card-edit-tags"
            onClick={() => {
              s.popover.set(null)
              canvas.select([el.id])
              // after this click has closed the popover: the picker opens for the card alone
              setTimeout(() => tagsOf(canvas)?.rt.openPicker(), 0)
            }}
          >
            Edit tags
          </button>
        )}
      </div>
    </div>
  )
}

function LinkField({
  s,
  el,
  writable,
  onResult,
}: {
  s: CardsState
  el: CanvasElement
  writable: boolean
  onResult(r: { ok: true } | { ok: false; problem: string }): void
}) {
  const canvas = s.ctx.canvas
  const stored = useValue(
    'cards.link',
    () => ((canvas.get(el.id) as { link?: string | null } | undefined)?.link ?? '') as string,
    [canvas, el.id],
  )
  const [draft, setDraft] = useState(stored)
  useEffect(() => setDraft(stored), [stored])
  const id = useId()
  const guest = isGuest(s.ctx)
  const save = () => {
    if (draft.trim() === stored) return
    onResult(setLink(canvas, el.id, draft, (l) => isAllowedLink(l, { guest })))
  }
  const web = /^https?:\/\//i.test(stored)
  return (
    <div className="dr-card-field">
      <label className="dr-card-field__label" htmlFor={id}>
        <LinkIcon size={13} /> Link
      </label>
      <div className="dr-card-date">
        <input
          id={id}
          type="url"
          className="dr-card-input"
          data-card-field="link"
          data-testid="card-link"
          placeholder={writable ? 'https://…' : 'No link'}
          value={draft}
          disabled={!writable}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
          }}
        />
        {stored && (web || stored.startsWith('/')) && (
          <a
            className="dr-card-btn"
            href={stored}
            target={web ? '_blank' : undefined}
            rel="noopener noreferrer"
            data-testid="card-link-open"
          >
            Open
          </a>
        )}
      </div>
    </div>
  )
}
