// Wave L foundation review (K-5): a key that takes a wave L claim (CommandSpec.claim, FeatureKeySpec.claim) is
// matched the way the allowlist reads that claim (canvas/input/keymap.ts waveLKeyClaimOf): a letter by the
// layout's character. Without a claim the registry keeps matching letters by `code` (canvas/api/keys.ts), so
// the palette's mod+k would miss Dvorak's K character (code KeyV) and the allowlist would block it.
import { describe, expect, it } from 'vitest'
import type { KeyEventLike } from '../registries.ts'
import {
  type CanvasFeature,
  type CanvasFeatureContext,
  chordsMatch,
  installCanvasFeatures,
} from './feature.ts'
import { parseChord } from './keys.ts'
import { createFeatureRegistries } from './registries.ts'

type Ev = KeyEventLike & { isComposing?: boolean; getModifierState?: (k: string) => boolean }
const ev = (key: string, code: string, mods: Partial<Ev> = {}): Ev => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})
const ctrl = { ctrlKey: true }
const MODK = [parseChord('mod+k')]

describe('chordsMatch with a wave L claim', () => {
  it('palette: the K character on any layout, never the physical K key typing another letter', () => {
    const cases: [string, Ev, boolean, boolean][] = [
      // [what, event, with the claim, without it (the registry's code reading)]
      ['QWERTY Ctrl+K', ev('k', 'KeyK', ctrl), true, true],
      ['Dvorak Ctrl + the K character (code KeyV)', ev('k', 'KeyV', ctrl), true, false],
      ['Dvorak Ctrl + the physical K key (the T character)', ev('t', 'KeyK', ctrl), false, true],
      ['Russian Ctrl+К (code KeyK)', ev('л', 'KeyK', ctrl), true, true],
      ['Caps Lock Ctrl+K', ev('K', 'KeyK', ctrl), true, true],
      ['Ctrl+Shift+K', ev('K', 'KeyK', { ctrlKey: true, shiftKey: true }), false, false],
      ['Ctrl+Alt+K', ev('k', 'KeyK', { ctrlKey: true, altKey: true }), false, false],
      ['Cmd+K off a Mac', ev('k', 'KeyK', { metaKey: true }), false, false],
      ['plain K', ev('k', 'KeyK'), false, false],
    ]
    for (const [what, e, claimed, plain] of cases) {
      expect(chordsMatch(MODK, e, 'other', 'palette'), `${what}, claimed`).toBe(claimed)
      expect(chordsMatch(MODK, e, 'other'), `${what}, unclaimed`).toBe(plain)
    }
    // macOS: Cmd, not Ctrl
    expect(chordsMatch(MODK, ev('k', 'KeyV', { metaKey: true }), 'mac', 'palette')).toBe(true)
    expect(chordsMatch(MODK, ev('k', 'KeyK', ctrl), 'mac', 'palette')).toBe(false)
  })

  it('palette: never while composing or with AltGr (read from the DOM event)', () => {
    expect(chordsMatch(MODK, ev('k', 'KeyK', { ctrlKey: true, isComposing: true }), 'other', 'palette')).toBe(
      false,
    )
    const altGr = ev('k', 'KeyK', { ctrlKey: true, getModifierState: (k) => k === 'AltGraph' })
    expect(chordsMatch(MODK, altGr, 'other', 'palette')).toBe(false)
  })

  it('arrow claims: only the listed chords, and only the claim’s own modifiers', () => {
    const right = [parseChord('mod+arrowright')]
    expect(chordsMatch(right, ev('ArrowRight', 'ArrowRight', ctrl), 'other', 'flow-next')).toBe(true)
    expect(chordsMatch(right, ev('ArrowLeft', 'ArrowLeft', ctrl), 'other', 'flow-next')).toBe(false)
    const shifted = ev('ArrowRight', 'ArrowRight', { ctrlKey: true, shiftKey: true })
    expect(chordsMatch(right, shifted, 'other', 'flow-next')).toBe(false)
    expect(chordsMatch([parseChord('mod+shift+arrowright')], shifted, 'other', 'flow-repeat')).toBe(true)
    // a chord another claim reads is not this claim's
    expect(chordsMatch([parseChord('mod+shift+arrowright')], shifted, 'other', 'flow-next')).toBe(false)
  })

  it('the registry adapters use the claim: a CommandSpec kbd and a FeatureKeySpec', () => {
    const registries = createFeatureRegistries()
    const ctx = {
      registries,
      canvas: { readOnly: () => false, tool: () => 'select' },
    } as unknown as CanvasFeatureContext
    let opened = 0
    const f: CanvasFeature = {
      id: 'test-palette',
      commands: [
        {
          id: 'command-palette.open',
          label: 'Command palette',
          kbd: ['mod+k'],
          claim: 'palette',
          readOnlyAllowed: true,
          run: () => void opened++,
        },
      ],
      keys: [
        {
          id: 'test.flow-next',
          scope: 'canvas',
          chords: ['mod+arrowright'],
          claim: 'flow-next',
          handle: () => true,
        },
      ],
    }
    const off = installCanvasFeatures([f], ctx)
    const keys = registries.keys.list()
    const palette = keys.find((k) => k.id === 'command:command-palette.open:canvas')
    const flow = keys.find((k) => k.id === 'key:test.flow-next')
    expect(palette?.match(ev('k', 'KeyV', ctrl))).toBe(true)
    expect(palette?.match(ev('t', 'KeyK', ctrl))).toBe(false)
    expect(flow?.match(ev('ArrowRight', 'ArrowRight', ctrl))).toBe(true)
    expect(flow?.match(ev('ArrowRight', 'ArrowRight', { altKey: true }))).toBe(false)
    palette?.handle(ev('k', 'KeyV', ctrl), {} as never)
    expect(opened).toBe(1)
    off()
  })
})
