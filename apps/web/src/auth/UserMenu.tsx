import { useEffect, useId, useRef, useState } from 'react'
import { useBoard } from '../board/board-context.ts'
import { initialsFor, safeColor } from '../lib/identity.ts'
import { ThemePicker } from '../theme/ThemePicker.tsx'
import { useTldrawThemeSync } from '../theme/useTheme.ts'
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
 * choice (System / Light / Dark); on a board it also keeps tldraw's canvas theme in step with it.
 * Switch user, Sign out and Sign out everywhere (SCA-4) all end the Clerk session too (SCA-1).
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
  const me = useMe()
  const { signOut, signingOut } = useSession()
  const dev = useIsDevAuth()
  const [open, setOpen] = useState(false)
  // Which button started the running sign-out (its label says so).
  const [clicked, setClicked] = useState<SignOutButton | null>(null)
  const everywhereHint = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const user = me.user
  const color = safeColor(user.color, user.id)
  // Every board page renders this menu (in the top bar, or in the "⋯" menu on phones): while it is
  // mounted there, the live canvas follows a theme change and tldraw's own Ctrl/Cmd+/ moves the app.
  // (The canvas opens in the right theme anyway: theme/boot.ts keeps tldraw's stored scheme in step.)
  useTldrawThemeSync(useBoard() !== null)

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
        aria-expanded={open}
        aria-haspopup="dialog"
        title={dev ? `Development sign-in: ${user.name}` : user.name}
        onClick={() => setOpen((o) => !o)}
      >
        {dev && <span className="dr-devbadge__tag">DEV</span>}
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
        <div className="dr-devbadge__menu" role="dialog" aria-label="Your account">
          <div className="dr-account">
            <span className="dr-avatar dr-avatar--static" style={{ background: color }} aria-hidden="true">
              {initialsFor(user.name)}
            </span>
            <div className="dr-account__text">
              <strong>{user.name}</strong>
              {user.handle && <span className="dr-muted">@{user.handle}</span>}
            </div>
          </div>
          {dev && (
            <p className="dr-account__note">
              Development sign-in: anyone using this server can sign in as any handle. Use it on your own
              machine only.
            </p>
          )}
          <ThemePicker />
          <div className="dr-account__actions">
            <button
              type="button"
              className="dr-btn"
              data-testid="switch-user"
              disabled={signingOut}
              onClick={() => start('switch', { returnTo: here })}
            >
              {label('switch', 'Switch user')}
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
          <div className="dr-account__everywhere">
            <button
              type="button"
              className="dr-btn"
              data-testid="sign-out-everywhere"
              disabled={signingOut}
              aria-describedby={everywhereHint}
              onClick={() => start('everywhere', { everywhere: true })}
            >
              {label('everywhere', 'Sign out everywhere')}
            </button>
            <p id={everywhereHint} className="dr-muted">
              Ends your Lobby sessions on every device and browser, this one included.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
