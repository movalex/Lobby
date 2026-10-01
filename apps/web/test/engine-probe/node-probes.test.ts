/**
 * The Node-checkable probes of the engine probe suite (plan §6.5), against the pinned packages.
 * Browser-only probes are listed in `docs/research/excalidraw/spike-a/A16-static.md` and belong to the
 * host and render owners.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  CaptureUpdateAction,
  duplicateElement,
  getStickyNoteFooter,
  newArrowElement,
  newElement,
  newElementWith,
  newFreeDrawElement,
  newLinearElement,
  newStickyNoteElement,
  newTextElement,
} from '@excalidraw/element'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildStickyNote } from '../../../../packages/canvas-schema/src/engine/layout.ts'
import { installServerTextMetrics } from '../../../../packages/canvas-schema/src/engine/text-metrics.ts'
import { count, readDist } from './bundle.ts'

const webDir = fileURLToPath(new URL('../../', import.meta.url))

/** run a snippet in a fresh plain `node` (the sync runtime: `default` = prod builds) from apps/web */
const node = (code: string) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: webDir,
    encoding: 'utf8',
  }).trim()

const base = {
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  link: null,
  locked: false,
} as const

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

beforeAll(() => {
  installServerTextMetrics()
})

describe('6.5 probes in Node', () => {
  it('getStickyNoteLayout and newTextElement need a metrics provider in Node, and run with the server one', () => {
    // without a provider, element falls back to the canvas provider and throws (no document)
    const bare = node(
      "import * as el from '@excalidraw/element';" +
        "try { el.newTextElement({ x: 0, y: 0, text: 'x' }); console.log('ok') } catch (e) { console.log(e.name + ': ' + e.message) }",
    )
    expect(bare).toBe('ReferenceError: document is not defined')
    const { note, label } = buildStickyNote({ id: 'n', x: 0, y: 0, text: 'Server made note' })
    expect(label?.containerId).toBe(note.id)
    expect(label?.fontSize).toBe(20)
  })

  it('duplicateElement sets created = updated on every copy, even from created: null (onDuplicate must reset it)', () => {
    const src = newStickyNoteElement({ ...base, type: 'stickynote', created: null } as never)
    expect(src.created).toBeNull()
    const copy = duplicateElement(null, new Map(), src)
    expect(copy.created).not.toBeNull()
    expect(copy.created).toBe(copy.updated)
  })

  it('the sticky-note footer depends on created (null → no footer)', () => {
    const at = Date.UTC(2026, 8, 7, 12)
    expect(getStickyNoteFooter({ created: null, width: 200, height: 200 } as never)).toBeNull()
    expect(getStickyNoteFooter({ created: at, width: 200, height: 200 } as never, at)?.text).toBe('7 Sep')
    expect(
      getStickyNoteFooter({ created: at, width: 200, height: 200 } as never, Date.UTC(2027, 5, 1))?.text,
    ).toBe('7 Sep 2026')
    expect(getStickyNoteFooter({ created: at, width: 74, height: 200 } as never, at)).toBeNull() // under STICKY_NOTE_MIN_SIZE
  })

  it('created is excluded from ElementUpdate by type only: newElementWith writes it at runtime', () => {
    const el = newStickyNoteElement({ ...base, type: 'stickynote', created: null } as never)
    const next = newElementWith(el, { created: 123, x: 5 } as never)
    expect(next.x).toBe(5)
    expect(next.created).toBe(123) // mutateElement.d.ts:3 excludes it from the type, not at runtime
  })

  it('CaptureUpdateAction has the three modes the adapter relies on', () => {
    expect(CaptureUpdateAction).toMatchObject({
      IMMEDIATELY: 'IMMEDIATELY',
      NEVER: 'NEVER',
      EVENTUALLY: 'EVENTUALLY',
    })
  })
})

describe('6.5: element sizes within the limits’ assumptions (plan §3.5)', () => {
  const round2 = (n: number) => Math.round(n * 100) / 100
  const stroke = (n: number, round: boolean) => {
    const pts: [number, number][] = []
    let x = 0
    let y = 0
    for (let i = 0; i < n; i++) {
      x += Math.cos(i / 17) * 3.7131 + ((i * 7919) % 37) / 100
      y += Math.sin(i / 11) * 2.9173 + ((i * 104729) % 41) / 100
      pts.push(round ? [round2(x), round2(y)] : [x, y])
    }
    return pts
  }
  const sizes: Record<string, number> = {}

  it('rectangle ≈ 470 B, 22-character label ≈ 730 B, note + label ≈ 1.2 KB', () => {
    const r = {
      ...newElement({ ...base, type: 'rectangle', x: 1234.5678, y: -987.6543 } as never),
      index: 'a1',
    }
    const { note, label } = buildStickyNote({
      id: 'noteid_012345678901',
      x: 1234.5,
      y: -987.6,
      text: 'Short sticky note text',
    })
    sizes.rectangle = bytes(r)
    sizes.label22 = bytes({ ...label, index: 'a2' })
    sizes.notePlusLabel = bytes({ ...note, index: 'a3' }) + sizes.label22
    expect(sizes.rectangle).toBeGreaterThan(350)
    expect(sizes.rectangle).toBeLessThan(600)
    expect(sizes.label22).toBeLessThan(900)
    expect(sizes.notePlusLabel).toBeLessThan(1600)
  })

  it('freedraw: 2,500 pen points rounded to 2 decimals fit 64 KiB; unrounded they do not', () => {
    const mk = (round: boolean) => {
      const points = stroke(2500, round)
      const pressures = points.map((_, i) =>
        round ? round2(((i * 31) % 100) / 100 + 0.004) : ((i * 31) % 100) / 100 + 0.00417,
      )
      return {
        ...newFreeDrawElement({
          ...base,
          type: 'freedraw',
          points,
          pressures,
          simulatePressure: false,
        } as never),
        index: 'a1',
      }
    }
    sizes.freedraw2500Rounded = bytes(mk(true))
    sizes.freedraw2500Raw = bytes(mk(false))
    expect(sizes.freedraw2500Rounded).toBeLessThanOrEqual(64 * 1024)
    expect(sizes.freedraw2500Raw).toBeGreaterThan(64 * 1024)
  })

  it('line and arrow: 1,000 rounded points fit the 32 KiB "every other type" limit; unrounded they do not', () => {
    const mk = (type: 'line' | 'arrow', round: boolean) => {
      const points = stroke(1000, round)
      const el =
        type === 'arrow'
          ? newArrowElement({ ...base, type: 'arrow', points } as never)
          : newLinearElement({ ...base, type: 'line', points } as never)
      return { ...el, index: 'a1' }
    }
    sizes.arrow1000Rounded = bytes(mk('arrow', true))
    sizes.line1000Rounded = bytes(mk('line', true))
    sizes.line1000Raw = bytes(mk('line', false))
    expect(sizes.arrow1000Rounded).toBeLessThanOrEqual(32 * 1024)
    expect(sizes.line1000Rounded).toBeLessThanOrEqual(32 * 1024)
    expect(sizes.line1000Raw).toBeGreaterThan(32 * 1024)
  })

  it('text: 20,000 three-byte characters, wrapped, fit 144 KiB', () => {
    const t = '会'.repeat(20_000)
    const { label } = buildStickyNote({ id: 'big', x: 0, y: 0, text: t, width: 300 })
    sizes.text20k3byte = bytes({ ...label, index: 'a1' })
    expect(sizes.text20k3byte).toBeLessThanOrEqual(144 * 1024)
    const free = newTextElement({ ...base, text: 'x'.repeat(20_000) } as never)
    expect(bytes(free)).toBeLessThanOrEqual(144 * 1024)
  })

  it('200 plusOne keys with 40-character uids fit their own 12 KiB budget', () => {
    const lobby: Record<string, true> = {}
    for (let i = 0; i < 200; i++) lobby[`plusOne:usr_${'x'.repeat(37)}${String(i).padStart(3, '0')}`] = true
    sizes.plusOnes200 = bytes(lobby)
    expect(sizes.plusOnes200).toBeLessThanOrEqual(12 * 1024)
    console.info('A16-static element sizes (bytes):', JSON.stringify(sizes))
  })

  it('coordinates: the constructor logs an error above ±1e6 (the plan allows ±1e7 on the wire)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    newElement({ ...base, type: 'rectangle', x: 1e6 } as never)
    expect(spy).not.toHaveBeenCalled()
    newElement({ ...base, type: 'rectangle', x: 2e6 } as never)
    expect(spy).toHaveBeenCalledWith('New element size or position is too large', expect.anything())
    spy.mockRestore()
  })
})

describe('6.5: static pins in the pinned bundles', () => {
  const dev = readDist('excalidraw', 'dev')
  const prod = readDist('excalidraw', 'prod')

  it('E7: updateScene runs no sticky-note re-layout; relayoutStickyNotes has one caller (paste styles)', () => {
    expect(count(dev, /relayoutStickyNotes\(/)).toBe(1)
    expect(dev.split('\n')[11818]).toContain('relayoutStickyNotes(')
    expect(count(prod, /relayoutStickyNotes/)).toBe(1) // renamed import in prod: only the call remains named? see doc
  })

  it('§2.5.4: the open text editor follows scene updates (textWysiwyg subscribes to scene.onUpdate)', () => {
    expect(dev.split('\n')[25599]).toContain('app.scene.onUpdate(')
  })

  it('§2.7: savePointer returns before onPointerUpdate when interaction is off and the tool is unsupported', () => {
    const lines = dev.split('\n')
    expect(lines[47779]).toContain('__publicField(this, "savePointer"')
    expect(lines[47783]).toContain(
      'if (!this.isInteractionEnabled() && !this.isToolSupported(this.state.activeTool.type))',
    )
    expect(lines[47800]).toContain('this.props.onPointerUpdate?.(')
  })

  it('E2/E3: Scene.replaceAllElements validates indices only in dev/test MODE, which the published builds never set', () => {
    const common = { dev: readDist('common', 'dev'), prod: readDist('common', 'prod') }
    expect(common.dev).toContain('define_import_meta_env_default = { DEV: true }')
    expect(count(common.prod, /MODE/)).toBeGreaterThan(0)
    expect(common.prod).toMatch(/\{PROD:!0\}/)
    const el = readDist('element', 'dev').split('\n')
    expect(el[18948]).toContain('isDevEnv5() || isTestEnv6() || window?.DEBUG_FRACTIONAL_INDICES')
  })

  // a label (L, a1) sorted before its container (C, a2): invalid for Excalidraw's bound-text rule
  const labelFirst = (windowSetup: string) =>
    node(
      `${windowSetup}` +
        "import('@excalidraw/element').then((el) => {" +
        'el.setCustomTextMetricsProvider({ getLineWidth: (t) => t.length * 10 });' +
        "const c = { ...el.newElement({ type: 'rectangle', x: 0, y: 0, id: 'C' }), index: 'a2', boundElements: [{ id: 'L', type: 'text' }] };" +
        "const l = { ...el.newTextElement({ x: 0, y: 0, text: 'x', containerId: 'C', id: 'L' }), index: 'a1' };" +
        'const errors = []; console.error = (...a) => errors.push(String(a[0]).slice(0, 70));' +
        "try { const s = new el.Scene(); s.replaceAllElements([l, c]); console.log('ok ' + s.getElementsIncludingDeleted().map((e) => e.id + ':' + e.index).join(',') + ' errors=' + errors.length + (errors[0] ? ' ' + errors[0] : '')) }" +
        "catch (e) { console.log(e.name + ': ' + e.message) }" +
        // the index-validation throttle (lodash, 60 s) holds a timer that keeps Node alive for a minute
        ' process.exit(0) })',
    )

  it('Scene.replaceAllElements in plain Node without a window global: ReferenceError (the server must never use Scene)', () => {
    expect(labelFirst('')).toBe('ReferenceError: window is not defined')
  })

  it('E3: with a window (as in a browser), a label before its container is neither fixed nor thrown', () => {
    expect(labelFirst('globalThis.window = {};')).toBe('ok L:a1,C:a2 errors=0')
  })

  it('E3: only window.DEBUG_FRACTIONAL_INDICES makes it validate, and then it logs instead of throwing', () => {
    expect(labelFirst('globalThis.window = { DEBUG_FRACTIONAL_INDICES: true };')).toBe(
      'ok L:a1,C:a2 errors=1 Fractional indices invariant for bound elements has been compromised:',
    )
  })
})
