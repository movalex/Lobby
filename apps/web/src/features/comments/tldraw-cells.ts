// The tldraw board page's SignalsKit (./cells.ts): tldraw's own atoms, so the tldraw components keep
// reading the comments and present-live stores with tldraw's useValue next to editor state. Deleted with
// the tldraw page at wave 4.

import { type Atom, atom, transact, useValue } from 'tldraw'
import type { Cell, SignalsKit } from './cells.ts'

export const TLDRAW_SIGNALS: SignalsKit = {
  atom: (name, initial) => atom(name, initial),
  transact: (fn) => transact(fn),
  useValue: <T>(cell: Cell<T>) => useValue(cell as unknown as Atom<T>),
}
