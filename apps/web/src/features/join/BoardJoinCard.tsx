// OWNER: WS3 (wave V). The Facilitate menu's "Show join code" on the board page: the join card of the board's newest
// open workshop link (its QR and short code, full screen, to project for a room). With no open workshop link, a creator
// may make one here (3 hours, people join with just a name), as the Share dialog would. The api decides who may: the
// list and the code are for creators who manage the board's access; anyone else is told whom to ask.
import type { PendingInvitation } from '@draftroom/contracts'
import { useCallback, useEffect, useState } from 'react'
import { isApiError } from '../../api/client.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { joinApi } from './api.ts'
import { type JoinTarget, joinTarget, workshopLinksToShow } from './model.ts'
import { JoinCard } from './QrCard.tsx'

/** A new workshop link from the card: the Share dialog's default (3 h), guests may join with a name. */
export const CARD_LINK_HOURS = 3

const opened = new WeakMap<object, Atom<number>>()
const openOf = (canvas: object): Atom<number> => {
  let a = opened.get(canvas)
  if (!a) {
    a = atom<number>('lobby-join-card', 0)
    opened.set(canvas, a)
  }
  return a
}
/** Opens this board page's join card (the Facilitate entry). */
export const openJoinCard = (canvas: object) => openOf(canvas).set(Date.now())
const closeJoinCard = (canvas: object) => openOf(canvas).set(0)

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; target: JoinTarget; note: string | null }
  | { kind: 'none' }
  | { kind: 'refused' }
  | { kind: 'failed'; message: string }

/** The overlay that holds the card while it is open (nothing otherwise). */
export function BoardJoinCardHost({ ctx }: { ctx: CanvasFeatureContext }) {
  const at = useValue(openOf(ctx.canvas))
  if (!at) return null
  return <BoardJoinCard key={at} ctx={ctx} onClose={() => closeJoinCard(ctx.canvas)} />
}

/** The card for `link`: its code (made on first ask), or the QR of its full URL when there is none. */
async function targetOf(
  ctx: CanvasFeatureContext,
  link: { id: string; url: string; expiresAt: string; joinCode?: PendingInvitation['joinCode'] },
): Promise<{ target: JoinTarget; note: string | null }> {
  if (link.joinCode) return { target: joinTarget(link, link.joinCode), note: null }
  try {
    const code = await joinApi(ctx.api).code(ctx.board.id, link.id)
    return { target: joinTarget(link, code), note: null }
  } catch {
    return { target: joinTarget(link, null), note: 'Scan the QR to join.' }
  }
}

function BoardJoinCard({ ctx, onClose }: { ctx: CanvasFeatureContext; onClose(): void }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const list = await joinApi(ctx.api).invitations(ctx.board.id, controller.signal)
        const link = workshopLinksToShow(list, Date.now())[0]
        if (!link?.url) {
          setState({ kind: 'none' })
          return
        }
        const ready = await targetOf(ctx, { ...link, url: link.url })
        if (!controller.signal.aborted) setState({ kind: 'ready', ...ready })
      } catch (e) {
        if (controller.signal.aborted) return
        if (isApiError(e) && (e.kind === 'forbidden' || e.kind === 'not-found')) setState({ kind: 'refused' })
        else
          setState({ kind: 'failed', message: isApiError(e) ? e.message : 'The join card could not open.' })
      }
    })()
    return () => controller.abort()
  }, [ctx])

  const create = useCallback(async () => {
    if (creating) return
    setCreating(true)
    try {
      const link = await joinApi(ctx.api).createWorkshopLink(ctx.board.id, {
        role: 'editor',
        expiresInHours: CARD_LINK_HOURS,
        allowGuests: true,
      })
      setState({ kind: 'ready', ...(await targetOf(ctx, link)) })
    } catch (e) {
      setState({
        kind: 'failed',
        message: isApiError(e) ? e.message : 'The workshop link could not be created.',
      })
    } finally {
      setCreating(false)
    }
  }, [ctx, creating])

  if (state.kind === 'ready')
    return <JoinCard target={state.target} title={ctx.board.title} note={state.note} onClose={onClose} />
  return (
    <Dialog title="Join code" onClose={onClose} testId="join-card-setup">
      <div className="dr-join-setup">
        {state.kind === 'loading' && (
          <p className="dr-muted" role="status">
            Opening the join card…
          </p>
        )}
        {state.kind === 'none' && (
          <>
            <p className="dr-muted" data-testid="join-card-none">
              This board has no open workshop link. Make one to show its QR and code: anyone who scans it can
              join with just a name, and edit, for {CARD_LINK_HOURS} hours.
            </p>
            <div className="dr-row dr-row--wrap">
              <button
                type="button"
                className="dr-btn dr-btn--primary"
                data-testid="join-card-create"
                aria-busy={creating || undefined}
                onClick={() => void create()}
              >
                {creating ? 'Creating…' : 'Make a workshop link'}
              </button>
            </div>
          </>
        )}
        {state.kind === 'refused' && (
          <p className="dr-muted" data-testid="join-card-refused">
            Only someone who shares this board's links can show its join code. Ask the board's owner.
          </p>
        )}
        {state.kind === 'failed' && (
          <p className="dr-share__error" role="alert" data-testid="join-card-error">
            {state.message}
          </p>
        )}
      </div>
    </Dialog>
  )
}
