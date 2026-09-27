// The slice of tldraw's Editor (5.4.2) that the suites drive through `window.editor`. The web app
// exposes it only behind the dev-auth guard. e2e has no tldraw dependency, so this is hand-written
// from node_modules/@tldraw/editor/dist-esm/index.d.mts; keep it to methods that exist there.

export interface VecLike {
  x: number
  y: number
}

export interface RecordLike {
  id: string
  typeName: string
  [key: string]: unknown
}

export interface ShapeLike extends RecordLike {
  type: string
  parentId: string
  x: number
  y: number
  props: Record<string, unknown>
  meta: Record<string, unknown>
}

export interface BindingLike extends RecordLike {
  type: string
  fromId: string
  toId: string
  props: Record<string, unknown>
}

export interface BoxLike {
  x: number
  y: number
  w: number
  h: number
}

export interface CollaboratorLike {
  userId: string
  userName: string
  cursor: VecLike | null
  meta: Record<string, unknown>
}

export interface EditorLike {
  store: { allRecords(): RecordLike[] }
  createShape(partial: Record<string, unknown>): EditorLike
  createShapes(partials: Record<string, unknown>[]): EditorLike
  updateShape(partial: Record<string, unknown>): EditorLike
  deleteShapes(ids: string[]): EditorLike
  getShape(id: string): ShapeLike | undefined
  getCurrentPageShapes(): ShapeLike[]
  getCollaborators(): CollaboratorLike[]
  getBindingsFromShape(id: string, type: string): BindingLike[]
  getSortedChildIdsForParent(id: string): string[]
  getShapePageBounds(id: string): BoxLike | undefined
  pageToScreen(point: VecLike): VecLike
  select(...ids: string[]): EditorLike
  getSelectedShapeIds(): string[]
  selectNone(): EditorLike
  setCurrentTool(id: string): EditorLike
  getCurrentToolId(): string
  getEditingShapeId(): string | null
  /** The TipTap editor of the shape being text-edited. */
  getRichTextEditor(): { isDestroyed: boolean; view: { dom: Element } } | null
  markHistoryStoppingPoint(name?: string): string
  getIsReadonly(): boolean
  zoomToFit(): EditorLike
}

declare global {
  interface Window {
    editor?: EditorLike
  }
}

/** tldraw rich text is a TipTap document. This is the shape richTextValidator accepts. */
export function richText(text: string) {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  }
}

/** Flattens a TipTap document to its text, one line per block. */
export function plainText(doc: unknown): string {
  const blocks: string[] = []
  const walk = (node: unknown, into: string[]) => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: unknown; text?: unknown; content?: unknown }
    if (typeof n.text === 'string') into.push(n.text)
    if (Array.isArray(n.content)) for (const child of n.content) walk(child, into)
  }
  const root = doc as { content?: unknown }
  for (const block of Array.isArray(root?.content) ? root.content : []) {
    const parts: string[] = []
    walk(block, parts)
    blocks.push(parts.join(''))
  }
  return blocks.join('\n')
}
