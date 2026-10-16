// OWNER: the wave R foundation (the lead): the dashboard's Import menu and its switches (docs/WAVE-R-CONTRACTS.md §7).
// Every switch is OFF: with all of them off the dashboard shows exactly today's single "Import" button (a Lobby board
// .json). WS1 turns on `miro` (with its dialog), WS4 `backup` (with its dialog), each in the change that ships its
// routes; the lead turns on `menu` once one of them is on, in the integration.
//
// A dev-auth build (local dev and the e2e build; never a production bundle: DEV_AUTH_ENABLED) may turn a switch on for
// its page, as the Elements panel's switch does: localStorage IMPORT_MENU_KEYS[name] = '1' (or '0' to force it off),
// read when the dashboard renders. The r1-* and r5-* specs set them with an init script.
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'

export interface ImportMenuFlags {
  /** the menu itself; off: the single "Import" button of today */
  readonly menu: boolean
  /** "From Miro…" (WS1) */
  readonly miro: boolean
  /** "Lobby backup (.lobby)…" (WS4) */
  readonly backup: boolean
}

export const IMPORT_MENU_FLAGS: ImportMenuFlags = { menu: false, miro: false, backup: false }

export const IMPORT_MENU_KEYS: Readonly<Record<keyof ImportMenuFlags, string>> = {
  menu: 'lobby.importMenu',
  miro: 'lobby.importMiro',
  backup: 'lobby.importBackup',
}

/** The switches of this page: the shipped ones, or a dev-auth page's overrides (each read in try/catch). */
export function importMenuFlags(
  devAuth: boolean = DEV_AUTH_ENABLED,
  read: (key: string) => string | null | undefined = (key) => globalThis.localStorage?.getItem(key),
): ImportMenuFlags {
  if (!devAuth) return IMPORT_MENU_FLAGS
  const one = (name: keyof ImportMenuFlags): boolean => {
    try {
      const v = read(IMPORT_MENU_KEYS[name])
      return v === '1' ? true : v === '0' ? false : IMPORT_MENU_FLAGS[name]
    } catch {
      return IMPORT_MENU_FLAGS[name]
    }
  }
  return { menu: one('menu'), miro: one('miro'), backup: one('backup') }
}
