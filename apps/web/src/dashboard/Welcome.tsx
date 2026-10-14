// The Welcome card (wave P, P-002, P-009): a person's first visit to the dashboard. What Lobby is, three one-click
// starts (a blank board, a template, the Lobby tour) and the keys to know, in place of a changelog for a product they
// have not seen. A plain function of its props (no hooks), like WhatsNewCard, so a component test can press its buttons;
// DashboardPage owns the state and makes the boards.
import type { StartChoice } from './start-row-model.ts'
import { WELCOME_INTRO, WELCOME_STARTS, welcomeShortcuts } from './welcome.ts'

export const WELCOME_HEADING_ID = 'dr-welcome-h'

export function WelcomeCard({
  canCreate,
  pending = null,
  apple = false,
  onStart,
  onMoreTemplates,
  onDismiss,
}: {
  /** They may make boards here: the three starts show. Someone who may not is told how boards reach them instead. */
  canCreate: boolean
  /** The start whose board is being made (every start waits for it), or null. */
  pending?: StartChoice | null
  apple?: boolean
  onStart(choice: StartChoice): void
  /** "More templates": opens the template picker (creators only). */
  onMoreTemplates(): void
  onDismiss(): void
}) {
  return (
    <section className="dr-welcome" aria-labelledby={WELCOME_HEADING_ID} data-testid="welcome">
      <div className="dr-welcome__head">
        <h2 id={WELCOME_HEADING_ID} className="dr-welcome__title">
          Welcome to Lobby
        </h2>
        <button
          type="button"
          className="dr-iconbtn dr-welcome__close"
          data-testid="welcome-dismiss"
          aria-label="Dismiss the welcome"
          title="Dismiss"
          onClick={onDismiss}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <p className="dr-welcome__intro">{WELCOME_INTRO}</p>
      {canCreate ? (
        <>
          <ul className="dr-welcome__starts" aria-label="Start with">
            {WELCOME_STARTS.map((s) => (
              <li key={s.choice}>
                <button
                  type="button"
                  className={`dr-btn dr-welcome__start${s.choice === 'blank' ? ' dr-btn--primary' : ''}`}
                  data-testid="welcome-start"
                  data-template-id={s.choice}
                  disabled={pending !== null}
                  aria-busy={pending === s.choice || undefined}
                  onClick={() => onStart(s.choice)}
                >
                  <strong>{pending === s.choice ? 'Creating…' : s.name}</strong>
                  <span>{s.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="dr-btn dr-btn--ghost dr-btn--sm dr-welcome__more"
            data-testid="welcome-more-templates"
            disabled={pending !== null}
            onClick={onMoreTemplates}
          >
            More templates
          </button>
        </>
      ) : (
        <p className="dr-welcome__noboards" data-testid="welcome-no-create">
          Boards appear here when someone shares one with you. Open one to start.
        </p>
      )}
      <dl className="dr-welcome__keys" aria-label="Keys to know">
        {welcomeShortcuts(apple).map((k) => (
          <div key={k.keys} className="dr-welcome__key">
            <dt>
              <kbd>{k.keys}</kbd>
            </dt>
            <dd>{k.does}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
