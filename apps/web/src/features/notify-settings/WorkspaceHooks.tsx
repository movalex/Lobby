// The workspace's Slack and Teams channels (wave R, WS2), for owners and admins who are creators: add a channel by pasting
// its webhook URL, send a test message, change or remove it, turn it back on after an answer switched it off. The URL is a
// secret: the field is a password field that autocompletes nothing, it is sent once and cleared at once, and the page only
// ever shows the hint the api sends back.
import type { ChatHook, ChatHookProvider } from '@draftroom/contracts'
import { type FormEvent, useEffect, useId, useState } from 'react'
import {
  ChatHookRequestError,
  type ChatHookRequestOptions,
  chatHooksAvailable,
  createChatHook,
  deleteChatHook,
  listChatHooks,
  patchChatHook,
  testChatHook,
} from './client.ts'
import {
  ADMIN_WARNING,
  HOW_TO,
  hookStatusLine,
  OFF_TEXT,
  PROVIDER_LABEL,
  requestErrorText,
  SNIPPET_SWITCH_HELP,
  SNIPPET_SWITCH_LABEL,
  testResultText,
} from './model.ts'

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; hooks: ChatHook[] }
  | { kind: 'off' }
  | { kind: 'error'; text: string }

const asError = (e: unknown) =>
  e instanceof ChatHookRequestError ? e : new ChatHookRequestError('unavailable')

export function WorkspaceHooksPanel({
  workspaceId,
  requestOptions = {},
}: {
  workspaceId: string
  requestOptions?: ChatHookRequestOptions
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const api = requestOptions.api

  useEffect(() => {
    const abort = new AbortController()
    setLoad({ kind: 'loading' })
    listChatHooks(workspaceId, { api, signal: abort.signal }).then(
      (hooks) => {
        if (abort.signal.aborted) return
        setLoad(chatHooksAvailable() ? { kind: 'ready', hooks } : { kind: 'off' })
      },
      (e: unknown) => {
        if (abort.signal.aborted) return
        setLoad({
          kind: 'error',
          text: requestErrorText(asError(e), 'The channels could not be loaded. Try again.'),
        })
      },
    )
    return () => abort.abort()
  }, [workspaceId, api])

  const replace = (hook: ChatHook) =>
    setLoad((cur) =>
      cur.kind === 'ready'
        ? { kind: 'ready', hooks: cur.hooks.map((h) => (h.id === hook.id ? hook : h)) }
        : cur,
    )
  const added = (hook: ChatHook) =>
    setLoad((cur) => (cur.kind === 'ready' ? { kind: 'ready', hooks: [...cur.hooks, hook] } : cur))
  /** the api remembers when a hook last sent or failed: read the list again after a test */
  const refresh = () =>
    listChatHooks(workspaceId, { api }).then(
      (hooks) => setLoad((cur) => (cur.kind === 'ready' ? { kind: 'ready', hooks } : cur)),
      () => {},
    )
  const removed = (id: string) =>
    setLoad((cur) =>
      cur.kind === 'ready' ? { kind: 'ready', hooks: cur.hooks.filter((h) => h.id !== id) } : cur,
    )

  if (load.kind === 'loading')
    return (
      <p className="dr-muted" data-testid="chat-hooks-loading">
        Loading…
      </p>
    )
  if (load.kind === 'off')
    return (
      <p className="dr-muted" data-testid="chat-hooks-off">
        {OFF_TEXT}
      </p>
    )
  if (load.kind === 'error')
    return (
      <p className="dr-field-error" role="alert" data-testid="chat-hooks-error">
        {load.text}
      </p>
    )

  return (
    <div className="dr-chat" data-testid="chat-hooks">
      <p className="dr-chat__warning" data-testid="chat-hooks-warning">
        {ADMIN_WARNING}
      </p>
      {load.hooks.length === 0 ? (
        <p className="dr-muted" data-testid="chat-hooks-empty">
          No channel is connected yet. Add one below.
        </p>
      ) : (
        <ul className="dr-chat__list">
          {load.hooks.map((hook) => (
            <HookRow
              key={hook.id}
              workspaceId={workspaceId}
              hook={hook}
              api={api}
              onChanged={replace}
              onRemoved={removed}
              onTested={() => void refresh()}
            />
          ))}
        </ul>
      )}
      <AddHookForm workspaceId={workspaceId} api={api} onAdded={added} />
    </div>
  )
}

function HookRow({
  workspaceId,
  hook,
  api,
  onChanged,
  onRemoved,
  onTested,
}: {
  workspaceId: string
  hook: ChatHook
  api: ChatHookRequestOptions['api']
  onChanged(h: ChatHook): void
  onRemoved(id: string): void
  onTested(): void
}) {
  const [busy, setBusy] = useState<'test' | 'remove' | 'enable' | 'edit' | null>(null)
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const disabled = hook.disabledAt !== null

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind)
    setResult(null)
    try {
      await fn()
    } catch (e) {
      setResult({ text: requestErrorText(asError(e), 'That did not work. Try again.'), ok: false })
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="dr-chat__hookrow" data-testid="chat-hook-row" data-hook-id={hook.id}>
      <div className="dr-chat__hookhead">
        <strong data-testid="chat-hook-name">{hook.name}</strong>
        <span className="dr-chat__badge">{PROVIDER_LABEL[hook.provider]}</span>
        {disabled && <span className="dr-chat__badge dr-chat__badge--off">Switched off</span>}
        {hook.includeSnippets && <span className="dr-chat__badge">Comment text on</span>}
      </div>
      <p className="dr-muted dr-chat__hint" data-testid="chat-hook-hint">
        {hook.hint}
      </p>
      <p className="dr-muted" data-testid="chat-hook-status">
        {hookStatusLine(hook)}
      </p>
      <div className="dr-chat__actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="chat-hook-test"
          disabled={busy !== null}
          onClick={() =>
            void run('test', async () => {
              const r = await testChatHook(workspaceId, hook.id, { api })
              setResult({ text: testResultText(r, hook.provider), ok: r.status === 'sent' })
              onTested()
            })
          }
        >
          {busy === 'test' ? 'Sending…' : 'Send test message'}
        </button>
        {disabled && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="chat-hook-enable"
            disabled={busy !== null}
            onClick={() =>
              void run('enable', async () => {
                onChanged(await patchChatHook(workspaceId, hook.id, { enabled: true }, { api }))
              })
            }
          >
            Turn back on
          </button>
        )}
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="chat-hook-edit"
          aria-expanded={editing}
          disabled={busy !== null}
          onClick={() => setEditing((v) => !v)}
        >
          Edit
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-btn--primary"
              data-testid="chat-hook-remove-confirm"
              disabled={busy !== null}
              onClick={() =>
                void run('remove', async () => {
                  await deleteChatHook(workspaceId, hook.id, { api })
                  onRemoved(hook.id)
                })
              }
            >
              Remove for everyone
            </button>
            <button type="button" className="dr-btn dr-btn--sm" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="chat-hook-remove"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            Remove
          </button>
        )}
      </div>
      {result && (
        <p
          className={result.ok ? 'dr-muted dr-chat__ok' : 'dr-field-error'}
          role={result.ok ? 'status' : 'alert'}
          data-testid="chat-hook-result"
        >
          {result.text}
        </p>
      )}
      {editing && (
        <EditHookForm
          workspaceId={workspaceId}
          hook={hook}
          api={api}
          onSaved={(h) => {
            onChanged(h)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  )
}

function EditHookForm({
  workspaceId,
  hook,
  api,
  onSaved,
  onCancel,
}: {
  workspaceId: string
  hook: ChatHook
  api: ChatHookRequestOptions['api']
  onSaved(h: ChatHook): void
  onCancel(): void
}) {
  const nameId = useId()
  const urlId = useId()
  const [name, setName] = useState(hook.name)
  const [text, setText] = useState(hook.includeSnippets)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const pasted = url.trim()
    setUrl('') // the secret leaves the form at once
    setPending(true)
    setError(null)
    try {
      onSaved(
        await patchChatHook(
          workspaceId,
          hook.id,
          {
            name,
            includeSnippets: text,
            ...(pasted ? { url: pasted } : {}),
            ...(pasted && hook.disabledAt ? { enabled: true as const } : {}),
          },
          { api },
        ),
      )
    } catch (err) {
      setPending(false)
      setError(requestErrorText(asError(err), 'The change could not be saved. Try again.'))
    }
  }

  return (
    <form
      className="dr-form dr-chat__edit"
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="chat-hook-edit-form"
    >
      <label htmlFor={nameId}>Name</label>
      <input
        id={nameId}
        className="dr-input dr-input--block"
        data-testid="chat-hook-edit-name"
        value={name}
        maxLength={80}
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
      />
      <label className="dr-check">
        <input
          type="checkbox"
          data-testid="chat-hook-edit-text"
          checked={text}
          onChange={(e) => setText(e.target.checked)}
        />
        <span>{SNIPPET_SWITCH_LABEL}</span>
      </label>
      <p className="dr-muted dr-chat__help">{SNIPPET_SWITCH_HELP}</p>
      <label htmlFor={urlId}>New webhook URL (leave empty to keep the saved one)</label>
      <input
        id={urlId}
        type="password"
        className="dr-input dr-input--block"
        data-testid="chat-hook-edit-url"
        value={url}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setUrl(e.target.value)}
      />
      {error && (
        <p className="dr-field-error" role="alert" data-testid="chat-hook-edit-error">
          {error}
        </p>
      )}
      <div className="dr-dialog__actions">
        <button type="button" className="dr-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="dr-btn dr-btn--primary"
          data-testid="chat-hook-edit-submit"
          disabled={pending || name.trim().length === 0}
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

export function AddHookForm({
  workspaceId,
  api,
  onAdded,
}: {
  workspaceId: string
  api: ChatHookRequestOptions['api']
  onAdded(h: ChatHook): void
}) {
  const providerId = useId()
  const nameId = useId()
  const urlId = useId()
  const errorId = useId()
  const [provider, setProvider] = useState<ChatHookProvider>('slack')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [text, setText] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const pasted = url.trim()
    if (!name.trim() || !pasted) {
      setError('Give the channel a name and paste its webhook URL.')
      return
    }
    setUrl('') // the secret leaves the form at once, whatever the answer
    setPending(true)
    setError(null)
    try {
      onAdded(
        await createChatHook(workspaceId, { name, provider, url: pasted, includeSnippets: text }, { api }),
      )
      setName('')
      setText(false)
    } catch (err) {
      setError(requestErrorText(asError(err), 'The channel could not be added. Try again.'))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="dr-form dr-chat__add"
      onSubmit={(e) => void submit(e)}
      noValidate
      data-testid="chat-hook-add"
    >
      <h3 className="dr-chat__h3">Add a channel</h3>
      <label htmlFor={providerId}>Where</label>
      <select
        id={providerId}
        className="dr-input dr-input--block dr-select"
        data-testid="chat-hook-add-provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as ChatHookProvider)}
      >
        <option value="slack">{PROVIDER_LABEL.slack}</option>
        <option value="teams">{PROVIDER_LABEL.teams}</option>
      </select>
      <details className="dr-chat__howto">
        <summary>How to get the webhook URL for {PROVIDER_LABEL[provider]}</summary>
        <ol>
          {HOW_TO[provider].map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </details>
      <label htmlFor={nameId}>Name (for your team, e.g. #lobby-pitches)</label>
      <input
        id={nameId}
        className="dr-input dr-input--block"
        data-testid="chat-hook-add-name"
        value={name}
        maxLength={80}
        autoComplete="off"
        onChange={(e) => {
          setName(e.target.value)
          setError(null)
        }}
      />
      <label htmlFor={urlId}>Webhook URL</label>
      <input
        id={urlId}
        type="password"
        className="dr-input dr-input--block"
        data-testid="chat-hook-add-url"
        value={url}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => {
          setUrl(e.target.value)
          setError(null)
        }}
      />
      <p className="dr-muted dr-chat__help">
        Whoever has this URL can post to the channel, so Lobby keeps it encrypted and never shows it again.
      </p>
      <label className="dr-check">
        <input
          type="checkbox"
          data-testid="chat-hook-add-text"
          checked={text}
          onChange={(e) => setText(e.target.checked)}
        />
        <span>{SNIPPET_SWITCH_LABEL}</span>
      </label>
      <p className="dr-muted dr-chat__help">{SNIPPET_SWITCH_HELP}</p>
      {error && (
        <p id={errorId} className="dr-field-error" role="alert" data-testid="chat-hook-add-error">
          {error}
        </p>
      )}
      <div className="dr-dialog__actions">
        <button
          type="submit"
          className="dr-btn dr-btn--primary"
          data-testid="chat-hook-add-submit"
          disabled={pending}
          aria-busy={pending || undefined}
        >
          {pending ? 'Adding…' : 'Add channel'}
        </button>
      </div>
    </form>
  )
}
