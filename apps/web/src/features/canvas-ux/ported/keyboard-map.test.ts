// The Excalidraw board page's keyboard map across ALL ported features (owner 3a; docs/EXCALIDRAW-CONTRACTS.md
// §1 rule 8: "the keyboard-map test reads collectKeyClaims(CANVAS_FEATURES) and fails on keyConflicts").
// The key registry dispatches the features' keys before the allowlist (canvas/input/keymap.ts), in feature
// order, so a chord claimed twice in one scope would silently lose one binding at run time: it fails here.
//
// Deferring keys (./keys.ts DEFERRING_KEYS) act only in a narrow state and step aside when another
// feature's key takes the same event; they are checked for that instead of for conflicts.
import { describe, expect, it } from 'vitest'
import {
  type CanvasFeatureContext,
  collectKeyClaims,
  createFeatureRegistries,
  type KeyEventLike,
  keyConflicts,
  parseChord,
} from '../../../canvas/api/index.ts'
import { CANVAS_FEATURES } from '../../canvas-registry.ts'
import { feature as canvasUx } from './index.tsx'
import { DEFERRING_KEYS, KEYS, othersTake } from './keys.ts'
import { shortcutSections } from './ShortcutsDialog.tsx'

const claims = collectKeyClaims(CANVAS_FEATURES)
const canonical = (chord: string) => {
  const p = parseChord(chord)
  return [p.mod && 'mod', p.ctrl && 'ctrl', p.meta && 'meta', p.alt && 'alt', p.shift && 'shift', p.key]
    .filter(Boolean)
    .join('+')
}

/** Browser chords no feature may take (reload, tabs, windows, the address bar, devtools, fullscreen). */
const BROWSER = [
  'mod+r',
  'mod+shift+r',
  'f5',
  'mod+t',
  'mod+shift+t',
  'mod+w',
  'mod+shift+w',
  'mod+n',
  'mod+shift+n',
  'mod+l',
  'alt+d',
  'f12',
  'mod+shift+i',
  'mod+shift+j',
  'mod+shift+c',
  'f11',
  'mod+tab',
  'mod+pageup',
  'mod+pagedown',
  ...'123456789'.split('').map((d) => `mod+${d}`),
].map(canonical)

/**
 * Keys Excalidraw keeps (plan §2.3.3 "Delegated to Excalidraw"); a feature that takes one replaces the
 * engine's own action, so each is listed with why.
 */
const ENGINE_KEYS = [
  'mod+d',
  'mod+g',
  'mod+shift+g',
  'mod+[',
  'mod+]',
  'mod+=',
  'mod+-',
  'escape',
  'space',
  'mod+shift+l',
].map(canonical)
const TAKES_ENGINE_KEY: Readonly<Record<string, string>> = {
  [canonical('mod+shift+l')]:
    'canvas-ux.toggle-lock: MAK-05 keeps the selection and never groups a locked selection',
}

describe('the keyboard map of CANVAS_FEATURES', () => {
  it('every claimed chord parses', () => {
    for (const c of claims) expect(() => parseChord(c.chord), `${c.by}: ${c.chord}`).not.toThrow()
  })

  it('binds no chord twice in one scope (deferring keys aside)', () => {
    const firm = claims.filter((c) => !DEFERRING_KEYS.has(c.by))
    expect(keyConflicts(firm)).toEqual([])
  })

  it('takes no browser chord', () => {
    const taken = claims.filter((c) => BROWSER.includes(canonical(c.chord)))
    expect(taken.map((c) => `${c.by}: ${c.chord}`)).toEqual([])
  })

  it('takes an engine key only where the table says why', () => {
    const taken = claims.filter((c) => ENGINE_KEYS.includes(canonical(c.chord)) && !DEFERRING_KEYS.has(c.by))
    for (const c of taken) expect(TAKES_ENGINE_KEY[canonical(c.chord)], `${c.by}: ${c.chord}`).toBeTruthy()
  })
})

describe('canvas-ux’s own keys (a change here is a change of docs/PROGRESS.md’s wave 3a key list)', () => {
  it('are exactly these', () => {
    const own = claims
      .filter((c) => c.featureId === 'canvas-ux' && !DEFERRING_KEYS.has(c.by))
      .map((c) => `${c.scope} ${canonical(c.chord)} → ${c.by}`)
      .sort()
    expect(own).toEqual(
      [
        'canvas mod+shift+l → canvas-ux.toggle-lock',
        'canvas pageup → canvas-ux.bring-to-front',
        'canvas ] → canvas-ux.bring-to-front',
        'canvas pagedown → canvas-ux.send-to-back',
        'canvas [ → canvas-ux.send-to-back',
        'canvas shift+pageup → canvas-ux.bring-forward',
        'canvas alt+] → canvas-ux.bring-forward',
        'canvas shift+pagedown → canvas-ux.send-backward',
        'canvas alt+[ → canvas-ux.send-backward',
        'canvas alt+a → canvas-ux.align-left',
        'canvas alt+h → canvas-ux.align-center-horizontal',
        'canvas alt+w → canvas-ux.align-top',
        'canvas alt+v → canvas-ux.align-center-vertical',
        'canvas alt+s → canvas-ux.align-bottom',
        'canvas alt+shift+h → canvas-ux.distribute-horizontal',
        'canvas alt+shift+v → canvas-ux.distribute-vertical',
        'canvas shift+? → canvas-ux.keyboard-shortcuts',
        'canvas mod+/ → canvas-ux.keyboard-shortcuts',
        'canvas mod+alt+/ → canvas-ux.keyboard-shortcuts',
        'canvas mod+u → canvas-ux.insert-file',
        'canvas shift+f10 → canvas-ux.context-menu-key',
        'canvas contextmenu → canvas-ux.context-menu-key',
        'canvas alt+f10 → canvas-ux.selection-bar-key',
      ].sort(),
    )
  })

  it('no letter without Ctrl, Cmd or Alt is claimed firmly (they are the allowlist’s tools and type-to-edit)', () => {
    const letters = claims.filter(
      (c) =>
        c.featureId === 'canvas-ux' && !DEFERRING_KEYS.has(c.by) && /^[a-z0-9]$/.test(canonical(c.chord)),
    )
    expect(letters).toEqual([])
  })
})

describe('deferring keys step aside', () => {
  const ev = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  })
  it('when another feature’s key takes the event, in the same scope only', () => {
    const registries = createFeatureRegistries()
    const ctx = { registries } as unknown as CanvasFeatureContext
    registries.keys.register({
      id: 'key:mindmap.enter',
      scope: 'canvas',
      match: (e) => e.key === 'Enter',
      handle: () => true,
    })
    // canvas-ux's own registrations never count
    registries.keys.register({
      id: 'key:canvas-ux.enter',
      scope: 'canvas',
      match: () => true,
      handle: () => true,
    })
    expect(othersTake(ev('Enter', 'Enter'), ctx, 'canvas')).toBe(true)
    expect(othersTake(ev('Enter', 'Enter'), ctx, 'editor')).toBe(false)
    expect(othersTake(ev('m', 'KeyM'), ctx, 'canvas')).toBe(false)
  })

  it('every deferring key is canvas-ux’s and in KEYS', () => {
    const ids = new Set(KEYS.map((k) => k.id))
    for (const id of DEFERRING_KEYS) expect(ids.has(id), id).toBe(true)
  })
})

describe('the shortcuts dialog', () => {
  it('lists every command and tool key the features claim', () => {
    const registries = createFeatureRegistries()
    for (const f of CANVAS_FEATURES) {
      for (const c of f.commands ?? []) registries.commands.register(c)
      for (const t of f.tools ?? []) registries.tools.register(t)
    }
    const ctx = { registries } as unknown as CanvasFeatureContext
    const listed = new Set(shortcutSections(ctx).flatMap((s) => s.rows.flatMap((r) => r.keys)))
    for (const f of CANVAS_FEATURES) {
      for (const c of f.commands ?? [])
        for (const k of c.kbd ?? []) expect(listed.has(k), `${c.id}: ${k}`).toBe(true)
      for (const t of f.tools ?? [])
        for (const k of t.kbd ?? []) expect(listed.has(k), `${t.id}: ${k}`).toBe(true)
    }
  })

  it('canvas-ux provides the chrome host slots it owns', () => {
    expect(Object.keys(canvasUx.slots ?? {}).sort()).toEqual(
      ['contextMenu', 'mainMenu', 'selectionBar', 'shortcutsDialog', 'stylePanel', 'toolbar'].sort(),
    )
  })
})
