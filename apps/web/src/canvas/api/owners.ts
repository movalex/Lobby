/**
 * Who implements what (docs/EXCALIDRAW-MIGRATION.md §7.2, docs/EXCALIDRAW-CONTRACTS.md §2.2, §7.2). Every stub
 * of the feature-facing canvas API names one of these owners; `NotImplementedError` carries it, so a
 * wave-3 owner who hits a stub knows whom to ask. Frozen at wave 1.
 */

export const OWNERS = {
  contracts: 'wave 1 contracts owner (this API, the registries, the facade types)',
  '2A': 'wave 2A sync-room (apps/sync/src/room)',
  '2B': 'wave 2B sync-edges (http, backups, conversion worker)',
  '2C': 'wave 2C web-engine (apps/web/src/canvas/** implementation, board/BoardPage.tsx, sync-quality)',
  '2D': 'wave 2D formats (packages/tldraw-import, board-ops, templates)',
  '2E': 'wave 2E harness (e2e/tests/support, the test facade verbs, protocol tests)',
  '2F': 'wave 2F api (routes A1/A2, readers A5, checkpoint v1/v2)',
  '3a': 'wave 3a canvas tools (features/canvas-ux: toolbar, style panel, keys, menus, selection bar)',
  '3b': 'wave 3b navigation (minimap, search, frames panel, start view, copy link, fit camera, LOD)',
  '3c': 'wave 3c comments + people (features/comments, features/people, present-live)',
  '3d': 'wave 3d mind maps + tags (features/mindmap, features/tags)',
  '3e': 'wave 3e present + export (features/present-export, features/thumbnails, canvas/export)',
  '3f': 'wave 3f workshops (features/workshops: vote tool, +1, private notes, timer, reactions)',
  '3g': 'wave 3g media (file-card, assets, board/ExternalContent, canvas/files placement)',
  '3h': 'wave 3h history + AI (features/history, features/ai, canvas/preview)',
  '3i': 'wave 3i a11y + mobile (live region, traversal, content list, phone sheet, touch)',
  W4: 'wave 4 integration (tldraw removal, CSP, cross-cutting fixes)',
} as const

export type Owner = keyof typeof OWNERS

export const isOwner = (s: string): s is Owner => Object.hasOwn(OWNERS, s)

/** Thrown by every stub of the canvas API until its owner implements it. */
export class NotImplementedError extends Error {
  readonly owner: Owner
  readonly member: string
  constructor(owner: Owner, member: string) {
    super(`not implemented (${owner}): ${member} (docs/EXCALIDRAW-CONTRACTS.md)`)
    this.name = 'NotImplementedError'
    this.owner = owner
    this.member = member
  }
}

/** A stub function for `member`, owned by `owner`: throws `NotImplementedError` when called. */
export function notImplemented<F extends (...args: never[]) => unknown>(owner: Owner, member: string): F {
  const stub = (() => {
    throw new NotImplementedError(owner, member)
  }) as unknown as F & { readonly __stub: { owner: Owner; member: string } }
  Object.defineProperty(stub, '__stub', { value: { owner, member }, enumerable: false })
  return stub
}

/** The owner of a stub made by `notImplemented`, or null for an implemented function. */
export function stubOwner(fn: unknown): { owner: Owner; member: string } | null {
  if (typeof fn !== 'function') return null
  return (fn as { __stub?: { owner: Owner; member: string } }).__stub ?? null
}
