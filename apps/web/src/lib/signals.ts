/**
 * Lobby's small reactive-state library: the replacement for the `atom`, `computed`, `react`,
 * `transact` and `useValue` that features import from `tldraw` today (docs/EXCALIDRAW-CONTRACTS.md §5,
 * "Signals"). The API below is frozen at wave 1; the implementation may be optimised later without
 * changing it.
 *
 * - `atom(name, value)`: a writable cell. `get()` inside a tracked context (a `computed`, a `react`
 *   effect, a `useValue` selector) records a dependency.
 * - `computed(name, fn)`: a lazily cached derivation; it recomputes only when a dependency changed.
 * - `react(name, fn)`: runs `fn` now and again after every change of what it read; returns the stop.
 * - `transact(fn)`: batches writes; effects run once, after the outermost `transact` returns.
 * - `useValue(name, fn, deps)` / `useValue(signal)`: a React hook over the same tracking.
 * - `source(name)`: an invisible signal for adapters (the LobbyCanvas implementation calls `track()`
 *   inside a read and `bump()` when the engine reports a change, so `useValue(() => canvas.selection)`
 *   re-renders on selection changes).
 *
 * Equality is `Object.is` unless an `isEqual` is given. A computed nobody observes holds no reference
 * from its dependencies (no leak) and re-validates by version on read. No DOM, no engine, no tldraw.
 */
import { useMemo, useSyncExternalStore } from 'react'

export interface Signal<T> {
  readonly name: string
  get(): T
}

export interface Atom<T> extends Signal<T> {
  set(value: T): void
  update(fn: (value: T) => T): void
}

export interface SignalOptions<T> {
  readonly isEqual?: (a: T, b: T) => boolean
}

/** A value-less change source (see the header). */
export interface Source {
  readonly name: string
  /** Records a dependency on this source in the current tracked context (a no-op outside one). */
  track(): void
  /** Marks everything that tracked this source as changed. */
  bump(): void
}

// ---- the graph -------------------------------------------------------------------------------------------

interface Node {
  /** bumped when the node's value changes */
  version: number
  addObserver(d: Derivation): void
  removeObserver(d: Derivation): void
  forEachObserver(fn: (d: Derivation) => void): void
}

interface Derivation {
  /** a dependency changed since the last run (it may still compute the same value) */
  stale: boolean
  /** dependencies of the last run, with the version each had */
  deps: Map<Node, number>
  /** whether it keeps itself registered with its dependencies (effects always; computeds while observed) */
  isHot(): boolean
  onStale(): void
}

let tracking: Derivation | null = null
let batchDepth = 0
let flushing = false
const pendingEffects = new Set<Effect>()

function record(node: Node): void {
  if (tracking && !tracking.deps.has(node)) tracking.deps.set(node, node.version)
}

function markStale(node: Node): void {
  const hit: Derivation[] = []
  node.forEachObserver((d) => hit.push(d))
  for (const d of hit) {
    if (d.stale) continue
    d.stale = true
    d.onStale()
  }
}

function flush(): void {
  if (batchDepth > 0 || flushing) return
  flushing = true
  try {
    // an effect may write atoms and schedule more effects: loop until quiet (bounded)
    for (let guard = 0; pendingEffects.size > 0; guard++) {
      if (guard > 1000) throw new Error('signals: effects did not settle after 1000 rounds (a write loop?)')
      const run = [...pendingEffects]
      pendingEffects.clear()
      for (const e of run) e.runIfChanged()
    }
  } catch (e) {
    // a failed flush drops what is left, so one broken effect cannot wedge every later write
    pendingEffects.clear()
    throw e
  } finally {
    flushing = false
  }
}

function changed(node: Node): void {
  node.version++
  batchDepth++
  try {
    markStale(node)
  } finally {
    batchDepth--
  }
  flush()
}

function runTracked<T>(d: Derivation, fn: () => T): T {
  const prevDeps = d.deps
  d.deps = new Map()
  const outer = tracking
  tracking = d
  try {
    return fn()
  } finally {
    tracking = outer
    d.stale = false
    if (d.isHot()) {
      for (const node of prevDeps.keys()) if (!d.deps.has(node)) node.removeObserver(d)
      for (const node of d.deps.keys()) node.addObserver(d)
    }
  }
}

/** Whether any dependency of `d` really changed (refreshing computed dependencies first). */
function depsChanged(d: Derivation): boolean {
  for (const [node, seen] of d.deps) {
    if (node instanceof ComputedImpl) node.refresh()
    if (node.version !== seen) return true
  }
  return false
}

class PlainNode {
  version = 0
  private readonly observers = new Set<Derivation>()
  addObserver(d: Derivation): void {
    this.observers.add(d)
  }
  removeObserver(d: Derivation): void {
    this.observers.delete(d)
  }
  forEachObserver(fn: (d: Derivation) => void): void {
    for (const d of this.observers) fn(d)
  }
}

class AtomImpl<T> extends PlainNode implements Atom<T>, Node {
  readonly name: string
  private value: T
  private readonly isEqual: (a: T, b: T) => boolean
  constructor(name: string, initial: T, isEqual: (a: T, b: T) => boolean) {
    super()
    this.name = name
    this.value = initial
    this.isEqual = isEqual
  }
  get(): T {
    record(this)
    return this.value
  }
  set(value: T): void {
    if (this.isEqual(this.value, value)) return
    this.value = value
    changed(this)
  }
  update(fn: (value: T) => T): void {
    this.set(fn(this.value))
  }
}

class SourceImpl extends PlainNode implements Source, Node {
  readonly name: string
  constructor(name: string) {
    super()
    this.name = name
  }
  track(): void {
    record(this)
  }
  bump(): void {
    changed(this)
  }
}

const UNSET: unique symbol = Symbol('unset')

class ComputedImpl<T> implements Signal<T>, Node, Derivation {
  version = 0
  stale = true
  deps = new Map<Node, number>()
  private readonly observers = new Set<Derivation>()
  private value: T | typeof UNSET = UNSET
  readonly name: string
  private readonly fn: () => T
  private readonly isEqual: (a: T, b: T) => boolean
  constructor(name: string, fn: () => T, isEqual: (a: T, b: T) => boolean) {
    this.name = name
    this.fn = fn
    this.isEqual = isEqual
  }
  isHot(): boolean {
    return this.observers.size > 0
  }
  addObserver(d: Derivation): void {
    const wasCold = this.observers.size === 0
    this.observers.add(d)
    // becoming observed: register with the dependencies of the last run (the reader just refreshed it)
    if (wasCold) for (const node of this.deps.keys()) node.addObserver(this)
  }
  removeObserver(d: Derivation): void {
    if (!this.observers.delete(d) || this.observers.size > 0) return
    // nobody observes it any more: drop the references its dependencies hold (re-validated by version)
    for (const node of this.deps.keys()) node.removeObserver(this)
  }
  forEachObserver(fn: (d: Derivation) => void): void {
    for (const d of this.observers) fn(d)
  }
  onStale(): void {
    markStale(this)
  }
  /** Recomputes if a dependency changed; bumps `version` only when the value changed. */
  refresh(): void {
    if (this.value !== UNSET) {
      // a hot computed knows when it is stale; a cold one checks its dependencies' versions
      if (this.isHot() && !this.stale) return
      if (!depsChanged(this)) {
        this.stale = false
        return
      }
    }
    const next = runTracked(this, this.fn)
    if (this.value === UNSET || !this.isEqual(this.value, next)) {
      this.value = next
      this.version++
    }
  }
  get(): T {
    this.refresh()
    record(this)
    return this.value as T
  }
}

class Effect implements Derivation {
  stale = true
  deps = new Map<Node, number>()
  private stopped = false
  private readonly fn: () => void
  constructor(fn: () => void) {
    this.fn = fn
  }
  isHot(): boolean {
    return !this.stopped
  }
  onStale(): void {
    pendingEffects.add(this)
  }
  run(): void {
    if (this.stopped) return
    runTracked(this, this.fn)
    // it wrote something it read (after reading it): run again with the new value
    for (const [node, seen] of this.deps) {
      if (node.version !== seen) {
        pendingEffects.add(this)
        break
      }
    }
  }
  runIfChanged(): void {
    if (this.stopped) return
    if (!depsChanged(this)) {
      this.stale = false
      return
    }
    this.run()
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    pendingEffects.delete(this)
    for (const node of this.deps.keys()) node.removeObserver(this)
    this.deps.clear()
  }
}

// ---- the API ----------------------------------------------------------------------------------------------

export function atom<T>(name: string, initial: T, opts: SignalOptions<T> = {}): Atom<T> {
  return new AtomImpl(name, initial, opts.isEqual ?? Object.is)
}

export function computed<T>(name: string, fn: () => T, opts: SignalOptions<T> = {}): Signal<T> {
  return new ComputedImpl(name, fn, opts.isEqual ?? Object.is)
}

export function source(name: string): Source {
  return new SourceImpl(name)
}

/** Runs `fn` now and after every change of what it read. Returns the stop function. */
export function react(_name: string, fn: () => void): () => void {
  const e = new Effect(fn)
  batchDepth++
  try {
    e.run()
  } finally {
    batchDepth--
  }
  flush()
  return () => e.stop()
}

/** Batches writes: effects run once, after the outermost `transact` returns (also when `fn` throws). */
export function transact<T>(fn: () => T): T {
  batchDepth++
  try {
    return fn()
  } finally {
    batchDepth--
    flush()
  }
}

/** Reads without recording dependencies. */
export function untracked<T>(fn: () => T): T {
  const outer = tracking
  tracking = null
  try {
    return fn()
  } finally {
    tracking = outer
  }
}

/**
 * Subscribes to a signal outside React: `onChange` is called after each change of its value (not for
 * the first value). Returns the stop function. `useValue` is built on it.
 */
export function subscribeValue<T>(signal: Signal<T>, onChange: () => void): () => void {
  let first = true
  return react(`subscribe:${signal.name}`, () => {
    signal.get()
    if (first) first = false
    else onChange()
  })
}

/** A React hook: the value of `signal`, or of the selector `fn` (re-created when `deps` change). */
export function useValue<T>(signal: Signal<T>): T
export function useValue<T>(name: string, fn: () => T, deps: readonly unknown[]): T
export function useValue<T>(a: Signal<T> | string, fn?: () => T, deps: readonly unknown[] = []): T {
  const signal = useMemo(
    () => (typeof a === 'string' ? computed(a, fn as () => T) : a),
    typeof a === 'string' ? deps : [a],
  )
  const subscribe = useMemo(() => (onChange: () => void) => subscribeValue(signal, onChange), [signal])
  return useSyncExternalStore(
    subscribe,
    () => signal.get(),
    () => signal.get(),
  )
}
