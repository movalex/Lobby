// Draftroom's own line icons for canvas-ux (dock rail, toolbar, selection bar). 24px grid, currentColor.

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

export const SearchIcon = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l5 5" />
  </Svg>
)

export const FramesIcon = () => (
  <Svg>
    <rect x="3" y="4" width="7" height="6" rx="1" />
    <rect x="14" y="4" width="7" height="6" rx="1" />
    <rect x="3" y="14" width="7" height="6" rx="1" />
    <path d="M14 15h7M14 19h5" />
  </Svg>
)

export const TemplatesIcon = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 9v12" />
  </Svg>
)

export const LinkIcon = () => (
  <Svg size={16}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
)

export const DragHandleIcon = () => (
  <Svg size={14}>
    <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth="3" />
  </Svg>
)

export const EyeOffIcon = () => (
  <Svg size={16}>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3 3.8M6.2 6.2A17 17 0 0 0 2.5 12S6 19 12 19a9.6 9.6 0 0 0 4.6-1.2" />
  </Svg>
)

export const ArrowUpIcon = () => (
  <Svg size={14}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
)
export const ArrowDownIcon = () => (
  <Svg size={14}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
)

export const LockIcon = () => (
  <Svg size={16}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
)

/** Arrange as grid (selection bar, MAK-18). */
export const GridIcon = () => (
  <Svg size={16}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <rect x="14" y="14" width="6" height="6" rx="1" />
  </Svg>
)

// Align / distribute (selection bar, MAK-03)
export const AlignIcons = {
  left: () => (
    <Svg size={16}>
      <path d="M4 3v18M8 7h10M8 15h6" strokeWidth="2.2" />
    </Svg>
  ),
  centerH: () => (
    <Svg size={16}>
      <path d="M12 3v18M6 7h12M8 15h8" strokeWidth="2.2" />
    </Svg>
  ),
  right: () => (
    <Svg size={16}>
      <path d="M20 3v18M6 7h10M10 15h6" strokeWidth="2.2" />
    </Svg>
  ),
  top: () => (
    <Svg size={16}>
      <path d="M3 4h18M7 8v10M15 8v6" strokeWidth="2.2" />
    </Svg>
  ),
  centerV: () => (
    <Svg size={16}>
      <path d="M3 12h18M7 6v12M15 8v8" strokeWidth="2.2" />
    </Svg>
  ),
  bottom: () => (
    <Svg size={16}>
      <path d="M3 20h18M7 6v10M15 10v6" strokeWidth="2.2" />
    </Svg>
  ),
  distH: () => (
    <Svg size={16}>
      <path d="M4 4v16M20 4v16M10 8v8M14 8v8" strokeWidth="2.2" />
    </Svg>
  ),
  distV: () => (
    <Svg size={16}>
      <path d="M4 4h16M4 20h16M8 10h8M8 14h8" strokeWidth="2.2" />
    </Svg>
  ),
}
