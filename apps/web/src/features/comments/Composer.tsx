// Comment composer: plain-text textarea with @mention autocomplete. Enter posts, Shift+Enter adds a
// line, Esc closes suggestions and then the composer. The text is kept as a draft per thread
// (or 'new' for a new comment) until it is posted, even when the composer is closed.

import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useValue } from 'tldraw'
import {
  activeMentionQuery,
  applyMention,
  type Draft,
  type Mentionable,
  type MentionQuery,
  matchMentionables,
} from './mentions.ts'
import type { CommentsStore } from './store.ts'

export interface ComposerProps {
  store: CommentsStore
  /** Persisted draft key (thread id or 'new'); omit for an edit, which keeps its own state. */
  draftKey?: string
  initial?: Draft
  label: string
  placeholder: string
  submitLabel: string
  onSubmit(draft: Draft): Promise<boolean>
  onCancel(): void
  autoFocus?: boolean
  compact?: boolean
}

export function Composer({
  store,
  draftKey,
  initial,
  label,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
  compact,
}: ComposerProps) {
  const [draft, setDraftState] = useState<Draft>(
    () => initial ?? (draftKey ? store.draft(draftKey) : { text: '', mentions: [] }),
  )
  const [query, setQuery] = useState<MentionQuery | null>(null)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const hintId = useId()
  const people = useValue('dr-comments.mentionables', () => store.mentionables.get(), [store])
  /** Caret to restore right after the next render (a picked mention changes the text under it). */
  const caretAfterRender = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = caretAfterRender.current
    const el = ref.current
    if (at === null || !el) return
    caretAfterRender.current = null
    el.focus()
    el.setSelectionRange(at, at)
  })

  useEffect(() => {
    if (!autoFocus) return
    const el = ref.current
    if (!el) return
    // After the click that opened us has finished (tldraw refocuses its container on pointerup).
    const id = requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [autoFocus])

  const suggestions = useMemo<Mentionable[]>(
    () => (query && people ? matchMentionables(people, query.query, { meId: store.meId }) : []),
    [query, people, store.meId],
  )
  const showList = query !== null && (suggestions.length > 0 || (people !== null && query.query.length > 0))
  // F4: nobody matches. Ask the server once more (throttled in the store) before trusting "Nobody with
  // access matches": someone may have just been given access. A new answer updates the list above.
  const miss = query !== null && query.query.length > 0 && people !== null && suggestions.length === 0
  useEffect(() => {
    if (miss) store.refetchMentionablesOnMiss()
  }, [miss, store])

  const update = (next: Draft, caret: number) => {
    setDraftState(next)
    if (draftKey) store.setDraft(draftKey, next)
    const q = activeMentionQuery(next.text, caret, next.mentions)
    setQuery(q)
    setActive(0)
    if (q) void store.ensureMentionables()
  }

  const pick = (person: Mentionable) => {
    if (!query) return
    const caret = ref.current?.selectionStart ?? draft.text.length
    const { draft: next, caret: at } = applyMention(draft, query, caret, person)
    setDraftState(next)
    if (draftKey) store.setDraft(draftKey, next)
    setQuery(null)
    caretAfterRender.current = at
  }

  const submit = async () => {
    if (busy || !draft.text.trim()) return
    setBusy(true)
    const ok = await onSubmit(draft)
    setBusy(false)
    if (ok) {
      setDraftState({ text: '', mentions: [] })
      setQuery(null)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (showList && suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + d + suggestions.length) % suggestions.length)
        return
      }
      // Shift+Enter always adds a line; Enter/Tab pick the highlighted person.
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const person = suggestions[active]
        if (person) {
          e.preventDefault()
          pick(person)
          return
        }
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) setQuery(null)
      else onCancel()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void submit()
    }
  }

  const activeId = showList && suggestions[active] ? `${listId}-${suggestions[active]?.userId}` : undefined

  return (
    <div className={`dr-ccomposer${compact ? ' dr-ccomposer--compact' : ''}`}>
      <div className="dr-ccomposer__field">
        <textarea
          ref={ref}
          className="dr-ccomposer__input"
          data-testid="comment-composer"
          aria-label={label}
          aria-describedby={hintId}
          aria-autocomplete="list"
          aria-controls={showList && suggestions.length > 0 ? listId : undefined}
          aria-expanded={showList && suggestions.length > 0}
          aria-activedescendant={activeId}
          role="combobox"
          placeholder={placeholder}
          value={draft.text}
          rows={compact ? 1 : 2}
          maxLength={5000}
          readOnly={busy}
          onChange={(e) =>
            update({ ...draft, text: e.target.value }, e.target.selectionStart ?? e.target.value.length)
          }
          onSelect={(e) => {
            const el = e.currentTarget
            setQuery(activeMentionQuery(el.value, el.selectionStart ?? el.value.length, draft.mentions))
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setQuery(null), 150)}
        />
        {showList && suggestions.length > 0 && (
          <div className="dr-cmention-list" id={listId} role="listbox" aria-label="People to mention">
            {suggestions.map((p, i) => (
              <div
                key={p.userId}
                id={`${listId}-${p.userId}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className="dr-cmention-list__option"
                data-testid="mention-option"
                data-user-id={p.userId}
                onPointerDown={(e) => {
                  e.preventDefault() // keep focus in the textarea
                  pick(p)
                }}
                onPointerEnter={() => setActive(i)}
              >
                <span className="dr-cmention-list__name">{p.name}</span>
                {p.userId === store.meId && <span className="dr-cmention-list__meta">you</span>}
                {p.handle && p.userId !== store.meId && (
                  <span className="dr-cmention-list__meta">@{p.handle}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {showList && suggestions.length === 0 && (
          <div
            className="dr-cmention-list dr-cmention-list__empty"
            role="status"
            data-testid="mention-no-match"
          >
            Nobody with access matches “{query?.query}”. People need access to this board before you can
            mention them.{' '}
            <button
              type="button"
              className="dr-linkbtn"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => window.dispatchEvent(new CustomEvent('draftroom:open-share'))}
            >
              Invite with Share
            </button>
          </div>
        )}
      </div>
      <div className="dr-ccomposer__bar">
        <span id={hintId} className="dr-ccomposer__hint">
          Enter to post · Shift+Enter for a new line · @ to mention
        </span>
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-btn--sm"
          data-testid="comment-submit"
          disabled={busy || !draft.text.trim()}
          onClick={() => void submit()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
