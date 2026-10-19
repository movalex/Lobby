// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2). The doc card's side panel: a textarea of the card's
// Markdown-lite words, a toolbar that inserts marks (./format.ts), a Preview of the formatted words, and a counter.
//
// It is a lease client (canvas/lease/panelEditor.ts) and the textarea is guarded like Excalidraw's editor (AGENTS.md):
// it is read-only (the attribute) unless the lease client says it is writable, and every way text could arrive
// without the attribute stopping it (beforeinput, paste, drop, cut, a format key, a toolbar press, a value the
// browser put in anyway) asks the client first and is refused or reverted otherwise. "Name is editing" and a
// read-only panel for everyone else; the unsaved words offered when the lease is lost.
//
// Keyboard: the format keys inside the textarea (Ctrl/Cmd+B, I, E, K; Ctrl/Cmd+Alt+1 to 3; Ctrl/Cmd+Shift+7, 8, 9),
// Enter continues a list, the toolbar is one tab stop with the arrow keys inside it, Escape closes the panel (the
// dock's), and the focus goes back to the card on the board. Screen readers: the textarea, the toolbar and the tabs
// are named, the status is a polite live region, the Preview is real headings and lists.
import { type KeyboardEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import type { PanelEditorState } from '../../canvas/lease/panelEditor.ts'
import { useValue } from '../../lib/signals.ts'
import { DocBlocks } from './DocBlocks.tsx'
import { applyFormat, continueList, type FormatAction, formatKey } from './format.ts'
import { docTitle, toggleCheck } from './markdown-lite.ts'
import { DOC_MAX_CHARS, DOC_SEARCH_CHARS, NEW_DOC_TITLE_RANGE, NEW_DOC_WORDS } from './model.ts'
import { closeDocPanel, docPanelOf, docState, parsedWords } from './state.ts'

const TOOLS: readonly { action: FormatAction; label: string; short: string; keys: string }[] = [
  { action: 'h1', label: 'Heading 1', short: 'H1', keys: 'Mod+Alt+1' },
  { action: 'h2', label: 'Heading 2', short: 'H2', keys: 'Mod+Alt+2' },
  { action: 'h3', label: 'Heading 3', short: 'H3', keys: 'Mod+Alt+3' },
  { action: 'bold', label: 'Bold', short: 'B', keys: 'Mod+B' },
  { action: 'italic', label: 'Italic', short: 'I', keys: 'Mod+I' },
  { action: 'code', label: 'Code', short: '</>', keys: 'Mod+E' },
  { action: 'bullet', label: 'Bulleted list', short: '•', keys: 'Mod+Shift+8' },
  { action: 'number', label: 'Numbered list', short: '1.', keys: 'Mod+Shift+7' },
  { action: 'check', label: 'Checklist', short: '☑', keys: 'Mod+Shift+9' },
  { action: 'quote', label: 'Quote', short: '❝', keys: '' },
  { action: 'link', label: 'Link', short: '🔗', keys: 'Mod+K' },
  { action: 'rule', label: 'Divider', short: '—', keys: '' },
]

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const keyWords = (keys: string) => (keys ? keys.replace('Mod', isMac() ? '⌘' : 'Ctrl') : '')

const CLOSED: PanelEditorState = {
  phase: 'closed',
  cardId: null,
  text: '',
  holder: null,
  unsaved: null,
  pending: false,
  reason: null,
}

function usePanelState(ctx: CanvasFeatureContext): PanelEditorState {
  const panel = docPanelOf(ctx.canvas)
  return useSyncExternalStore(
    (l) => panel?.subscribe(l) ?? (() => {}),
    () => panel?.state() ?? CLOSED,
    () => CLOSED,
  )
}

/** What the status line says. */
export function statusWords(s: PanelEditorState, writable: boolean, readOnlyRole: boolean): string {
  if (s.phase === 'open')
    return writable ? (s.pending ? 'Editing · saving…' : 'Editing') : (s.reason ?? 'Read only')
  if (s.phase === 'pending') return 'Opening for editing…'
  if (s.phase === 'denied') return s.reason ?? 'Someone else is editing this doc card.'
  if (s.phase === 'lost' || s.phase === 'handed-over') return s.reason ?? 'Read only'
  if (readOnlyRole) return 'Read only'
  return s.holder ? `${s.holder.name} is editing this doc card.` : (s.reason ?? 'Read only')
}

export function DocEditorPanel({ ctx, close }: { ctx: CanvasFeatureContext; close(): void }) {
  const canvas = ctx.canvas
  const panel = docPanelOf(canvas)
  const s = usePanelState(ctx)
  const target = useValue('doc-editor-target', () => docState(canvas).target.get(), [canvas])
  const readOnlyRole = useValue('doc-editor-ro', () => canvas.readOnly(), [canvas])
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const area = useRef<HTMLTextAreaElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const writable = !!panel && panel.isWritable()
  const [copied, setCopied] = useState(false)

  // the panel closing (its ×, Escape, another panel) closes the card: the words written, the lease given back, and
  // the keyboard back on the card. Decided a microtask later: a remount in the same commit (React's StrictMode runs
  // every effect twice) is not a close.
  useEffect(() => {
    const st = docState(canvas)
    st.mounted++
    return () => {
      st.mounted--
      queueMicrotask(() => {
        if (st.mounted > 0) return
        const id = st.target.get()
        closeDocPanel(canvas)
        const el = id ? canvas.get(id) : undefined
        if (id && el && !el.isDeleted) {
          canvas.select([id])
          canvas.focus({ preventScroll: true })
        }
      })
    }
  }, [canvas])

  // the card went away (deleted for everyone, or the panel was never given one): nothing to show
  useEffect(() => {
    if (!target) close()
  }, [target, close])

  // granted: the keyboard goes into the words (a new card's title selected to type over)
  const grantedFor = useRef<string | null>(null)
  useEffect(() => {
    const ta = area.current
    if (!ta || s.phase !== 'open' || grantedFor.current === s.cardId) return
    grantedFor.current = s.cardId
    setTab('write')
    requestAnimationFrame(() => {
      ta.focus({ preventScroll: true })
      if (ta.value === NEW_DOC_WORDS) ta.setSelectionRange(NEW_DOC_TITLE_RANGE[0], NEW_DOC_TITLE_RANGE[1])
      else ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }, [s.phase, s.cardId])

  const doc = useMemo(() => parsedWords(s.text), [s.text])
  if (!panel || !target) return null
  const title = docTitle(s.text) || 'Untitled doc'
  const editable = !readOnlyRole

  /** Hands a new value to the lease client; refused (and the shown words kept) unless writable. */
  const put = (value: string, sel?: { start: number; end: number }) => {
    if (!panel.input(value)) {
      const ta = area.current
      if (ta && ta.value !== panel.state().text) ta.value = panel.state().text
      return
    }
    if (sel)
      requestAnimationFrame(() => {
        const ta = area.current
        if (ta) ta.setSelectionRange(sel.start, sel.end)
      })
  }

  const format = (action: FormatAction) => {
    const ta = area.current
    if (!ta || !panel.isWritable()) return
    const next = applyFormat({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd }, action)
    put(next.value, next)
    ta.focus({ preventScroll: true })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    const action = formatKey({
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      mac: isMac(),
    })
    if (action) {
      // the page's own chords (Ctrl/Cmd+K is the command palette) stay out of the panel's typing
      e.preventDefault()
      e.stopPropagation()
      format(action)
      return
    }
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing
    ) {
      if (!panel.isWritable()) return
      const next = continueList({ value: ta.value, start: ta.selectionStart, end: ta.selectionEnd })
      if (next) {
        e.preventDefault()
        put(next.value, next)
      }
    }
  }

  const guard = (e: { preventDefault(): void }) => {
    if (!panel.isWritable()) e.preventDefault()
  }

  const onToolbarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
    const buttons = [...(toolbar.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const n = buttons.length
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n
    e.preventDefault()
    for (const b of buttons) b.tabIndex = -1
    const b = buttons[next]
    if (b) {
      b.tabIndex = 0
      b.focus()
    }
  }

  const count = s.text.length
  const over = count > DOC_SEARCH_CHARS
  return (
    <div className="lobby-doc-editor" data-testid="doc-editor" data-phase={s.phase} data-writable={writable}>
      <header className="lobby-doc-editor__head">
        <p className="lobby-doc-editor__title" data-testid="doc-editor-title" title={title}>
          {title}
        </p>
        <p
          className="lobby-doc-editor__status"
          data-testid="doc-editor-status"
          data-phase={s.phase}
          role="status"
          aria-live="polite"
        >
          {statusWords(s, writable, readOnlyRole)}
        </p>
      </header>
      {(s.phase === 'lost' || s.phase === 'handed-over') && s.unsaved && (
        <div className="lobby-doc-editor__lost" data-testid="doc-editor-lost" role="alert">
          <span>Your last changes were not saved.</span>
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="doc-editor-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(s.unsaved ?? '').then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }}
          >
            {copied ? 'Copied' : 'Copy my text'}
          </button>
        </div>
      )}
      <div className="lobby-doc-editor__bar">
        <div
          ref={toolbar}
          className="lobby-doc-editor__tools"
          role="toolbar"
          aria-label="Format"
          aria-disabled={!writable}
          onKeyDown={onToolbarKey}
        >
          {TOOLS.map((t, i) => (
            <button
              key={t.action}
              type="button"
              className="lobby-doc-editor__tool"
              data-testid={`doc-editor-tool-${t.action}`}
              aria-label={t.label}
              title={t.keys ? `${t.label} (${keyWords(t.keys)})` : t.label}
              tabIndex={i === 0 ? 0 : -1}
              disabled={!writable || tab !== 'write'}
              // the textarea keeps its selection while a button is pressed
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => format(t.action)}
            >
              <span aria-hidden="true" data-tool={t.action}>
                {t.short}
              </span>
            </button>
          ))}
        </div>
        <div className="lobby-doc-editor__tabs" role="tablist" aria-label="View">
          {(['write', 'preview'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              className="lobby-doc-editor__tab"
              data-testid={`doc-editor-tab-${v}`}
              aria-selected={tab === v}
              onClick={() => setTab(v)}
            >
              {v === 'write' ? 'Write' : 'Preview'}
            </button>
          ))}
        </div>
      </div>
      {tab === 'write' ? (
        <textarea
          ref={area}
          className="lobby-doc-editor__area"
          data-testid="doc-editor-text"
          aria-label={`Words of the doc card ${title} (Markdown)`}
          aria-describedby="lobby-doc-editor-count"
          value={s.text}
          readOnly={!writable}
          maxLength={DOC_MAX_CHARS}
          spellCheck
          onChange={(e) => put(e.currentTarget.value)}
          onBeforeInput={guard}
          onPaste={guard}
          onDrop={guard}
          onCut={guard}
          onKeyDown={onKeyDown}
        />
      ) : (
        <div className="lobby-doc-editor__preview lobby-doc" data-testid="doc-editor-preview">
          <DocBlocks
            doc={doc}
            mode="preview"
            onToggle={
              writable
                ? (line) => {
                    const next = toggleCheck(s.text, line)
                    if (next !== null) panel.input(next)
                  }
                : null
            }
          />
        </div>
      )}
      <footer className="lobby-doc-editor__foot">
        <p id="lobby-doc-editor-count" className="lobby-doc-editor__count" data-testid="doc-editor-count">
          {count.toLocaleString()} / {DOC_MAX_CHARS.toLocaleString()} characters
          {over ? ` · search finds the first ${DOC_SEARCH_CHARS.toLocaleString()}` : ''}
        </p>
        <div className="lobby-doc-editor__actions">
          {editable && (s.phase === 'reading' || s.phase === 'denied' || s.phase === 'lost') && (
            <button
              type="button"
              className="dr-btn"
              data-testid="doc-editor-edit"
              disabled={!!s.holder}
              onClick={() => panel.requestEdit()}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="doc-editor-done"
            onClick={close}
          >
            Done
          </button>
        </div>
      </footer>
    </div>
  )
}
