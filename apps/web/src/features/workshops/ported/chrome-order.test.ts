// OWNER: 3f. Where the workshops feature's chrome sits on the Excalidraw page, against the tldraw page's
// order (W5-50, the workshops part). The tldraw board puts each feature's top-bar item and dock panels in
// BOARD_FEATURES order (features/registry.ts: canvas-ux, comments, workshops, present-export, history,
// sharing, …); this page sorts them by each entry's `order` (canvas/api/registries.ts `sorted`). The
// review found Timer, Voting and Reactions after Present, Export and Private (beside Share) and the
// Voting and Private notes panels after History, at the bottom of the rail.
import { describe, expect, it } from 'vitest'
import { CANVAS_FEATURES } from '../../canvas-registry.ts'

const byOrder = <T extends { id: string; order: number }>(list: readonly T[]) =>
  [...list].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => e.id)

const topBar = byOrder(CANVAS_FEATURES.flatMap((f) => f.topBar ?? []).filter((i) => !i.pinned))
const dock = byOrder(CANVAS_FEATURES.flatMap((f) => f.panels ?? []))
const before = (list: string[], a: string, b: string) => {
  expect(list, `${a} and ${b} are both there`).toEqual(expect.arrayContaining([a, b]))
  expect(list.indexOf(a), `${a} before ${b} in ${list.join(', ')}`).toBeLessThan(list.indexOf(b))
}

describe('the workshops chrome in tldraw’s order (W5-50)', () => {
  it('top bar: Timer, Voting and Reactions come before Present and export, and Sharing', () => {
    before(topBar, 'workshops', 'present-export')
    before(topBar, 'workshops', 'sharing')
  })

  it('dock: Voting, then Private notes, right after Comments and before History', () => {
    before(dock, 'comments', 'voting')
    before(dock, 'voting', 'private-notes')
    before(dock, 'private-notes', 'history')
  })
})
