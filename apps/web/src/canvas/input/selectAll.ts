// Lobby's Ctrl+A (docs/EXCALIDRAW-MIGRATION.md §2.3.3). Pure.
//
// The same set Excalidraw's select-all takes, minus every element a mind-map collapse hides (§4.7):
//  - actionSelectAll (@excalidraw/excalidraw dist/dev/index.js:3633-3672): live, unlocked, bound labels
//    excluded;
//  - then selectGroupsForSelectedElements (@excalidraw/element dist/dev/index.js:12228-12290): each
//    element's outermost group is selected, every live member of a selected group joins the selection
//    (bound labels and locked members included), and a "group" with fewer than 2 live members is not
//    selected.
// Hidden elements are never added, not even as group members. The result is installed with
// updateScene({ appState }): a selection change, no document change, no push.

export interface SelectableElement {
  id: string
  type: string
  isDeleted: boolean
  locked: boolean
  containerId?: string | null
  groupIds: readonly string[]
}

export interface SelectAllResult {
  selectedElementIds: Record<string, true>
  selectedGroupIds: Record<string, true>
}

export function computeSelectAll(
  elements: readonly SelectableElement[],
  hidden: ReadonlySet<string> = new Set(),
): SelectAllResult {
  const selectedElementIds: Record<string, true> = {}
  const groups = new Set<string>()
  for (const el of elements) {
    if (el.isDeleted || el.locked || hidden.has(el.id)) continue
    if (el.type === 'text' && el.containerId) continue
    selectedElementIds[el.id] = true
    const outer = el.groupIds[el.groupIds.length - 1]
    if (outer) groups.add(outer)
  }
  const members = new Map<string, string[]>()
  for (const el of elements) {
    if (el.isDeleted) continue
    const g = el.groupIds.find((id) => groups.has(id))
    if (!g) continue
    const list = members.get(g) ?? []
    list.push(el.id)
    members.set(g, list)
  }
  const selectedGroupIds: Record<string, true> = {}
  for (const [g, ids] of members) {
    if (ids.length < 2) continue
    selectedGroupIds[g] = true
    for (const id of ids) if (!hidden.has(id)) selectedElementIds[id] = true
  }
  return { selectedElementIds, selectedGroupIds }
}
