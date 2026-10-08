// The "What's new" card (wave K, K4-5): see whats-new.ts. A plain function of its props (no hooks), so a
// component test can read it and press its buttons; DashboardPage owns the state and what each "Try it" does.
import type { TryAction, WhatsNewItem } from './whats-new.ts'

export const WHATS_NEW_HEADING_ID = 'dr-whatsnew-h'

export function WhatsNewCard({
  items,
  onTry,
  onTellUs,
  onDismiss,
}: {
  items: readonly WhatsNewItem[]
  onTry(action: TryAction): void
  /** Opens the feedback dialog. */
  onTellUs(): void
  onDismiss(): void
}) {
  return (
    <section className="dr-whatsnew" aria-labelledby={WHATS_NEW_HEADING_ID} data-testid="whats-new">
      <div className="dr-whatsnew__head">
        <h2 id={WHATS_NEW_HEADING_ID} className="dr-whatsnew__title">
          What’s new in Lobby
        </h2>
        <button
          type="button"
          className="dr-iconbtn dr-whatsnew__close"
          data-testid="whats-new-dismiss"
          aria-label="Dismiss what’s new"
          title="Dismiss"
          onClick={onDismiss}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <ul className="dr-whatsnew__list">
        {items.map((item) => (
          <li key={item.id} className="dr-whatsnew__item" data-testid="whats-new-item" data-item-id={item.id}>
            <span className="dr-whatsnew__text">
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </span>
            {item.tryIt && (
              <button
                type="button"
                className="dr-btn dr-btn--sm"
                data-testid="whats-new-try"
                data-action={item.tryIt}
                aria-label={`Try it: ${item.title}`}
                onClick={() => item.tryIt && onTry(item.tryIt)}
              >
                Try it
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="dr-whatsnew__foot">
        <span>Something not right, or something missing?</span>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="whats-new-tell-us"
          onClick={onTellUs}
        >
          Tell us
        </button>
      </div>
    </section>
  )
}
