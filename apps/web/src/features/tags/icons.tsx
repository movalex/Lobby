// Line icons for tags (24px grid, currentColor), drawn like canvas-ux's.

import type { ReactNode } from 'react'

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
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

export const TagIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7a1 1 0 0 1 .7.3l7.8 7.8a1 1 0 0 1 0 1.4l-7.7 7.7a1 1 0 0 1-1.4 0l-7.8-7.8a1 1 0 0 1-.3-.7z" />
    <circle cx="8.2" cy="8.2" r="1.4" />
  </Svg>
)

/** "Show only": a funnel. */
export const FilterIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z" />
  </Svg>
)

export const PencilIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 20l4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z" />
    <path d="M13.8 7.2l3 3" />
  </Svg>
)
