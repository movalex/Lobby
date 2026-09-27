// Per-browser dashboard preferences (never identity or access). Storage may be missing or throw
// (private windows, blocked site data): every access is guarded and failure means "default".

export type ViewMode = 'grid' | 'list'

type ReadStore = Pick<Storage, 'getItem'> | null
type WriteStore = Pick<Storage, 'setItem' | 'removeItem'> | null

const VIEW_KEY = 'draftroom:dashboard-view'
const pickerKey = (userId: string) => `draftroom:template-picker-hidden:${userId}`

export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readViewMode(store: ReadStore = browserStorage()): ViewMode {
  try {
    return store?.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export function writeViewMode(mode: ViewMode, store: WriteStore = browserStorage()) {
  try {
    store?.setItem(VIEW_KEY, mode)
  } catch {
    // not remembered
  }
}

/** PRE-01: "Don't show on new boards" is a per-user choice (keyed by user id in this browser). */
export function readPickerHidden(userId: string, store: ReadStore = browserStorage()): boolean {
  try {
    return store?.getItem(pickerKey(userId)) === '1'
  } catch {
    return false
  }
}

export function writePickerHidden(userId: string, hidden: boolean, store: WriteStore = browserStorage()) {
  try {
    if (hidden) store?.setItem(pickerKey(userId), '1')
    else store?.removeItem(pickerKey(userId))
  } catch {
    // not remembered: the picker shows again next time
  }
}
