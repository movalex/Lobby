// The wave R web side (docs/WAVE-R-CONTRACTS.md §7). The Import control ships as a menu (the integration turned its
// switches on); with them off it is the single button of before (a dev-auth page may turn each on or off). Every wave
// R client is live:
// the chat hooks (WS2, features/notify-settings/client.test.ts), the import job and Miro clients (WS1,
// import-miro/client.test.ts) and the backup client (WS4, import-backup).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IMPORT_MENU_FLAGS, IMPORT_MENU_KEYS, importMenuFlags } from './import-menu/flags.ts'
import { ImportMenu, importMenuEntries } from './import-menu/ImportMenu.tsx'

describe('the Import control', () => {
  it('ships with every switch on', () => {
    expect(IMPORT_MENU_FLAGS).toEqual({ menu: true, miro: true, backup: true })
    expect(importMenuFlags(false, () => '0')).toEqual(IMPORT_MENU_FLAGS)
  })

  it('a dev-auth page may turn each on or off; an unreadable store keeps the shipped value', () => {
    const store: Record<string, string> = { [IMPORT_MENU_KEYS.menu]: '1', [IMPORT_MENU_KEYS.miro]: '0' }
    expect(importMenuFlags(true, (k) => store[k])).toEqual({ menu: true, miro: false, backup: true })
    expect(
      importMenuFlags(true, () => {
        throw new Error('blocked')
      }),
    ).toEqual(IMPORT_MENU_FLAGS)
  })

  it('off: exactly today’s button; on: a menu of the entries whose handler is there', () => {
    const none = { menu: false, miro: false, backup: false }
    const off = renderToStaticMarkup(
      createElement(ImportMenu, { importing: false, onJson: () => {}, onMiro: () => {}, flags: none }),
    )
    expect(off).toContain('data-testid="import-board"')
    expect(off).toContain('title="Import a board exported from Lobby (.json)"')
    expect(off).toContain('>Import<')
    expect(off).not.toContain('import-menu')
    const busy = renderToStaticMarkup(
      createElement(ImportMenu, { importing: true, onJson: () => {}, flags: none }),
    )
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
      'Import from Miro (beta)…',
    ])
    expect(importMenuEntries({ ...all, miro: false }, { miro: () => {}, backup: () => {} })).toHaveLength(2)
  })
})
