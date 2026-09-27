/** The Draftroom mark: a drafting set-square on a blueprint tile, followed by the name. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="dr-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="24" height="24" rx="6" fill="var(--dr-navy)" />
      <path
        d="M6 6.2v11.8h11.8zM8.6 12.4v3h3z"
        fill="var(--dr-amber)"
        fillRule="evenodd"
        stroke="var(--dr-amber)"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={`dr-wordmark dr-wordmark--${size}`}>
      <Mark size={size === 'lg' ? 40 : 22} />
      <span className="dr-wordmark__text">Draftroom</span>
    </span>
  )
}
