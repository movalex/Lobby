// OWNER: W4 (wave L, L4-1). The flow keys, as FeatureKeySpecs with the wave L claims (canvas/input/keymap.ts
// WAVE_L_KEY_CLAIMS: W3 owns the table, W4 the takers):
//
//   flow.next     Ctrl/Cmd+Arrow        claim 'flow-next': the next connected shape that way (editors)
//   flow.repeat   Ctrl/Cmd+Shift+Arrow  claim 'flow-repeat': the same, of the last created kind (editors). It is
//                                       contextual (WAVE_L_CONTEXTUAL_KEYS): it takes the key only while a flow is
//                                       being built from the one selected shape (a shape this tab's flow made or
//                                       built from), and declines otherwise, so a11y's Ctrl/Cmd+Shift+Down / Up
//                                       (into and out of a frame) and the comment tool's level keys keep working.
//
// A key that declines (no source: nothing or several things selected, a frame, a locked shape, a mind-map topic,
// a read-only role, an editor open) falls through to the allowlist, which blocks every wave L chord: the engine's
// own flowchart action never runs. The claim keeps AltGr and IME presses out (canvas/api feature.ts chordsMatch).
// Alt+Arrow is not registered here: a11y's walk takes it (./runtime.ts tells it which arrow).
import type { CanvasFeatureContext, FeatureKeySpec, KeyEventLike } from '../../canvas/api/index.ts'
import { dirOfKey, flowRuntimeOf } from './runtime.ts'

const ARROWS = ['arrowright', 'arrowleft', 'arrowdown', 'arrowup'] as const
export const FLOW_NEXT_CHORDS = ARROWS.map((a) => `mod+${a}`)
export const FLOW_REPEAT_CHORDS = ARROWS.map((a) => `mod+shift+${a}`)

const rtOf = (ctx: CanvasFeatureContext) => flowRuntimeOf(ctx.canvas)

export const FLOW_KEYS: readonly FeatureKeySpec[] = [
  {
    id: 'flow.next',
    scope: 'canvas',
    chords: FLOW_NEXT_CHORDS,
    claim: 'flow-next',
    match: (e: KeyEventLike, ctx) => dirOfKey(e.key) !== null && (rtOf(ctx)?.source() ?? null) !== null,
    handle(e, ctx) {
      const rt = rtOf(ctx)
      const dir = dirOfKey(e.key)
      const source = rt?.source() ?? null
      if (!rt || !dir || !source) return false
      rt.next(source, dir)
      return true
    },
  },
  {
    id: 'flow.repeat',
    scope: 'canvas',
    chords: FLOW_REPEAT_CHORDS,
    claim: 'flow-repeat',
    match: (e: KeyEventLike, ctx) => dirOfKey(e.key) !== null && (rtOf(ctx)?.repeatSource() ?? null) !== null,
    handle(e, ctx) {
      const rt = rtOf(ctx)
      const dir = dirOfKey(e.key)
      const source = rt?.repeatSource() ?? null
      if (!rt || !dir || !source || !rt.lastKind) return false
      rt.next(source, dir, { kind: rt.lastKind })
      return true
    },
  },
]
