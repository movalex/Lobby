// P-023 (wave P): who is offered Lobby's own Feedback (the pill on the dashboard and in a board's top bar, and the
// account menu's "Send feedback"). It is the team's: an external client, a name-only guest, or an account Lobby cannot
// place at a creator domain (domain access: `Me.access.creator`, which fails closed) is not shown it. Hiding what is not
// known is the other way round: until the person's kind and access are known nothing is hidden (a page still loading,
// a bare unit render), because the pill is not evidence of anything and the api still checks who sends.
import type { UserKind } from '@draftroom/contracts'
import { useSessionOrNull } from '../../auth/session.tsx'
import { useUserKind } from '../../invite/guest.tsx'

/** Whether this person is offered Feedback (pure; `access` null: not known). */
export function mayGiveFeedback(
  kind: UserKind | null,
  access: { readonly creator: boolean } | null | undefined,
): boolean {
  if (kind === 'guest') return false
  return access ? access.creator === true : true
}

/** The same for the signed-in person (as far as this tab knows right now). */
export function useMayGiveFeedback(): boolean {
  const kind = useUserKind()
  const session = useSessionOrNull()
  const access = session?.state.status === 'signed-in' ? session.state.me.access : null
  return mayGiveFeedback(kind, access)
}
