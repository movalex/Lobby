// The reactive cells the comments and present-live stores keep their state in, engine-neutral so one
// store (and its tests) serves both board pages until wave 4 (docs/EXCALIDRAW-CONTRACTS.md §1: a shared
// pure module stays importable by ported code, so it carries no tldraw at run time).
//
// A store is built with a `SignalsKit`: the tldraw board page passes tldraw's atoms (./tldraw-cells.ts),
// so its components keep reading them with tldraw's useValue next to editor state; the Excalidraw board
// page passes Lobby's (LOBBY_SIGNALS, lib/signals.ts), read next to LobbyCanvas state. Components shared
// by both pages (Composer, ThreadView) read a cell through the store's own kit: `kit.useValue(cell)`.

import { atom, type Signal, transact, useValue } from '../../lib/signals.ts'

/** A writable reactive value: tldraw's `Atom` and lib/signals' `Atom` both are one. */
export interface Cell<T> {
  get(): T
  set(value: T): void
  update(fn: (value: T) => T): void
}

export interface SignalsKit {
  atom<T>(name: string, initial: T): Cell<T>
  /** batches writes: reactions run once, after the outermost call returns */
  transact<T>(fn: () => T): T
  /** a React hook: the cell's value, re-rendering when it changes */
  useValue<T>(cell: Cell<T>): T
}

/** Lobby's signals (the Excalidraw board page, and the stores' unit tests). */
export const LOBBY_SIGNALS: SignalsKit = {
  atom: (name, initial) => atom(name, initial),
  transact: (fn) => transact(fn),
  // the cell is a lib/signals atom (made by this kit's `atom`)
  useValue: <T>(cell: Cell<T>) => useValue(cell as unknown as Signal<T>),
}
