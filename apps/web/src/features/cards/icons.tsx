// OWNER: WS4 (wave T). The cards' icons (inline SVG, currentColor): one per status, so a status never rests on colour
// alone, and the field icons of the chips, the popover and the table. The same paths draw into exports (./export.ts).
import type { CardStatus } from './model.ts'

/** Each status icon's path data in a 16 x 16 box (stroked, round caps), shared with the export layer. */
export const STATUS_PATHS: Readonly<Record<CardStatus, readonly string[]>> = {
  // an open circle
  todo: ['M8 2.75a5.25 5.25 0 1 0 0 10.5a5.25 5.25 0 1 0 0-10.5z'],
  // a circle with its first half filled by a stroke
  doing: ['M8 2.75a5.25 5.25 0 1 0 0 10.5a5.25 5.25 0 1 0 0-10.5z', 'M8 5.25v2.75l2 1.5'],
  // an eye
  review: [
    'M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8s-2.25 4.25-6.25 4.25S1.75 8 1.75 8z',
    'M8 6.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2z',
  ],
  // a no-entry sign
  blocked: ['M8 2.75a5.25 5.25 0 1 0 0 10.5a5.25 5.25 0 1 0 0-10.5z', 'M4.4 11.6l7.2-7.2'],
  // a check in a circle
  done: ['M8 2.75a5.25 5.25 0 1 0 0 10.5a5.25 5.25 0 1 0 0-10.5z', 'M5.4 8.2l1.8 1.8l3.4-3.6'],
}

interface IconProps {
  readonly size?: number
}

function Svg({ size, children, status }: { size: number; children: React.ReactNode; status?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-status-icon={status}
    >
      {children}
    </svg>
  )
}

export function StatusIcon({ status, size = 14 }: IconProps & { readonly status: CardStatus }) {
  return (
    <Svg size={size} status={status}>
      {STATUS_PATHS[status].map((d) => (
        <path key={d} d={d} />
      ))}
    </Svg>
  )
}

export function CalendarIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </Svg>
  )
}

export function AlertIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 2.25l6 10.5H2z" />
      <path d="M8 6.5v3M8 11.4v.1" />
    </Svg>
  )
}

export function PersonIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="8" cy="5.5" r="2.6" />
      <path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
    </Svg>
  )
}

export function LinkIcon({ size = 14 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6.6 9.4l2.8-2.8" />
      <path d="M7.3 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1M8.7 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1" />
    </Svg>
  )
}

export function CardIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.75" />
      <path d="M4.75 6h6.5M4.75 8.5h4" />
      <circle cx="11" cy="11" r=".4" />
    </Svg>
  )
}

export function TableIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M2 9.75h12M6.5 3v10" />
    </Svg>
  )
}

export function KanbanIcon({ size = 18 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="6.25" y="2.5" width="3.5" height="7.5" rx="1" />
      <rect x="10.5" y="2.5" width="3.5" height="9.25" rx="1" />
    </Svg>
  )
}
