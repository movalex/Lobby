// "Start something" (wave K, K4-1): the template gallery's best tiles one click from the dashboard, above
// Recent boards. A click creates a private board from the tile and opens it (the same path as choosing a
// template in New board: DashboardPage's `startFromRow`, then `?template=<id>` on the board). The row is a
// plain function of its props (no hooks), so a component test can read it and press a tile.
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { StartChoice, StartTile } from './start-row-model.ts'
import { TemplateThumb } from './TemplateGallery.tsx'
import type { CatalogEntry } from './template-catalog.ts'

export const START_ROW_HEADING_ID = 'dr-start-h'

export function StartRow({
  tiles,
  pending,
  onChoose,
}: {
  tiles: readonly StartTile[]
  /** The tile whose board is being made (every tile is disabled until it is), or null. */
  pending: StartChoice | null
  /** Same shape as the picker's `onChoose`: the choice and its catalog entry (null for a blank board). */
  onChoose(choice: StartChoice, entry: CatalogEntry | null): void
}) {
  return (
    <section className="dr-start" aria-labelledby={START_ROW_HEADING_ID} data-testid="start-row">
      <h2 id={START_ROW_HEADING_ID} className="dr-dash__group-title">
        Start something
      </h2>
      <StartScroller>
        {tiles.map((t) => (
          <li key={t.choice} className="dr-start__item">
            <button
              type="button"
              className={`dr-start__tile${t.choice === 'blank' ? ' dr-start__tile--blank' : ''}`}
              data-testid="start-tile"
              data-template-id={t.choice}
              disabled={pending !== null}
              aria-busy={pending === t.choice || undefined}
              title={
                t.entry?.description ?? (t.choice === 'blank' ? 'Start from an empty canvas.' : undefined)
              }
              onClick={() => onChoose(t.choice, t.entry)}
            >
              <span className="dr-start__thumb" aria-hidden="true">
                {t.entry ? (
                  <TemplateThumb preview={t.entry.preview} />
                ) : t.choice === 'blank' ? (
                  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : null}
              </span>
              <span className="dr-start__name">{pending === t.choice ? 'Creating…' : t.name}</span>
            </button>
          </li>
        ))}
      </StartScroller>
    </section>
  )
}

/**
 * The row's scrolling list. When more tiles wait to the right (P-031: the row was cut at the edge with nothing to say
 * so) it fades out there and has a "More templates" arrow; at the end both go away. Its own component (it has state),
 * so StartRow stays a plain function.
 */
function StartScroller({ children }: { children: ReactNode }) {
  const list = useRef<HTMLUListElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = list.current
    if (el) setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 4)
  }, [])
  useEffect(() => {
    measure()
    const el = list.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])
  return (
    <div className="dr-start__scroller" data-more={more ? 'true' : 'false'} data-testid="start-scroller">
      <ul className="dr-start__list" ref={list} onScroll={measure}>
        {children}
      </ul>
      {more && (
        <button
          type="button"
          className="dr-start__next"
          data-testid="start-next"
          aria-label="Show more templates"
          title="Show more templates"
          onClick={() => {
            const el = list.current
            el?.scrollBy({ left: Math.max(200, el.clientWidth * 0.7), behavior: 'smooth' })
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M9 5l7 7-7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  )
}
