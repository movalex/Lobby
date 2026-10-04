/**
 * Which groups a restored selection may hand to the engine as selected (board/session.ts `select`, the
 * undo controller's F11 restore). NODE-SAFE: plain data, no engine.
 */

/** What this reads of an element: Excalidraw's elements and the headless scene's both have it. */
export interface GroupedElement {
  readonly id: string
  readonly isDeleted?: boolean
  readonly groupIds?: readonly string[]
}

/**
 * F2 (wave F; the E2 follow-up): `groups` without any group that has a hidden member. An undo or a redo
 * restores a selection as the ids it was made with plus the groups among them (`selectedGroups`,
 * history/controller.ts), and the history does not know the feature registries' hidden ids (a collapsed
 * mind-map branch, say). The port's `select` leaves a hidden id out of the selection, but `selectedGroupIds`
 * naming the group would still make Excalidraw draw the group's box and move the group over every member,
 * the hidden one included: a restore selecting a hidden element through its group. Such a group comes back as
 * its visible members instead. Only live members count (a deleted element is neither drawn nor moved).
 */
export function groupsWithoutHiddenMembers(
  groups: readonly string[],
  elements: readonly GroupedElement[],
  isHidden: (id: string) => boolean,
): readonly string[] {
  if (groups.length === 0) return groups
  const wanted = new Set(groups)
  const withHidden = new Set<string>()
  for (const el of elements) {
    if (el.isDeleted || !el.groupIds) continue
    const mine = el.groupIds.filter((g) => wanted.has(g) && !withHidden.has(g))
    if (mine.length > 0 && isHidden(el.id)) for (const g of mine) withHidden.add(g)
  }
  return withHidden.size === 0 ? groups : groups.filter((g) => !withHidden.has(g))
}
