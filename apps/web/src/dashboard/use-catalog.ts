// The template catalog module, loaded on demand. It pulls in the template builders (every template's plan),
// so the dashboard's first paint never carries it: the picker loads it when it opens, and the "Start
// something" row loads it once the page has had its first paint (the row's tiles have names at once; the
// thumbnails come with the catalog).
import { useEffect, useState } from 'react'

export type Catalog = typeof import('./template-catalog.ts')

/** Loads the catalog module; `when` false waits (the row's idle load). The module is fetched once. */
export function useCatalog(when = true): { mod: Catalog | null; error: boolean } {
  const [mod, setMod] = useState<Catalog | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!when) return
    let live = true
    import('./template-catalog.ts').then(
      (m) => live && setMod(m),
      () => live && setError(true),
    )
    return () => {
      live = false
    }
  }, [when])
  return { mod, error }
}

/** Calls `run` when the browser is idle (or soon after, where it has no idle callback). Returns the cancel. */
export function whenIdle(run: () => void, timeoutMs = 1500): () => void {
  const w = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(run, { timeout: timeoutMs })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = setTimeout(run, 200)
  return () => clearTimeout(t)
}
