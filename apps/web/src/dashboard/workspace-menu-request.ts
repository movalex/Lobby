// "Open the workspace menu" as a request (wave K, K4-5): the What's new card's "Try it" for Internal only wants to
// show the person where the control went. The sidebar folds into a "Menu" button on a phone and the workspace
// tile's panel is closed until asked, so both listen for the request (Sidebar.tsx opens its folded menu,
// WorkspaceMenu.tsx its panel). A counter, not a flag: every request is new, and one made before a listener
// mounted is not replayed.
import { atom } from '../lib/signals.ts'

export const workspaceMenuRequests = atom<number>('lobby-workspace-menu-requests', 0)

export function requestWorkspaceMenu(): void {
  workspaceMenuRequests.update((n) => n + 1)
}
