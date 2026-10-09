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
  installCanvasFeatures,
  type KeyEventLike,
  keyConflicts,
  parseChord,
  WAVE_L_CONTEXTUAL_KEYS,
  WAVE_L_KEY_CLAIMS,
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
  'mod+shift++',
  'mod+shift+_',
  'escape',
  'space',
  'mod+shift+l',
].map(canonical)
const TAKES_ENGINE_KEY: Readonly<Record<string, string>> = {
  [canonical('mod+shift+l')]:
    'canvas-ux.toggle-lock: MAK-05 keeps the selection and never groups a locked selection',
  // wave-3 integration: plan §4.2 gives the zoom keys to 3b
  [canonical('mod+=')]:
    'navigation.zoom-in: MAK-10, Lobby’s zoom steps and limits (below the engine’s 0.1, down to the whole-board fit)',
  [canonical('mod+-')]:
    'navigation.zoom-out: MAK-10, Lobby’s zoom steps and limits (below the engine’s 0.1, down to the whole-board fit)',
  // 3b at wave 3b: tldraw's zoom-in/out-on-cursor (Ctrl/Cmd+Shift+= and -), on Lobby's steps and limits
  [canonical('mod+shift++')]:
    'navigation.zoom-cursor-keys: tldraw’s zoom-in-on-cursor, on Lobby’s zoom steps and limits',
  [canonical('mod+shift+_')]:
    'navigation.zoom-cursor-keys: tldraw’s zoom-out-on-cursor, on Lobby’s zoom steps and limits',
}

/**
 * Browser chords a feature takes anyway, each with why (wave-3 integration). The key registry sees the
 * key before the allowlist, so the feature acts and the browser does not.
 */
const TAKES_BROWSER_CHORD: Readonly<Record<string, string>> = {
  [canonical('mod+shift+c')]:
    'present-export.copy-as-png: Copy as PNG keeps the tldraw page’s Ctrl/Cmd+Shift+C (F12 and Ctrl/Cmd+Shift+I still open devtools)',
}

/**
 * Keys that act only while one pointer tool is on (CR-3A-9: their claim says which, `KeyClaim.tool`, and the key
 * registry checks it), so they cannot collide at run time with a claim that acts under another tool. They are
 * checked for that instead of for conflicts: each belongs to a feature that comes before every other claimant of
 * its chord (so it wins while its tool is on). The comment tool's are the only ones today.
 */
const toolScoped = claims.filter((c) => c.tool !== undefined)
const contextual = (c: { by: string; tool?: string }) =>
  DEFERRING_KEYS.has(c.by) || c.tool !== undefined || WAVE_L_CONTEXTUAL_KEYS.has(c.by)

describe('the keyboard map of CANVAS_FEATURES', () => {
  it('every claimed chord parses', () => {
    for (const c of claims) expect(() => parseChord(c.chord), `${c.by}: ${c.chord}`).not.toThrow()
  })

  it('binds no chord twice in one scope (deferring keys aside)', () => {
    const firm = claims.filter((c) => !contextual(c))
    expect(keyConflicts(firm)).toEqual([])
  })

  it('takes no browser chord', () => {
    const taken = claims.filter(
      (c) => BROWSER.includes(canonical(c.chord)) && !TAKES_BROWSER_CHORD[canonical(c.chord)],
    )
    expect(taken.map((c) => `${c.by}: ${c.chord}`)).toEqual([])
  })

  it('takes an engine key only where the table says why', () => {
    const taken = claims.filter((c) => ENGINE_KEYS.includes(canonical(c.chord)) && !contextual(c))
    expect(
      taken.filter((c) => !TAKES_ENGINE_KEY[canonical(c.chord)]).map((c) => `${c.by}: ${c.chord}`),
    ).toEqual([])
  })

  it('a tool-scoped key wins while its tool is on: its feature comes before every other claimant of the chord', () => {
    const order = CANVAS_FEATURES.map((f) => f.id)
    // the comment tool's four keys (Enter, Escape, Tab, Mod+Shift+Arrow): the claims carry the tool now
    expect(new Set(toolScoped.map((c) => c.by))).toEqual(
      new Set(['comments.tool-enter', 'comments.tool-escape', 'comments.tool-tab', 'comments.tool-level']),
    )
    for (const own of toolScoped) {
      expect(own.tool, own.by).toBe('comment')
      const same = claims.filter(
        (c) =>
          c.by !== own.by &&
          c.tool !== own.tool &&
          // canvas-ux's deferring keys step aside for any other feature's key at run time
          !DEFERRING_KEYS.has(c.by) &&
          (c.scope === own.scope || c.scope === 'anywhere' || own.scope === 'anywhere') &&
          canonical(c.chord) === canonical(own.chord),
      )
      for (const c of same)
        expect(order.indexOf(own.featureId), `${own.by} before ${c.by} (${own.chord})`).toBeLessThan(
          order.indexOf(c.featureId),
        )
    }
  })
})

describe('the wave L key claims (L3-1; canvas/input/keymap.ts WAVE_L_KEY_CLAIMS, owner W3)', () => {
  const claimOf = new Map(WAVE_L_KEY_CLAIMS.flatMap((w) => w.chords.map((c) => [canonical(c), w] as const)))

  it('only the ids the table names take a wave L chord', () => {
    const taken = claims.filter((c) => claimOf.has(canonical(c.chord)))
    const wrong = taken.filter((c) => !claimOf.get(canonical(c.chord))?.takenBy.includes(c.by))
    expect(wrong.map((c) => `${c.by}: ${c.chord}`)).toEqual([])
    // the claims that shipped before wave L keep their chords: a11y's walk and frame keys, the comment tool's
    for (const id of [
      'a11y.next',
      'a11y.previous',
      'a11y.into-frame',
      'a11y.out-of-frame',
      'comments.tool-level',
    ])
      expect(
        taken.some((c) => c.by === id),
        id,
      ).toBe(true)
    // mod+k and mod+Arrow are nobody's but the wave L features' (none is registered before W3 and W4 land)
    for (const c of taken.filter((x) =>
      ['palette', 'flow-next'].includes(claimOf.get(canonical(x.chord))?.claim ?? ''),
    ))
      expect(['command-palette.open', 'flow.next'], `${c.by}: ${c.chord}`).toContain(c.by)
  })

  it('a taker of a letter claim (mod+k) declares it, so the registry reads the layout’s character as the allowlist does', () => {
    // canvas/api feature.ts chordsMatch: without `claim`, letters match by code (Dvorak's K character, code
    // KeyV, would miss the palette and the allowlist would block it)
    const letters = WAVE_L_KEY_CLAIMS.filter((w) => w.chords.some((c) => /^[a-z]$/.test(parseChord(c).key)))
    expect(letters.map((w) => w.claim)).toEqual(['palette'])
    for (const w of letters)
      for (const c of claims.filter((x) => w.chords.map(canonical).includes(canonical(x.chord))))
        expect(c.claim, `${c.by}: ${c.chord}`).toBe(w.claim)
  })

  it('a contextual wave L key is asked before the shipped claims of its chord (its feature comes first)', () => {
    const order = CANVAS_FEATURES.map((f) => f.id)
    for (const own of claims.filter((c) => WAVE_L_CONTEXTUAL_KEYS.has(c.by))) {
      const others = claims.filter(
        (c) => c.by !== own.by && c.tool === undefined && canonical(c.chord) === canonical(own.chord),
      )
      for (const c of others)
        expect(order.indexOf(own.featureId), `${own.by} before ${c.by} (${own.chord})`).toBeLessThan(
          order.indexOf(c.featureId),
        )
    }
  })
})

describe('the wave L keyboard map (L3-1, regenerated with the palette; W3 owns the claims)', () => {
  const claimOf = new Map(
    WAVE_L_KEY_CLAIMS.flatMap((w) => w.chords.map((c) => [canonical(c), w.claim] as const)),
  )
  const line = (c: (typeof claims)[number]) =>
    `${claimOf.get(canonical(c.chord))} ${c.scope} ${canonical(c.chord)} → ${c.by}${c.tool ? ` (tool ${c.tool})` : ''}${c.claim ? ` [claim ${c.claim}]` : ''}`

  it('the wave L chords and who takes them (W4’s flow.* keys join this list when features/flow lands)', () => {
    const taken = claims
      .filter((c) => claimOf.has(canonical(c.chord)) && !c.by.startsWith('flow.'))
      .map(line)
      .sort()
    expect(taken).toEqual(
      [
        // the palette: mod+k, read by the layout's character (claim), on the canvas scope only
        'palette canvas mod+k → command-palette.open [claim palette]',
        // shipped before wave L, unchanged: a11y's frame keys and the comment tool's level keys…
        'flow-repeat canvas mod+shift+arrowdown → a11y.into-frame',
        'flow-repeat canvas mod+shift+arrowdown → comments.tool-level (tool comment)',
        'flow-repeat canvas mod+shift+arrowup → a11y.out-of-frame',
        'flow-repeat canvas mod+shift+arrowup → comments.tool-level (tool comment)',
        // …and a11y's reading-order walk on Alt+Arrow
        'flow-walk canvas alt+arrowdown → a11y.next',
        'flow-walk canvas alt+arrowleft → a11y.previous',
        'flow-walk canvas alt+arrowright → a11y.next',
        'flow-walk canvas alt+arrowup → a11y.previous',
      ].sort(),
    )
  })

  it('the palette: every role, the canvas scope only (inside a granted text editor mod+k is the allowlist’s: blocked)', () => {
    const palette = CANVAS_FEATURES.flatMap((f) => f.commands ?? []).find(
      (c) => c.id === 'command-palette.open',
    )
    expect(palette).toMatchObject({
      kbd: ['mod+k'],
      claim: 'palette',
      scope: 'canvas',
      readOnlyAllowed: true,
    })
    expect(claims.filter((c) => canonical(c.chord) === 'mod+k' && c.scope !== 'canvas')).toEqual([])
    // and the shortcuts dialog lists it
    const registries = createFeatureRegistries()
    if (palette) registries.commands.register(palette)
    const ctx = { registries } as unknown as CanvasFeatureContext
    const rows = shortcutSections(ctx).flatMap((s) => s.rows)
    expect(rows.find((r) => r.label === 'Command palette')?.keys).toEqual(['mod+k'])
  })

  it('installed, the palette opens on the K character of any layout, never with AltGr, Shift or Alt', () => {
    const registries = createFeatureRegistries()
    const palette = CANVAS_FEATURES.find((f) => f.id === 'command-palette')
    expect(palette).toBeDefined()
    let opened = 0
    const ctx = {
      registries,
      canvas: { readOnly: () => true, container: () => null, tool: () => 'select' },
    } as unknown as CanvasFeatureContext
    // the command's own run opens the palette; count it instead
    const spec = palette?.commands?.find((c) => c.id === 'command-palette.open')
    const off = installCanvasFeatures(
      [{ id: 'command-palette', commands: spec ? [{ ...spec, run: () => void opened++ }] : [] }],
      ctx,
    )
    const key = registries.keys.list().find((k) => k.id === 'command:command-palette.open:canvas')
    expect(registries.keys.list().some((k) => k.id === 'command:command-palette.open:editor')).toBe(false)
    const ev = (
      key: string,
      code: string,
      m: Partial<KeyEventLike> & { getModifierState?: (k: string) => boolean } = {},
    ) => ({ key, code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...m }) as KeyEventLike
    expect(key?.match(ev('k', 'KeyK'))).toBe(true)
    expect(key?.match(ev('k', 'KeyV'))).toBe(true) // Dvorak's K character
    expect(key?.match(ev('л', 'KeyK'))).toBe(true) // Russian
    expect(key?.match(ev('t', 'KeyK'))).toBe(false) // Dvorak's physical K key
    expect(key?.match(ev('K', 'KeyK', { shiftKey: true }))).toBe(false)
    expect(key?.match(ev('k', 'KeyK', { altKey: true }))).toBe(false)
    expect(key?.match(ev('k', 'KeyK', { altKey: true, getModifierState: (m) => m === 'AltGraph' }))).toBe(
      false,
    )
    // a read-only role opens it too (it finds, selects and jumps)
    expect(key?.handle(ev('k', 'KeyK'), {} as never)).toBe(true)
    expect(opened).toBe(1)
    off()
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
        // A11Y2-02 (wave 3b): Ctrl/Cmd+X cuts on the canvas (the allowlist blocks the chord itself)
        'canvas mod+x → canvas-ux.cut',
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
