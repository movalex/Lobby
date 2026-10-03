// OWNER: 3a. The highlighter and the read-only Hand around the port's setTool / tool (./tools.ts, CR-3A-6), and
// the port seams they use (CR-3A-9: the port's mode names, its gesture-element hook).
import { describe, expect, it } from 'vitest'
import { attachBoardEngine } from '../../overrides.ts'
import type { CanvasPort } from '../../port.ts'
import type { LobbyCanvas, StyleValues } from '../lobby-canvas.ts'
import { createFeatureRegistries } from '../registries.ts'
import { createToolsPart, HIGHLIGHT_OPACITY, HIGHLIGHT_WIDTH, highlightOf } from './tools.ts'

function setup(opts: { readOnly?: boolean; next?: StyleValues } = {}) {
  let engineTool = 'select'
  const calls: string[] = []
  // CR-3A-9: the board page's port is told the mode, and names it itself
  const modes: ({ name: string; over: string } | null)[] = []
  const hooks: ((el: Record<string, unknown>) => Record<string, unknown> | null)[] = []
  const port = {
    setToolMode: (m: { name: string; over: string } | null) => modes.push(m),
    onGestureElement: (h: (el: Record<string, unknown>) => Record<string, unknown> | null) => {
      hooks.push(h)
      return () => {}
    },
    setTool(t: string) {
      calls.push(t)
      // the port refuses the names the engine has no tool for
      if (t === 'highlight') return false
      if (t === 'hand' && opts.readOnly) return false
      engineTool = t
      return true
    },
    tool: () => engineTool,
  } as unknown as CanvasPort
  let next: StyleValues = { strokeColor: '#1e1e1e', opacity: 100, ...opts.next }
  const cursors: (string | null)[] = []
  const self = {
    readOnly: () => opts.readOnly ?? false,
    setCursor: (c: string | null) => cursors.push(c),
    styles: {
      next: () => next,
      setNext: (p: StyleValues) => {
        next = { ...next, ...p }
      },
    },
  } as unknown as LobbyCanvas
  const registries = createFeatureRegistries()
  const part = createToolsPart({ port, registries, self: () => self })
  return { part, calls, next: () => next, cursors, modes, hooks, registries }
}

describe('the highlighter (CR-3A-6)', () => {
  it("is the engine's pen with the highlight shade at opacity 50, and gives the next style back after", () => {
    const { part, calls, next } = setup({ next: { strokeColor: '#e03131', opacity: 80 } })
    expect(part.setTool('highlight')).toBe(true)
    expect(calls).toEqual(['freedraw'])
    expect(part.tool()).toBe('highlight')
    expect(next()).toMatchObject({ strokeColor: '#ff636e', opacity: HIGHLIGHT_OPACITY })
    // the pen is the pen again, with its own colour
    expect(part.setTool('freedraw')).toBe(true)
    expect(part.tool()).toBe('freedraw')
    expect(next()).toMatchObject({ strokeColor: '#e03131', opacity: 80 })
  })

  it('another tool ends it too; read-only roles cannot have it', () => {
    const a = setup()
    a.part.setTool('highlight')
    a.part.setTool('rectangle')
    expect(a.part.tool()).toBe('rectangle')
    expect(a.next().strokeColor).toBe('#1e1e1e')
    const v = setup({ readOnly: true })
    expect(v.part.setTool('highlight')).toBe(false)
    expect(v.calls).toEqual([])
  })

  it("maps every tldraw stroke colour (and Excalidraw's own black) to tldraw's highlight shade", () => {
    expect(highlightOf('#1d1d1d')).toBe('#fddd00')
    expect(highlightOf('#1E1E1E')).toBe('#fddd00')
    expect(highlightOf('#4465e9')).toBe('#10acff')
    expect(highlightOf('#5f6b7a')).toBe('#cbe7f1')
    // a highlight shade stays itself; an unknown colour highlights in yellow
    expect(highlightOf('#ff636e')).toBe('#ff636e')
    expect(highlightOf('#123456')).toBe('#fddd00')
    expect(highlightOf(undefined)).toBe('#fddd00')
  })
})

describe('the port seams (CR-3A-9)', () => {
  it('the port is told each mode (so it names them) and when it ends', () => {
    const a = setup()
    a.part.setTool('highlight')
    a.part.setTool('rectangle')
    expect(a.modes).toEqual([{ name: 'highlight', over: 'freedraw' }, null])
    const v = setup({ readOnly: true })
    v.part.setTool('hand')
    v.part.setTool('select')
    expect(v.modes).toEqual([{ name: 'hand', over: 'select' }, null])
  })

  it('a stroke the highlighter starts is stamped through the gesture-element hook, nothing else is', () => {
    const t = setup()
    let changes: ((els: unknown[], s: Record<string, unknown>) => void) | null = null
    const api = {
      onChange: (cb: typeof changes) => {
        changes = cb
        return () => {}
      },
    }
    attachBoardEngine(t.registries, { api: api as never, wrapper: {} as HTMLElement, boardId: null })
    expect(t.hooks).toHaveLength(1)
    expect(changes).not.toBeNull()
    const hook = t.hooks[0] as (el: Record<string, unknown>) => Record<string, unknown> | null
    const pen = { id: 'p', type: 'freedraw', customData: { lobby: { by: 'me' } } }
    expect(hook(pen)).toBeNull()
    t.part.setTool('highlight')
    expect(hook(pen)).toEqual({
      strokeWidth: HIGHLIGHT_WIDTH,
      opacity: HIGHLIGHT_OPACITY,
      customData: { lobby: { by: 'me', kind: 'highlight' } },
    })
    expect(hook({ id: 'r', type: 'rectangle' })).toBeNull()
  })
})

describe('the read-only Hand (CR-3A-6)', () => {
  it('is the neutral state reported as hand, with the grab cursor, for read-only roles', () => {
    const { part, calls, cursors } = setup({ readOnly: true })
    expect(part.setTool('hand')).toBe(true)
    expect(calls).toEqual(['select'])
    expect(part.tool()).toBe('hand')
    expect(cursors).toEqual(['grab'])
    expect(part.setTool('select')).toBe(true)
    expect(part.tool()).toBe('select')
    expect(cursors).toEqual(['grab', null])
  })

  it("editors get the engine's own Hand", () => {
    const { part, calls } = setup()
    expect(part.setTool('hand')).toBe(true)
    expect(calls).toEqual(['hand'])
    expect(part.tool()).toBe('hand')
  })
})
