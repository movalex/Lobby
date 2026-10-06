// "Continue with Google" for open sign-in (docs/OPEN-SIGNIN.md "Google"). Google Identity Services draws
// its own button; when the person picks an account it hands this page an ID token (`credential`), which
// the api verifies and trades for the session cookie (POST /api/auth/google/login). Any Google account,
// any domain. The script loads only on a server that offers Google (GET /api/auth/config), and the
// page's CSP allows exactly https://accounts.google.com/gsi/* (deploy/nas/theater/nginx.conf).
import { useEffect, useRef, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { useTheme } from '../theme/useTheme.ts'
import { useSession } from './session.tsx'
import { signedOutMarks } from './signOutMark.ts'

const GSI_SRC = 'https://accounts.google.com/gsi/client'

interface GoogleIdApi {
  initialize(opts: {
    client_id: string
    callback(response: { credential?: string }): void
    auto_select?: boolean
    cancel_on_tap_outside?: boolean
    itp_support?: boolean
  }): void
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } }
  }
}

let loading: Promise<GoogleIdApi> | null = null
/** Loads Google's script once per page; resolves with google.accounts.id. */
function loadGsi(): Promise<GoogleIdApi> {
  loading ??= new Promise<GoogleIdApi>((resolve, reject) => {
    const ready = () => {
      const id = window.google?.accounts?.id
      if (id) resolve(id)
      else reject(new Error('Google sign-in did not load'))
    }
    if (window.google?.accounts?.id) return ready()
    const script = document.createElement('script')
    script.src = GSI_SRC
    script.async = true
    script.onload = ready
    script.onerror = () => reject(new Error('Google sign-in did not load'))
    document.head.appendChild(script)
  }).catch((e: unknown) => {
    loading = null // a later visit may try again (offline, blocked)
    throw e
  })
  return loading
}

export function GoogleSignIn({ clientId, onDone }: { clientId: string; onDone(): void }) {
  const { refresh } = useSession()
  const { colorMode } = useTheme()
  const slot = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // The latest callbacks, so Google's button is set up once per client id and theme, not per render.
  const latest = useRef({ refresh, onDone })
  latest.current = { refresh, onDone }

  useEffect(() => {
    let live = true
    loadGsi().then(
      (gsi) => {
        if (!live || !slot.current) return
        gsi.initialize({
          client_id: clientId,
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
          callback: ({ credential }) => {
            if (!credential) return
            setPending(true)
            setError(null)
            void (async () => {
              try {
                await api.googleLogin({ credential })
                if (!(await latest.current.refresh())) throw new Error('no session after sign-in')
                signedOutMarks.clear()
                latest.current.onDone()
              } catch (e) {
                setError(isApiError(e) ? e.message : 'Google sign-in did not go through. Try again.')
                setPending(false)
              }
            })()
          },
        })
        slot.current.replaceChildren()
        gsi.renderButton(slot.current, {
          type: 'standard',
          theme: colorMode === 'dark' ? 'filled_black' : 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          logo_alignment: 'left',
          width: Math.min(320, slot.current.clientWidth || 320),
        })
        setLoaded(true)
      },
      () => live && setError('Google sign-in could not load. Check your connection and reload the page.'),
    )
    return () => {
      live = false
    }
  }, [clientId, colorMode])

  return (
    <div className="dr-google-signin" data-testid="google-signin">
      <div ref={slot} className="dr-google-signin__button" aria-busy={!loaded || pending || undefined} />
      {!loaded && !error && (
        <div className="dr-signin__loading" role="status">
          <span className="dr-spinner" aria-hidden="true" />
          <span className="dr-sr-only">Loading Google sign-in…</span>
        </div>
      )}
      {pending && (
        <p className="dr-muted" role="status">
          Signing you in…
        </p>
      )}
      {error && (
        <p className="dr-field-error" role="alert" data-testid="google-signin-error">
          {error}
        </p>
      )}
    </div>
  )
}
