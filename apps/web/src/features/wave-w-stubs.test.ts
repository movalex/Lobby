// The wave W web side shared by the workstreams (docs/WAVE-W-CONTRACTS.md §1.3, §8): the switches (all off; a web switch
// needs the api's offer too), the three wave W board features (registered empty), the /w/:wid/admin route and the
// pending palette ids. Each workstream pins its own feature in its own tests; this file pins what they share.
import {
  FORMAT_SWITCHES_OFF,
  PENDING_PALETTE_COMMAND_IDS,
  WAVE_W_PALETTE_COMMAND_IDS,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { matchRoute } from '../lib/routing.ts'
import { CANVAS_FEATURES } from './canvas-registry.ts'
import {
  FORMATS_FLAG_KEYS,
  FORMATS_FLAG_SERVER,
  FORMATS_FLAGS,
  type FormatsFlags,
  formatsEnabled,
  formatsFlags,
  formatsOffer,
  setFormatsOffer,
} from './formats/flags.ts'

afterEach(() => setFormatsOffer(null))

const ALL_ON: FormatsFlags = {
  docCards: true,
  removeBackground: true,
  fileSearch: true,
  deckImport: true,
  admin: true,
}

describe('the wave W switches', () => {
  it('ship off, and a production page ignores any override', () => {
    expect(FORMATS_FLAGS).toEqual({
      docCards: false,
      removeBackground: false,
      fileSearch: false,
      deckImport: false,
      admin: false,
    })
    expect(Object.keys(FORMATS_FLAG_KEYS).sort()).toEqual(Object.keys(FORMATS_FLAGS).sort())
    expect(Object.keys(FORMATS_FLAG_SERVER).sort()).toEqual(Object.keys(FORMATS_FLAGS).sort())
    expect(formatsFlags(false, () => '1')).toEqual(FORMATS_FLAGS)
  })

  it('a dev-auth page may turn each on or off; a blocked store keeps the shipped value', () => {
    expect(formatsFlags(true, () => '1')).toEqual(ALL_ON)
    expect(formatsFlags(true, () => '0')).toEqual(FORMATS_FLAGS)
    expect(formatsFlags(true, (k) => (k === FORMATS_FLAG_KEYS.admin ? '1' : null)).admin).toBe(true)
    expect(
      formatsFlags(true, () => {
        throw new Error('blocked')
      }),
    ).toEqual(FORMATS_FLAGS)
  })

  it('the api offer starts all off; anything not exactly true is off; an api before wave W sends none', () => {
    expect(formatsOffer.get()).toEqual(FORMAT_SWITCHES_OFF)
    setFormatsOffer({ docCards: true, removeBackground: 'yes' as unknown as boolean, admin: true })
    expect(formatsOffer.get()).toEqual({ ...FORMAT_SWITCHES_OFF, docCards: true, admin: true })
    setFormatsOffer(undefined)
    expect(formatsOffer.get()).toEqual(FORMAT_SWITCHES_OFF)
  })

  it('a feature is offered only when its web switch AND the api offer say on', () => {
    const offer = { ...FORMAT_SWITCHES_OFF, docCards: true, fileSearch: true }
    expect(formatsEnabled('docCards', ALL_ON, offer)).toBe(true)
    expect(formatsEnabled('fileSearch', ALL_ON, offer)).toBe(true)
    expect(formatsEnabled('removeBackground', ALL_ON, offer)).toBe(false)
    expect(formatsEnabled('docCards', FORMATS_FLAGS, offer)).toBe(false)
    // the shipped switches are off: nothing is offered whatever the api says
    for (const f of Object.keys(FORMATS_FLAGS) as (keyof FormatsFlags)[])
      expect(formatsEnabled(f, FORMATS_FLAGS, { ...FORMAT_SWITCHES_OFF, [f]: true }), f).toBe(false)
  })
})

describe('the wave W board features and routes', () => {
  it('doc-cards, remove-bg and deck-import are registered, empty, before the Elements panel (the last)', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    for (const id of ['doc-cards', 'remove-bg', 'deck-import']) {
      const f = CANVAS_FEATURES.find((x) => x.id === id)
      expect(f, id).toBeDefined()
      expect(Object.keys(f ?? {}), id).toEqual(['id'])
    }
    expect(ids.at(-1)).toBe('elements')
    expect(ids.indexOf('deck-import')).toBe(ids.indexOf('breakouts') + 3)
  })

  it('/w/:wid/admin is its own route', () => {
    expect(matchRoute('/w/wsp_0123456789abcdefghij/admin')).toEqual({
      name: 'workspace-admin',
      workspaceId: 'wsp_0123456789abcdefghij',
    })
  })

  it('every wave W palette id is pending until its owner registers it', () => {
    for (const id of WAVE_W_PALETTE_COMMAND_IDS)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[], id).toContain(id)
  })
})
