import { describe, expect, it } from 'vitest'
import { decideEngineChange, type EngineView } from './openRule.ts'

// The editor-open rule (A16, corrected after the verifier's pending-lease probes). Every combination of
// Lobby's session and Excalidraw's editingTextElement has exactly one outcome.

type S = NonNullable<EngineView['session']>
const session = (o: Partial<S> = {}): S => ({
  phase: 'pending',
  hasEditor: false,
  editorAlive: false,
  ownsCurrent: false,
  leaseId: 'A',
  ...o,
})
const decide = (s: S | null, editing: string | null, editorPresent = editing !== null) =>
  decideEngineChange({ session: s, editing, editorPresent }).kind

describe('decideEngineChange: an editor Excalidraw has open', () => {
  it('Lobby idle: the P5 guard (read-only, its own lease request)', () => {
    expect(decide(null, 'B')).toBe('guard')
  })

  it("while Lobby's request for A is pending (no editor yet): an editor on B is closed, not left writable", () => {
    expect(decide(session({ phase: 'pending' }), 'B')).toBe('close-current')
  })

  it("while A's request is pending: an editor Excalidraw opens on A itself is not granted either", () => {
    expect(decide(session({ phase: 'pending' }), 'A')).toBe('close-current')
  })

  it("while A's guard editor waits for its answer: a second editor (on B) is closed", () => {
    expect(decide(session({ phase: 'pending', hasEditor: true, editorAlive: true }), 'B')).toBe(
      'close-current',
    )
  })

  it("while A is opening (granted, synthetic Enter sent): A's new textarea is adopted, B's is closed", () => {
    expect(decide(session({ phase: 'opening' }), 'A')).toBe('adopt')
    expect(decide(session({ phase: 'opening' }), 'B')).toBe('close-current')
    expect(decide(session({ phase: 'opening', hasEditor: true, editorAlive: true }), 'B')).toBe(
      'close-current',
    )
  })

  it("while A is open and alive: an editor on B is closed (A keeps its lease until A's text is written)", () => {
    expect(decide(session({ phase: 'open', hasEditor: true, editorAlive: true }), 'B')).toBe('close-current')
  })

  it("A's editor already closed by Excalidraw (written): end A, then guard B", () => {
    expect(decide(session({ phase: 'open', hasEditor: true, editorAlive: false }), 'B')).toBe(
      'end-then-guard',
    )
    expect(decide(session({ phase: 'pending', hasEditor: true, editorAlive: false }), 'B')).toBe(
      'end-then-guard',
    )
  })

  it("the session's own editor: nothing to do", () => {
    for (const phase of ['pending', 'opening', 'open'] as const) {
      expect(decide(session({ phase, hasEditor: true, editorAlive: true, ownsCurrent: true }), 'A')).toBe(
        'none',
      )
    }
  })
})

describe('decideEngineChange: Excalidraw between states', () => {
  it('editingTextElement set but no textarea (its submit removed it first): wait, never end or re-guard', () => {
    expect(decide(session({ phase: 'open', hasEditor: true, editorAlive: false }), 'A', false)).toBe('none')
    expect(decide(null, 'A', false)).toBe('none')
    expect(decide(session({ phase: 'pending' }), 'B', false)).toBe('none')
  })
})

describe('decideEngineChange: no editor in Excalidraw', () => {
  it('Lobby idle, or a Lobby request with no editor yet: nothing', () => {
    expect(decide(null, null)).toBe('none')
    expect(decide(session({ phase: 'pending' }), null)).toBe('none')
    expect(decide(session({ phase: 'opening' }), null)).toBe('none')
  })

  it("the session's editor closed: end (release after the write, or cancel)", () => {
    for (const phase of ['pending', 'opening', 'open'] as const) {
      expect(decide(session({ phase, hasEditor: true, editorAlive: false }), null)).toBe('end')
    }
  })

  it("the session's textarea outlived editingTextElement (orphaned): submit it first, then end", () => {
    expect(decide(session({ phase: 'open', hasEditor: true, editorAlive: true }), null)).toBe(
      'close-own-then-end',
    )
    expect(decide(session({ phase: 'pending', hasEditor: true, editorAlive: true }), null)).toBe(
      'close-own-then-end',
    )
    // Opening: Excalidraw has not reported the editor Lobby's Enter just opened; the open waits.
    expect(decide(session({ phase: 'opening', hasEditor: true, editorAlive: true }), null)).toBe('none')
  })
})

describe('decideEngineChange: exhaustive', () => {
  it('never leaves an unrequested editor in place: every editor that is not the session’s own is closed or guarded', () => {
    const phases = ['pending', 'opening', 'open'] as const
    const bools = [false, true]
    for (const editing of ['A', 'B'] as const) {
      for (const phase of phases) {
        for (const hasEditor of bools) {
          for (const editorAlive of hasEditor ? bools : [false]) {
            for (const ownsCurrent of editorAlive ? bools : [false]) {
              const k = decide(session({ phase, hasEditor, editorAlive, ownsCurrent }), editing)
              const own = editing === 'A' && ownsCurrent
              if (own) expect(k).toBe('none')
              else
                expect(
                  ['close-current', 'end-then-guard', 'adopt'],
                  `${editing} ${phase} ${hasEditor} ${editorAlive}`,
                ).toContain(k)
              // Adopt only for Lobby's own open of the same element, before it claimed a textarea.
              if (k === 'adopt') expect(editing === 'A' && phase === 'opening' && !hasEditor).toBe(true)
            }
          }
        }
      }
    }
  })
})
