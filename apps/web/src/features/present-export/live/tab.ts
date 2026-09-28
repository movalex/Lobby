// This browser tab's own id for present-live. The api remembers which tab presents, so a reload of
// that tab (same sessionStorage) goes straight back to presenting, while the presenter's other tabs
// know they are not the presenting one. The id is random and grants nothing: every route checks the
// signed-in user. (A tab the browser duplicates copies sessionStorage, and with it this id.)

import { PRESENTER_TAB_PATTERN } from '@draftroom/contracts'

const TAB_KEY = 'draftroom:present-tab'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function randomTabId(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  let id = 'tab_'
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length]
  return id
}

let cached: string | null = null

/** This tab's id: kept in sessionStorage (survives a reload of this tab), made up on first use. */
export function presenterTabId(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = sessionStore(),
): string {
  if (cached) return cached
  try {
    const stored = storage?.getItem(TAB_KEY)
    if (stored && PRESENTER_TAB_PATTERN.test(stored)) {
      cached = stored
      return stored
    }
  } catch {
    // blocked storage: a new id for this page load
  }
  const id = randomTabId()
  try {
    storage?.setItem(TAB_KEY, id)
  } catch {
    // the id lasts for this page load only
  }
  cached = id
  return id
}
