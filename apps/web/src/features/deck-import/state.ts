// OWNER: WS4 (wave W, deck import). Which card's "Insert as slides" dialog is open on this board page (local UI state,
// never synced), keyed by the page's registries like the PDF viewer's request (file-card/ported/viewer-state.ts).
import type { FeatureRegistries } from '../../canvas/api/index.ts'
import { type Atom, atom } from '../../lib/signals.ts'

export interface DeckImportRequest {
  /** the card's element id */
  readonly id: string
  /** changes on every open, so reopening the same card starts fresh */
  readonly nonce: number
}

const requests = new WeakMap<FeatureRegistries, Atom<DeckImportRequest | null>>()
let nonce = 0

export function deckImportRequest(registries: FeatureRegistries): Atom<DeckImportRequest | null> {
  let a = requests.get(registries)
  if (!a) {
    a = atom<DeckImportRequest | null>('deck-import-request', null)
    requests.set(registries, a)
  }
  return a
}

export function openDeckImport(registries: FeatureRegistries, id: string): void {
  deckImportRequest(registries).set({ id, nonce: ++nonce })
}

export function closeDeckImport(registries: FeatureRegistries): void {
  deckImportRequest(registries).set(null)
}
