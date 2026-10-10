// OWNER: W3 (wave M, M3-1, FTU-4.2). "Search or do… Ctrl+K": the palette's on-screen entry in the board's top bar. Most of
// wave L sat behind Ctrl+K or a right-click submenu, so a person on a touch screen or with only a mouse could not find it.
// The button is a top-bar item of this feature (the topBar registry: chrome.tsx is unchanged). It is not pinned, so
// a tablet, a phone and a crowded bar fold it into the "⋯" menu (topbar-fit.ts `topBarPlan`); a bar that is only a little
// crowded shows its search icon alone (the `palette` compact step; the rules are in ./palette.css). It runs the
// palette's own command 'command-palette.open', which opens an empty field with no line chosen (a reflex Enter runs
// nothing, L3-2).
import { type CanvasFeatureContext, currentPlatform, formatChord } from '../../canvas/api/index.ts'
import { runCommand } from '../canvas-ux/ported/commands.ts'
import { ariaKeys } from '../canvas-ux/ported/Toolbar.tsx'
import { PALETTE_COMMAND_ID } from './ids.ts'

/** The button's name and its visible words. */
export const PALETTE_BUTTON_LABEL = 'Search or do…'
export const PALETTE_CHORD = 'mod+k'

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" data-icon="search">
      <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M15 15l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function PaletteButton({ ctx }: { readonly ctx: CanvasFeatureContext }) {
  const hint = formatChord(PALETTE_CHORD, currentPlatform())
  return (
    <button
      type="button"
      className="dr-btn dr-btn--sm dr-topbar__palette"
      data-testid="topbar-palette"
      // the visible words are the name (WCAG label in name); the key is announced by aria-keyshortcuts
      aria-label={PALETTE_BUTTON_LABEL}
      aria-keyshortcuts={ariaKeys(PALETTE_CHORD)}
      title={`${PALETTE_BUTTON_LABEL} (${hint})`}
      onClick={() => {
        runCommand(ctx, PALETTE_COMMAND_ID, 'toolbar', { via: 'button' })
      }}
    >
      <SearchIcon />
      <span className="dr-topbar__palette-label">{PALETTE_BUTTON_LABEL}</span>
      {/* the key is aria-keyshortcuts's to announce (the name stays its words, WCAG label in name); a span, for it is drawn as a badge */}
      <span className="dr-topbar__palette-kbd" aria-hidden="true">
        {hint}
      </span>
    </button>
  )
}
