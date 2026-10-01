// CanvasPort-style tool switching (docs/EXCALIDRAW-MIGRATION.md §2.3.4). The API object is taken as a
// minimal interface, so the refusal rules run in Node tests.
//
// Note (N), text (T), comment, vote and open-card are Lobby CUSTOM tools: with a custom tool active
// Excalidraw creates nothing and only reports pointer events (api.onPointerDown/onPointerUp). They are
// activated with `locked: true`, or Excalidraw reverts to the selection tool after one click and the tool
// goes inert (types.d.ts:620-630).
//
// Refused engine tools: `text` and `stickynote` open Excalidraw's text editor straight from a click
// (handleTextOnPointerDown, dist/dev/index.js:46338-46380; new text :51240-51257; sticky note
// :51295-51320) and `autoshape` from a double-click (:44733), all without the text lease (P6-P8 of
// §2.9.2). `image` would open Excalidraw's file picker and base64 path (§2.10.1); `embeddable` and
// `magicframe` are refused element types (§3.1); `bucketfill` is not a Lobby tool.

export const REFUSED_ENGINE_TOOLS: ReadonlySet<string> = new Set([
  'text',
  'stickynote',
  'autoshape',
  'image',
  'embeddable',
  'magicframe',
  'bucketfill',
])

/** Excalidraw tool types Lobby activates as they are. */
export const ENGINE_TOOLS = [
  'selection',
  'lasso',
  'hand',
  'rectangle',
  'diamond',
  'ellipse',
  'arrow',
  'line',
  'freedraw',
  'eraser',
  'laser',
  'frame',
] as const
export type EngineTool = (typeof ENGINE_TOOLS)[number]

/** Lobby's custom tools: Lobby name -> Excalidraw customType. */
export const CUSTOM_TOOLS = Object.freeze({
  note: 'lobby-note',
  text: 'lobby-text',
  comment: 'lobby-comment',
  vote: 'lobby-vote',
  'open-card': 'lobby-open-card',
} as const)
export type CustomTool = keyof typeof CUSTOM_TOOLS
export type CustomToolType = (typeof CUSTOM_TOOLS)[CustomTool]

/** Every tool name the port accepts. */
export type LobbyTool = CustomTool | 'select' | Exclude<EngineTool, 'selection'>

export type ToolRequest =
  | { type: EngineTool; locked?: boolean }
  | { type: 'custom'; customType: CustomToolType; locked: true }

export interface ToolApi {
  setActiveTool(tool: ToolRequest): void
  getAppState(): { activeTool: { type: string; customType: string | null; locked?: boolean } }
  /** Used only to leave a custom tool for read-only roles (see setEngineTool). */
  updateScene?(scene: { appState: { activeTool: SelectionToolState } }): void
}

/** The neutral selection state, as Excalidraw's updateActiveTool builds it. */
export interface SelectionToolState {
  type: 'selection'
  customType: null
  locked: boolean
  lastActiveTool: null
  fromSelection: boolean
}
const SELECTION_TOOL: Readonly<SelectionToolState> = Object.freeze({
  type: 'selection',
  customType: null,
  locked: false,
  lastActiveTool: null,
  fromSelection: false,
})

export class ToolRefused extends Error {
  readonly tool: string

  constructor(tool: string) {
    super(`tool "${tool}" is refused by Lobby (docs/EXCALIDRAW-MIGRATION.md §2.3.4)`)
    this.name = 'ToolRefused'
    this.tool = tool
  }
}

const isEngineTool = (t: string): t is EngineTool => (ENGINE_TOOLS as readonly string[]).includes(t)
const isCustomTool = (t: string): t is CustomTool => Object.hasOwn(CUSTOM_TOOLS, t)

/**
 * The Excalidraw request for a Lobby tool name. `text` means Lobby's text tool (custom), never
 * Excalidraw's; an engine type Lobby refuses throws ToolRefused.
 */
export function toolRequest(tool: string): ToolRequest {
  if (isCustomTool(tool)) return { type: 'custom', customType: CUSTOM_TOOLS[tool], locked: true }
  if (tool === 'select') return { type: 'selection' }
  if (isEngineTool(tool)) return { type: tool }
  throw new ToolRefused(tool)
}

/**
 * The low-level switch every activation goes through. `type` is an Excalidraw tool type; `text`,
 * `stickynote`, `autoshape` and the other refused types never reach Excalidraw.
 */
export interface ToolOptions {
  /** Commenters, viewers and limited guests (Excalidraw runs with the `interaction` config). */
  readOnly?: boolean
}

export function setEngineTool(api: ToolApi, type: string, opts: ToolOptions = {}): boolean {
  if (REFUSED_ENGINE_TOOLS.has(type) || !isEngineTool(type)) return false
  if (!opts.readOnly) {
    api.setActiveTool({ type })
    return true
  }
  // Finding (spike A4): under the `interaction` config Excalidraw refuses EVERY engine tool, the
  // selection tool included (App.setActiveTool -> isToolSupported, dist/dev/index.js:44343-44350 and
  // :42465-42479: only `laser` and `custom` pass), with a console warning. A read-only viewer who picked
  // Lobby's comment tool could then never get back to plain navigation (a primary-button drag pans only
  // with no capturing tool, :28810-28815). Lobby restores the neutral selection state through appState;
  // every other engine tool stays refused for read-only roles, as Excalidraw decides.
  if (type === 'selection' && api.updateScene) {
    api.updateScene({ appState: { activeTool: { ...SELECTION_TOOL } } })
    return true
  }
  // the laser writes nothing: read-only roles may point (CR-3A-8; READ_ONLY_INTERACTION enables it)
  if (type === 'laser') {
    api.setActiveTool({ type })
    return true
  }
  return false
}

/** CanvasPort.setTool: a Lobby tool name. Returns false (and changes nothing) for a refused name. */
export function setTool(api: ToolApi, tool: string, opts: ToolOptions = {}): boolean {
  let req: ToolRequest
  try {
    req = toolRequest(tool)
  } catch (err) {
    if (err instanceof ToolRefused) return false
    throw err
  }
  if (req.type === 'custom') {
    api.setActiveTool(req)
    return true
  }
  return setEngineTool(api, req.type, opts)
}

/** The Lobby name of the active tool, or null when Excalidraw is on a tool Lobby never activates. */
export function activeLobbyTool(api: ToolApi): LobbyTool | null {
  const t = api.getAppState().activeTool
  if (t.type === 'custom') {
    const entry = Object.entries(CUSTOM_TOOLS).find(([, v]) => v === t.customType)
    return entry ? (entry[0] as CustomTool) : null
  }
  if (t.type === 'selection') return 'select'
  return isEngineTool(t.type) ? (t.type as LobbyTool) : null
}
