// OWNER: WS7 (wave N, N7-1, N7-2). A board card's face, drawn by the media feature's scene layer
// (file-card/ported/CardLayer.tsx) over the card's rectangle, in scene units (it moves and scales with it):
//  - `ok` (this viewer can open the target now): the board's thumbnail (the same-origin thumbnail route, which checks
//    access itself; a board with none shows its initial), its title and, for a card that opens a frame, the frame's
//    name;
//  - anything else, and until the api answered: the neutral face, "Board you can't open" (or "Board link" while
//    loading), with nothing about the target: a missing, a forbidden and a trashed board look the same. Name-only
//    guests always see it (the api answers them nothing else).
// Its "Open" link goes there (a plain click in this tab, through the router, `?el=` zooming to the element, or in
// place for a link to this very board; Ctrl, Cmd, Shift or a middle click: a new tab without opener or referrer).
// The rest of the face takes no pointer events: selecting, moving and editing the card stay the canvas's.
import { type CSSProperties, useEffect, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import './board-links.css'
import { faceStoreOf } from './faces.ts'
import { boardLinkHandlers, openFrom } from './open.ts'

export function BoardCardFace({
  ctx,
  id,
  path,
  target,
  style,
}: {
  ctx: CanvasFeatureContext
  /** the card element's id */
  id: string
  /** its stored link (`/b/<id>[?el=<id>]`) */
  path: string
  /** its board-cards target (`<id>[:<el>]`) */
  target: string
  style: CSSProperties
}) {
  const store = faceStoreOf(ctx.registries, ctx.board.id)
  useEffect(() => store.want([target]), [store, target])
  const face = useValue('board-card-face', () => store.face(target), [store, target])
  const [thumbFailed, setThumbFailed] = useState<string | null>(null)
  const ok = face?.state === 'ok' ? face : null
  const state = ok ? 'ok' : face ? 'unavailable' : 'loading'
  const title = ok ? ok.title : face ? 'Board you can’t open' : 'Board link'
  const thumb = ok && thumbFailed !== ok.thumbnailPath ? ok.thumbnailPath : null
  const handlers = boardLinkHandlers(path, { counted: 'boardlinks.open', from: openFrom(ctx) })
  return (
    <figure
      className="lobby-board-card"
      data-testid="board-card"
      data-lobby-board-card={id}
      data-state={state}
      aria-label={
        ok ? `Board link: ${ok.title}${ok.frameName ? `, ${ok.frameName}` : ''}` : `Board link: ${title}`
      }
      style={style}
    >
      <div className="lobby-board-card__thumb" aria-hidden="true">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            data-testid="board-card-thumbnail"
            decoding="async"
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setThumbFailed(thumb)}
          />
        ) : (
          <span className="lobby-board-card__glyph">
            {ok ? (ok.title.trim()[0] ?? 'B').toUpperCase() : ''}
          </span>
        )}
      </div>
      <figcaption className="lobby-board-card__text">
        <span className="lobby-board-card__title" data-testid="board-card-title" title={title}>
          {title}
        </span>
        {ok?.frameName ? (
          <span className="lobby-board-card__frame" data-testid="board-card-frame" title={ok.frameName}>
            {ok.frameName}
          </span>
        ) : null}
      </figcaption>
      <a
        className="lobby-board-card__open dr-interactive"
        data-testid="board-card-open"
        href={path}
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        title={ok ? `Open ${ok.title}` : 'Open the board'}
        draggable={false}
        {...handlers}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="lobby-board-card__open-label">Open</span>
      </a>
    </figure>
  )
}
