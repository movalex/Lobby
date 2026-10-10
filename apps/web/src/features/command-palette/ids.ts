// OWNER: W3 (wave M; the topbar id was frozen by the wave M foundation). The on-screen palette entry's topBar item id
// (M3-1): the topBar registry item the command-palette feature registers ("Search or do… Ctrl+K"), which topbar-fit
// folds into the overflow menu at narrow widths. The command it runs is PALETTE_COMMAND_ID ('command-palette.open').
// Both ids live in this tiny file so another feature (the phone sheet) can name them without loading the palette.
export const COMMAND_PALETTE_TOPBAR_ID = 'command-palette'

/** The palette's own command (it is not listed in itself). */
export const PALETTE_COMMAND_ID = 'command-palette.open'
