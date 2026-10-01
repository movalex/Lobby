import { describe, expect, it } from 'vitest'
import { installKeyupGate, keyIdOf, keyupVerdict, registerKeyupClient } from './keyupGate.ts'

// Spike B, the keys verifier's K1 (docs/research/excalidraw/spike-b/OPEN-FROM-SPIKE-A.md): keys typed
// outside the board reached Excalidraw's DOCUMENT keyup listener (index.js:49348) and re-bound selected
// arrows (a version bump per keyup). The gate is a document listener registered before Excalidraw's.
// The browser half (a real <input> outside the board, CDP key events) is e2e/spike-b/tests/b3-l13-keys-k.spec.ts.

const keyup = (key: string, code: string) => Object.assign(new Event('keyup'), { key, code })

describe('keyupVerdict (pure)', () => {
  it('passes only keyups whose keydown was delegated, once', () => {
    const delegated = new Set(['ArrowLeft'])
    expect(keyupVerdict({ key: 'ArrowLeft', code: 'ArrowLeft' }, delegated)).toBe('pass')
    expect(keyupVerdict({ key: 'ArrowLeft', code: 'ArrowLeft' }, delegated)).toBe('stop')
    expect(keyupVerdict({ key: 'ArrowRight', code: 'ArrowRight' }, delegated)).toBe('stop')
  })

  it('keys an event with an empty code by its key (a blocked Unidentified keydown is stopped too)', () => {
    expect(keyIdOf({ key: 'Unidentified', code: '' })).toBe('key:unidentified')
    expect(keyupVerdict({ key: 'Unidentified', code: '' }, new Set())).toBe('stop')
    expect(keyupVerdict({ key: 'Unidentified', code: '' }, new Set(['key:unidentified']))).toBe('pass')
  })

  it('lets everything through for the allowlist-off control runs and for Lobby-dispatched events', () => {
    expect(keyupVerdict({ key: ' ', code: 'Space' }, new Set(), { allowlistOff: true })).toBe('pass')
    expect(keyupVerdict({ key: 'Enter', code: 'Enter' }, new Set(), { synthetic: true })).toBe('pass')
  })
})

describe('the document gate', () => {
  it("a later document listener (Excalidraw's onKeyUp) never sees a keyup the board did not delegate", () => {
    const doc = new EventTarget()
    installKeyupGate(doc)
    const delegated = new Set<string>()
    const off = registerKeyupClient(doc, { allowsKeyup: (e) => keyupVerdict(e, delegated) === 'pass' })
    const seen: string[] = []
    doc.addEventListener('keyup', (e) => seen.push((e as unknown as { code: string }).code)) // Excalidraw's, later
    // an arrow keyup from an input outside the board: stopped
    doc.dispatchEvent(keyup('ArrowLeft', 'ArrowLeft'))
    doc.dispatchEvent(keyup(' ', 'Space'))
    expect(seen).toEqual([])
    // a keyup whose keydown the board delegated (a nudge): passes, once
    delegated.add('ArrowRight')
    doc.dispatchEvent(keyup('ArrowRight', 'ArrowRight'))
    doc.dispatchEvent(keyup('ArrowRight', 'ArrowRight'))
    expect(seen).toEqual(['ArrowRight'])
    // no board attached: the gate is inert
    off()
    doc.dispatchEvent(keyup('ArrowLeft', 'ArrowLeft'))
    expect(seen).toEqual(['ArrowRight', 'ArrowLeft'])
  })

  it('is installed once per document', () => {
    const doc = new EventTarget()
    let adds = 0
    const add = doc.addEventListener.bind(doc)
    doc.addEventListener = ((...a: Parameters<EventTarget['addEventListener']>) => {
      adds++
      add(...a)
    }) as EventTarget['addEventListener']
    installKeyupGate(doc)
    installKeyupGate(doc)
    registerKeyupClient(doc, { allowsKeyup: () => true })
    expect(adds).toBe(1)
  })
})
