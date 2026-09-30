// OWNER: 3i. The accessible content list as a dock panel, "Contents" (docs/EXCALIDRAW-MIGRATION.md §4.8 (3)):
// every note, frame and text in reading order, frames with what is inside them. One Tab stop (↑/↓, Home and
// End move through the rows); Enter or a click selects the item on the board and brings it into view (the
// live region then says what it is), and the keyboard stays in the list, as the search panel's results do.
// F6 goes to the board. Updates while the board changes, at most every 250 ms.
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { untracked, useValue } from '../../../lib/signals.ts'
import { boardContents, type ContentNode, contentsSummary, flatten } from './contents.ts'
import { bringIntoView, levelInput } from './traversal.ts'

/** Rows rendered at most (a 9,000-element board lists its first rows; search finds the rest). */
export const CONTENTS_ROW_LIMIT = 500
const REFRESH_MS = 250

/** Re-reads the board at most every REFRESH_MS while it changes (drags, remote edits). */
function useBoardVersion(canvas: LobbyCanvas): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const off = canvas.on('changed', () => {
      if (t) return
      t = setTimeout(() => {
        t = null
        setVersion((v) => v + 1)
      }, REFRESH_MS)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [canvas])
  return version
}

export function ContentsPanel({ ctx }: { readonly ctx: CanvasFeatureContext; close(): void }) {
  const canvas = ctx.canvas
  const version = useBoardVersion(canvas)
  const contents = useMemo(() => {
    void version
    return untracked(() => boardContents(levelInput(canvas)))
  }, [canvas, version])
  const rows = useMemo(() => flatten(contents.nodes, CONTENTS_ROW_LIMIT), [contents])
  const total = contents.counts.notes + contents.counts.frames + contents.counts.texts
  const selected = useValue('a11y.contents-selection', () => new Set(canvas.selection), [canvas])
  const [activeId, setActiveId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const tabStop = rows.some((r) => r.node.id === activeId) ? activeId : (rows[0]?.node.id ?? null)

  const go = (node: ContentNode) => {
    setActiveId(node.id)
    if (!canvas.get(node.id)) return
    canvas.select([node.id])
    bringIntoView(canvas, [node.id])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-a11y-row]') ?? [])]
    if (!buttons.length) return
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
    e.preventDefault()
    const b = buttons[next]
    if (!b) return
    b.focus()
    setActiveId(b.dataset.a11yRow ?? null)
  }

  const row = (node: ContentNode) => (
    <button
      type="button"
      className="dr-a11y-contents__row"
      data-testid="contents-item"
      data-a11y-row={node.id}
      data-kind={node.kind}
      tabIndex={node.id === tabStop ? 0 : -1}
      aria-current={selected.has(node.id) ? 'true' : undefined}
      onFocus={() => setActiveId(node.id)}
      onClick={() => go(node)}
    >
      {node.label}
      {node.kind === 'frame' ? (
        <span className="dr-a11y-contents__count">
          {' '}
          ({node.children.length === 1 ? '1 item' : `${node.children.length} items`})
        </span>
      ) : null}
    </button>
  )

  // the rows shown, as the tree they belong to (frames keep their children under them)
  const shown = new Set(rows.map((r) => r.node.id))
  return (
    <div className="dr-a11y-contents" data-testid="board-contents">
      <p className="dr-a11y-muted" role="status" data-testid="contents-summary">
        {contentsSummary(contents.counts)}
      </p>
      {total > 0 ? (
        <p className="dr-a11y-muted" id="dr-a11y-contents-hint">
          ↑ and ↓ move through the list. Enter selects the item on the board. F6 goes to the board.
        </p>
      ) : null}
      <ul
        ref={listRef}
        className="dr-a11y-contents__list"
        aria-label="Board contents"
        aria-describedby={total > 0 ? 'dr-a11y-contents-hint' : undefined}
        onKeyDown={onKeyDown}
      >
        {contents.nodes
          .filter((n) => shown.has(n.id))
          .map((n) => (
            <li key={n.id}>
              {row(n)}
              {n.children.some((c) => shown.has(c.id)) ? (
                <ul className="dr-a11y-contents__inner" aria-label={`Inside ${n.label}`}>
                  {n.children
                    .filter((c) => shown.has(c.id))
                    .map((c) => (
                      <li key={c.id}>{row(c)}</li>
                    ))}
                </ul>
              ) : null}
            </li>
          ))}
      </ul>
      {rows.length < total ? (
        <p className="dr-a11y-muted" data-testid="contents-more">
          And {total - rows.length} more. Search the board to find them.
        </p>
      ) : null}
    </div>
  )
}
