// The keyboard shortcuts dialog on the Excalidraw canvas (host slot `shortcutsDialog`; the tldraw page's
// ../ShortcutsDialog.tsx over tldraw's dialog). Opened with "?", Ctrl/Cmd+/ or Ctrl/Cmd+Alt+/ (A11Y2-07),
// or the board menu. It lists what the keys do on this canvas: the tools and edit keys the allowlist
// routes itself (canvas/input/keymap.ts), every feature's command and tool with a key (the registries, so
// a feature's key shows up without editing this file), and the "Board" keys canvas-ux documents.
//
// Wave L (W3, L3-2): a search field over the same rows, ranked as the command palette ranks (its scorer:
// prefix, word starts, initials), matching a row's words or its keys as written on this platform.
import { useEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext, KeyChord, Platform } from '../../../canvas/api/index.ts'
import { currentPlatform, formatChord } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { scoreEntry } from '../../command-palette/scorer.ts'
import { uxState } from './state.ts'
import { MAIN_TOOLS, OVERFLOW_TOOLS } from './Toolbar.tsx'

export interface ShortcutRow {
  readonly label: string
  /** chords (formatted per platform) or literal key text */
  readonly keys: readonly (KeyChord | { readonly text: string })[]
}
export interface ShortcutSection {
  readonly id: string
  readonly title: string
  readonly rows: readonly ShortcutRow[]
}

/** The edit keys the allowlist delegates to the engine or takes itself (they are no registry entries). */
const BUILT_IN_EDIT: readonly ShortcutRow[] = [
  { label: 'Undo', keys: ['mod+z'] },
  { label: 'Redo', keys: ['mod+shift+z', 'mod+y'] },
  { label: 'Cut', keys: ['mod+x'] },
  { label: 'Copy', keys: ['mod+c'] },
  { label: 'Paste', keys: ['mod+v'] },
  { label: 'Duplicate', keys: ['mod+d'] },
  { label: 'Delete', keys: ['delete', 'backspace'] },
  { label: 'Select all', keys: ['mod+a'] },
  { label: 'Group', keys: ['mod+g'] },
  { label: 'Ungroup', keys: ['mod+shift+g'] },
  { label: 'Move the selection', keys: [{ text: '← ↑ → ↓' }] },
  { label: 'Zoom in', keys: ['mod+='] },
  { label: 'Zoom out', keys: ['mod+-'] },
  { label: 'Pan (hold)', keys: ['space'] },
]

/** The keys canvas-ux documents (the tldraw dialog's "Board" group). */
const BOARD_ROWS: readonly ShortcutRow[] = [
  { label: 'Type on a selected note or shape to edit its words', keys: [{ text: 'A–Z' }] },
  { label: 'Edit the selected note (caret at the end)', keys: ['enter'] },
  { label: 'New note beside (while editing a note)', keys: ['tab'] },
  { label: 'New note below (while editing a note)', keys: ['mod+enter'] },
  { label: 'New sticky note (double-click empty canvas)', keys: [{ text: 'Double-click' }] },
  { label: 'Place the picked note, shape or text in the middle of the view', keys: ['enter'] },
  // K2-2: Note and Text go back to Select after one placement unless the lock is on
  { label: 'Tool lock: keep the tool picked after placing (or double-click a tool)', keys: ['q'] },
  { label: 'Rename the selected frame', keys: ['enter'] },
  { label: 'Go to the selection toolbar (Esc returns)', keys: ['alt+f10'] },
  { label: 'Open the context menu for the selection', keys: ['shift+f10'] },
]

/** Every section, from the registries (pure over the context; the dialog renders it). */
export function shortcutSections(ctx: CanvasFeatureContext): ShortcutSection[] {
  const r = ctx.registries
  const tools: ShortcutRow[] = []
  const seen = new Set<string>()
  for (const t of [...MAIN_TOOLS, ...OVERFLOW_TOOLS]) {
    if (!t.key) continue
    seen.add(t.key)
    tools.push({ label: t.label, keys: [t.key] })
  }
  for (const t of r.tools.list()) {
    const keys = (t.kbd ?? []).filter((k) => !seen.has(k))
    if (!keys.length) continue
    for (const k of keys) seen.add(k)
    tools.push({ label: t.label, keys })
  }
  const edit: ShortcutRow[] = [...BUILT_IN_EDIT]
  const more: ShortcutRow[] = []
  for (const c of r.commands.list()) {
    if (!c.kbd?.length) continue
    // wave K.1: a command this device does not offer has no row (cursor chat with no cursor)
    if (c.available && !c.available(ctx)) continue
    const row = { label: c.label, keys: c.kbd }
    if (c.id.startsWith('canvas-ux.')) edit.push(row)
    else more.push(row)
  }
  const sections: ShortcutSection[] = [
    { id: 'tools', title: 'Tools', rows: tools },
    { id: 'edit', title: 'Edit', rows: edit },
  ]
  if (more.length) sections.push({ id: 'features', title: 'View and features', rows: more })
  sections.push({ id: 'dr-board', title: 'Board', rows: BOARD_ROWS })
  return dedupeRows(sections)
}

/** A row's identity: its words and its keys, as written (chords compared case-blind, without spaces). */
const rowId = (r: ShortcutRow) =>
  `${r.label.trim().toLowerCase()}|${r.keys
    .map((k) => (typeof k === 'string' ? k.toLowerCase().replace(/\s+/g, '') : `text:${k.text}`))
    .join(' ')}`

/**
 * Wave M (M1-6, FTU-12): a row listed twice is listed once, where it first appears (Cut was in the built-in edit
 * keys and again as canvas-ux's command; Zoom in and out as navigation's). Empty sections are left out. Pure.
 */
export function dedupeRows(sections: readonly ShortcutSection[]): ShortcutSection[] {
  const seen = new Set<string>()
  const out: ShortcutSection[] = []
  for (const s of sections) {
    const rows = s.rows.filter((r) => {
      const id = rowId(r)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    if (rows.length) out.push({ ...s, rows })
  }
  return out
}

/**
 * The sections with only the rows that match `query` (their words, or their keys as this platform writes
 * them), best first inside each section; empty sections left out. An empty query keeps everything.
 */
export function filterSections(
  sections: readonly ShortcutSection[],
  query: string,
  platform: Platform = currentPlatform(),
): ShortcutSection[] {
  const q = query.trim()
  if (!q) return [...sections]
  const out: ShortcutSection[] = []
  for (const s of sections) {
    const scored = s.rows
      .map((row) => {
        const keys = row.keys.map((k) => (typeof k === 'string' ? formatChord(k, platform) : k.text))
        return { row, score: scoreEntry(q, row.label, keys) }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    if (scored.length) out.push({ ...s, rows: scored.map((x) => x.row) })
  }
  return out
}

export function ShortcutsDialog({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const open = useValue(state.shortcutsOpen)
  const ref = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  if (!open) return null
  const platform = currentPlatform()
  const close = () => {
    // The modal <dialog> closes first: while it is open the page is inert, so a focus() on the canvas can
    // be dropped and the keyboard end on <body> once React removes the dialog (3b's finding, a11y-3).
    if (ref.current?.open) ref.current.close()
    state.shortcutsOpen.set(false)
    setQuery('')
    canvas.focus({ preventScroll: true })
  }
  const sections = filterSections(shortcutSections(ctx), query, platform)
  return (
    <dialog
      ref={ref}
      className="dr-dialog cux-shortcuts"
      data-testid="shortcuts-dialog"
      aria-labelledby="cux-shortcuts-title"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <header className="cux-shortcuts__head">
        <h2 id="cux-shortcuts-title">Keyboard shortcuts</h2>
        <button
          type="button"
          className="dr-iconbtn"
          aria-label="Close"
          data-testid="shortcuts-dialog-close"
          onClick={close}
        >
          ×
        </button>
      </header>
      <div className="cux-shortcuts__search" style={{ padding: '0 16px 8px' }}>
        <input
          type="search"
          className="dr-input dr-input--block"
          aria-label="Search shortcuts"
          placeholder="Search shortcuts (“lock”, “zoom”, “Ctrl+K”)"
          data-testid="shortcuts-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // the board never sees a key typed here; Escape still closes the dialog (its cancel)
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        />
      </div>
      <div className="cux-shortcuts__body" data-testid="shortcuts-dialog-body">
        {sections.length === 0 && (
          <p
            className="cux-shortcuts__none"
            data-testid="shortcuts-none"
            style={{ margin: '8px 0', color: 'var(--dr-ink-2)' }}
          >
            No shortcut matches “{query.trim()}”.
          </p>
        )}
        {sections.map((s) => (
          <section key={s.id} className="cux-shortcuts__section" data-section={s.id}>
            <h3>{s.title}</h3>
            <ul>
              {s.rows.map((row) => (
                <li key={`${row.label}`} className="cux-shortcuts__row" data-testid="shortcut-row">
                  <span className="cux-shortcuts__label">{row.label}</span>
                  <span className="cux-shortcuts__keys">
                    {row.keys.map((k) => (
                      <kbd key={typeof k === 'string' ? k : k.text} className="cux-shortcuts__kbd">
                        {typeof k === 'string' ? formatChord(k, platform) : k.text}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </dialog>
  )
}
