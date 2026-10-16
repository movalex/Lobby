// The chat notifications dialog (wave R, WS2), rendered to static markup (effects do not run, so each panel shows its
// loading line; the behaviour with an api is e2e/excalidraw/r3-chat-hooks.spec.ts).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatNotificationsDialog, ChatNotificationsEntry } from './ChatNotificationsDialog.tsx'
import { AddHookForm } from './WorkspaceHooks.tsx'

const W = 'wsp_0123456789abcdefghij'
const dialog = (canManage: boolean) =>
  renderToStaticMarkup(
    createElement(ChatNotificationsDialog, { workspaceId: W, workspaceName: 'DBC Pitches', canManage, onClose() {} }),
  )

describe('the dialog', () => {
  it('a member sees only "My notifications": no tabs, no channels', () => {
    const html = dialog(false)
    expect(html).toContain('data-testid="chat-notifications-dialog"')
    expect(html).toContain('DBC Pitches')
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('chat-tab-channels')
  })

  it('an owner or admin gets both tabs, "My notifications" first and selected', () => {
    const html = dialog(true)
    expect(html).toContain('role="tablist"')
    expect(html).toMatch(/data-testid="chat-tab-mine"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-testid="chat-tab-mine"/)
    expect(html).toContain('data-testid="chat-tab-channels"')
    expect(html).toContain('role="tabpanel"')
  })

  it('the entry draws nothing until the api has said chat notifications are on', () => {
    expect(
      renderToStaticMarkup(
        createElement(ChatNotificationsEntry, { workspaceId: W, workspaceName: 'DBC Pitches', canManage: true }),
      ),
    ).toBe('')
  })
})

describe('adding a channel', () => {
  const html = renderToStaticMarkup(createElement(AddHookForm, { workspaceId: W, api: undefined, onAdded() {} }))

  it('takes the webhook URL in a password field that remembers nothing', () => {
    const field = /<input[^>]*data-testid="chat-hook-add-url"[^>]*>/.exec(html)?.[0] ?? ''
    expect(field).toContain('type="password"')
    expect(field).toContain('autoComplete="off"')
    expect(field).toContain('spellCheck="false"')
    expect(field).toContain('value=""')
  })

  it('says who can see the messages, what the switch does, and that the URL is never shown again', () => {
    expect(html).toContain('Include comment text and private board titles')
    expect(html).toContain('a private board')
    expect(html).toContain('never shows it again')
    expect(html).toContain('Slack')
    expect(html).toContain('Microsoft Teams')
    expect(html).toContain('How to get the webhook URL for Slack')
  })

  it('the text switch starts off', () => {
    const box = /<input[^>]*data-testid="chat-hook-add-text"[^>]*>/.exec(html)?.[0] ?? ''
    expect(box).not.toContain('checked')
  })
})
