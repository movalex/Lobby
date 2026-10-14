// "Start something" (wave K, K4-1): the row of templates above Recent boards. The pure side: which tiles it
// offers, in which order, and who sees it. The row never decides who may create (the api answers 403
// CREATOR_REQUIRED either way); it only hides what a person cannot use, like New board does.
import type { DashboardSection } from '../lib/routing.ts'
import type { CatalogEntry } from './template-catalog.ts'
import type { NewBoardTemplateId } from './template-paths.ts'

export type StartChoice = NewBoardTemplateId | 'blank'

/**
 * The tiles, in order: a blank board first, the Lobby tour, the four everyday templates (Brainstorm, Retro,
 * Mood board, Storyboard), then the six that match the agency's daily work (K4-2). Pitch outline and Production
 * plan stay in the full picker (New board). The names are the catalog's (a test keeps them equal), so a tile
 * reads right before the catalog module has loaded.
 */
export const START_TILES: readonly { readonly choice: StartChoice; readonly name: string }[] = [
  { choice: 'blank', name: 'Blank board' },
  { choice: 'lobby-tour', name: 'Lobby tour' },
  { choice: 'brainstorm', name: 'Brainstorm' },
  { choice: 'retrospective', name: 'Retrospective' },
  { choice: 'mood-board', name: 'Mood board' },
  { choice: 'storyboard', name: 'Storyboard' },
  { choice: 'creative-brief', name: 'Creative brief' },
  { choice: 'client-feedback', name: 'Client feedback round' },
  { choice: 'shot-list', name: 'Shot list' },
  { choice: 'launch-timeline', name: 'Launch timeline' },
  { choice: 'prioritisation-2x2', name: '2x2 prioritisation' },
  { choice: 'kanban', name: 'Kanban columns' },
]

export interface StartTile {
  choice: StartChoice
  name: string
  /** null for the blank board, and for every tile until the catalog has loaded (its thumbnail). */
  entry: CatalogEntry | null
}

/** The tiles with their catalog entries once the catalog is there. */
export function startTiles(catalog: readonly CatalogEntry[] | null): StartTile[] {
  return START_TILES.map(({ choice, name }) => {
    const entry = choice === 'blank' ? null : (catalog?.find((e) => e.id === choice) ?? null)
    return { choice, name: entry?.name ?? name, entry }
  })
}

/**
 * Whether this person gets the row at all (as against it being hidden for now, by a search or another view):
 * creators who can make boards here and are not a name-only guest. Someone who ticked "Don't show templates
 * on new boards" asked not to be shown templates, so they get the plain "Templates" button instead. The
 * What's new card asks the same question before it talks about the row.
 */
export function startRowOffered(input: {
  canCreate: boolean
  guest: boolean
  pickerHidden: boolean
}): boolean {
  return input.canCreate && !input.guest && !input.pickerHidden
}

/**
 * Whether the dashboard shows the row right now: to those it is offered to (`startRowOffered`; `canCreate` is
 * the same flag as New board), on the landing view, while nothing is searched.
 */
export function showStartRow(input: {
  canCreate: boolean
  guest: boolean
  section: DashboardSection
  searching: boolean
  pickerHidden: boolean
}): boolean {
  return startRowOffered(input) && input.section.kind === 'recent' && !input.searching
}

/**
 * The title a board made from a tile starts with: the template's name, or "Untitled board". Before the catalog has
 * loaded (the Welcome card and the Help menu start a template without it) the tile's own name stands in.
 */
export function startTitle(entry: Pick<CatalogEntry, 'name'> | null, choice?: StartChoice): string {
  if (entry) return entry.name
  if (choice === 'blank') return 'Untitled board'
  return START_TILES.find((t) => t.choice === choice)?.name ?? 'Untitled board'
}
