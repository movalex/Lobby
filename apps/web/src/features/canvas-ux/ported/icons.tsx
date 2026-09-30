// The tool icons of canvas-ux's own toolbar on the Excalidraw canvas (tldraw drew its own before). Line
// icons on a 24px grid in currentColor, like ../icons.tsx (which keeps the dock, selection bar and lock
// icons, reused here).
import type { ComponentType, ReactNode } from 'react'

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const SelectIcon = () => (
  <Svg>
    <path d="M6 3.5l12 7.2-5.3 1.2 3.2 5.9-2.3 1.2-3.2-5.9L6.6 17z" />
  </Svg>
)
export const HandIcon = () => (
  <Svg>
    <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14" />
    <path d="M17 10a1.5 1.5 0 0 1 3 0v4a7 7 0 0 1-7 7h-.5a6.5 6.5 0 0 1-5.4-2.9L4.4 14a1.6 1.6 0 0 1 2.6-1.8L8 13.5" />
  </Svg>
)
export const NoteIcon = () => (
  <Svg>
    <path d="M5 4h14v10l-5 6H5z" />
    <path d="M14 20v-6h5" />
  </Svg>
)
export const TextIcon = () => (
  <Svg>
    <path d="M5 6V4h14v2M12 4v16M9 20h6" />
  </Svg>
)
export const RectangleIcon = () => (
  <Svg>
    <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
  </Svg>
)
export const EllipseIcon = () => (
  <Svg>
    <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
  </Svg>
)
export const DiamondIcon = () => (
  <Svg>
    <path d="M12 3l9 9-9 9-9-9z" />
  </Svg>
)
export const PenIcon = () => (
  <Svg>
    <path d="M4 20c2-6 5-3 7-7s3-7 6-8M15 5l3 3" />
  </Svg>
)
export const ConnectorIcon = () => (
  <Svg>
    <path d="M5 19L19 5M11 5h8v8" />
  </Svg>
)
export const LineIcon = () => (
  <Svg>
    <path d="M5 19L19 5" />
  </Svg>
)
export const FrameIcon = () => (
  <Svg>
    <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />
  </Svg>
)
export const EraserIcon = () => (
  <Svg>
    <path d="M8 20h12M5.5 14.5l7.8-7.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.5z" />
    <path d="M9.5 10.5l5 5" />
  </Svg>
)
export const LaserIcon = () => (
  <Svg>
    <circle cx="16" cy="8" r="2.5" />
    <path d="M4 20l9.5-9.5" />
  </Svg>
)
export const LassoIcon = () => (
  <Svg>
    <path d="M7 16c-2.5-1-4-2.8-4-5 0-3.9 4-7 9-7s9 3.1 9 7-4 7-9 7c-1.3 0-2.5-.2-3.6-.6" />
    <path d="M8 16c0 2-1 4-3 5" />
  </Svg>
)
export const MediaIcon = () => (
  <Svg>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M20.5 16l-5-5-8.5 8.5" />
  </Svg>
)
export const MoreIcon = () => (
  <Svg>
    <path d="M6 9l6 6 6-6" />
  </Svg>
)
export const MenuIcon = () => (
  <Svg>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)
export const CheckIcon = () => (
  <Svg size={14}>
    <path d="M5 12l5 5 9-10" />
  </Svg>
)
export const ChevronRightIcon = () => (
  <Svg size={14}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
)

/** Built-in tool → its icon. */
export const TOOL_ICONS: Readonly<Record<string, ComponentType>> = {
  select: SelectIcon,
  hand: HandIcon,
  note: NoteIcon,
  text: TextIcon,
  rectangle: RectangleIcon,
  ellipse: EllipseIcon,
  diamond: DiamondIcon,
  freedraw: PenIcon,
  arrow: ConnectorIcon,
  line: LineIcon,
  frame: FrameIcon,
  eraser: EraserIcon,
  laser: LaserIcon,
  lasso: LassoIcon,
}
