// OWNER: WS3 (wave Q). The insert options bar's choices (contracts elements-panel.ts InsertOptions: colour, icon size,
// keep together, lock), remembered per viewer in browser storage: a convenience only. Every read and write is in a
// try/catch, and each field that does not parse falls back to its own default.
import { DEFAULT_INSERT_OPTIONS, InsertOptions } from '@draftroom/contracts'

export const INSERT_OPTIONS_KEY = 'lobby.elements.insertOptions'

type Store = Pick<Storage, 'getItem' | 'setItem'>
const storage = (): Store | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The options a stored value gives (unknown keys dropped; a bad field gets its default). */
export function parseInsertOptions(raw: unknown): InsertOptions {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_INSERT_OPTIONS }
  const r = raw as Record<string, unknown>
  const parsed = InsertOptions.safeParse({
    color: r.color ?? null,
    size: r.size,
    keepTogether: r.keepTogether,
    lock: r.lock,
  })
  return parsed.success ? parsed.data : { ...DEFAULT_INSERT_OPTIONS }
}

export function loadInsertOptions(store: Store | null = storage()): InsertOptions {
  try {
    const raw = store?.getItem(INSERT_OPTIONS_KEY)
    return parseInsertOptions(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_INSERT_OPTIONS }
  }
}

export function saveInsertOptions(o: InsertOptions, store: Store | null = storage()): void {
  try {
    store?.setItem(INSERT_OPTIONS_KEY, JSON.stringify(o))
  } catch {
    // no storage: the choice lasts for this page only
  }
}
