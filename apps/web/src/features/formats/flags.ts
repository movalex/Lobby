// OWNER: the wave W foundation (the lead): the switches of wave W, "Formats" (docs/WAVE-W-CONTRACTS.md §1.3). With every
// switch off (a web switch, or the api's offer it needs) a user sees exactly the build before wave W: no doc card
// insert, face or panel; no Remove background; no file pages in search or Ask; no Insert as slides; no admin page.
// Each workstream turns its own switch on in the change that makes its feature live (one line, through the lead).
//
// A web switch alone never offers anything that needs the api: the api must offer it too (GET /api/auth/config
// `formats`: its kill switch, and for the three worker-backed features a capable worker seen recently; an api before
// wave W tells nothing, read as all off). `formatsEnabled(flag)` asks both when the offer is drawn.
//
// A dev-auth build (local dev and the e2e build; never a production bundle: DEV_AUTH_ENABLED) may turn a switch on for
// its page: localStorage FORMATS_FLAG_KEYS[name] = '1' (or '0' to force it off), read when asked (try/catch: a blocked
// store keeps the shipped value). The w1-* to w5-* specs set them with an init script.
import { FORMAT_SWITCHES_OFF, type FormatSwitch, type FormatsOffer } from '@draftroom/contracts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { atom } from '../../lib/signals.ts'

export interface FormatsFlags {
  /** WS1: doc cards (the insert, Text → Doc card, the formatted face, the side panel editor) */
  readonly docCards: boolean
  /** WS2: Remove background on an image (the menu row, the op's progress, the swap in one undo step) */
  readonly removeBackground: boolean
  /** WS3: file pages in Ctrl+K and the dashboard search, the ?file= deep link, file pages in Ask across boards */
  readonly fileSearch: boolean
  /** WS4: Insert as slides (a deck as frames and page images; pages past 8 through render-pages) */
  readonly deckImport: boolean
  /** WS5: the workspace admin page /w/:wid/admin and its workspace menu entry */
  readonly admin: boolean
}

export type FormatsFlag = keyof FormatsFlags

// The wave W foundation shipped every switch off; the integration turned on four, and background removal followed on
// 2026-10-19 once the owner-approved model was pinned (apps/worker/src/ops/bg-model.ts).
// Each still needs the api's offer (its kill switch, and for file search and deck import a capable worker).
export const FORMATS_FLAGS: FormatsFlags = {
  docCards: true,
  removeBackground: true,
  fileSearch: true,
  deckImport: true,
  admin: true,
}

export const FORMATS_FLAG_KEYS: Readonly<Record<FormatsFlag, string>> = {
  docCards: 'lobby.formatsDocCards',
  removeBackground: 'lobby.formatsRemoveBackground',
  fileSearch: 'lobby.formatsFileSearch',
  deckImport: 'lobby.formatsDeckImport',
  admin: 'lobby.formatsAdmin',
}

/** The api offer each web switch needs (all five need one: doc cards too, so a kill switch can hide them). */
export const FORMATS_FLAG_SERVER: Readonly<Record<FormatsFlag, FormatSwitch>> = {
  docCards: 'docCards',
  removeBackground: 'removeBackground',
  fileSearch: 'fileSearch',
  deckImport: 'deckImport',
  admin: 'admin',
}

const NAMES = Object.keys(FORMATS_FLAGS) as FormatsFlag[]

/** The switches of this page: the shipped ones, or a dev-auth page's overrides (each read in try/catch). */
export function formatsFlags(
  devAuth: boolean = DEV_AUTH_ENABLED,
  read: (key: string) => string | null | undefined = (key) => globalThis.localStorage?.getItem(key),
): FormatsFlags {
  if (!devAuth) return FORMATS_FLAGS
  const one = (name: FormatsFlag): boolean => {
    try {
      const v = read(FORMATS_FLAG_KEYS[name])
      return v === '1' ? true : v === '0' ? false : FORMATS_FLAGS[name]
    } catch {
      return FORMATS_FLAGS[name]
    }
  }
  return Object.fromEntries(NAMES.map((n) => [n, one(n)])) as unknown as FormatsFlags
}

/**
 * What this api offers (GET /api/auth/config `formats`), set by the session once the config arrives (auth/session.tsx);
 * all off until then, and for an api before wave W. A signal: an offer drawn before the config arrived redraws. The
 * worker-backed three can change while a page is open (a worker comes or goes): the session asks again only on its own
 * schedule, and the api answers every request regardless (404 while off, FILE_OP_* refusals otherwise).
 */
export const formatsOffer = atom<FormatsOffer>('lobby-formats-offer', FORMAT_SWITCHES_OFF)

/** The session's setter (auth/session.tsx): an absent or malformed `formats` is all off. */
export function setFormatsOffer(offer: Partial<FormatsOffer> | null | undefined): void {
  formatsOffer.set({
    docCards: offer?.docCards === true,
    removeBackground: offer?.removeBackground === true,
    fileSearch: offer?.fileSearch === true,
    deckImport: offer?.deckImport === true,
    admin: offer?.admin === true,
  })
}

/** Whether this page offers `flag`'s feature: its web switch AND the api's offer. */
export function formatsEnabled(
  flag: FormatsFlag,
  flags: FormatsFlags = formatsFlags(),
  server: FormatsOffer = formatsOffer.get(),
): boolean {
  return flags[flag] && server[FORMATS_FLAG_SERVER[flag]] === true
}
