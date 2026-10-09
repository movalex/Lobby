// The Pieces panel's icon in the dock rail: four small shapes, as a kit. 24px grid, currentColor.
export function PiecesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <circle cx="17" cy="7" r="3.5" />
      <path d="M7 14l3.5 6h-7z" />
      <rect x="13.5" y="14" width="7" height="6" rx="3" />
    </svg>
  )
}
