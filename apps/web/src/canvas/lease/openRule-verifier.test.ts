import { describe, expect, it } from 'vitest'
import { bufferText, denyNewClose, refreshOnGrant } from './openRule.ts'

// Spike B: the lease verifier's L1-L4 (docs/research/excalidraw/spike-b/OPEN-FROM-SPIKE-A.md), the pure
// parts. The browser regressions (host-lab, the verifier's repros) are e2e/spike-b/tests/b3-l12-lease-l.spec.ts.

describe('L2: refreshOnGrant', () => {
  it("replaces the editor's stale copy with the label's stored text before it becomes writable", () => {
    // P5: the caret where the click put it (inside 'memo'), the label now 'memo by alice'
    expect(refreshOnGrant({ value: 'memo', selectionStart: 2, selectionEnd: 2 }, 'memo by alice')).toEqual({
      value: 'memo by alice',
      selectionStart: 2,
      selectionEnd: 2,
    })
  })
  it('keeps a select-all a select-all (a double-click selects the whole label)', () => {
    expect(refreshOnGrant({ value: 'memo', selectionStart: 0, selectionEnd: 4 }, 'memo by alice')).toEqual({
      value: 'memo by alice',
      selectionStart: 0,
      selectionEnd: 13,
    })
  })
  it('clamps a caret past the end of a shorter text', () => {
    expect(refreshOnGrant({ value: 'a long memo', selectionStart: 9, selectionEnd: 9 }, 'memo')).toEqual({
      value: 'memo',
      selectionStart: 4,
      selectionEnd: 4,
    })
  })
  it('changes nothing when the editor is current or the label is gone', () => {
    expect(refreshOnGrant({ value: 'memo', selectionStart: 4, selectionEnd: 4 }, 'memo')).toBeNull()
    expect(refreshOnGrant({ value: 'memo', selectionStart: 4, selectionEnd: 4 }, undefined)).toBeNull()
  })
})

describe('L3: denyNewClose', () => {
  it("never submits over someone else's text in the label (it used to empty and delete it)", () => {
    expect(denyNewClose({ labelText: 'alice was here', editorValue: 'XY', labelConfirmed: false })).toBe(
      'close-without-submit',
    )
  })
  it("puts back what it opened with when only this session's typing is in the label", () => {
    expect(denyNewClose({ labelText: 'XY', editorValue: 'XY', labelConfirmed: false })).toBe(
      'restore-and-submit',
    )
    expect(denyNewClose({ labelText: undefined, editorValue: 'XY', labelConfirmed: false })).toBe(
      'restore-and-submit',
    )
  })
  it('never submits a label the server holds (the engine resets it from confirmed)', () => {
    expect(denyNewClose({ labelText: 'XY', editorValue: 'XY', labelConfirmed: true })).toBe(
      'close-without-submit',
    )
  })
})

describe('L4: bufferText', () => {
  it('turns buffered keys into the text they would have typed (for Copy my text)', () => {
    expect(
      bufferText([{ key: 'Q' }, { key: 'S' }, { key: 'Enter' }, { key: 'x' }, { key: 'Backspace' }]),
    ).toBe('QS\nx')
    expect(bufferText([])).toBe('')
  })
})
