/**
 * `LobbyCanvas.settings` (docs/EXCALIDRAW-CONTRACTS.md §2.1): grid, snapping and focus mode, local to
 * this browser and never synced (tldraw's user preferences and instance state). Grid and snapping are
 * remembered in localStorage; focus mode (present mode, a focused view) lasts only for this page.
 *
 * The board page applies them: grid and snapping as Excalidraw's `gridModeEnabled` /
 * `objectsSnapModeEnabled` props; focus mode by hiding its chrome and every overlay layer that does not
 * say `focusMode: 'show'`.
 *
 * Pure (Node-tested): the storage is injected (a browser passes localStorage, which may throw).
 */

export interface CanvasSettings {
  readonly grid: boolean
  readonly snap: boolean
  readonly focusMode: boolean
}

export interface SettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const SETTINGS_KEY = 'lobby:canvas-settings'

const DEFAULTS: CanvasSettings = Object.freeze({ grid: false, snap: false, focusMode: false })

function read(storage: SettingsStorage | null): CanvasSettings {
  try {
    const raw = storage?.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULTS
    const v = JSON.parse(raw) as Partial<Record<keyof CanvasSettings, unknown>>
    return { grid: v.grid === true, snap: v.snap === true, focusMode: false }
  } catch {
    return DEFAULTS
  }
}

export class SettingsStore {
  private value: CanvasSettings
  private readonly listeners = new Set<() => void>()
  private readonly storage: SettingsStorage | null

  constructor(storage: SettingsStorage | null) {
    this.storage = storage
    this.value = read(storage)
  }

  get(): CanvasSettings {
    return this.value
  }

  set(patch: Partial<CanvasSettings>): void {
    const next: CanvasSettings = {
      grid: patch.grid ?? this.value.grid,
      snap: patch.snap ?? this.value.snap,
      focusMode: patch.focusMode ?? this.value.focusMode,
    }
    if (
      next.grid === this.value.grid &&
      next.snap === this.value.snap &&
      next.focusMode === this.value.focusMode
    )
      return
    const persist = next.grid !== this.value.grid || next.snap !== this.value.snap
    this.value = next
    if (persist) {
      try {
        this.storage?.setItem(SETTINGS_KEY, JSON.stringify({ grid: next.grid, snap: next.snap }))
      } catch {
        // storage blocked: the setting lasts for this page only
      }
    }
    for (const l of [...this.listeners]) l()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
