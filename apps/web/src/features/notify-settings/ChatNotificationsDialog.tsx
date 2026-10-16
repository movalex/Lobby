// "Chat notifications" (wave R, WS2): one dialog for the two things about Slack and Teams. "My notifications" is for every
// member; "Channels" (the workspace's webhooks) only for owners and admins, whose creator status the api checks again.
// ChatNotificationsEntry is the link that opens it from the dashboard's bell: it asks the api once whether chat
// notifications are on here at all, and shows nothing when they are not (or when a member has no channel to choose from).
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from 'react'
import { Dialog } from '../../ui/Dialog.tsx'
import { type ChatHookRequestOptions, chatHooksAvailable, getChatPrefs } from './client.ts'
import { MyNotificationsPanel } from './MyNotifications.tsx'
import { WorkspaceHooksPanel } from './WorkspaceHooks.tsx'
import './notify-settings.css'

export type ChatTab = 'mine' | 'channels'

export function ChatNotificationsDialog({
  workspaceId,
  workspaceName,
  canManage,
  initialTab = 'mine',
  requestOptions,
  onClose,
}: {
  workspaceId: string
  workspaceName: string
  /** an owner or admin of the workspace (the api decides again, and needs a creator) */
  canManage: boolean
  initialTab?: ChatTab
  requestOptions?: ChatHookRequestOptions
  onClose(): void
}) {
  const [tab, setTab] = useState<ChatTab>(canManage ? initialTab : 'mine')
  const idBase = useId()
  const tabs: { id: ChatTab; label: string }[] = [
    { id: 'mine', label: 'My notifications' },
    ...(canManage ? [{ id: 'channels' as const, label: 'Channels' }] : []),
  ]
  const onKey = (e: KeyboardEvent) => {
    if (tabs.length < 2 || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
    e.preventDefault()
    const i = tabs.findIndex((t) => t.id === tab)
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    if (next) {
      setTab(next.id)
      document.getElementById(`${idBase}-${next.id}`)?.focus()
    }
  }
  return (
    <Dialog
      title="Chat notifications"
      description={
        <>
          Messages in Slack or Microsoft Teams about <strong>{workspaceName}</strong> in Lobby.
        </>
      }
      size="lg"
      testId="chat-notifications-dialog"
      onClose={onClose}
    >
      {tabs.length > 1 && (
        <div className="dr-chat__tabs" role="tablist" aria-label="Chat notifications" onKeyDown={onKey}>
          {tabs.map((t) => (
            <button
              key={t.id}
              id={`${idBase}-${t.id}`}
              type="button"
              role="tab"
              className="dr-chat__tab"
              data-testid={`chat-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`${idBase}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div
        id={`${idBase}-panel`}
        role={tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={tabs.length > 1 ? `${idBase}-${tab}` : undefined}
        className="dr-chat__panel"
      >
        {tab === 'mine' ? (
          <MyNotificationsPanel workspaceId={workspaceId} requestOptions={requestOptions} />
        ) : (
          <WorkspaceHooksPanel workspaceId={workspaceId} requestOptions={requestOptions} />
        )}
      </div>
      <div className="dr-dialog__actions">
        <button type="button" className="dr-btn" data-testid="chat-notifications-close" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  )
}

type Probe = 'checking' | 'yes' | 'no'

/**
 * The link in the bell that opens the dialog. It asks the api (the member's own choices, which any member may read)
 * whether chat notifications are on: off, or a role that may not have them (403), shows nothing; a member sees it only
 * when the workspace has a channel to choose from; an owner or admin always can (to add the first one).
 */
export function ChatNotificationsEntry({
  workspaceId,
  workspaceName,
  canManage,
  requestOptions,
  children = 'Chat notifications…',
}: {
  workspaceId: string
  workspaceName: string
  canManage: boolean
  requestOptions?: ChatHookRequestOptions
  children?: ReactNode
}) {
  const [probe, setProbe] = useState<Probe>('checking')
  const [open, setOpen] = useState(false)
  const api = requestOptions?.api

  useEffect(() => {
    const abort = new AbortController()
    setProbe('checking')
    getChatPrefs(workspaceId, { api, signal: abort.signal }).then(
      (data) => {
        if (abort.signal.aborted) return
        setProbe(chatHooksAvailable() && (canManage || data.hooks.length > 0) ? 'yes' : 'no')
      },
      () => {
        if (!abort.signal.aborted) setProbe('no')
      },
    )
    return () => abort.abort()
  }, [workspaceId, canManage, api])

  if (probe !== 'yes') return null
  return (
    <>
      <button
        type="button"
        className="dr-linkbtn"
        data-testid="chat-notifications-open"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open && (
        <ChatNotificationsDialog
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          canManage={canManage}
          requestOptions={requestOptions}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
