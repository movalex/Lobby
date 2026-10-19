// OWNER: WS3 (wave V). The Share dialog's "Show QR" row under each open workshop link (board/ShareDialog.tsx
// WorkshopLinksSection renders it, for people who may share the link: its URL is theirs to show): the link's join code
// and a button that opens the full-screen join card. The code comes with the link (the api makes it with a new
// workshop link while join codes are on); a link made before that gets it here on first ask. Without a code (the api
// refuses or is older) the card shows the QR of the full invite URL, which works whatever the switch says.
import type { PendingInvitation } from '@draftroom/contracts'
import { useState } from 'react'
import { api, isApiError } from '../../api/client.ts'
import { joinApi } from './api.ts'
import { type JoinTarget, joinTarget } from './model.ts'
import { JoinCard } from './QrCard.tsx'
import { useJoinCodesOn } from './switch.ts'

export function ShowQrRow({
  boardId,
  link,
  boardTitle,
}: {
  boardId: string
  link: PendingInvitation
  boardTitle?: string
}) {
  const on = useJoinCodesOn()
  const [open, setOpen] = useState<{ target: JoinTarget; note: string | null } | null>(null)
  const [pending, setPending] = useState(false)
  if (!on || link.url === null) return null
  const url = link.url

  const show = async () => {
    if (pending) return
    if (link.joinCode) {
      setOpen({ target: joinTarget({ url, expiresAt: link.expiresAt }, link.joinCode), note: null })
      return
    }
    setPending(true)
    try {
      const code = await joinApi(api).code(boardId, link.id)
      setOpen({ target: joinTarget({ url, expiresAt: link.expiresAt }, code), note: null })
    } catch (e) {
      // The QR of the full link still lets people in.
      const note =
        isApiError(e) && e.kind === 'rate-limited'
          ? 'No short code just now: scan the QR.'
          : 'Scan the QR to join.'
      setOpen({ target: joinTarget({ url, expiresAt: link.expiresAt }, null), note })
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="dr-join-row" data-testid="workshop-link-qr-row">
      {link.joinCode && (
        <span className="dr-muted">
          Join code{' '}
          <span className="dr-join-row__code" data-testid="workshop-link-code">
            {link.joinCode.display}
          </span>
        </span>
      )}
      <button
        type="button"
        className="dr-btn dr-btn--ghost"
        data-testid="workshop-link-show-qr"
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        onClick={() => void show()}
      >
        {pending ? 'Opening…' : 'Show QR'}
      </button>
      {open && (
        <JoinCard
          target={open.target}
          title={boardTitle ?? 'this board'}
          note={open.note}
          onClose={() => setOpen(null)}
        />
      )}
    </li>
  )
}
