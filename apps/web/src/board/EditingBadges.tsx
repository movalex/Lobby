import { useMemo } from 'react'
import { useEditor, useValue } from 'tldraw'
import { useBoard } from './board-context.ts'
import { type RemoteEditing, remoteEditing } from './presence.ts'

type Placed = RemoteEditing & { x: number; y: number }

/**
 * Rendered through tldraw's `InFrontOfTheCanvas` slot (viewport coordinates, above shapes). Shows who
 * is text-editing which shape, from their presence hint. The server lease is what actually blocks
 * concurrent edits; this only explains it before anyone gets denied.
 */
export function EditingBadges() {
  const editor = useEditor()
  const selfUserId = useBoard()?.userId ?? ''
  const key = useValue('dr-editing-badges', () => {
    const placed: Placed[] = []
    const perShape = new Map<string, number>()
    for (const r of remoteEditing(editor.getCollaboratorsOnCurrentPage(), selfUserId)) {
      const bounds = editor.getShapePageBounds(r.shapeId)
      if (!bounds) continue
      const pt = editor.pageToViewport({ x: bounds.minX, y: bounds.minY })
      const stack = perShape.get(r.shapeId) ?? 0 // badges for one shape stack upwards
      perShape.set(r.shapeId, stack + 1)
      placed.push({ ...r, x: Math.round(pt.x), y: Math.round(pt.y) - 26 - stack * 24 })
    }
    return JSON.stringify(placed)
  }, [editor, selfUserId])
  const items = useMemo(() => JSON.parse(key) as Placed[], [key])
  return (
    <>
      {items.map((it) => (
        <div
          key={`${it.userId}/${it.shapeId}`}
          className="dr-editing-badge"
          data-testid="editing-badge"
          data-user-id={it.userId}
          data-shape-id={it.shapeId}
          style={{
            transform: `translate(${it.x}px, ${it.y}px)`,
            background: it.color,
          }}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
            <path d="M4 20h4L19 9l-4-4L4 16z" fill="currentColor" />
          </svg>
          {it.name} is editing
        </div>
      ))}
    </>
  )
}
