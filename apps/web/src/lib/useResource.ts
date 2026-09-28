import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client.ts'

export type Resource<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: ApiError }

/**
 * Loads `load` (memoize it with useCallback: a new identity means "fetch again"), aborting the
 * previous request. A reload keeps showing the previous data until the new data arrives, so lists do
 * not flash empty after every mutation.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Resource<T>>({ status: 'loading', data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  // Functions passed to useState are initializers, hence the wrapper.
  const [loadedFor, setLoadedFor] = useState(() => load)

  // A different loader (e.g. another workspace) must not show the previous loader's data.
  if (loadedFor !== load) {
    setLoadedFor(() => load)
    setState({ status: 'loading', data: null, error: null })
  }

  useEffect(() => {
    void attempt // re-run on reload()
    const controller = new AbortController()
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data, error: null })
      },
      (e: unknown) => {
        if (controller.signal.aborted) return
        const error = e instanceof ApiError ? e : new ApiError('network', 0, 'NETWORK', "Can't reach Lobby.")
        setState({ status: 'error', data: null, error })
      },
    )
    return () => controller.abort()
  }, [load, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  /** Local update after a successful mutation (the next reload replaces it with server truth). */
  const update = useCallback(
    (fn: (data: T) => T) => setState((s) => (s.status === 'ready' ? { ...s, data: fn(s.data) } : s)),
    [],
  )
  return { ...state, reload, update }
}
