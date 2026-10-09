// Glyphs for the AI feature (currentColor, so both themes work).

export function SparkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" fill="currentColor" />
      <path
        d="M19 14.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z"
        fill="currentColor"
        opacity="0.7"
      />
    </svg>
  )
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="dr-ai-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

const ICONS = {
  summarize: (
    <path
      d="M5 6h14M5 10h14M5 14h9M5 18h6"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      fill="none"
    />
  ),
  themes: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3.5" y="4" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="4" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="14" width="7" height="6" rx="1.5" />
      <path d="M14 16.5h6M14 19.5h4" strokeLinecap="round" />
    </g>
  ),
  actions: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7l2 2 3.5-3.5M4 15l2 2 3.5-3.5" />
      <path d="M12.5 8h7.5M12.5 16h7.5" />
    </g>
  ),
  ideas: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
    </g>
  ),
  // K7: a topic with three new sub-topics, and a hub with a ring of branches
  expand: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="9.5" width="7" height="5" rx="1.5" />
      <path d="M10 12h3.5M13.5 12V6.5H16M13.5 12V12H16M13.5 12v5.5H16" />
      <rect x="16" y="4.5" width="5" height="4" rx="1.2" />
      <rect x="16" y="10" width="5" height="4" rx="1.2" />
      <rect x="16" y="15.5" width="5" height="4" rx="1.2" />
    </g>
  ),
  mindmap: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8.5" y="9.5" width="7" height="5" rx="1.5" />
      <path d="M8.5 12H6M15.5 12H18M12 9.5V7M12 14.5V17" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="19.5" cy="12" r="1.6" />
      <circle cx="12" cy="5.5" r="1.6" />
      <circle cx="12" cy="18.5" r="1.6" />
    </g>
  ),
  // wave L: a speech bubble with a question mark (Ask this board), a list closed by a check (Wrap up)
  ask: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5h16v10H10l-4 3.5v-3.5H4z" />
      <path d="M10.2 8.8a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3M12 13.8v.1" />
    </g>
  ),
  recap: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 8h8M8 11.5h8M8 15l1.8 1.8L13.5 13" />
    </g>
  ),
} as const

export function ActionIcon({ action }: { action: keyof typeof ICONS }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[action]}
    </svg>
  )
}
