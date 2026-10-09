// Wave L (W1): Excalidraw elements for the AI tests, as the engine's sync stores them (a lobby-elements
// snapshot, support.ts AiSync.setElements). The server stamps `customData.lobbyServer` (createdAt and
// lastEditedAt, the authors); a container's words live in its bound label. Authors here are fixed test names
// so a test can check that none of them reaches a prompt.

export const DAY = 24 * 60 * 60 * 1000

/** An author attribution as the server writes it (a name a prompt must never carry). */
export const author = (uid: string, name: string) => ({ uid, name, guest: false })
export const AUTHOR = author('usr_author000001', 'Morgan Writer-Secret')

type Any = Record<string, unknown>

export interface NoteOpts {
  x?: number
  y?: number
  w?: number
  h?: number
  frameId?: string | null
  /** Server-stamped creation time of the container (ms). */
  createdAt?: number
  /** Server-stamped time its words were last typed (the label's lastEditedAt; default: createdAt). */
  editedAt?: number
  /** A client-set Excalidraw `updated` (never read by the api). */
  updated?: number
  backgroundColor?: string
  strokeColor?: string
  locked?: boolean
  /** customData.lobby keys of the container. */
  lobby?: Any
  /** Who typed the words (default AUTHOR). */
  typedBy?: ReturnType<typeof author> | null
}

const server = (createdAt: number, editedAt: number, by: ReturnType<typeof author> | null) => ({
  createdBy: by,
  createdAt,
  lastEditedBy: by,
  lastEditedAt: editedAt,
})

function base(id: string, type: string, o: NoteOpts, w: number, h: number): Any {
  const createdAt = o.createdAt ?? 0
  return {
    id,
    type,
    x: o.x ?? 0,
    y: o.y ?? 0,
    width: o.w ?? w,
    height: o.h ?? h,
    angle: 0,
    isDeleted: false,
    frameId: o.frameId ?? null,
    locked: o.locked ?? false,
    backgroundColor: o.backgroundColor ?? 'transparent',
    strokeColor: o.strokeColor ?? '#1d1d1d',
    updated: o.updated ?? createdAt,
    customData: {
      ...(o.lobby ? { lobby: o.lobby } : {}),
      lobbyServer: server(createdAt, createdAt, o.typedBy === undefined ? AUTHOR : o.typedBy),
    },
  }
}

function labelOf(containerId: string, words: string, o: NoteOpts): Any {
  const createdAt = o.createdAt ?? 0
  const by = o.typedBy === undefined ? AUTHOR : o.typedBy
  return {
    id: `${containerId}-t`,
    type: 'text',
    x: o.x ?? 0,
    y: o.y ?? 0,
    width: 100,
    height: 25,
    isDeleted: false,
    frameId: o.frameId ?? null,
    containerId,
    text: words,
    originalText: words,
    updated: o.updated ?? createdAt,
    customData: { lobbyServer: server(createdAt, o.editedAt ?? createdAt, by) },
  }
}

/** A sticky note and its label (yellow by default: Lobby's '#f6c453'). */
export function note(id: string, words: string, o: NoteOpts = {}): Any[] {
  const el = base(id, 'stickynote', { backgroundColor: '#f6c453', strokeColor: '#1b2330', ...o }, 200, 200)
  return words ? [el, labelOf(id, words, o)] : [el]
}

/** A rectangle with a label. */
export function shape(id: string, words: string, o: NoteOpts = {}): Any[] {
  const el = base(id, 'rectangle', o, 240, 80)
  return words ? [el, labelOf(id, words, o)] : [el]
}

/** A free text (its words are its own; its lastEditedAt is the time they were typed). */
export function freeText(id: string, words: string, o: NoteOpts = {}): Any[] {
  const el = base(id, 'text', o, 300, 30)
  const by = o.typedBy === undefined ? AUTHOR : o.typedBy
  el.text = words
  el.originalText = words
  el.containerId = null
  ;(el.customData as Any).lobbyServer = server(o.createdAt ?? 0, o.editedAt ?? o.createdAt ?? 0, by)
  return [el]
}

/** A frame (its name is what a recap and an index read). */
export function frame(id: string, name: string, o: NoteOpts = {}): Any[] {
  const el = base(id, 'frame', o, 1600, 1000)
  el.name = name
  return [el]
}

/** An image showing a file (its name is never read). */
export function image(id: string, o: NoteOpts = {}): Any[] {
  const el = base(id, 'image', o, 300, 200)
  el.fileId = 'ver_000000000001'
  el.customData = {
    lobby: {
      file: {
        assetId: 'ast_000000000001',
        versionId: 'ver_000000000001',
        kind: 'image',
        name: 'SECRET-plan.png',
      },
    },
    lobbyServer: server(o.createdAt ?? 0, o.createdAt ?? 0, AUTHOR),
  }
  return [el]
}

export const ref = (id: string) => `shape:${id}`
