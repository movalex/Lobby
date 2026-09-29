/**
 * OWNER: 3g (media). URLs for an element's file (a derivative or the original, through the api's
 * authorised routes, never a stored URL) and inserting files like a drop (upload, wait for the worker,
 * place with the card facts; canvas/files/place.ts). `files.status` (the loader's state) stays 2C's in
 * ../impl.ts. Stubs until 3g lands them.
 */
import type { LobbyFiles } from '../lobby-canvas.ts'
import { notImplemented } from '../owners.ts'
import type { PartDeps } from './types.ts'

export type FilesPart = Pick<LobbyFiles, 'urlOf' | 'insert'>

export function createFilesPart(_deps: PartDeps): FilesPart {
  return {
    urlOf: notImplemented('3g', 'files.urlOf'),
    insert: notImplemented('3g', 'files.insert'),
  }
}
