// Dev-auth builds only (the e2e build): `window.__lobbyNavigation`, so the ported specs can run this
// feature's commands and its context-menu, board-menu and selection-bar entries with the page's feature
// context while the shells that render them (3a's context menu, board menu and selection bar) are not
// on the page yet, and read what those shells would show. Never installed in a normal build.
import type { CanvasFeatureContext, MenuEntrySpec, MenuTarget } from '../../../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../../../lib/identity.ts'

export interface NavigationDevHook {
  /** runs a command of the registry by id (as its menu entry or key would); false when disabled or unknown */
  run(commandId: string): Promise<boolean>
  /** the visible entries of a menu (submenus flattened as `parent/child`), with their labels */
  entries(menu: 'contextMenu' | 'mainMenu'): { id: string; label: string }[]
  /** runs a visible menu entry (`parent/child` for a submenu entry); false when it is not shown */
  menu(menu: 'contextMenu' | 'mainMenu', path: string): Promise<boolean>
  /** the selection-bar items that would show for the current selection */
  selectionBar(): string[]
}

declare global {
  interface Window {
    __lobbyNavigation?: NavigationDevHook
  }
}

export function installNavigationDevHook(ctx: CanvasFeatureContext): () => void {
  if (!DEV_AUTH_ENABLED) return () => {}
  const r = ctx.registries
  const target = (): MenuTarget => ({ ids: ctx.canvas.selection, point: null, hit: null })
  const labelOf = (e: MenuEntrySpec, t: MenuTarget) =>
    typeof e.label === 'function' ? e.label(ctx, t) : e.label
  const shown = (e: MenuEntrySpec, t: MenuTarget) => (e.visible ? e.visible(ctx, t) : true)
  const flat = (menu: 'contextMenu' | 'mainMenu') => {
    const t = target()
    const out: { id: string; label: string; entry: MenuEntrySpec }[] = []
    for (const e of r.sorted(r[menu])) {
      if (!shown(e, t)) continue
      out.push({ id: e.id, label: labelOf(e, t), entry: e })
      for (const s of e.submenu ?? [])
        if (shown(s, t)) out.push({ id: `${e.id}/${s.id}`, label: labelOf(s, t), entry: s })
    }
    return out
  }
  const run = async (commandId: string) => {
    const cmd = r.commands.get(commandId)
    if (!cmd) return false
    if (ctx.canvas.readOnly() && !cmd.readOnlyAllowed) return false
    if (cmd.enabled && !cmd.enabled(ctx)) return false
    await cmd.run(ctx, 'api')
    return true
  }
  const hook: NavigationDevHook = {
    run,
    entries: (menu) => flat(menu).map(({ id, label }) => ({ id, label })),
    async menu(menu, path) {
      const e = flat(menu).find((x) => x.id === path)?.entry
      if (!e) return false
      if (e.disabled?.(ctx, target())) return false
      if (e.run) {
        await e.run(ctx, target())
        return true
      }
      return e.command ? run(e.command) : false
    },
    selectionBar: () => {
      const sel = ctx.canvas.selection
      return r
        .sorted(r.selectionBar)
        .filter((s) => (s.visible ? s.visible(ctx, sel) : true))
        .map((s) => s.id)
    },
  }
  window.__lobbyNavigation = hook
  return () => {
    if (window.__lobbyNavigation === hook) delete window.__lobbyNavigation
  }
}
