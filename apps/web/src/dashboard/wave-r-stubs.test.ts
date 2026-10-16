// The wave R foundation's web side (docs/WAVE-R-CONTRACTS.md §7): nothing changes for a user. The Import control is
// today's single button while its switches are off (a dev-auth page may turn them on). Every wave R client is live:
// the chat hooks (WS2, features/notify-settings/client.test.ts), the import job and Miro clients (WS1,
// import-miro/client.test.ts) and the backup client (WS4, import-backup).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IMPORT_MENU_FLAGS, IMPORT_MENU_KEYS, importMenuFlags } from './import-menu/flags.ts'
import { ImportMenu, importMenuEntries } from './import-menu/ImportMenu.tsx'

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
