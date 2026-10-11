/**
 * Wave N (WS1, N1-6): the dev-only full-walk counter. Dev-auth and dev builds count every walk of the whole scene by
 * its site (the scene index's build, the LOD pass, the presence hub, the frame-name guard, the hidden-branch
 * expansion, the hit guard, and every `canvas.items()` read), so a perf spec counts walks per pointer move
 * (e2e/excalidraw/n1-drag-10k.spec.ts, `window.__lobbyWalks`). A production build counts nothing: the board page's
 * scene index (canvas/api/parts/scene-index.ts) turns counting on for dev and dev-auth builds only.
 *
 * Dependency-free on purpose: the presence hub, the LOD pass and the hit guard import it, and some of them are
 * compiled into apps/sync's own tests.
 */
let counting = false
const walks = new Map<string, number>()

/** Turns the counter on (dev and dev-auth builds) or off. */
export function setSceneWalkCounting(on: boolean): void {
  counting = on
}

/** Counts one walk of the whole scene at `site` (a no-op unless counting is on). */
export function noteSceneWalk(site: string): void {
  if (counting) walks.set(site, (walks.get(site) ?? 0) + 1)
}

/** The walks counted so far, by site. */
export function sceneWalks(): Record<string, number> {
  return Object.fromEntries(walks)
}

export function resetSceneWalks(): void {
  walks.clear()
}

/** Whether walks are counted in this build. */
export const sceneWalksCounted = (): boolean => counting
