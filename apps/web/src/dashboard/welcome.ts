// The Welcome card and the Help menu's shortcuts (wave P, P-002, P-009, P-010): what a brand-new teammate sees on the
// dashboard before they have a board, and the keys they need on day one. Pure data; Welcome.tsx and HelpShortcuts.tsx
// draw it. The keys are the board's own (canvas/input/keymap.ts and the canvas-ux tool keys); a board's "?" lists them all.
import type { StartChoice } from './start-row-model.ts'

/** What Lobby is, in one sentence a Miro user needs. */
export const WELCOME_INTRO =
  'Lobby is where the team brainstorms, plans and runs sessions together on one shared board. Everyone sees changes as they happen.'

/** The three one-click starts: a blank board, a template, the Lobby tour. Their names are the Start row's. */
export const WELCOME_STARTS: readonly { readonly choice: StartChoice; readonly name: string; readonly hint: string }[] = [
  { choice: 'blank', name: 'Blank board', hint: 'An empty canvas' },
  { choice: 'brainstorm', name: 'Brainstorm', hint: 'Notes to fill in with the team' },
  { choice: 'lobby-tour', name: 'Lobby tour', hint: 'A board that shows what Lobby can do' },
]

export interface ShortcutLine {
  readonly keys: string
  readonly does: string
}

/** True on a Mac, iPhone or iPad: the key written as ⌘ rather than Ctrl. */
export function isApplePlatform(
  nav: Pick<Navigator, 'platform' | 'userAgent'> | undefined = globalThis.navigator,
): boolean {
  return !!nav && /Mac|iPhone|iPad|iPod/i.test(`${nav.platform} ${nav.userAgent}`)
}

/** A chord with the platform's modifier: ⌘K on a Mac, Ctrl+K elsewhere (`rest` may start with Shift+). */
const modifier = (apple: boolean) => (rest: string) =>
  apple ? `⌘${rest.replace('Shift+', '⇧')}` : `Ctrl+${rest}`

/** The shortcuts to know on day one, written for this platform. */
export function welcomeShortcuts(apple: boolean): readonly ShortcutLine[] {
  const mod = modifier(apple)
  return [
    { keys: mod('K'), does: 'Search or do anything' },
    { keys: 'N · T · R', does: 'Sticky note, text, rectangle' },
    { keys: 'Double-click', does: 'Add a sticky note anywhere' },
    { keys: 'Space + drag', does: 'Move around the board' },
    { keys: mod('Z'), does: 'Undo' },
    { keys: 'Shift+?', does: 'All shortcuts, on a board' },
  ]
}

export interface ShortcutGroup {
  readonly title: string
  readonly rows: readonly ShortcutLine[]
}

/** The Help menu's "Keyboard shortcuts": the welcome keys, the rest of the everyday ones and the dashboard's. */
export function helpShortcuts(apple: boolean): readonly ShortcutGroup[] {
  const mod = modifier(apple)
  return [
    {
      title: 'On a board',
      rows: [
        ...welcomeShortcuts(apple).filter((r) => r.keys !== 'Shift+?'),
        { keys: mod('Shift+Z'), does: 'Redo' },
        { keys: mod('D'), does: 'Duplicate the selection' },
        { keys: 'V · H', does: 'Select tool, hand tool' },
        { keys: 'L', does: 'Connector' },
        { keys: 'F', does: 'Frame' },
        { keys: 'C', does: 'Comment' },
        { keys: mod('F'), does: 'Search the board' },
        { keys: 'Shift+?', does: 'Every shortcut, with a search box' },
      ],
    },
    {
      title: 'On the dashboard',
      rows: [
        { keys: mod('K'), does: 'Search or do anything' },
        { keys: mod('E'), does: 'Search boards' },
      ],
    },
  ]
}
