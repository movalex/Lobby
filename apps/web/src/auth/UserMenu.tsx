import { useEffect, useId, useRef, useState } from 'react'
import { FeedbackMenuEntries } from '../features/feedback/FeedbackMenu.tsx'
import { useIsGuest } from '../invite/guest.tsx'
import '../invite/invite.css'
import { initialsFor, safeColor } from '../lib/identity.ts'
import { matchRoute } from '../lib/routing.ts'
import { ThemePicker } from '../theme/ThemePicker.tsx'
import { type SignOutOptions, useMe, useSession } from './session.tsx'

type SignOutButton = 'switch' | 'out' | 'everywhere'

/** True when this server signs people in with the development provider (anyone can be anyone). */
export function useIsDevAuth(): boolean {
  const { config, state } = useSession()
  if (config) return config.providers.includes('dev')
  // Config failed to load: a handle is only set by the dev provider today.
  return state.status === 'signed-in' && state.me.user.handle !== null
}

/**
 * The signed-in user's button. With development sign-in it is the "dev identity" badge the e2e
 * suite looks for, and it says plainly that the identity is not verified. Its menu holds the theme
 * choice (System / Light / Dark); the canvas follows the app theme (canvas/engine/theme.ts).
 * Switch user, Sign out and Sign out everywhere (SCA-4) all end the Clerk session too (SCA-1).
 * A name-only guest (wave 3) sees a "Guest" tag, that signing out means needing the link again,
 * "Sign in with an account" and "Sign out" (they have no other devices or account to end).
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
  const me = useMe()
  const { signOut, signingOut } = useSession()
  // A name-only guest (wave 3) gets the guest menu: no account to switch or sign out everywhere.
  const guest = useIsGuest()
  const dev = useIsDevAuth() && !guest
  const [open, setOpen] = useState(false)
  // Which button started the running sign-out (its label says so).
  const [clicked, setClicked] = useState<SignOutButton | null>(null)
  const everywhereHint = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const user = me.user
  const color = safeColor(user.color, user.id)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const here = `${location.pathname}${location.search}`
  const start = (which: SignOutButton, opts?: SignOutOptions) => {
    setClicked(which)
    void signOut(opts)
  }
  const label = (which: SignOutButton, text: string) =>
    signingOut && clicked === which ? 'Signing out…' : text
  return (
    <div className="dr-devbadge-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={dev ? 'dr-devbadge' : 'dr-userbtn'}
        data-testid={dev ? 'dev-identity-badge' : 'user-menu'}
        data-user-id={user.id}
        data-kind={guest ? 'guest' : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={guest ? `${user.name}: guest menu` : undefined}
        title={dev ? `Development sign-in: ${user.name}` : user.name}
        onClick={() => setOpen((o) => !o)}
      >
        {dev && <span className="dr-devbadge__tag">DEV</span>}
        {guest && (
          <span className="dr-guest-tag" data-testid="guest-tag">
            Guest
          </span>
        )}
        <span
          className="dr-avatar dr-avatar--static dr-avatar--sm"
          style={{ background: color }}
          aria-hidden="true"
        >
          {initialsFor(user.name)}
        </span>
        {!compact && <span className="dr-userbtn__name">{user.name}</span>}
      </button>
      {open && (
        <div
          className="dr-devbadge__menu"
          role="dialog"
          aria-label={guest ? 'Your guest access' : 'Your account'}
        >
          <div className="dr-account">
            <span className="dr-avatar dr-avatar--static" style={{ background: color }} aria-hidden="true">
              {initialsFor(user.name)}
            </span>
            <div className="dr-account__text">
              <strong>{user.name}</strong>
              {user.handle && <span className="dr-muted">@{user.handle}</span>}
              {guest && <span className="dr-guest-tag">Guest</span>}
            </div>
          </div>
          {dev && (
            <p className="dr-account__note">
              Development sign-in: anyone using this server can sign in as any handle. Use it on your own
              machine only.
            </p>
          )}
          {guest && (
            <p className="dr-account__guest" data-testid="guest-menu-note">
              You joined with a link, without an account. If you sign out, you'll need the link again to come
              back, and it only works while it is open.
            </p>
          )}
          <ThemePicker />
          {/* Wave J5: Send feedback (and the inbox for its readers). A board has it in its own menu. */}
          {matchRoute(location.pathname).name !== 'board' && (
            <FeedbackMenuEntries userId={user.id} guest={guest} onDone={() => setOpen(false)} />
          )}
          {guest ? (
            <div className="dr-account__actions dr-account__actions--guest">
              <button
                type="button"
                className="dr-btn"
                data-testid="guest-signin-account"
                disabled={signingOut}
                onClick={() => start('switch', { returnTo: here })}
              >
                {label('switch', 'Sign in with an account')}
              </button>
              <button
                type="button"
                className="dr-btn"
                data-testid="sign-out"
                disabled={signingOut}
                onClick={() => start('out')}
              >
                {label('out', 'Sign out')}
              </button>
            </div>
          ) : (
            <AccountActions
              signingOut={signingOut}
              everywhereHint={everywhereHint}
              label={label}
              onSwitch={() => start('switch', { returnTo: here })}
              onOut={() => start('out')}
              onEverywhere={() => start('everywhere', { everywhere: true })}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Switch user, Sign out and Sign out everywhere (SCA-4), for someone with an account. */
function AccountActions({
  signingOut,
  everywhereHint,
  label,
  onSwitch,
  onOut,
  onEverywhere,
}: {
  signingOut: boolean
  everywhereHint: string
  label(which: SignOutButton, text: string): string
  onSwitch(): void
  onOut(): void
  onEverywhere(): void
}) {
  return (
    <>
      <div className="dr-account__actions">
        <button
          type="button"
          className="dr-btn"
          data-testid="switch-user"
          disabled={signingOut}
          onClick={onSwitch}
        >
          {label('switch', 'Switch user')}
        </button>
        <button type="button" className="dr-btn" data-testid="sign-out" disabled={signingOut} onClick={onOut}>
          {label('out', 'Sign out')}
        </button>
      </div>
      <div className="dr-account__everywhere">
        <button
          type="button"
          className="dr-btn"
          data-testid="sign-out-everywhere"
          disabled={signingOut}
          aria-describedby={everywhereHint}
          onClick={onEverywhere}
        >
          {label('everywhere', 'Sign out everywhere')}
        </button>
        <p id={everywhereHint} className="dr-muted">
          Ends your Lobby sessions on every device and browser, this one included.
        </p>
      </div>
    </>
  )
}
