// OWNER: W3 (wave L, L3-2). The command palette's dialog, shared by the board (./index.tsx) and the dashboard
// (./dashboard.tsx): a modal <dialog> holding an ARIA combobox (the field) and its listbox (the lines, in
// groups). No canvas here, so the dashboard's lazy palette chunk stays small.
//
// Keys (they never reach the board: the field is outside the canvas, and each keydown stops here):
//   ↑ / ↓, Page Up / Page Down   move through the lines (every group)
//   Enter                         runs the line; a line that cannot run says why, and the palette stays
//   Escape, Ctrl/Cmd+K            close it (the focus goes back to where it was: the board)
// A click on a line runs it; a click outside the dialog closes it.
//
// The searches (the board's own search, the workspace's) go out only for two or more characters, after a
// 150 ms pause in typing; a newer query aborts the older one. The static lines are ranked at once.
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { isPaletteKey, paletteKeyOf } from './keys.ts'
import {
  chooseEntry,
  PALETTE_MAX_RESULTS,
  PALETTE_SEARCH_DEBOUNCE_MS,
  PALETTE_SEARCH_MIN_CHARS,
  type PaletteEntry,
  type PaletteSearch,
  runnable,
} from './model.ts'
import { fold, rank } from './scorer.ts'
import './palette.css'

export interface PaletteProps {
  /** the dialog's accessible name ('Command palette') */
  readonly label: string
  readonly placeholder: string
  /** the lines built when it opened */
  readonly entries: readonly PaletteEntry[]
  /** lines that depend on what is typed (the parsed "Do" line, "Ask: …"), ranked with the rest */
  readonly queryEntries?: (query: string) => readonly PaletteEntry[]
  readonly searches?: readonly PaletteSearch[]
  /** recent picks (PaletteEntry.recentKey), most recent first */
  readonly recents: readonly string[]
  readonly initialQuery?: string
  /**
   * M3-3: a "Try it" from the What's new card opened the palette on this line (its id) with a sentence on what it is:
   * the line is marked "Try this" and scrolled into view. Nothing is chosen for the person.
   */
  readonly coach?: { readonly entryId: string; readonly text: string }
  /** a runnable line was chosen: close the palette, then run it */
  readonly onChoose: (entry: PaletteEntry) => void
  readonly onClose: () => void
}

interface Section {
  readonly id: string
  readonly title: string
  readonly entries: readonly PaletteEntry[]
  /** 'loading' or 'error' rows for a search still on its way, or one that failed */
  readonly state?: 'loading' | 'error' | 'ready'
}

type SearchState = { readonly query: string; readonly state: 'loading' | 'error' | 'ready' } & {
  readonly entries: readonly PaletteEntry[]
}

/** The empty palette's sections (M3-2). */
export const TRY_SECTION = 'try'
export const UNAVAILABLE_SECTION = 'unavailable'

/**
 * The sections for `query`: the ranked index (or, with nothing typed, Recent, Try and every group), then the searches.
 *
 * With nothing typed (M3-2, FTU-4): Recent (this person's own picks that can run), then Try (the lines the index marks
 * as starters: what wave L offers, in its order, the ones that can run first, the rest with their reasons), then the
 * groups with the lines that can run, and last "Not available right now" with every other line that cannot run (it used
 * to open on Undo, Redo and a screenful of "Select something first"). A palette whose lines mark no starters has no Try.
 */
export function paletteSections(
  entries: readonly PaletteEntry[],
  query: string,
  recents: readonly string[],
  extra: readonly PaletteEntry[] = [],
): Section[] {
  const q = query.trim()
  if (!q) {
    const byKey = new Map(entries.filter((e) => e.recentKey).map((e) => [e.recentKey as string, e]))
    const picks = recents.map((k) => byKey.get(k)).filter((e): e is PaletteEntry => !!e)
    const recent = picks.filter(runnable)
    const recentIds = new Set(recent.map((e) => e.id))
    const starters = entries
      .filter((e): e is PaletteEntry & { starter: NonNullable<PaletteEntry['starter']> } => !!e.starter)
      .filter((e) => !recentIds.has(e.id))
      .sort((a, b) => a.starter.rank - b.starter.rank)
    const starting = [...starters.filter(runnable), ...starters.filter((e) => !runnable(e))].map((e) => ({
      ...e,
      label: e.starter.label ?? e.label,
      ...(e.starter.detail ? { detail: e.starter.detail } : {}),
    }))
    const shown = new Set([...recentIds, ...starters.map((e) => e.id)])
    const groups = new Map<string, PaletteEntry[]>()
    const unavailable: PaletteEntry[] = picks.filter((e) => !runnable(e))
    for (const e of entries) {
      if (shown.has(e.id)) continue
      if (!runnable(e)) {
        if (!unavailable.some((u) => u.id === e.id)) unavailable.push(e)
        continue
      }
      groups.set(e.group, [...(groups.get(e.group) ?? []), e])
    }
    const out: Section[] = []
    if (recent.length) out.push({ id: 'recent', title: 'Recent', entries: recent })
    if (starting.length) out.push({ id: TRY_SECTION, title: 'Try', entries: starting })
    for (const [title, list] of groups) out.push({ id: `group:${title}`, title, entries: list })
    if (unavailable.length)
      out.push({ id: UNAVAILABLE_SECTION, title: 'Not available right now', entries: unavailable })
    return out
  }
  const ranked = rank([...extra, ...entries], q, recents).slice(0, PALETTE_MAX_RESULTS)
  return [{ id: 'matches', title: 'Best matches', entries: ranked }]
}

/**
 * The line the palette starts on: the first of the ranked matches or of Recent, but none (-1) when nothing is
 * typed and there are no recents, so a reflex Ctrl/Cmd+K, Enter runs nothing (it used to run the first registered
 * command, Undo; wave L integration, the W3 review). The Try section does not start on a line either (M3-2): it
 * shows what could be done, it is not what the person last did. An arrow key or the pointer then picks a line.
 */
export function firstActiveLine(sections: readonly Pick<Section, 'id'>[]): number {
  const first = sections[0]
  return first && (first.id === 'recent' || first.id === 'matches') ? 0 : -1
}

export function Palette(props: PaletteProps) {
  const { entries, queryEntries, searches, recents, onChoose, onClose } = props
  const [query, setQuery] = useState(props.initialQuery ?? '')
  const [active, setActive] = useState(0)
  const [status, setStatus] = useState('')
  const [found, setFound] = useState<Readonly<Record<string, SearchState>>>({})
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  const base = useId()
  const listId = `${base}-list`
  const titleId = `${base}-title`

  // open as a modal dialog: the page behind is inert, Tab stays in the field, Escape is `cancel`
  useEffect(() => {
    const d = dialogRef.current
    if (d && !d.open) d.showModal()
    inputRef.current?.focus()
    return () => {
      if (d?.open) d.close()
    }
  }, [])

  const close = () => {
    if (closing.current) return
    closing.current = true
    if (dialogRef.current?.open) dialogRef.current.close()
    onClose()
  }

  // the searches: two or more characters, after a pause; a newer query aborts the older
  const q = query.trim()
  useEffect(() => {
    if (!searches?.length || fold(q).replace(/ /g, '').length < PALETTE_SEARCH_MIN_CHARS) {
      setFound({})
      return
    }
    const controllers = searches.map(() => new AbortController())
    const timer = setTimeout(() => {
      searches.forEach((s, i) => {
        const signal = (controllers[i] as AbortController).signal
        setFound((f) => ({ ...f, [s.id]: { query: q, state: 'loading', entries: f[s.id]?.entries ?? [] } }))
        s.find(q, signal).then(
          (list) => {
            if (!signal.aborted)
              setFound((f) => ({
                ...f,
                [s.id]: { query: q, state: 'ready', entries: list.slice(0, s.limit) },
              }))
          },
          () => {
            if (!signal.aborted)
              setFound((f) => ({ ...f, [s.id]: { query: q, state: 'error', entries: [] } }))
          },
        )
      })
    }, PALETTE_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      for (const c of controllers) c.abort()
    }
  }, [q, searches])

  const extra = useMemo(() => queryEntries?.(q) ?? [], [queryEntries, q])
  const sections = useMemo(() => {
    const out = paletteSections(entries, q, recents, extra)
    for (const s of searches ?? []) {
      const f = found[s.id]
      if (!f || f.query !== q) continue
      if (f.state === 'ready' && !f.entries.length) continue
      out.push({ id: `search:${s.id}`, title: s.title, entries: f.entries, state: f.state })
    }
    return out
  }, [entries, q, recents, extra, searches, found])
  const flat = useMemo(() => sections.flatMap((s) => s.entries), [sections])

  // a new query starts at the top; a search that arrives later keeps the line the person is on
  const [moved, setMoved] = useState(false)
  useEffect(() => {
    setActive(0)
    setMoved(false)
    setStatus('')
  }, [q])
  // nothing typed and no recents: no line until an arrow key or the pointer picks one (firstActiveLine)
  const resting = !moved && firstActiveLine(sections) < 0
  const activeIndex = flat.length && !resting ? Math.min(active, flat.length - 1) : -1
  const activeEntry = activeIndex >= 0 ? flat[activeIndex] : undefined
  const optionId = (i: number) => `${base}-opt-${i}`

  // a coached line is brought into view (the list may start with Recent, ahead of Try)
  useEffect(() => {
    if (!props.coach) return
    listRef.current?.querySelector('[data-coach="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [props.coach])

  useEffect(() => {
    if (activeIndex < 0) return
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(activeIndex))}`)
      ?.scrollIntoView({ block: 'nearest' })
  })

  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry) return
    const chosen = chooseEntry(entry)
    if (!chosen.run) {
      setStatus(chosen.status)
      return
    }
    if (closing.current) return
    closing.current = true
    if (dialogRef.current?.open) dialogRef.current.close()
    onChoose(entry)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // the board, the engine and the browser never see a key typed here
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    // Ctrl/Cmd+K again closes it (as the board and the dashboard read the key)
    if (isPaletteKey(paletteKeyOf(e.nativeEvent))) {
      e.preventDefault()
      close()
      return
    }
    const step = (d: number) => {
      e.preventDefault()
      if (!flat.length) return
      if (resting) {
        setMoved(true)
        setActive(0)
        return
      }
      setActive((i) => Math.max(0, Math.min(flat.length - 1, Math.min(i, flat.length - 1) + d)))
    }
    switch (e.key) {
      case 'ArrowDown':
        return step(1)
      case 'ArrowUp':
        return step(-1)
      case 'PageDown':
        return step(8)
      case 'PageUp':
        return step(-8)
      case 'Enter':
        e.preventDefault()
        return choose(activeEntry)
      case 'Tab':
        // one field: Tab would only leave it for the page behind (inert while the palette is open)
        e.preventDefault()
        return
    }
  }

  let index = -1
  return (
    <dialog
      ref={dialogRef}
      className="dr-dialog dr-palette"
      data-testid="command-palette"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onMouseDown={(e) => {
        // a press on the backdrop (the dialog element itself, outside its box) closes it
        const d = dialogRef.current
        if (!d || e.target !== d) return
        const r = d.getBoundingClientRect()
        const inside =
          e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
        if (!inside) close()
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <h2 id={titleId} className="dr-sr-only">
        {props.label}
      </h2>
      <div className="dr-palette__field">
        <input
          ref={inputRef}
          className="dr-palette__input"
          data-testid="command-palette-input"
          type="text"
          role="combobox"
          aria-label={props.label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          placeholder={props.placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {props.coach && (
        <p className="dr-palette__coach" role="note" data-testid="command-palette-coach">
          {props.coach.text}
        </p>
      )}
      <div
        ref={listRef}
        id={listId}
        className="dr-palette__list"
        role="listbox"
        aria-label={`${props.label} results`}
        data-testid="command-palette-list"
      >
        {sections.map((s) => (
          // biome-ignore lint/a11y/useSemanticElements: an ARIA group of options inside a listbox (a fieldset is no listbox child)
          <div
            key={s.id}
            className="dr-palette__group"
            role="group"
            aria-labelledby={`${base}-${s.id}`}
            data-testid="command-palette-group"
            data-group-id={s.id}
            data-state={s.state ?? 'ready'}
          >
            <div id={`${base}-${s.id}`} className="dr-palette__heading" role="presentation">
              {s.title}
              {s.state === 'loading' && <span className="dr-palette__note"> · searching…</span>}
              {s.state === 'error' && <span className="dr-palette__note"> · could not search right now</span>}
            </div>
            {s.entries.map((entry) => {
              index++
              const i = index
              const disabled = !runnable(entry)
              return (
                // the field keeps the keyboard (aria-activedescendant); its keys move and run (ArrowUp/ArrowDown/Enter)
                // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are the combobox field's, not the option's
                <div
                  key={entry.id}
                  id={optionId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === activeIndex}
                  aria-disabled={disabled || undefined}
                  className="dr-palette__option"
                  data-testid="command-palette-option"
                  data-entry-id={entry.id}
                  data-group={entry.group}
                  data-active={i === activeIndex ? 'true' : undefined}
                  data-coach={props.coach?.entryId === entry.id ? 'true' : undefined}
                  onMouseMove={() => {
                    if (i !== activeIndex) {
                      setMoved(true)
                      setActive(i)
                    }
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(entry)}
                >
                  <span className="dr-palette__main">
                    <span className="dr-palette__label">
                      {entry.label}
                      {props.coach?.entryId === entry.id && (
                        <span className="dr-palette__coachtag">Try this</span>
                      )}
                    </span>
                    {entry.detail && <span className="dr-palette__detail">{entry.detail}</span>}
                    {disabled && (
                      <span className="dr-palette__reason" data-testid="command-palette-reason">
                        {entry.disabledReason}
                      </span>
                    )}
                  </span>
                  {(s.id === 'matches' || s.id === UNAVAILABLE_SECTION) && (
                    <span className="dr-palette__tag">{entry.group}</span>
                  )}
                  {entry.kbd && <kbd className="dr-palette__kbd">{entry.kbd}</kbd>}
                </div>
              )
            })}
          </div>
        ))}
        {q && flat.length === 0 && (
          <p className="dr-palette__empty" data-testid="command-palette-empty">
            Nothing matches “{q}”.
          </p>
        )}
      </div>
      <p className="dr-palette__status" role="status" data-testid="command-palette-status">
        {status}
      </p>
      <p className="dr-palette__hint" aria-hidden="true">
        ↑↓ move · Enter runs · Esc closes
      </p>
    </dialog>
  )
}
