import { type AuthConfig, Me } from '@draftroom/contracts'
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
import './auth.css'
import { runSignOut, type SignOutOutcome, type SignOutProblem, sessionEnded } from './signOut.ts'
import { signedOutMarks } from './signOutMark.ts'

export type SessionState =
  | { status: 'loading' }
  /** `explicit`: the person's own Sign out finished (not a 401): the offline queues are purged (CRIT-18). */
  | { status: 'signed-out'; explicit?: true }
  | { status: 'signed-in'; me: Me }
  /** The API could not be reached (or answered with a 5xx) while checking the session. */
  | { status: 'unreachable'; message: string }

export type ConfigStatus = 'loading' | 'ready' | 'error'

export interface SignOutOptions {
  /** Where to come back to after the next sign-in ("Switch user"). */
  returnTo?: string | null
  /** SCA-4: end every session of this user on every device (POST /api/auth/sessions/revoke-all). */
  everywhere?: boolean
}

export interface SessionValue {
  state: SessionState
  /** null until loaded, or when /api/auth/config failed (see configStatus). */
  config: AuthConfig | null
  configStatus: ConfigStatus
  retryConfig(): void
  /** Re-reads the session (GET /api/auth/me; after sign-in, invitation acceptance, workspace changes). */
  refresh(): Promise<Me | null>
  /**
   * Ends the API session AND the browser's Clerk session (SCA-1), then goes to /signin (optionally
   * coming back to `returnTo` afterwards). When it could not finish, the person stays signed in and
   * the provider shows why (data-testid="signout-error") instead of a signed-out screen.
   */
  signOut(opts?: SignOutOptions): Promise<SignOutOutcome>
  /** A sign-out is running (the account menu disables its buttons). */
  signingOut: boolean
}

const SessionContext = createContext<SessionValue | null>(null)

export function useSession(): SessionValue {
  const v = useContext(SessionContext)
  if (!v) throw new Error('useSession outside <SessionProvider>')
  return v
}

/** The session, or null outside a <SessionProvider> (a component that can also be rendered bare). */
export const useSessionOrNull = (): SessionValue | null => useContext(SessionContext)

/** The signed-in user; only call below a signed-in guard. */
export function useMe(): Me {
  const { state } = useSession()
  if (state.status !== 'signed-in') throw new Error('useMe without a session')
  return state.me
}

// 204 (signed out) has no body: undefined.
const MeOrSignedOut = Me.optional()

/**
 * A11Y-17: who is signed in, through GET /api/auth/me, which answers a signed-out browser with 204
 * instead of the 401 every browser logs as a console error (the sign-in page's console stays clean).
 * null = signed out. An api without that route (404, an older deploy) is asked /api/me as before.
 */
async function probeSession(): Promise<Me | null> {
  try {
    return (await api.request('GET', '/api/auth/me', { schema: MeOrSignedOut })) ?? null
  } catch (e) {
    if (isApiError(e) && e.kind === 'not-found') return api.me()
    throw e
  }
}

/** The Clerk publishable key when this server signs people in with Clerk; null otherwise. */
function clerkKey(config: AuthConfig | null): string | null {
  return config?.providers.includes('clerk') ? (config.clerkPublishableKey ?? null) : null
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' })
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading')
  const [configAttempt, setConfigAttempt] = useState(0)
  const [signingOut, setSigningOut] = useState(false)
  const [problem, setProblem] = useState<{ outcome: SignOutProblem; opts: SignOutOptions } | null>(null)
  // Responses can arrive out of order (a slow boot /api/me after a fast sign-in); only the latest counts.
  const generation = useRef(0)
  const configRef = useRef<AuthConfig | null>(null)
  configRef.current = config
  const running = useRef<Promise<SignOutOutcome> | null>(null)

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    try {
      const me = await probeSession()
      if (!me) {
        if (gen === generation.current) setState(sessionEnded)
        return null
      }
      if (gen === generation.current) setState({ status: 'signed-in', me })
      return me
    } catch (e) {
      if (gen !== generation.current) return null
      if (isApiError(e) && e.kind === 'unauthorized') setState(sessionEnded)
      else
        setState({
          status: 'unreachable',
          message: isApiError(e) ? e.message : "Can't reach Lobby right now.",
        })
      return null
    }
  }, [])

  useEffect(() => {
    // Any 401 anywhere means the session ended (expired, revoked, signed out in another tab).
    setUnauthorizedHandler(() => {
      generation.current++
      setState(sessionEnded)
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

  const signOut = useCallback((opts: SignOutOptions = {}): Promise<SignOutOutcome> => {
    // One at a time: a second click while Clerk is still loading joins the first sign-out.
    if (running.current) return running.current
    // A visible problem stays up (its "Try again" says "Signing out…") until this attempt's outcome.
    setSigningOut(true)
    const key = clerkKey(configRef.current)
    const run = runSignOut({
      mode: opts.everywhere ? 'everywhere' : 'here',
      revokeAll: api.revokeAllSessions,
      logout: api.logout,
      // Only with Clerk: the dev provider never downloads the Clerk SDK. When the config is not known,
      // there is nothing to end here; the mark still stops the sign-in page from exchanging on its own.
      endClerkSession: key ? () => import('./clerkSession.tsx').then((m) => m.endClerkSession(key)) : null,
      marks: signedOutMarks,
    })
      .then((outcome) => {
        if (outcome.status === 'signed-out') {
          generation.current++
          setProblem(null)
          // Navigate before the state change so the signed-out guard never sees the old page.
          navigate(signInPath(opts.returnTo), { replace: true })
          setState({ status: 'signed-out', explicit: true })
        } else {
          setProblem({ outcome, opts })
        }
        return outcome
      })
      .finally(() => {
        running.current = null
        setSigningOut(false)
      })
    running.current = run
    return run
  }, [])

  const value = useMemo<SessionValue>(
    () => ({ state, config, configStatus, retryConfig, refresh, signOut, signingOut }),
    [state, config, configStatus, retryConfig, refresh, signOut, signingOut],
  )
  return (
    <SessionContext.Provider value={value}>
      {children}
      {problem && (
        <SignOutProblemAlert
          problem={problem.outcome}
          busy={signingOut}
          onRetry={() => void signOut(problem.opts)}
          onDismiss={() => setProblem(null)}
        />
      )}
    </SessionContext.Provider>
  )
}

/** Why a sign-out did not happen, over whatever page the person is on (they are still signed in). */
function SignOutProblemAlert({
  problem,
  busy,
  onRetry,
  onDismiss,
}: {
  problem: SignOutProblem
  busy: boolean
  onRetry(): void
  onDismiss(): void
}) {
  return (
    <div
      className="dr-signout-alert"
      role="alert"
      data-testid="signout-error"
      data-reason={problem.status === 'unsupported' ? 'unsupported' : problem.step}
    >
      <p>
        <strong>{problem.title}</strong> {problem.detail}
      </p>
      <div className="dr-row">
        {problem.retryable && (
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="signout-retry"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onRetry}
          >
            {busy ? 'Signing out…' : 'Try again'}
          </button>
        )}
        <button type="button" className="dr-btn" data-testid="signout-dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
