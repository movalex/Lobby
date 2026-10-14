// P-005 (wave P): typing on the one selected shape labels it, as typing on a note edits it (Miro's habit: draw a
// shape, start typing, the words go in it). The rule is a type-to-edit spec (the page's `registries.typeToEdit`),
// so the key allowlist (canvas/input/keymap.ts) stays the only path: a printable key on such a shape is Lobby's
// `typeToEdit`, before the tool letters; `start` declines, so the allowlist's own lease flow runs (a lease request
// with the key as the first one typed, the editor once the lease is granted, the keys typed meanwhile buffered).
// The features that step aside for type-to-edit (cursor chat's '/', canvas-ux's Shift+D, navigation's M, = and -)
// read the same rule.
//
// Which shapes: a rectangle, an ellipse or a diamond Lobby drew as a plain shape, unlocked, for someone who can
// edit, while no text editor is open. Not a link card or a board card (their label is the page's title), a file
// card or a mind-map topic (its own rule), whatever `customData.lobby.kind` says it was made as.
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'

const LABELLED_SHAPES: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'diamond'])

/** A plain shape: a rectangle, ellipse or diamond nothing in Lobby made as something else. */
export function isPlainShape(el: Pick<CanvasElement, 'type'> & { customData?: unknown }): boolean {
  if (!LABELLED_SHAPES.has(el.type)) return false
  const lobby = (el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby
  return !lobby || (lobby.kind === undefined && lobby.file === undefined && lobby.mindmap === undefined)
}

/** Typing labels this element now: one unlocked plain shape, an editor's board, no text editor open. */
export function labelsOnType(canvas: LobbyCanvas, id: string): boolean {
  if (canvas.readOnly() || canvas.editingId() !== null) return false
  const el = canvas.get(id)
  return !!el && !(el as { isDeleted?: boolean }).isDeleted && isPlainShape(el) && !canvas.isLocked(id)
}

/** The one selected element a printable key types into: a note, or a plain shape (its label). */
export function typesOnKey(canvas: LobbyCanvas): boolean {
  if (canvas.readOnly() || canvas.editingId() !== null || canvas.selection.length !== 1) return false
  const id = canvas.selection[0] as string
  const el = canvas.get(id)
  if (!el || canvas.isLocked(id)) return false
  return el.type === 'stickynote' || labelsOnType(canvas, id)
}

/** Registers the rule; returns the unregister. */
export function installTypeToLabel(ctx: CanvasFeatureContext): () => void {
  const { canvas } = ctx
  return ctx.registries.typeToEdit.register({
    id: 'canvas-ux.type-to-label',
    applies: (id) => labelsOnType(canvas, id),
    // the allowlist's lease flow starts the edit (canvas/input/CanvasInput.ts runAction)
    start: () => false,
  })
}
