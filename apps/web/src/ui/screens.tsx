import { type ReactNode, type RefObject, useCallback, useMemo, useRef, useState } from 'react'
import { api } from '../api/client.ts'
import { useSession } from '../auth/session.tsx'
import { Wordmark } from '../brand/Wordmark.tsx'
import { type NoWorkspaceCopy, noWorkspaceCopy } from '../dashboard/model.ts'
import { RequestAccess } from '../features/sharing/RequestAccess.tsx'
import { GuestNoAccessScreen } from '../invite/GuestNoAccessScreen.tsx'
import { useUserKind } from '../invite/guest.tsx'
import type { BoardRole } from '../lib/permissions.ts'
import { linkClick, matchRoute } from '../lib/routing.ts'
import { ADDRESS_COPY_FALLBACK, copyAddress } from './copy-address.ts'
import './screens.css'

export function LoadingScreen({ label = 'Loading…', testId }: { label?: string; testId?: string }) {
  return (
    <div className="dr-screen dr-screen--page" data-testid={testId} role="status" aria-live="polite">
      <span className="dr-spinner" aria-hidden="true" />
      <span className="dr-sr-only">{label}</span>
    </div>
  )
}

export function MessageScreen({
  title,
  body,
  testId,
  reason,
  actions,
  scroll = false,
}: {
  title: string
  body: ReactNode
  testId?: string
  /** `data-reason` on the screen: which variant of a screen this is (for tests and styles). */
  reason?: string
  actions?: ReactNode
  /**
   * A screen with more than a line or two (K4-4): it scrolls when the card is taller than the window (a phone,
   * a landscape phone), instead of cutting off its top and its buttons.
   */
  scroll?: boolean
}) {
  return (
    <main
      className={`dr-screen dr-screen--page${scroll ? ' dr-screen--scroll' : ''}`}
      data-testid={testId}
      data-reason={reason}
    >
      <div className="dr-card dr-card--narrow">
        <a href="/" onClick={linkClick('/')} className="dr-card__brand" aria-label="Lobby home">
          <Wordmark />
        </a>
        <h1 className="dr-card__title">{title}</h1>
        <div className="dr-muted dr-card__body">{body}</div>
        <div className="dr-row dr-row--wrap">
          {actions ?? (
            <a className="dr-btn dr-btn--primary" href="/" onClick={linkClick('/')}>
              Go to your boards
            </a>
          )}
        </div>
      </div>
    </main>
  )
}

/**
 * "Can't reach Lobby": the api gave no answer or a 5xx while a page read what it needs (the session,
 * an invitation). One screen for every page, with the retry that page needs: RequireSession re-reads
 * the session, the invite page re-reads what failed. A failure to reach Lobby is never shown as
 * "signed out", "no access" or a wrong account (fixer round 3, docs/DOMAIN-ACCESS-CONTRACTS.md §21).
 */
export function UnreachableScreen({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <MessageScreen
      testId="api-unreachable"
      title="Can't reach Lobby"
      body={message}
      actions={
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          data-testid="api-unreachable-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      }
    />
  )
}

/**
 * One screen for "not found" and "forbidden": the API answers 404 for both so a board's existence
 * never leaks, and the UI does not try to tell them apart either. On a board link, a signed-in user
 * can request access (PRS-04); the server answers the same whether or not the board exists.
 */
export function NoAccessScreen({
  thing = 'board',
  revoked = false,
  previousRole = null,
}: {
  thing?: 'board' | 'workspace'
  revoked?: boolean
  /** The role they had before it ended (revoked while open): the request form starts from it. */
  previousRole?: BoardRole | null
}) {
  const { signOut, state } = useSession()
  const here = `${location.pathname}${location.search}`
  const route = matchRoute(location.pathname)
  const boardId = thing === 'board' && route.name === 'board' ? route.boardId : null
  const userId = state.status === 'signed-in' ? state.me.user.id : null
  // Once the owner approves, the board opens: reload when the API starts answering for it.
  const checkApproved = useCallback(() => {
    if (!boardId) return
    api.getBoard(boardId).then(
      () => location.reload(),
      () => {},
    )
  }, [boardId])
  // Wave 3 (F16): a name-only guest cannot request access; their screen says what happened instead.
  const guest = useUserKind() === 'guest'
  if (guest && thing === 'board') return <GuestNoAccessScreen revoked={revoked} />
  return (
    <MessageScreen
      testId="no-access"
      title={
        revoked ? `You no longer have access to this ${thing}` : `You don't have access to this ${thing}`
      }
      body={
        <>
          <p>
            {revoked
              ? `Your access was removed or changed while you had it open, or the ${thing} was moved to trash.`
              : `It may not exist, it may have been moved to trash, or it hasn't been shared with you.`}
          </p>
          {/* An old invite link cannot bring back access that was removed (PRI-04). */}
          <p>
            {revoked
              ? 'Ask its owner for access again: they see your request in their Share dialog.'
              : 'Ask its owner to share it with you, or open the invite link they sent you.'}
          </p>
          {boardId && userId && (
            <div className="dr-noaccess__request">
              <RequestAccess
                key={`${userId}:${boardId}`}
                boardId={boardId}
                userId={userId}
                currentRole={null}
                defaultRole={previousRole === 'owner' ? 'editor' : previousRole}
                onApprovedCheck={checkApproved}
              />
            </div>
          )}
        </>
      }
      actions={
        <>
          <a className="dr-btn dr-btn--primary" href="/" onClick={linkClick('/')}>
            Go to your boards
          </a>
          <button type="button" className="dr-btn" onClick={() => void signOut({ returnTo: here })}>
            Sign in as someone else
          </button>
        </>
      }
    />
  )
}

// ---- wave K (K4-4): "Nothing has been shared with you yet" and "You're not in a workspace yet" ------------

/** What the copy button did: not yet, the address is on the clipboard, or the browser would not (do it by hand). */
export type CopyState = 'idle' | 'copied' | 'manual'

/** "You're signed in as <b>pat@client.example</b>." with the address set apart (the sentence reads the same). */
function accountSentence(sentence: string, address: string | null, ref?: RefObject<HTMLElement | null>) {
  const at = address ? sentence.indexOf(address) : -1
  if (!address || at < 0) return sentence
  return (
    <>
      {sentence.slice(0, at)}
      <strong className="dr-nowork__email" data-testid="no-workspace-email" ref={ref}>
        {address}
      </strong>
      {sentence.slice(at + address.length)}
    </>
  )
}

/**
 * The screen for an account with no workspace, as a plain function of its props (no hooks: a component test
 * reads it). It shows which address is signed in, what to do next, which addresses are work addresses (from the
 * build's configuration, in the copy), "Switch account", and "Copy my address" (the clipboard only: nothing is
 * sent to anyone). The "unconfirmed" variant keeps its Reload.
 */
export function NoWorkspaceView({
  copy,
  copyState = 'idle',
  switching = false,
  addressRef,
  onSwitch,
  onCopy,
  onReload,
}: {
  copy: NoWorkspaceCopy
  copyState?: CopyState
  switching?: boolean
  /** The address element, so the container can select it when the browser would not copy. */
  addressRef?: RefObject<HTMLElement | null>
  onSwitch(): void
  onCopy(): void
  onReload(): void
}) {
  const hasAccount = copy.address !== null
  return (
    <MessageScreen
      testId="no-workspace"
      reason={copy.reason}
      title={copy.title}
      scroll
      body={
        <>
          {copy.body.map((p, i) => {
            const account = i === 0 && hasAccount
            return (
              <p
                key={p}
                className={account ? 'dr-nowork__account' : undefined}
                data-testid={i === 0 && copy.reason !== 'unconfirmed' ? 'no-workspace-account' : undefined}
              >
                {account ? accountSentence(p, copy.address, addressRef) : p}
              </p>
            )
          })}
          {copyState === 'copied' && (
            <p className="dr-nowork__hint" role="status" data-testid="no-workspace-copied">
              Copied. Send it to someone at Dark Burn Creative or Trailer Park Group, then open the invite
              link they send you.
            </p>
          )}
          {copyState === 'manual' && (
            <p className="dr-nowork__hint" role="status" data-testid="no-workspace-copy-fallback">
              {ADDRESS_COPY_FALLBACK}
            </p>
          )}
        </>
      }
      actions={
        <>
          {copy.action === 'switch-account' && (
            <button
              type="button"
              className="dr-btn dr-btn--primary"
              data-testid="no-workspace-switch"
              disabled={switching}
              aria-busy={switching || undefined}
              onClick={onSwitch}
            >
              {switching ? 'Signing out…' : 'Switch account'}
            </button>
          )}
          {copy.action === 'reload' && (
            <button
              type="button"
              className="dr-btn dr-btn--primary"
              data-testid="no-workspace-reload"
              onClick={onReload}
            >
              Reload
            </button>
          )}
          {hasAccount && (
            <button type="button" className="dr-btn" data-testid="no-workspace-copy" onClick={onCopy}>
              Copy my address
            </button>
          )}
        </>
      }
    />
  )
}

/** Selects an element's text (what Ctrl+C then copies), for a browser that refused the copy button. */
function selectContents(el: HTMLElement | null) {
  try {
    if (!el) return
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection?.removeAllRanges()
    selection?.addRange(range)
  } catch {
    // the address stays shown, selectable by hand
  }
}

/** "/" for a signed-in account that belongs to no workspace (App.tsx RootRedirect). */
export function NoWorkspaceScreen() {
  const { state, signOut, signingOut } = useSession()
  const me = state.status === 'signed-in' ? state.me : null
  const copy = useMemo(() => (me ? noWorkspaceCopy(me.access) : null), [me])
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const addressRef = useRef<HTMLElement | null>(null)
  if (!copy) return <LoadingScreen />
  const onCopy = () => {
    void copyAddress(copy.address).then((ok) => {
      setCopyState(ok ? 'copied' : 'manual')
      if (!ok) selectContents(addressRef.current)
    })
  }
  return (
    <NoWorkspaceView
      copy={copy}
      copyState={copyState}
      switching={signingOut}
      addressRef={addressRef}
      onSwitch={() => void signOut()}
      onCopy={onCopy}
      onReload={() => location.reload()}
    />
  )
}
