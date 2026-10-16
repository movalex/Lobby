// The wave R foundation's web side (docs/WAVE-R-CONTRACTS.md §7): nothing changes for a user. The Import control is
// today's single button while its switches are off (a dev-auth page may turn them on); the backup and chat hook
// clients answer empty and reject writes with 'unavailable', without a single request. WS1 made the import job and
// Miro clients live: their tests are in import-miro/client.test.ts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChatHookRequestError,
  chatHooksAvailable,
  createChatHook,
  deleteChatHook,
  getChatPrefs,
  listChatHooks,
  patchChatHook,
  putChatPrefs,
  testChatHook,
} from '../features/notify-settings/client.ts'
import { backupTicket, restoreBackup } from './import-backup/client.ts'
import { IMPORT_MENU_FLAGS, IMPORT_MENU_KEYS, importMenuFlags } from './import-menu/flags.ts'
import { ImportMenu, importMenuEntries } from './import-menu/ImportMenu.tsx'
import { ImportRequestError } from './imports/client.ts'

const W = 'wsp_0123456789abcdefghij'
const HOOK = 'chk_0123456789abcdefghij'

describe('the Import control', () => {
  it('ships with every switch off', () => {
    expect(IMPORT_MENU_FLAGS).toEqual({ menu: false, miro: false, backup: false })
    expect(importMenuFlags(false, () => '1')).toEqual(IMPORT_MENU_FLAGS)
  })

  it('a dev-auth page may turn each on or off; an unreadable store keeps the shipped value', () => {
    const store: Record<string, string> = { [IMPORT_MENU_KEYS.menu]: '1', [IMPORT_MENU_KEYS.miro]: '1' }
    expect(importMenuFlags(true, (k) => store[k])).toEqual({ menu: true, miro: true, backup: false })
    expect(
      importMenuFlags(true, () => {
        throw new Error('blocked')
      }),
    ).toEqual(IMPORT_MENU_FLAGS)
  })

  it('off: exactly today’s button; on: a menu of the entries whose handler is there', () => {
    const off = renderToStaticMarkup(createElement(ImportMenu, { importing: false, onJson: () => {} }))
    expect(off).toContain('data-testid="import-board"')
    expect(off).toContain('title="Import a board exported from Lobby (.json)"')
    expect(off).toContain('>Import<')
    expect(off).not.toContain('import-menu')
    const busy = renderToStaticMarkup(createElement(ImportMenu, { importing: true, onJson: () => {} }))
    expect(busy).toContain('disabled=""')
    expect(busy).toContain('Importing…')
    const all = { menu: true, miro: true, backup: true }
    // the menu on, but no entry other than .json has a handler: still the button
    const lone = renderToStaticMarkup(
      createElement(ImportMenu, { importing: false, onJson: () => {}, flags: all }),
    )
    expect(lone).toContain('data-testid="import-board"')
    const menu = renderToStaticMarkup(
      createElement(ImportMenu, { importing: false, onJson: () => {}, onMiro: () => {}, flags: all }),
    )
    expect(menu).toContain('data-testid="import-menu"')
    expect(menu).toContain('aria-haspopup="menu"')
    expect(importMenuEntries(all, { miro: () => {}, backup: () => {} }).map((e) => e.label)).toEqual([
      'Lobby backup (.lobby)…',
      'Lobby board (.json)…',
      'From Miro…',
    ])
    expect(importMenuEntries({ ...all, miro: false }, { miro: () => {}, backup: () => {} })).toHaveLength(2)
  })
})

describe('the wave R clients (stubs)', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  const rejectsUnavailable = async (
    p: Promise<unknown>,
    kind: typeof ImportRequestError | typeof ChatHookRequestError,
  ) => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    )
    expect(e).toBeInstanceOf(kind)
    expect((e as { code: string }).code).toBe('unavailable')
  }

  it('backup: refused writes, no request', async () => {
    await rejectsUnavailable(backupTicket('b-abc1234567'), ImportRequestError)
    await rejectsUnavailable(restoreBackup(W, new Blob(['PK'])), ImportRequestError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('chat hooks: empty reads, refused writes, no request', async () => {
    expect(chatHooksAvailable()).toBe(false)
    expect(await listChatHooks(W)).toEqual([])
    expect(await getChatPrefs(W)).toEqual({ hooks: [], prefs: [] })
    const url = 'https://hooks.slack.com/services/T1/B1/abc'
    await rejectsUnavailable(
      createChatHook(W, { name: '#lobby', provider: 'slack', url, includeSnippets: false }),
      ChatHookRequestError,
    )
    await rejectsUnavailable(patchChatHook(W, HOOK, { name: '#x' }), ChatHookRequestError)
    await rejectsUnavailable(deleteChatHook(W, HOOK), ChatHookRequestError)
    await rejectsUnavailable(testChatHook(W, HOOK), ChatHookRequestError)
    await rejectsUnavailable(putChatPrefs({ workspaceId: W, prefs: [] }), ChatHookRequestError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
