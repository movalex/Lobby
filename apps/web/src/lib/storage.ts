// Per-browser conveniences only (never identity or access). Storage can be missing or throw
// (private windows, blocked site data), so every access is guarded and failure means "no value".

const LAST_WORKSPACE_KEY = 'draftroom:last-workspace'

export function readLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY)
  } catch {
    return null
  }
}

export function writeLastWorkspace(workspaceId: string) {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId)
  } catch {
    // not persisted: "/" falls back to the first workspace
  }
}
