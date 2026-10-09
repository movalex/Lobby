// OWNER: W2 (wave L, L2-1a). AI provenance: the `customData` an AI-made element is created with, and how to read
// it back. ./public.ts re-exports `aiCustomData` and `AI_KIND_PREFIX` for the other workstreams (frozen there);
// the AI feature's own writers (./apply.ts, ../recap/apply.ts) import them from here, so the modules that
// public.ts itself imports never import public.ts back.
//
// canvas-schema (custom-data.ts): `lobby.ai` is AiValue `{ by, run? }`, create-only (the server checks `by` is
// the writer); `lobby.kind` is a free word of at most 32 characters. Neither is ever written after the create.

import { type CanvasElement, items } from '../../../canvas/api/index.ts'

/** The `customData.lobby.kind` prefix of AI-made elements. */
export const AI_KIND_PREFIX = 'ai-'
/** A kind word after the prefix: what canvas-schema's `kind` value allows (32 characters with the prefix). */
const KIND_WORD = /^[a-z][a-z0-9-]{0,28}$/

/**
 * The `customData` an AI-made element is created with (L2-1a): `lobby.ai = { by, run }` (canvas-schema
 * AiValue: `run` is the AiResult's run id) and `lobby.kind = 'ai-' + kind` ('theme-label', 'recap-heading',
 * 'recap-item', 'answer', 'diagram-node', …). `run` null or absent leaves it out (an element made before wave
 * L, or by a path with no run). Throws for a kind word the schema would refuse (a programming error).
 */
export function aiCustomData(
  by: string,
  kind: string,
  run?: string | null,
): { lobby: { ai: { by: string; run?: string }; kind: string } } {
  if (!KIND_WORD.test(kind)) throw new Error(`aiCustomData: not a kind word: ${JSON.stringify(kind)}`)
  return { lobby: { ai: run ? { by, run } : { by }, kind: `${AI_KIND_PREFIX}${kind}` } }
}

/** An element's AI provenance (`lobby.ai`), or null when AI did not make it. */
export function aiOf(el: CanvasElement | undefined): { by: string; run: string | null } | null {
  if (!el) return null
  const v = items.lobbyValue(el, 'ai')
  if (typeof v !== 'object' || v === null) return null
  const { by, run } = v as { by?: unknown; run?: unknown }
  if (typeof by !== 'string') return null
  return { by, run: typeof run === 'string' && run ? run : null }
}

/** The kind word of an AI-made element without its prefix ('theme-label', 'action-item', …), else null. */
export function aiKindWord(el: CanvasElement | undefined): string | null {
  if (!aiOf(el)) return null
  const kind = el ? items.lobbyValue(el, 'kind') : undefined
  return typeof kind === 'string' && kind.startsWith(AI_KIND_PREFIX)
    ? kind.slice(AI_KIND_PREFIX.length)
    : null
}

/** The server's stamps of an element (`customData.lobbyServer`), as far as they are there. */
export interface ServerStamps {
  readonly createdBy: { readonly uid: string; readonly name: string } | null
  readonly createdAt: number | null
  readonly lastEditedAt: number | null
}

export function stampsOf(el: CanvasElement | undefined): ServerStamps {
  const ls = (el?.customData as { lobbyServer?: unknown } | null | undefined)?.lobbyServer
  if (typeof ls !== 'object' || ls === null) return { createdBy: null, createdAt: null, lastEditedAt: null }
  const r = ls as Record<string, unknown>
  const by = r.createdBy as { uid?: unknown; name?: unknown } | null | undefined
  return {
    createdBy:
      by && typeof by.uid === 'string' && typeof by.name === 'string' ? { uid: by.uid, name: by.name } : null,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : null,
    lastEditedAt: typeof r.lastEditedAt === 'number' ? r.lastEditedAt : null,
  }
}
