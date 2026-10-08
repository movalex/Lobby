/**
 * K1-5 (wave K): what a board shows while it opens, instead of a lone spinner on a blank page (creating a
 * board from a template showed one for about 4.5 s locally): the board page's own frame, drawn at once.
 *
 *  - the top bar, the same height and in the same place as the board's (`dr-topbar`): Lobby's mark, the
 *    workspace and the board's title when they are known (the board's answer, or a hint: the link the
 *    person reached, lib/prefetch-board.ts `boardTitleHint`), a neutral placeholder when not;
 *  - the dock's column and a greyed toolbar where the board's own will be (centred on the canvas, 12 px
 *    from the bottom), so nothing moves when the board takes over (no layout shift);
 *  - a soft shimmer over the canvas (still under prefers-reduced-motion).
 *
 * It never says "Saved" or "Live" (nothing is synced yet) and has nothing to click: the real top bar
 * replaces it once the board's session exists. Rendered by App.tsx (the session check of a board
 * address), route.tsx (while the board code downloads) and LobbyBoardPage.tsx (while the board, its
 * ticket and its session start). Its styles are in ./board.css, which this module brings into the
 * page's first stylesheet.
 */
import { Mark } from '../../brand/Wordmark.tsx'
import { boardTitleHint } from '../../lib/prefetch-board.ts'
import { useTopBarWidth } from '../../ui/useMedia.ts'
import './board.css'

export interface BoardSkeletonProps {
  readonly boardId: string
  /** the board's title once the board answered (otherwise the hint, otherwise a placeholder) */
  readonly title?: string | null
  /** the board's workspace once the board answered */
  readonly workspace?: { readonly id: string; readonly name: string } | null
  /** the person's workspaces (the session's), to name a hint's workspace */
  readonly workspaces?: readonly { readonly id: string; readonly name: string }[]
  /** a read-only role shows the read-only toolbar's shape */
  readonly readonly?: boolean
  /** what a screen reader hears (default "Opening board…") */
  readonly label?: string
}

export interface BoardSkeletonView {
  readonly title: string | null
  readonly workspaceName: string | null
  readonly readonly: boolean
  readonly label: string
}

/** What the skeleton shows (pure): the board's own answer first, then the hint, then nothing. */
export function boardSkeletonView(p: BoardSkeletonProps): BoardSkeletonView {
  const hint = boardTitleHint(p.boardId)
  const title = p.title?.trim() || hint?.title || null
  const wsId = p.workspace?.id ?? hint?.workspaceId ?? null
  const workspaceName =
    p.workspace?.name ?? (wsId ? (p.workspaces?.find((w) => w.id === wsId)?.name ?? null) : null)
  return { title, workspaceName, readonly: p.readonly === true, label: p.label ?? 'Opening board…' }
}

/** The greyed toolbar (also drawn over the canvas while the session connects: LobbyBoardPage). */
export function SkeletonToolbar({ readonly = false }: { readonly?: boolean }) {
  const tools = readonly ? 2 : 9
  return (
    <div
      className="lobby-skeleton__toolbar"
      data-testid="board-skeleton-toolbar"
      data-readonly={readonly ? 'true' : undefined}
      aria-hidden="true"
    >
      {Array.from({ length: tools }, (_, i) => (
        <span key={i} className="lobby-skeleton__bone lobby-skeleton__bone--tool" />
      ))}
    </div>
  )
}

export function BoardSkeleton(props: BoardSkeletonProps) {
  const v = boardSkeletonView(props)
  // the board's own top bar breakpoints (styles.css): the workspace crumb goes at 768 px, and so on
  const width = useTopBarWidth()
  return (
    <div
      className="dr-board lobby-skeleton"
      data-testid="board-skeleton"
      data-board-id={props.boardId}
      aria-busy="true"
    >
      <header
        className="dr-topbar lobby-skeleton__topbar"
        data-width={width}
        data-testid="board-skeleton-topbar"
      >
        <span className="dr-topbar__home" aria-hidden="true">
          <Mark size={24} />
        </span>
        <span className="dr-topbar__sep" aria-hidden="true" />
        <div className="dr-topbar__board">
          {v.workspaceName ? (
            <span className="dr-topbar__ws">{v.workspaceName}</span>
          ) : (
            <span className="lobby-skeleton__bone lobby-skeleton__bone--ws" aria-hidden="true" />
          )}
          <span className="dr-topbar__slash" aria-hidden="true">
            /
          </span>
          {v.title ? (
            <h1 className="dr-topbar__title" data-testid="board-skeleton-title" title={v.title}>
              {v.title}
            </h1>
          ) : (
            <span
              className="lobby-skeleton__bone lobby-skeleton__bone--title"
              data-testid="board-skeleton-title"
              data-placeholder="true"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="dr-topbar__spacer" />
        <span className="lobby-skeleton__bone lobby-skeleton__bone--pill" aria-hidden="true" />
        <span className="lobby-skeleton__bone lobby-skeleton__bone--button" aria-hidden="true" />
      </header>
      <div className="dr-board__body">
        <div className="dr-dock lobby-skeleton__dock" data-open="false" aria-hidden="true">
          <div className="dr-dock__rail">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="lobby-skeleton__bone lobby-skeleton__bone--tab" />
            ))}
          </div>
        </div>
        <main className="dr-board__canvas lobby-skeleton__canvas" aria-label="Board canvas">
          <div className="lobby-skeleton__shimmer" aria-hidden="true" />
          <SkeletonToolbar readonly={v.readonly} />
          <p className="dr-sr-only" role="status" aria-live="polite">
            {v.label}
          </p>
        </main>
      </div>
    </div>
  )
}
