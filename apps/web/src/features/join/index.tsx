// OWNER: WS3 (wave V; docs/WAVE-V-CONTRACTS.md §3.3). The 'join' feature on the Excalidraw board page: the join card
// (the QR of the link's /j/ URL, the short code in large type, the host, the expiry; never on the board) behind the
// Facilitate menu's "Show join code" (workshops/ported/facilitate-entries.ts, entry `join-code`). The /j/:code page
// is ./JoinPage.tsx (App.tsx), the Share dialog's "Show QR" row is ./ShowQr.tsx (board/ShareDialog.tsx
// WorkshopLinksSection), "Have a code?" is ./JoinField.tsx (auth/SignInPage.tsx). Its switch is
// features/live/flags.ts LIVE_FLAGS.joinCodes, and the api's DRAFTROOM_JOIN_CODES must be on too (liveEnabled).
import type { CanvasFeature } from '../../canvas/api/index.ts'
import { liveEnabled } from '../live/index.ts'
import {
  type FacilitateEntryInput,
  type FacilitateItemProps,
  registerFacilitateEntry,
} from '../workshops/ported/facilitate-entries.ts'
import { BoardJoinCardHost, openJoinCard } from './BoardJoinCard.tsx'

/**
 * Whether the Facilitate menu offers "Show join code": a facilitator with an account who is a creator (only creators
 * hand out links; the api decides, this only keeps the entry from people it would refuse), with join codes on.
 */
export function joinCodeEntryShown(input: FacilitateEntryInput): boolean {
  if (input.guest || !input.facilitator) return false
  if (input.ctx.me.access?.creator === false) return false
  return liveEnabled('joinCodes')
}

function ShowJoinCodeItem({ ctx, close }: FacilitateItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="dr-wk-menu__item"
      data-testid="facilitate-join-code"
      onClick={() => {
        close(false)
        openJoinCard(ctx.canvas)
      }}
    >
      <span className="dr-wk-menu__icon" aria-hidden="true">
        <QrIcon />
      </span>
      <span className="dr-wk-menu__label">Show join code</span>
    </button>
  )
}

function QrIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="1.75" y="1.75" width="4.5" height="4.5" rx="0.5" />
      <rect x="9.75" y="1.75" width="4.5" height="4.5" rx="0.5" />
      <rect x="1.75" y="9.75" width="4.5" height="4.5" rx="0.5" />
      <path d="M9.75 9.75h2v2h-2zM12.25 12.25h2v2h-2z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export const feature: CanvasFeature = {
  id: 'join',
  overlays: [
    {
      id: 'join-card',
      layer: 'screen',
      order: 990,
      pointer: 'auto',
      // the card is for projecting: it shows while presenting too (it renders nothing until opened)
      focusMode: 'show',
      component: BoardJoinCardHost,
    },
  ],
  onMount() {
    return registerFacilitateEntry({
      id: 'join-code',
      order: 200,
      shown: joinCodeEntryShown,
      Item: ShowJoinCodeItem,
    })
  },
}
