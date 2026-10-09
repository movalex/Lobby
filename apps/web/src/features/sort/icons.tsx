// Line icons of the sort feature. 24px grid, currentColor, decorative (the buttons carry their words).
import type { ReactNode } from 'react'

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Three columns of notes under their headings. */
export const SortIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 4h4M10 4h4M16 4h4" />
    <rect x="4" y="8" width="4" height="5" rx="1" />
    <rect x="4" y="16" width="4" height="4" rx="1" />
    <rect x="10" y="8" width="4" height="4" rx="1" />
    <rect x="16" y="8" width="4" height="6" rx="1" />
  </Svg>
)

/** A 2x2 with a note in one square. */
export const MatrixIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 3v18M3 12h18" />
    <rect x="14.5" y="5.5" width="4" height="4" rx="0.8" />
  </Svg>
)
