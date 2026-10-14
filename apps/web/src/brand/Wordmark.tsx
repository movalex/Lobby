// The Lobby brand (Dark Burn Creative's "square L"): an L-shaped room with an orange node in its open
// corner. The L takes `--dr-mark-ink` (charcoal on light surfaces, paper on dark ones: `tone="on-dark"`
// or a theme that redefines the property); the node is always DBC orange. Source artwork: the
// everyday mark is `sl-notile-mark.svg`, the favicon `public/favicon.svg`, the sign-in hero
// `public/brand/lobby-hero.svg`. The product is "Lobby"; internal code names (packages, env vars,
// storage keys, CSS prefixes) stay "draftroom".

const L_PATH =
  'M4.9 1.5H10.8A1.2 1.2 0 0 1 12 2.7V11.25A0.75 0.75 0 0 0 12.75 12H21.3A1.2 1.2 0 0 1 22.5 13.2V19.1A3.4 3.4 0 0 1 19.1 22.5H4.9A3.4 3.4 0 0 1 1.5 19.1V4.9A3.4 3.4 0 0 1 4.9 1.5Z'
const NODE_PATH =
  'M16.2 1.5H21.3A1.2 1.2 0 0 1 22.5 2.7V7.8A1.2 1.2 0 0 1 21.3 9H16.2A1.2 1.2 0 0 1 15 7.8V2.7A1.2 1.2 0 0 1 16.2 1.5Z'
const NODE_ORANGE = '#FE5A05'

type Tone = 'auto' | 'on-dark'

/** The everyday mark, inline so it follows the surface it sits on. Decorative: pair it with a name. */
export function Mark({ size = 24, tone = 'auto' }: { size?: number; tone?: Tone }) {
  return (
    <svg
      className={tone === 'on-dark' ? 'dr-mark dr-mark--on-dark' : 'dr-mark'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={L_PATH} fill="currentColor" />
      <path d={NODE_PATH} fill={NODE_ORANGE} />
    </svg>
  )
}

/**
 * Mark + "Lobby" (the short lockup), or "DBC Lobby" (`variant="dbc"`, kept for a lockup that names the company; nothing uses it since wave P: the product is "Lobby" everywhere). The text
 * is real text, so the accessible name is the product name. `mark={false}` drops the mark where a
 * larger one (the sign-in hero) already stands next to it.
 */
export function Wordmark({
  size = 'md',
  variant = 'short',
  mark = true,
  tone = 'auto',
}: {
  size?: 'md' | 'lg'
  variant?: 'short' | 'dbc'
  mark?: boolean
  tone?: Tone
}) {
  const classes = ['dr-wordmark', `dr-wordmark--${size}`]
  if (tone === 'on-dark') classes.push('dr-wordmark--on-dark')
  return (
    <span className={classes.join(' ')}>
      {mark && <Mark size={size === 'lg' ? 44 : 26} tone={tone} />}
      <span className="dr-wordmark__text">
        {variant === 'dbc' && (
          <>
            <span className="dr-wordmark__org">DBC</span>{' '}
          </>
        )}
        <span className="dr-wordmark__name">Lobby</span>
      </span>
    </span>
  )
}
