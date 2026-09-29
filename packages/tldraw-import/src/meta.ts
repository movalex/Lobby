/**
 * Lobby's tldraw meta and attribution → `customData` on the new canvas (docs/EXCALIDRAW-MIGRATION.md §5.1
 * "Lobby meta", §3.3). Every value is checked against the frozen key registry
 * (`@draftroom/canvas-schema/custom-data`); a value the registry refuses is dropped and reported
 * (`meta-dropped`), never written, so the server never refuses a converted element.
 *
 * | tldraw                                   | new canvas                                             |
 * |------------------------------------------|--------------------------------------------------------|
 * | shape meta `drTags:<key>` {name, color}  | `customData.lobby['tag:<key>']` (≤ 10, else over-limit) |
 * | shape meta `plusOnes` [uid]              | `customData.lobby['plusOne:<uid>'] = true` (≤ 200)      |
 * | `drMindmap`, `drMindmapEdge` (shape refs) | `mindmap`, `mindmapEdge` (element ids)                 |
 * | `presentationIndex`, `presentationSkip`  | `present` {index?, skip?}                              |
 * | `draftroomPrompt`/`Slot`/`Swatch`        | `prompt`/`slot`/`swatch` when the registry has them     |
 * | image `altText`                          | `alt`                                                  |
 * | `drPrivateNote` {session, author?}       | `lobbyServer.privateNote` (server-owned)               |
 * | note `textLastEditedBy`                  | the label's `lobbyServer.lastEditedBy`                  |
 * | `drAi`, `drPrivateFrame`                 | dropped (`ai-marker`, `private-frame-marker`): the     |
 * |                                          | registry's `ai` {by} and `privateFrame` {session, by}  |
 * |                                          | need an author the tldraw meta never recorded          |
 *
 * Nothing here logs or reports a value: only codes and record ids leave the converter.
 */
import {
  checkLobbyData,
  LobbyServer,
  lobbyKeySpec,
  lobbyValueProblem,
  PLUS_ONE_KEY_PREFIX,
  TAG_KEY_PREFIX,
} from '@draftroom/canvas-schema/custom-data'
import { MAX_ALT_CHARS, MAX_TAGS_PER_ELEMENT, PLUS_ONES_MAX } from '@draftroom/canvas-schema/limits'
import type { LossyCode } from './types.ts'

export type Rec = Record<string, unknown>
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface MetaResult {
  /** `customData.lobby`, or null when empty */
  readonly lobby: Rec | null
  /** `lobbyServer.privateNote` of the element, when the note was a private-brainstorm note */
  readonly privateNote: { session: string; author?: string } | null
  readonly lossy: readonly LossyCode[]
}

const SHAPE_TAG_PREFIX = 'drTags:'

/**
 * The customData of one shape. `idOf` maps a tldraw shape ref (`shape:…`) to its element id (mind-map
 * refs); `extra` holds converter-made keys (`kind`, `alt`, `file`, `pdfPage`).
 */
export function lobbyDataOf(
  meta: unknown,
  idOf: (shapeRef: string) => string | null,
  extra: Rec = {},
): MetaResult {
  const lobby: Rec = {}
  const lossy: LossyCode[] = []
  let privateNote: MetaResult['privateNote'] = null
  const m = isObj(meta) ? meta : {}
  const put = (key: string, value: unknown) => {
    if (lobbyValueProblem(key, value) === null) lobby[key] = value
    else lossy.push('meta-dropped')
  }
  let tags = 0
  for (const key of Object.keys(m).sort()) {
    const value = m[key]
    if (key.startsWith(SHAPE_TAG_PREFIX)) {
      if (tags >= MAX_TAGS_PER_ELEMENT) {
        lossy.push('over-limit')
        continue
      }
      const before = Object.keys(lobby).length
      put(`${TAG_KEY_PREFIX}${key.slice(SHAPE_TAG_PREFIX.length)}`, value)
      if (Object.keys(lobby).length > before) tags++
    } else if (key === 'plusOnes') {
      if (!Array.isArray(value)) {
        lossy.push('meta-dropped')
        continue
      }
      const uids = [...new Set(value.filter((u): u is string => typeof u === 'string'))]
      if (uids.length !== value.length) lossy.push('meta-dropped')
      if (uids.length > PLUS_ONES_MAX) lossy.push('over-limit')
      for (const uid of uids.slice(0, PLUS_ONES_MAX)) put(`${PLUS_ONE_KEY_PREFIX}${uid}`, true)
    } else if (key === 'drMindmap') {
      const v = isObj(value) ? value : null
      const rootId = typeof v?.rootId === 'string' ? idOf(v.rootId) : null
      const parentId =
        v?.parentId === null ? null : typeof v?.parentId === 'string' ? idOf(v.parentId) : undefined
      if (!v || rootId === null || parentId === undefined) lossy.push('meta-dropped')
      else put('mindmap', { rootId, parentId, side: v.side, collapsed: v.collapsed })
    } else if (key === 'drMindmapEdge') {
      const v = isObj(value) ? value : null
      const ids = ['rootId', 'parentId', 'childId'].map((k) =>
        typeof v?.[k] === 'string' ? idOf(v[k] as string) : null,
      )
      if (!v || ids.some((x) => x === null)) lossy.push('meta-dropped')
      else put('mindmapEdge', { rootId: ids[0], parentId: ids[1], childId: ids[2] })
    } else if (key === 'presentationIndex' || key === 'presentationSkip') {
      // folded below
    } else if (key === 'draftroomPrompt' || key === 'draftroomSlot' || key === 'draftroomSwatch') {
      const target = key === 'draftroomPrompt' ? 'prompt' : key === 'draftroomSlot' ? 'slot' : 'swatch'
      if (lobbyKeySpec(target)) put(target, value)
      else lossy.push('meta-dropped')
    } else if (key === 'drPrivateNote') {
      const v = isObj(value) ? value : null
      const candidate = v
        ? { session: v.session, ...(v.author !== undefined ? { author: v.author } : {}) }
        : null
      const ok =
        candidate &&
        LobbyServer.safeParse({
          createdBy: null,
          createdAt: 0,
          lastEditedBy: null,
          lastEditedAt: 0,
          privateNote: candidate,
        }).success
      if (ok) privateNote = candidate as { session: string; author?: string }
      else lossy.push('meta-dropped')
    } else if (key === 'drAi') lossy.push('ai-marker')
    else if (key === 'drPrivateFrame') lossy.push('private-frame-marker')
    else lossy.push('meta-dropped')
  }
  if ('presentationIndex' in m || 'presentationSkip' in m) {
    const present: Rec = {}
    if (m.presentationIndex !== undefined) present.index = m.presentationIndex
    if (m.presentationSkip !== undefined) present.skip = m.presentationSkip
    put('present', present)
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'alt' && typeof value === 'string' && value.length > MAX_ALT_CHARS) {
      lossy.push('over-limit')
      put(key, value.slice(0, MAX_ALT_CHARS))
    } else put(key, value)
  }
  // the budgets (8 KiB without +1s, 16 KiB of +1s): drop +1s first, then everything but `kind`/`file`
  if (!checkLobbyData(lobby).ok) {
    lossy.push('over-limit')
    for (const key of Object.keys(lobby).sort().reverse()) {
      if (checkLobbyData(lobby).ok) break
      if (key !== 'kind' && key !== 'file' && key !== 'pdfPage') delete lobby[key]
    }
  }
  return { lobby: Object.keys(lobby).length ? lobby : null, privateNote, lossy }
}

/** `customData.lobbyServer` for a converted element (null when there is nothing server-owned to say). */
export function lobbyServerOf(
  at: number,
  opts: { privateNote?: { session: string; author?: string } | null; lastEditedBy?: string | null },
): { value: Rec | null; lossy: LossyCode[] } {
  const lossy: LossyCode[] = []
  if (!opts.privateNote && !opts.lastEditedBy) return { value: null, lossy }
  const value: Rec = {
    createdBy: null,
    createdAt: at,
    lastEditedBy: opts.lastEditedBy ? { uid: opts.lastEditedBy, name: '', guest: false } : null,
    lastEditedAt: at,
    ...(opts.privateNote ? { privateNote: opts.privateNote } : {}),
  }
  if (LobbyServer.safeParse(value).success) return { value, lossy }
  lossy.push('meta-dropped')
  return { value: null, lossy }
}

/** The customData object of an element (null when both parts are empty). */
export function customDataOf(lobby: Rec | null, lobbyServer: Rec | null): Rec | null {
  if (!lobby && !lobbyServer) return null
  return { ...(lobby ? { lobby } : {}), ...(lobbyServer ? { lobbyServer } : {}) }
}
