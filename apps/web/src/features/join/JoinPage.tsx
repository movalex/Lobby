// OWNER: WS3 (wave V, join codes; docs/WAVE-V-CONTRACTS.md §3.3). The /j/:code page, outside the session (someone
// joining from a phone has none yet): it reads the code (contracts normalizeJoinCode), asks GET /api/join/:code (no
// session needed) and continues at /invite/:token, whose name-only join is unchanged. An unknown, expired or revoked
// code (the api's one 404) says "This code does not work any more" with a field to type another. Loaded only while
// LIVE_FLAGS.joinCodes is on (App.tsx); the api decides the rest (its switch off: the same 404). No request leaves
// Lobby's origin.
import { normalizeJoinCode } from '@draftroom/contracts'
import { useEffect, useState } from 'react'
import { api, isApiError } from '../../api/client.ts'
import { navigate } from '../../lib/routing.ts'
import { LoadingScreen, MessageScreen, UnreachableScreen } from '../../ui/screens.tsx'
import { joinApi } from './api.ts'
import { JoinCodeField } from './JoinField.tsx'

type State =
  | { kind: 'resolving' }
  | { kind: 'malformed' }
  | { kind: 'unknown' }
  | { kind: 'limited' }
  | { kind: 'unreachable' }

/** Where a resolved code continues: the invite page of its link's token. */
export const invitePathOf = (token: string) => `/invite/${encodeURIComponent(token)}`

export default function JoinPage({ code: raw }: { code: string }) {
  const code = normalizeJoinCode(raw)
  const [state, setState] = useState<State>(code ? { kind: 'resolving' } : { kind: 'malformed' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!code) {
      setState({ kind: 'malformed' })
      return
    }
    setState({ kind: 'resolving' })
    const controller = new AbortController()
    joinApi(api)
      .resolve(code, controller.signal)
      // replace: Back from the invite page goes where the person came from, not to this hop
      .then((token) => navigate(invitePathOf(token), { replace: true }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return
        if (isApiError(e) && e.kind === 'not-found') setState({ kind: 'unknown' })
        else if (isApiError(e) && e.kind === 'rate-limited') setState({ kind: 'limited' })
        else setState({ kind: 'unreachable' })
      })
    return () => controller.abort()
    // attempt: "Try again" after an unreachable api
  }, [code, attempt])

  if (state.kind === 'resolving') return <LoadingScreen label="Opening the board…" testId="join-resolving" />
  if (state.kind === 'unreachable')
    return (
      <UnreachableScreen
        message="Lobby did not answer. Check your connection and try again."
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )
  const copy = {
    malformed: {
      title: 'That is not a join code',
      body: 'A join code has 8 letters and digits, like ABCD-2345. Type it again:',
    },
    unknown: {
      title: 'This code does not work any more',
      body: 'It may have expired or been switched off. Check the code, or ask whoever shared it for a new one.',
    },
    limited: {
      title: 'Too many codes tried',
      body: 'Too many join codes were tried from this network just now. Wait a few minutes and try again.',
    },
  }[state.kind]
  return (
    <MessageScreen
      title={copy.title}
      body={copy.body}
      testId="join-page"
      reason={state.kind}
      actions={<JoinCodeField label="Join code" testId="join-page-field" autoFocus />}
    />
  )
}
