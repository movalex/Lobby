// "My notifications" (wave R, WS2): which events of this workspace reach me in which Slack or Teams channel. Everything is
// off until chosen; the whole choice is saved together and the page says "Saved" only after the api answered.
import { CHAT_HOOK_KINDS, type ChatHookKind, type ChatPrefsResponse } from '@draftroom/contracts'
import { useEffect, useId, useState } from 'react'
import {
  ChatHookRequestError,
  type ChatHookRequestOptions,
  chatHooksAvailable,
  getChatPrefs,
  putChatPrefs,
} from './client.ts'
import {
  CHANNEL_NOTE,
  type Chosen,
  chosenFrom,
  KIND_LABEL,
  MY_NOTIFICATIONS_INTRO,
  OFF_TEXT,
  PROVIDER_LABEL,
  prefsInput,
  requestErrorText,
  sameChoice,
  toggled,
} from './model.ts'

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ChatPrefsResponse }
  | { kind: 'off' }
  | { kind: 'error'; text: string }

export function MyNotificationsPanel({
  workspaceId,
  requestOptions = {},
}: {
  workspaceId: string
  requestOptions?: ChatHookRequestOptions
}) {
  const noteId = useId()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [chosen, setChosen] = useState<Chosen>({})
  const [saved, setSaved] = useState<Chosen>({})
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const api = requestOptions.api

  useEffect(() => {
    const abort = new AbortController()
    setLoad({ kind: 'loading' })
    getChatPrefs(workspaceId, { api, signal: abort.signal }).then(
      (data) => {
        if (abort.signal.aborted) return
        if (!chatHooksAvailable()) return setLoad({ kind: 'off' })
        setLoad({ kind: 'ready', data })
        setChosen(chosenFrom(data))
        setSaved(chosenFrom(data))
      },
      (e: unknown) => {
        if (abort.signal.aborted) return
        const err = e instanceof ChatHookRequestError ? e : new ChatHookRequestError('unavailable')
        setLoad({ kind: 'error', text: requestErrorText(err, 'Your choices could not be loaded. Try again.') })
      },
    )
    return () => abort.abort()
  }, [workspaceId, api])

  if (load.kind === 'loading')
    return (
      <p className="dr-muted" data-testid="chat-prefs-loading">
        Loading…
      </p>
    )
  if (load.kind === 'off')
    return (
      <p className="dr-muted" data-testid="chat-prefs-off">
        {OFF_TEXT}
      </p>
    )
  if (load.kind === 'error')
    return (
      <p className="dr-field-error" role="alert" data-testid="chat-prefs-error">
        {load.text}
      </p>
    )

  const hooks = load.data.hooks
  const hookIds = hooks.map((h) => h.id)
  const dirty = !sameChoice(chosen, saved, hookIds)

  const save = async () => {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const out = await putChatPrefs(prefsInput(workspaceId, hookIds, chosen), { api })
      const next = chosenFrom(out)
      setChosen(next)
      setSaved(next)
      setMessage('Saved.')
    } catch (e) {
      const err = e instanceof ChatHookRequestError ? e : new ChatHookRequestError('unavailable')
      setError(requestErrorText(err, 'Your choices could not be saved. Try again.'))
    } finally {
      setPending(false)
    }
  }

  if (hooks.length === 0)
    return (
      <p className="dr-muted" data-testid="chat-prefs-empty">
        No Slack or Teams channel is connected to this workspace yet. A workspace admin can add one.
      </p>
    )

  return (
    <div className="dr-chat" data-testid="chat-prefs">
      <p className="dr-muted">{MY_NOTIFICATIONS_INTRO}</p>
      {hooks.map((hook) => (
        <fieldset key={hook.id} className="dr-chat__hook" data-testid="chat-prefs-hook" data-hook-id={hook.id}>
          <legend className="dr-chat__legend">
            <strong>{hook.name}</strong>
            <span className="dr-chat__badge">{PROVIDER_LABEL[hook.provider]}</span>
            {hook.disabled && <span className="dr-chat__badge dr-chat__badge--off">Switched off</span>}
          </legend>
          {CHAT_HOOK_KINDS.map((kind: ChatHookKind) => (
            <label key={kind} className="dr-chat__kind">
              <input
                type="checkbox"
                data-testid={`chat-pref-${hook.id}-${kind}`}
                checked={(chosen[hook.id] ?? []).includes(kind)}
                aria-describedby={noteId}
                onChange={(e) => {
                  setChosen((c) => toggled(c, hook.id, kind, e.target.checked))
                  setMessage(null)
                }}
              />
              <span>{KIND_LABEL[kind]}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <p id={noteId} className="dr-muted dr-chat__note">
        {CHANNEL_NOTE}
      </p>
      {error && (
        <p className="dr-field-error" role="alert" data-testid="chat-prefs-save-error">
          {error}
        </p>
      )}
      <div className="dr-dialog__actions">
        <span className="dr-chat__saved" role="status" data-testid="chat-prefs-saved">
          {message}
        </span>
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          data-testid="chat-prefs-save"
          disabled={pending || !dirty}
          aria-busy={pending || undefined}
          onClick={() => void save()}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
