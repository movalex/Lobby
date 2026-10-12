// Wave N.1 review: on a large board the features install a frame and a task after the welcome
// (./features-install.ts). Their input listeners (canvas-ux's double-click note and Lobby's context menu, the mind
// map's keys and copies, every feature key) are not there in that window, so the engine acted on the input instead
// (its own text box, its own menu). Now the canvas takes no input until they are: a press, a double-click, a
// right-click, a wheel or a key in the window does nothing; hovering, a press's end, Lobby's own synthetic keys and
// Tab go through. Stubbed frame and task timers; the input stream as the board's input layer dispatches it.
// Wave O: a hidden tab runs no animation frame, so a big board opened in a background tab never installed them until
// the tab was shown; a fallback timer (FRAME_FALLBACK_MS, as the chunked apply's) installs on whichever comes first.
import { describe, expect, it } from 'vitest'
import type { CanvasInputEvent, LobbyCanvas } from '../api/lobby-canvas.ts'
import { FRAME_FALLBACK_MS, type InstallTimers, installFeaturesAfterWelcome } from './features-install.ts'

type Listener = (e: CanvasInputEvent) => void

/** A canvas of `n` elements whose input stream works as the board's (./input.ts: every listener, then the engine). */
function board(n: number) {
  const listeners = new Set<Listener>()
  const engine: string[] = []
  const canvas = {
    items: () => Array.from({ length: n }, (_, i) => ({ id: `e${i}` })),
    on: (event: string, l: Listener) => {
      if (event !== 'input') throw new Error(`unexpected ${event}`)
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
  /** Dispatches an input event; the engine acts on it unless a listener took it. */
  const input = (e: Record<string, unknown>) => {
    let handled = false
    const ev = {
      button: 0,
      synthetic: false,
      ...e,
      handled: () => {
        handled = true
      },
    } as unknown as CanvasInputEvent
    for (const l of [...listeners]) l(ev)
    if (!handled) engine.push(String(e.type === 'key-down' ? `key:${String(e.key)}` : e.type))
    return handled
  }
  return { canvas: canvas as unknown as Pick<LobbyCanvas, 'items' | 'on'>, listeners, engine, input }
}

function timers() {
  const frames = new Map<number, () => void>()
  const tasks = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const t: InstallTimers = {
    requestAnimationFrame: (fn) => {
      frames.set(next, fn)
      return next++
    },
    cancelAnimationFrame: (id) => void frames.delete(id),
    setTimeout: (fn, ms) => {
      tasks.set(next, { fn, ms })
      return next++
    },
    clearTimeout: (id) => void tasks.delete(id as number),
  }
  /** Runs what is due: a timer cancelled by an earlier one in the same run does not fire. */
  const runFrames = () => {
    for (const [id, fn] of [...frames]) if (frames.delete(id)) fn()
  }
  const runTasks = (ms: number) => {
    for (const [id, task] of [...tasks]) if (task.ms === ms && tasks.delete(id)) task.fn()
  }
  return {
    t,
    /** the animation frame (a hidden tab never runs it) */
    frame: runFrames,
    /** the task the frame starts (a timer of 0 ms) */
    task: () => runTasks(0),
    /** the fallback timer that does not wait for a frame */
    fallback: () => runTasks(FRAME_FALLBACK_MS),
    frames,
    tasks,
  }
}

/** The features as the page installs them: canvas-ux's listener takes a double-click and a right-click. */
function features(b: ReturnType<typeof board>) {
  const got: string[] = []
  let installs = 0
  const install = () => {
    installs++
    const off = b.canvas.on('input', (e: CanvasInputEvent) => {
      if (e.type === 'double-click' || e.type === 'context-menu') {
        e.handled()
        got.push(e.type)
      }
    })
    return off
  }
  return { install, got, installs: () => installs }
}

describe('installFeaturesAfterWelcome', () => {
  it('a small board installs the features at once', () => {
    const b = board(10)
    const f = features(b)
    const tm = timers()
    const off = installFeaturesAfterWelcome(b.canvas, 100, f.install, tm.t)
    expect(f.installs()).toBe(1)
    expect(tm.frames.size).toBe(0)
    b.input({ type: 'double-click' })
    expect(f.got).toEqual(['double-click'])
    off()
    expect(b.listeners.size).toBe(0)
  })

  it('a large board installs them a frame and a task later; nothing reaches the engine in between', () => {
    const b = board(500)
    const f = features(b)
    const tm = timers()
    installFeaturesAfterWelcome(b.canvas, 100, f.install, tm.t)
    expect(f.installs()).toBe(0)
    // the window: a double-click (the engine's text box), a right-click (its menu), a press, a wheel, a paste key
    for (const e of [
      { type: 'double-click' },
      { type: 'context-menu', button: 2 },
      { type: 'pointer-down' },
      { type: 'wheel' },
      { type: 'pinch' },
      { type: 'key-down', key: 'v', ctrl: true },
      { type: 'key-down', key: 'Delete' },
    ])
      expect(b.input(e), String(e.type)).toBe(true)
    tm.frame()
    expect(b.input({ type: 'double-click' })).toBe(true)
    expect(b.engine).toEqual([])
    tm.task()
    expect(f.installs()).toBe(1)
    // installed: the features take what is theirs, the engine the rest
    b.input({ type: 'double-click' })
    b.input({ type: 'context-menu', button: 2 })
    b.input({ type: 'pointer-down' })
    expect(f.got).toEqual(['double-click', 'context-menu'])
    expect(b.engine).toEqual(['pointer-down'])
  })

  it('in the window hovering, a press’s end, Lobby’s own synthetic keys and Tab still reach the engine', () => {
    const b = board(500)
    const tm = timers()
    installFeaturesAfterWelcome(b.canvas, 100, features(b).install, tm.t)
    expect(b.input({ type: 'pointer-move' })).toBe(false)
    expect(b.input({ type: 'pointer-up' })).toBe(false)
    expect(b.input({ type: 'key-down', key: 'Enter', synthetic: true })).toBe(false)
    expect(b.input({ type: 'key-down', key: 'Tab' })).toBe(false)
    expect(b.engine).toEqual(['pointer-move', 'pointer-up', 'key:Enter', 'key:Tab'])
  })

  it('torn down before the install (the board closed): nothing installs, and the canvas takes input again', () => {
    const b = board(500)
    const f = features(b)
    const tm = timers()
    const off = installFeaturesAfterWelcome(b.canvas, 100, f.install, tm.t)
    tm.frame()
    off()
    tm.task()
    expect(f.installs()).toBe(0)
    expect(b.listeners.size).toBe(0)
    expect(b.input({ type: 'pointer-down' })).toBe(false)
    // torn down after it: the features' listeners go
    const g = features(b)
    const off2 = installFeaturesAfterWelcome(b.canvas, 100, g.install, tm.t)
    tm.frame()
    tm.task()
    expect(g.installs()).toBe(1)
    off2()
    expect(b.listeners.size).toBe(0)
  })

  it('wave O: a hidden tab runs no frame: the fallback timer installs the features, once, and the gate opens', () => {
    const b = board(500)
    const f = features(b)
    const tm = timers()
    const off = installFeaturesAfterWelcome(b.canvas, 100, f.install, tm.t)
    expect(b.input({ type: 'double-click' })).toBe(true) // gated while waiting
    expect(f.installs()).toBe(0)
    tm.fallback()
    expect(f.installs()).toBe(1)
    b.input({ type: 'double-click' })
    b.input({ type: 'pointer-down' })
    expect(f.got).toEqual(['double-click'])
    expect(b.engine).toEqual(['pointer-down'])
    // nothing is left waiting; were the tab shown and the frame to come, it finds nothing to do
    expect(tm.frames.size).toBe(0)
    expect(tm.tasks.size).toBe(0)
    tm.frame()
    tm.task()
    tm.fallback()
    expect(f.installs()).toBe(1)
    off()
    expect(b.listeners.size).toBe(0)
  })

  it('wave O: the fallback comes between the frame and its task: one install, the task finds nothing left', () => {
    const b = board(500)
    const f = features(b)
    const tm = timers()
    installFeaturesAfterWelcome(b.canvas, 100, f.install, tm.t)
    tm.frame()
    expect(f.installs()).toBe(0)
    tm.fallback()
    expect(f.installs()).toBe(1)
    tm.task()
    expect(f.installs()).toBe(1)
    expect(tm.tasks.size).toBe(0)
  })

  it('wave O: the frame and its task came first: the fallback is cancelled, one install', () => {
    const b = board(500)
    const f = features(b)
    const tm = timers()
    installFeaturesAfterWelcome(b.canvas, 100, f.install, tm.t)
    tm.frame()
    tm.task()
    expect(f.installs()).toBe(1)
    expect(tm.tasks.size).toBe(0)
    tm.fallback()
    expect(f.installs()).toBe(1)
  })

  it('wave O: torn down before either: no frame, no task and no fallback is left, and nothing installs', () => {
    const b = board(500)
    const f = features(b)
    const tm = timers()
    const off = installFeaturesAfterWelcome(b.canvas, 100, f.install, tm.t)
    off()
    expect(tm.frames.size).toBe(0)
    expect(tm.tasks.size).toBe(0)
    tm.fallback()
    expect(f.installs()).toBe(0)
    expect(b.listeners.size).toBe(0)
    // torn down after the fallback installed them: their listeners go
    const g = features(b)
    const off2 = installFeaturesAfterWelcome(b.canvas, 100, g.install, tm.t)
    tm.fallback()
    expect(g.installs()).toBe(1)
    off2()
    expect(b.listeners.size).toBe(0)
  })
})
