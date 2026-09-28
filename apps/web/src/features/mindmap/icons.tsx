// Line icons for mind maps (toolbar, topic bar). 24px grid, currentColor, like canvas-ux's.

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

/** A central topic with branches either side. */
export const MindmapIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="8" y="9.5" width="8" height="5" rx="1.5" />
    <path d="M16 12h1.5c1 0 1.5-.6 1.5-1.5V7.5c0-.9.5-1.5 1.5-1.5M16 12h1.5c1 0 1.5.6 1.5 1.5v3c0 .9.5 1.5 1.5 1.5" />
    <path d="M8 12H6.5C5.5 12 5 12.6 5 13.5v3c0 .9-.5 1.5-1.5 1.5" />
  </Svg>
)

/** Add a child: a topic with a new branch to its side. */
export const AddChildIcon = () => (
  <Svg>
    <rect x="3" y="8" width="8" height="8" rx="1.5" />
    <path d="M11 12h4" />
    <path d="M18.5 9v6M15.5 12h6" />
  </Svg>
)

/** Add a sibling: a topic with a new one below it. */
export const AddSiblingIcon = () => (
  <Svg>
    <rect x="6" y="3" width="12" height="7" rx="1.5" />
    <path d="M12 14v6M9 17h6" />
  </Svg>
)

export const CollapseIcon = () => (
  <Svg>
    <rect x="3" y="8" width="8" height="8" rx="1.5" />
    <path d="M11 12h3" />
    <circle cx="17.5" cy="12" r="3.5" />
    <path d="M16 12h3" />
  </Svg>
)

export const ExpandIcon = () => (
  <Svg>
    <rect x="3" y="8" width="8" height="8" rx="1.5" />
    <path d="M11 12h3" />
    <circle cx="17.5" cy="12" r="3.5" />
    <path d="M16 12h3M17.5 10.5v3" />
  </Svg>
)

/** Tidy up: evenly stacked branches. */
export const TidyIcon = () => (
  <Svg>
    <rect x="3" y="9.5" width="6" height="5" rx="1.2" />
    <rect x="15" y="3.5" width="6" height="4" rx="1.2" />
    <rect x="15" y="10" width="6" height="4" rx="1.2" />
    <rect x="15" y="16.5" width="6" height="4" rx="1.2" />
    <path d="M9 12h2.5M11.5 5.5v13M11.5 5.5H15M11.5 12H15M11.5 18.5H15" />
  </Svg>
)

/** The outline: a nested list. */
export const OutlineIcon = () => (
  <Svg>
    <path d="M4 6h10M8 11h12M8 16h9M12 20.5h8" />
    <path d="M4 6v14.5" strokeOpacity="0" />
  </Svg>
)

export const ChevronIcon = () => (
  <Svg size={14}>
    <path d="M7 10l5 5 5-5" />
  </Svg>
)
