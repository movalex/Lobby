// Loaded by apps/web/index.html before main.tsx: starts the theme controller on every page (sign-in and
// invite pages included), so "System" follows an OS switch and a choice made in another tab applies
// here too, and keeps tldraw's stored colour scheme in step before any tldraw code can read it (see
// tldraw-storage.ts). The first paint was already set by the inline script in index.html.
import { getTheme } from './theme.ts'
import { keepTldrawStorageInStep } from './tldraw-storage.ts'

function localStorageOrNull(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

keepTldrawStorageInStep(getTheme(), localStorageOrNull(), () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
)
