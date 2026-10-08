// Wave K (K4-4): "Nothing has been shared with you yet" and "You're not in a workspace yet". A phone visitor
// signed in four times and out twice in four minutes without reaching a board, so both screens now say which
// address is signed in (prominently), what to do next, which addresses are work addresses (from the build's
// configuration, never typed into the copy), and offer "Switch account" and "Copy my address". Component tests
// in Node: the view is a plain function of its props, so a test reads it and presses a button. How it lays out
// on a phone (no sideways scroll, every action reachable) is e2e/excalidraw/k4-screens.spec.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MeAccess } from '@draftroom/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CREATOR_DOMAINS,
  creatorDomainsInWords,
  DEFAULT_CREATOR_DOMAINS,
  parseCreatorDomains,
} from '../dashboard/creator-config.ts'
import { noWorkspaceCopy } from '../dashboard/model.ts'
import { byTestId, fire, textOf } from '../dashboard/test-tree.ts'
import {
  ADDRESS_COPY_FALLBACK,
  ADDRESS_MAX_LENGTH,
  COPY_TIMEOUT_MS,
  copyAddress,
  isCopyableAddress,
} from './copy-address.ts'
import { NoWorkspaceView } from './screens.tsx'

const outside: MeAccess = { creator: false, reason: 'outside', email: 'pat@client.example.test' }
const none: MeAccess = { creator: true, reason: 'domain', email: 'sam@team.example.test' }
const unconfirmed: MeAccess = { creator: false, reason: 'unconfirmed', email: null }

const view = (
  access: MeAccess,
  over: Partial<Parameters<typeof NoWorkspaceView>[0]> = {},
  domains?: readonly string[],
) => {
  const handlers = { onSwitch: vi.fn(), onCopy: vi.fn(), onReload: vi.fn() }
  const props = { copy: noWorkspaceCopy(access, domains), ...handlers, ...over }
  return { tree: NoWorkspaceView(props), html: renderToStaticMarkup(NoWorkspaceView(props)), ...handlers }
}

afterEach(() => vi.useRealTimers())

describe.each([
  ['Nothing has been shared with you yet', outside, 'outside', 'pat@client.example.test'],
  ["You're not in a workspace yet", none, 'none', 'sam@team.example.test'],
] as const)('the screen "%s"', (title, access, reason, address) => {
  it('is the no-workspace screen of its variant, with its title', () => {
    const { html } = view(access)
    expect(html).toContain('data-testid="no-workspace"')
    expect(html).toContain(`data-reason="${reason}"`)
    expect(html).toContain(title.replace("'", '&#x27;'))
  })

  it('shows the signed-in address prominently: a sentence in a callout with the address set apart', () => {
    const { html, tree } = view(access)
    expect(html).toMatch(
      new RegExp(
        `<p class="dr-nowork__account" data-testid="no-workspace-account">You(?:&#x27;|')re signed in as <strong class="dr-nowork__email" data-testid="no-workspace-email">${address.replace(/\./g, '\\.')}</strong>\\.</p>`,
      ),
    )
    expect(textOf(byTestId(tree, 'no-workspace-account')[0])).toBe(`You're signed in as ${address}.`)
  })

  it('says what to do next and names the work addresses, from the configuration', () => {
    const text = textOf(view(access).tree)
    expect(text).toMatch(/open the invite link|Open an invite link/)
    expect(text).toContain(`Work addresses end in ${creatorDomainsInWords(CREATOR_DOMAINS)}.`)
  })

  it('offers "Switch account" (it signs out) and "Copy my address" (it copies), one press each', () => {
    const { tree, onSwitch, onCopy } = view(access)
    const switchBtn = byTestId(tree, 'no-workspace-switch')[0]
    const copyBtn = byTestId(tree, 'no-workspace-copy')[0]
    expect(textOf(switchBtn)).toBe('Switch account')
    expect(textOf(copyBtn)).toBe('Copy my address')
    expect(byTestId(tree, 'no-workspace-reload')).toHaveLength(0)
    fire(copyBtn as never)
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onSwitch).not.toHaveBeenCalled()
    fire(switchBtn as never)
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })

  it('names the domains it is configured with, and no others', () => {
    const configured = ['studio.example', 'studio2.example']
    const { html } = view(access, {}, configured)
    expect(html).toContain('Work addresses end in @studio.example or @studio2.example.')
    for (const d of DEFAULT_CREATOR_DOMAINS) expect(html, d).not.toContain(d)
    expect(view(access, {}, ['only.example']).html).toContain('Work addresses end in @only.example.')
  })

  it('shows what happened to the copy: nothing, copied, or by hand with the fallback text', () => {
    expect(view(access).html).not.toContain('no-workspace-copy-fallback')
    expect(view(access).html).not.toContain('no-workspace-copied')
    const copied = view(access, { copyState: 'copied' }).html
    expect(copied).toContain('data-testid="no-workspace-copied"')
    expect(copied).toContain('role="status"')
    const manual = view(access, { copyState: 'manual' }).html
    expect(manual).toContain('data-testid="no-workspace-copy-fallback"')
    expect(manual).toContain(`>${ADDRESS_COPY_FALLBACK}<`)
    expect(ADDRESS_COPY_FALLBACK).toBe('Select the address and press Ctrl+C')
  })

  it('sends nothing to anybody: no mail link, no form, no address in a link', () => {
    const { html } = view(access)
    expect(html).not.toMatch(/mailto:|<form|type="submit"/i)
    expect(html).not.toMatch(new RegExp(`href="[^"]*${address.split('@')[0]}`))
  })

  it('disables Switch account while it signs out', () => {
    const busy = view(access, { switching: true })
    const btn = byTestId(busy.tree, 'no-workspace-switch')[0]
    expect(btn?.props.disabled).toBe(true)
    expect(textOf(btn)).toBe('Signing out…')
  })
})

describe('the screen that could not confirm an account', () => {
  it('keeps its Reload, shows no address and offers no copy button', () => {
    const { tree, html, onReload } = view(unconfirmed)
    expect(html).toContain('data-reason="unconfirmed"')
    expect(byTestId(tree, 'no-workspace-switch')).toHaveLength(0)
    expect(byTestId(tree, 'no-workspace-copy')).toHaveLength(0)
    expect(html).not.toContain('no-workspace-email')
    fire(byTestId(tree, 'no-workspace-reload')[0] as never)
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})

describe('an account with no confirmed address', () => {
  it('says so and offers no copy (there is nothing to send)', () => {
    const { tree, html } = view({ ...outside, email: null })
    expect(html).toContain('no confirmed email address')
    expect(byTestId(tree, 'no-workspace-copy')).toHaveLength(0)
    expect(byTestId(tree, 'no-workspace-switch')).toHaveLength(1)
  })
})

describe('"Copy my address" is bounded', () => {
  it('copies a plain address and says so', async () => {
    const write = vi.fn(async () => true)
    expect(await copyAddress('pat@client.example.test', write)).toBe(true)
    expect(write).toHaveBeenCalledWith('pat@client.example.test')
  })

  it('refuses anything that is not an address, without touching the clipboard', async () => {
    const write = vi.fn(async () => true)
    for (const bad of [
      null,
      undefined,
      '',
      'a',
      '@x.example',
      'x@',
      'a@b@c.example',
      'pat smith@client.example',
      'pat@client.example\nBcc: x@y.example',
      `${'a'.repeat(ADDRESS_MAX_LENGTH)}@client.example`,
      'pät@client.example',
    ]) {
      expect(isCopyableAddress(bad), String(bad)).toBe(false)
      expect(await copyAddress(bad, write), String(bad)).toBe(false)
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('counts a refusing clipboard, and one that throws, as "do it by hand"', async () => {
    expect(await copyAddress('pat@client.example.test', async () => false)).toBe(false)
    expect(
      await copyAddress('pat@client.example.test', async () => {
        throw new Error('NotAllowedError')
      }),
    ).toBe(false)
  })

  it('does not hang on a clipboard that never answers: it gives up after a moment', async () => {
    vi.useFakeTimers()
    const pending = copyAddress('pat@client.example.test', () => new Promise<boolean>(() => {}))
    await vi.advanceTimersByTimeAsync(COPY_TIMEOUT_MS + 1)
    expect(await pending).toBe(false)
    expect(COPY_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })
})

describe('the creator domains are configuration', () => {
  it('default to the api’s own list (apps/api/src/auth/creators.ts), which this test reads', () => {
    const api = readFileSync(
      fileURLToPath(new URL('../../../api/src/auth/creators.ts', import.meta.url)),
      'utf8',
    )
    const listed = /DEFAULT_CREATOR_DOMAINS = \[([^\]]+)\]/.exec(api)?.[1] ?? ''
    const apiDefault = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(apiDefault.length).toBeGreaterThan(0)
    expect([...DEFAULT_CREATOR_DOMAINS]).toEqual(apiDefault)
    expect([...CREATOR_DOMAINS]).toEqual(apiDefault)
  })

  it('read a comma list, lowercased, and leave out anything that is not a plain domain', () => {
    expect(parseCreatorDomains(' Studio.Example , other.example,studio.example')).toEqual([
      'studio.example',
      'other.example',
    ])
    expect(
      parseCreatorDomains('good.example, *, a@b.example, host.example:443, x.invalid, .lead.example'),
    ).toEqual(['good.example'])
  })

  it('fall back to the default for an unset, blank or wholly invalid value', () => {
    for (const raw of [undefined, null, '', '   ', ',,', '*', 'nodot', 42])
      expect(parseCreatorDomains(raw), String(raw)).toEqual([...DEFAULT_CREATOR_DOMAINS])
  })

  it('say the endings of a work address in plain words', () => {
    expect(creatorDomainsInWords(['a.example'])).toBe('@a.example')
    expect(creatorDomainsInWords(['a.example', 'b.example'])).toBe('@a.example or @b.example')
    expect(creatorDomainsInWords(['a.example', 'b.example', 'c.example'])).toBe(
      '@a.example, @b.example or @c.example',
    )
    expect(creatorDomainsInWords([])).toBe('')
  })
})
