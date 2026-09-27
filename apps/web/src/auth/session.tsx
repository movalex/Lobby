import type { AuthConfig, Me } from '@draftroom/contracts'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api, isApiError, setUnauthorizedHandler } from '../api/client.ts'
import { navigate, signInPath } from '../lib/routing.ts'

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; me: Me }
  /** The API could not be reached (or answered with a 5xx) while checking the session. */
  | { status: 'unreachable'; message: string }

export type ConfigStatus = 'loading' | 'ready' | 'error'

export interface SessionValue {
  state: SessionState
  /** null until loaded, or when /api/auth/config failed (see configStatus). */
  config: AuthConfig | null
  configStatus: ConfigStatus
  retryConfig(): void
  /** Re-reads /api/me (after sign-in, invitation acceptance, workspace changes). */
  refresh(): Promise<Me | null>
  /** Ends the API session and goes to /signin (optionally coming back to `returnTo` afterwards). */
  signOut(opts?: { returnTo?: string | null }): Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function useSession(): SessionValue {
  const v = useContext(SessionContext)
  if (!v) throw new Error('useSession outside <SessionProvider>')
  return v
}

/** The signed-in user; only call below a signed-in guard. */
export function useMe(): Me {
  const { state } = useSession()
  if (state.status !== 'signed-in') throw new Error('useMe without a session')
  return state.me
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading')
  const [configAttempt, setConfigAttempt] = useState(0)
  // Responses can arrive out of order (a slow boot /api/me after a fast sign-in); only the latest counts.
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    try {
      const me = await api.me()
      if (gen === generation.current) setState({ status: 'signed-in', me })
      return me
    } catch (e) {
      if (gen !== generation.current) return null
      if (isApiError(e) && e.kind === 'unauthorized') setState({ status: 'signed-out' })
      else
        setState({
          status: 'unreachable',
          message: isApiError(e) ? e.message : "Can't reach Draftroom right now.",
        })
      return null
    }
  }, [])

  useEffect(() => {
    // Any 401 anywhere means the session ended (expired, revoked, signed out in another tab).
    setUnauthorizedHandler(() => {
      generation.current++
      setState({ status: 'signed-out' })
    })
    void refresh()
    return () => setUnauthorizedHandler(null)
  }, [refresh])

  useEffect(() => {
    const controller = new AbortController()
    setConfigStatus('loading')
    api.authConfig(controller.signal).then(
      (c) => {
        setConfig(c)
        setConfigStatus('ready')
      },
      () => {
        if (controller.signal.aborted) return
        setConfig(null)
        setConfigStatus('error')
      },
    )
    return () => controller.abort()
  }, [configAttempt])

  const retryConfig = useCallback(() => setConfigAttempt((n) => n + 1), [])

  const signOut = useCallback(async (opts: { returnTo?: string | null } = {}) => {
    generation.current++
    try {
      await api.logout()
    } catch {
      // The cookie may already be gone; either way the UI is signed out below.
    }
    // Navigate before the state change so the signed-out guard never sees the old page.
    navigate(signInPath(opts.returnTo), { replace: true })
    setState({ status: 'signed-out' })
  }, [])

  const value = useMemo<SessionValue>(
    () => ({ state, config, configStatus, retryConfig, refresh, signOut }),
    [state, config, configStatus, retryConfig, refresh, signOut],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
