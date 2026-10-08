// canvas-ux's stateful keys on the Excalidraw canvas (docs/EXCALIDRAW-CONTRACTS.md §3 `featureKeys`): the
// keys the tldraw page's document listener took itself (../keyboard.ts, ../keys.ts, ui/place-at-center.ts).
// The board page's key registry runs them before the allowlist (canvas/input/keymap.ts), which keeps
// type-to-edit (COL-04), Enter on a text (A11Y-12: the caret at the end), the tool letters and Ctrl+A.
//
//  - RETRO-02: the note left selected by finishing an edit (Esc) is not typed into: tool letters pick their
//    tool, other letters and digits do nothing, Enter re-edits it (the allowlist's own Enter), until the
//    selection changes or the note is clicked again.
//  - Enter: renames the one selected frame (RETRO-14); with the note, shape or text tool picked, places
//    that shape in the middle of the view, ready to type in (A11Y-07).
//  - Tab / Shift+Tab / Ctrl+Enter / Ctrl+Shift+Enter while editing a note: the next note beside, before,
//    below or above it, edited at once; keys typed meanwhile wait in the lease's buffer (RETRO-09).
//  - Shift+F10 and the menu key open the context menu for the selection; Alt+F10 moves the keyboard to the
//    selection toolbar (A11Y-04).
//  - Delete / Backspace on a selection that holds locked elements delete only the unlocked ones (a
//    locked element never goes; MAK-05 keeps it selected after locking).
//  - export control: while exporting is off for this person, Ctrl/Cmd+C and +X on a selection say why (the
//    allowlist keeps the key from read-only roles, so no copy event ever reaches ./export-gate.ts's guard).
//  - K2-2 (wave K): Q turns the tool lock on and off (./tool-lock.ts), unless a printable key on the selection
//    types into it (a selected note, a mind-map topic).
//  - CR-3A-6 (wave 3b): Shift+D picks the highlighter (tldraw's key; a key on one selected note types into
//    it instead), P while highlighting goes back to the pen, and H / V pick the read-only Hand and Select
//    for people who cannot edit. These tools are the canvas API's (canvas/api/parts/tools.ts), which the
//    allowlist's own tool letters do not reach.
//
// Keys that act only in a narrow state DEFER: when another feature's key takes the same event (a mind
// map's Enter or Tab, a feature's letter), theirs runs instead (`othersTake`). The keyboard-map test
// (./keyboard-map.test.ts) leaves them out of the conflict check for that reason.
import type { CanvasFeatureContext, FeatureKeySpec, KeyEventLike } from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { setToolLock } from './commands.ts'
import { openContextMenuForSelection } from './context-menu-open.ts'
import { exportAllowed, notifyExportOff } from './export-gate.ts'
import { editAdjacentNote, type NoteDirection } from './notes.ts'
import { placeAtCenter, placeableTool } from './place.ts'
import { uxState } from './state.ts'

/** The tool letters the allowlist routes (canvas/input/keymap.ts TOOL_KEYS, without M: navigation's). */
export const TOOL_LETTERS: Readonly<Record<string, string>> = {
  n: 'note',
  l: 'arrow',
  p: 'freedraw',
  t: 'text',
  r: 'rectangle',
  o: 'ellipse',
  f: 'frame',
  h: 'hand',
  c: 'comment',
  v: 'select',
  e: 'eraser',
  k: 'laser',
}

const LETTERS = [...'abcdefghijklmnopqrstuvwxyz']
const DIGITS = [...'0123456789']

/** The ids of canvas-ux's deferring keys (the keyboard-map test reads it). */
export const DEFERRING_KEYS: ReadonlySet<string> = new Set([
  'canvas-ux.after-edit',
  'canvas-ux.enter',
  'canvas-ux.next-note',
  'canvas-ux.locked-delete',
  'canvas-ux.export-off-copy',
  'canvas-ux.tool-highlight',
  'canvas-ux.tool-pen-after-highlight',
  'canvas-ux.readonly-tools',
  'canvas-ux.tool-lock-key',
])

/** One selected sticky note: the allowlist's type-to-edit takes printable keys (canvas/input/keymap.ts). */
const typeToEditTarget = (ctx: CanvasFeatureContext) => {
  const sel = ctx.canvas.selection
  return sel.length === 1 && ctx.canvas.get(sel[0] as string)?.type === 'stickynote'
}

const plain = (e: KeyEventLike) => !e.ctrlKey && !e.metaKey && !e.altKey

/** A printable key on the selection types into it: one selected note, or a feature's type-to-edit rule. */
const typesInto = (ctx: CanvasFeatureContext) => {
  const sel = ctx.canvas.selection
  if (sel.length !== 1) return false
  if (typeToEditTarget(ctx)) return true
  const id = sel[0] as string
  return ctx.registries.typeToEdit.list().some((r) => {
    try {
      return r.applies(id)
    } catch {
      return false
    }
  })
}

/** Another feature's key (commands and keys alike) takes this event: a deferring key steps aside. */
export function othersTake(e: KeyEventLike, ctx: CanvasFeatureContext, scope: 'canvas' | 'editor'): boolean {
  for (const k of ctx.registries.keys.list()) {
    if (k.scope !== scope) continue
    if (k.id.startsWith('key:canvas-ux.') || k.id.startsWith('command:canvas-ux.')) continue
    try {
      if (k.match(e)) return true
    } catch {
      // a broken matcher never blocks ours
    }
  }
  return false
}

const onlySelected = (ctx: CanvasFeatureContext) => {
  const sel = ctx.canvas.selection
  return sel.length === 1 ? (ctx.canvas.get(sel[0] as string) ?? null) : null
}

export const KEYS: readonly FeatureKeySpec[] = [
  {
    id: 'canvas-ux.after-edit',
    scope: 'canvas',
    chords: [...LETTERS, ...LETTERS.map((l) => `shift+${l}`), ...DIGITS, ...DIGITS.map((d) => `shift+${d}`)],
    match: (e, ctx) => {
      const left = uxState(ctx.canvas).leftEditing.get()
      if (!left || !plain(e)) return false
      const sel = ctx.canvas.selection
      if (sel.length !== 1 || sel[0] !== left) return false
      return !othersTake(e, ctx, 'canvas')
    },
    handle: (e, ctx) => {
      const letter = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase()
      const tool = letter && !e.shiftKey ? TOOL_LETTERS[letter] : undefined
      if (tool) ctx.canvas.setTool(tool)
      // K2-2: Q is the tool lock here too (the note just edited is not typed into)
      else if (letter === 'q' && !e.shiftKey && !ctx.canvas.readOnly()) setToolLock(ctx)
      return true
    },
  },
  {
    id: 'canvas-ux.enter',
    scope: 'canvas',
    chords: ['enter'],
    match: (e, ctx) => {
      if (e.shiftKey || !plain(e) || ctx.canvas.readOnly()) return false
      if (ctx.registries.menusOpen.call()) return false
      const only = onlySelected(ctx)
      const renames = only?.type === 'frame' && !ctx.canvas.isLocked(only.id)
      const places = !renames && placeableTool(ctx) !== null
      return (renames || places) && !othersTake(e, ctx, 'canvas')
    },
    handle: (_e, ctx) => {
      const only = onlySelected(ctx)
      if (only?.type === 'frame') {
        uxState(ctx.canvas).renamingFrame.set(only.id)
        return true
      }
      const tool = placeableTool(ctx)
      if (!tool) return false
      placeAtCenter(ctx, tool)
      return true
    },
  },
  {
    id: 'canvas-ux.next-note',
    scope: 'editor',
    chords: ['tab', 'shift+tab', 'mod+enter', 'mod+shift+enter'],
    match: (e, ctx) => {
      const id = ctx.canvas.editingId()
      const el = id ? ctx.canvas.get(id) : undefined
      return el?.type === 'stickynote' && !othersTake(e, ctx, 'editor')
    },
    handle: (e, ctx) => {
      const dir: NoteDirection =
        e.key === 'Tab' ? (e.shiftKey ? 'left' : 'right') : e.shiftKey ? 'above' : 'below'
      return editAdjacentNote(ctx, dir)
    },
  },
  {
    id: 'canvas-ux.context-menu-key',
    scope: 'canvas',
    chords: ['shift+f10', 'contextmenu'],
    handle: (_e, ctx) => openContextMenuForSelection(ctx),
  },
  {
    id: 'canvas-ux.selection-bar-key',
    scope: 'canvas',
    chords: ['alt+f10'],
    handle: (_e, ctx) => {
      if (!ctx.canvas.selection.length) return false
      const s = uxState(ctx.canvas)
      s.selectionBarFocus.set(s.selectionBarFocus.get() + 1)
      return true
    },
  },
  {
    id: 'canvas-ux.export-off-copy',
    scope: 'canvas',
    chords: ['mod+c', 'mod+x'],
    match: (_e, ctx) => ctx.canvas.selection.length > 0 && !exportAllowed(ctx),
    handle: (_e, ctx) => {
      notifyExportOff(ctx)
      return true
    },
  },
  {
    id: 'canvas-ux.locked-delete',
    scope: 'canvas',
    chords: ['delete', 'backspace'],
    match: (e, ctx) => {
      if (!plain(e) || e.shiftKey || ctx.canvas.readOnly()) return false
      const locked = ctx.canvas.selection.some((id) => {
        const el = ctx.canvas.get(id)
        return !!el && ctx.canvas.isLocked(items.containerOf(el, (x) => ctx.canvas.get(x)).id)
      })
      return locked && !othersTake(e, ctx, 'canvas')
    },
    handle: (_e, ctx) => {
      const { canvas } = ctx
      const ids = new Set<string>()
      for (const id of canvas.selection) {
        const el = canvas.get(id)
        if (!el) continue
        const root = items.containerOf(el, (x) => canvas.get(x))
        if (!canvas.isLocked(root.id)) ids.add(root.id)
      }
      if (ids.size) {
        canvas.transact('delete', (tx) => {
          for (const id of ids) tx.delete(id)
        })
        canvas.select(canvas.selection.filter((id) => !ids.has(id)))
      }
      return true
    },
  },
  {
    // CR-3A-6: tldraw's highlighter key. A printable key on the one selected note types into it instead
    // (the allowlist's type-to-edit), as it does on the tldraw page.
    id: 'canvas-ux.tool-highlight',
    scope: 'canvas',
    chords: ['shift+d'],
    match: (e, ctx) => !ctx.canvas.readOnly() && !typeToEditTarget(ctx) && !othersTake(e, ctx, 'canvas'),
    handle: (_e, ctx) => ctx.canvas.setTool('highlight'),
  },
  {
    // P while the highlighter is on picks the pen (the allowlist's own P would keep the engine's pen, which
    // the highlighter already is)
    id: 'canvas-ux.tool-pen-after-highlight',
    scope: 'canvas',
    chords: ['p'],
    match: (e, ctx) =>
      plain(e) && !e.shiftKey && ctx.canvas.tool() === 'highlight' && !othersTake(e, ctx, 'canvas'),
    handle: (_e, ctx) => ctx.canvas.setTool('freedraw'),
  },
  {
    // K2-2: the tool lock (./tool-lock.ts); a printable key on a selected note types into it instead
    id: 'canvas-ux.tool-lock-key',
    scope: 'canvas',
    chords: ['q'],
    match: (e, ctx) =>
      plain(e) && !e.shiftKey && !ctx.canvas.readOnly() && !typesInto(ctx) && !othersTake(e, ctx, 'canvas'),
    handle: (_e, ctx) => {
      setToolLock(ctx)
      return true
    },
  },
  {
    // CR-3A-6: H and V for read-only roles pick the read-only Hand and Select (canvas/api/parts/tools.ts);
    // the allowlist's own H is the engine's Hand, which read-only roles cannot have
    id: 'canvas-ux.readonly-tools',
    scope: 'canvas',
    chords: ['h', 'v'],
    match: (e, ctx) => plain(e) && !e.shiftKey && ctx.canvas.readOnly() && !othersTake(e, ctx, 'canvas'),
    handle: (e, ctx) => ctx.canvas.setTool(e.code === 'KeyH' ? 'hand' : 'select'),
  },
]
