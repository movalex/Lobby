import { describe, expect, it } from 'vitest'
import { toolLock } from '../../features/canvas-ux/ported/tool-lock.ts'
import {
  activeLobbyTool,
  REFUSED_ENGINE_TOOLS,
  setEngineTool,
  setTool,
  type ToolApi,
  toolRequest,
} from './tools.ts'

function fakeApi(): ToolApi & { calls: unknown[] } {
  const state = { activeTool: { type: 'selection', customType: null as string | null, locked: false } }
  const calls: unknown[] = []
  return {
    calls,
    setActiveTool(tool) {
      calls.push(tool)
      state.activeTool =
        tool.type === 'custom'
          ? { type: 'custom', customType: tool.customType, locked: tool.locked }
          : { type: tool.type, customType: null, locked: tool.locked ?? false }
    },
    getAppState: () => state,
  }
}

describe('setTool (CanvasPort-style, §2.3.4)', () => {
  it('refuses Excalidraw text, stickynote and autoshape (P6-P8): nothing reaches the engine', () => {
    for (const t of [
      'text',
      'stickynote',
      'autoshape',
      'image',
      'embeddable',
      'magicframe',
      'bucketfill',
      'nope',
    ]) {
      const api = fakeApi()
      expect(setEngineTool(api, t), t).toBe(false)
      expect(api.calls).toEqual([])
    }
    expect([...REFUSED_ENGINE_TOOLS].slice(0, 3)).toEqual(['text', 'stickynote', 'autoshape'])
  })

  it("maps Lobby's note and text to CUSTOM tools with locked: true", () => {
    const api = fakeApi()
    expect(setTool(api, 'note')).toBe(true)
    expect(api.calls.at(-1)).toEqual({ type: 'custom', customType: 'lobby-note', locked: true })
    expect(activeLobbyTool(api)).toBe('note')
    expect(setTool(api, 'text')).toBe(true)
    expect(api.calls.at(-1)).toEqual({ type: 'custom', customType: 'lobby-text', locked: true })
    expect(activeLobbyTool(api)).toBe('text')
    expect(toolRequest('comment')).toEqual({ type: 'custom', customType: 'lobby-comment', locked: true })
  })

  it('passes the engine tools Lobby keeps', () => {
    const api = fakeApi()
    for (const t of [
      'select',
      'hand',
      'rectangle',
      'ellipse',
      'arrow',
      'line',
      'freedraw',
      'eraser',
      'laser',
      'frame',
    ]) {
      expect(setTool(api, t), t).toBe(true)
    }
    expect(api.calls.at(0)).toEqual({ type: 'selection' })
    expect(api.calls.at(2)).toEqual({ type: 'rectangle', locked: false })
    expect(activeLobbyTool(api)).toBe('frame')
    expect(setTool(api, 'stickynote')).toBe(false)
    expect(setTool(api, 'autoshape')).toBe(false)
  })

  it('K2-2: a drawing tool says locked every time, so a custom tool before it (locked: true) does not keep it armed', () => {
    const api = fakeApi()
    expect(setTool(api, 'note')).toBe(true)
    expect(api.getAppState().activeTool.locked).toBe(true)
    for (const t of ['rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'frame']) {
      expect(setTool(api, t), t).toBe(true)
      expect(api.calls.at(-1), t).toEqual({ type: t, locked: false })
    }
    // the tools whose stay is the engine's own rule (the pen stays, select and hand have nothing to place)
    for (const t of ['select', 'hand', 'freedraw', 'eraser', 'laser']) {
      setTool(api, t)
      expect(api.calls.at(-1), t).not.toHaveProperty('locked')
    }
  })

  it('K2-2: with the tool lock on (Q), the drawing tools stay picked; an explicit choice wins', () => {
    const api = fakeApi()
    toolLock.set(true)
    try {
      expect(setTool(api, 'rectangle')).toBe(true)
      expect(api.calls.at(-1)).toEqual({ type: 'rectangle', locked: true })
      expect(setEngineTool(api, 'arrow', { locked: false })).toBe(true)
      expect(api.calls.at(-1)).toEqual({ type: 'arrow', locked: false })
      // the custom tools are always locked at the engine (or the engine drops them after one click)
      expect(setTool(api, 'text')).toBe(true)
      expect(api.calls.at(-1)).toEqual({ type: 'custom', customType: 'lobby-text', locked: true })
    } finally {
      toolLock.set(false)
    }
    setTool(api, 'rectangle')
    expect(api.calls.at(-1)).toEqual({ type: 'rectangle', locked: false })
  })

  it('read-only roles: custom tools pass, "select" goes back through appState, other engine tools refuse', () => {
    const api = fakeApi()
    const scenes: unknown[] = []
    api.updateScene = (s) => scenes.push(s)
    expect(setTool(api, 'comment', { readOnly: true })).toBe(true)
    expect(setTool(api, 'select', { readOnly: true })).toBe(true)
    expect(scenes).toEqual([
      {
        appState: {
          activeTool: {
            type: 'selection',
            customType: null,
            locked: false,
            lastActiveTool: null,
            fromSelection: false,
          },
        },
      },
    ])
    expect(setTool(api, 'hand', { readOnly: true })).toBe(false)
    expect(setTool(api, 'rectangle', { readOnly: true })).toBe(false)
    // CR-3A-8: the laser writes nothing; read-only roles may point
    expect(setTool(api, 'laser', { readOnly: true })).toBe(true)
    expect(api.calls).toEqual([
      { type: 'custom', customType: 'lobby-comment', locked: true },
      { type: 'laser' },
    ])
  })
})
