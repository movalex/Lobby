// API schemas for ai-assist (docs/WAVE4-CONTRACTS.md §4). Browser-safe. Owned by the ai-assist owner.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// Routes (apps/api/src/features/ai):
//   GET  /api/boards/:bid/ai       → AiStatus (view; 404 for anyone who cannot view the board)
//   POST /api/boards/:bid/ai/run   AiRunInput → AiResult
//
// The api never trusts client-sent board text: a request names shape ids only (frames and groups stand
// for what is inside them), and the api reads those records itself from the board's sync snapshot. The
// ideas prompt is the one piece of text the caller types, and it is capped. What comes back is a plan
// the client applies as ordinary canvas edits (one undo step, synced like any edit). Everything the
// model wrote is validated and clamped first: lengths, counts, and ids (only ids the api sent).
//
// Who may use AI (the api decides; the web only follows AiStatus):
// - people with an account only: a name-only guest never triggers a paid call (403
//   GUEST_ACCOUNT_REQUIRED; AiStatus says 'guest');
// - adding results to the board needs edit on an active board; "Summarize" into a panel needs view;
// - on a board whose export policy is 'editors', the people it limits get no AI at all (AI reads the
//   content out): 403 AI_EXPORT_DISABLED, AiStatus 'export-policy'.
// - the board owner can turn AI off for a board, and workspace owners and admins for their workspace
//   (a default each board may override): 403 AI_BOARD_OFF, AiStatus 'board-off'.
// Hard cost limits (the OpenAI key has no provider-side cap), all server-side and in the usage ledger:
// input and output tokens per call, calls per person per hour, tokens per person, per workspace and
// for the whole of Lobby per UTC day, and a global kill switch (DRAFTROOM_AI=off).

import { z } from 'zod'

export const AI_ACTIONS = ['summarize', 'themes', 'actions', 'ideas'] as const
export const AiAction = z.enum(AI_ACTIONS)
export type AiAction = z.infer<typeof AiAction>

/** Shape ids one request may name (a frame or group counts once; the api reads what is inside). */
export const AI_MAX_REQUEST_SHAPES = 200
/** The "Generate ideas" prompt, in characters after trimming. */
export const AI_PROMPT_MAX_CHARS = 200
export const AI_IDEAS_MIN = 1
export const AI_IDEAS_MAX = 12
export const AI_IDEAS_DEFAULT = 6
/** What an answer can hold at most: the api clamps the model's output to these. */
export const AI_SUMMARY_MAX_CHARS = 1_200
export const AI_THEMES_MAX = 8
export const AI_THEME_NAME_MAX_CHARS = 40
export const AI_ACTION_ITEMS_MAX = 12
export const AI_ITEM_MAX_CHARS = 160
export const AI_OWNER_MAX_CHARS = 40
/** Sticky notes one "Group into themes" call arranges (more stay where they are; `truncated` says so). */
export const AI_THEMES_MAX_NOTES = 150
/** The name of the theme that collects notes the model did not place. */
export const AI_OTHER_THEME = 'Other'

/**
 * A tldraw shape id as the canvas stores it: `shape:` and printable ASCII (tldraw's own ids are
 * nanoids; templates use readable ones). Only ever used to look records up.
 */
export const AI_SHAPE_ID_PATTERN = /^shape:[\x21-\x7e]{1,200}$/
export const AiShapeId = z.string().regex(AI_SHAPE_ID_PATTERN)

const ShapeIds = z.array(AiShapeId).max(AI_MAX_REQUEST_SHAPES)
/** True once the caller has shown the "Sends the selected text to OpenAI" notice and the person agreed. */
const Acknowledged = z.boolean().optional()

export const AiRunInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('summarize'),
    shapeIds: ShapeIds.min(1),
    /** 'insert' adds a text block next to the selection (edit); 'panel' only answers (view). */
    mode: z.enum(['insert', 'panel']),
    acknowledged: Acknowledged,
  }),
  z.object({ action: z.literal('themes'), shapeIds: ShapeIds.min(1), acknowledged: Acknowledged }),
  z.object({ action: z.literal('actions'), shapeIds: ShapeIds.min(1), acknowledged: Acknowledged }),
  z.object({
    action: z.literal('ideas'),
    /** Optional context: the selection the ideas go next to. */
    shapeIds: ShapeIds,
    prompt: z.string().trim().min(1).max(AI_PROMPT_MAX_CHARS),
    count: z.number().int().min(AI_IDEAS_MIN).max(AI_IDEAS_MAX),
    acknowledged: Acknowledged,
  }),
])
export type AiRunInput = z.infer<typeof AiRunInput>

/**
 * Why AI is not offered to this person on this board (the web hides the feature for every reason).
 * 'board-off': the board owner turned AI off for this board, or it follows a workspace default of off.
 */
export const AI_OFF_REASONS = ['not-configured', 'turned-off', 'guest', 'export-policy', 'board-off'] as const
export const AiOffReason = z.enum(AI_OFF_REASONS)
export type AiOffReason = z.infer<typeof AiOffReason>

/** The workspace's AI budget for the current UTC day. Shown to workspace owners only. */
export const AiBudget = z.object({
  /** 0–100, rounded down (100 = nothing left). */
  usedPercent: z.number().int().min(0).max(100),
  /** The next UTC midnight (ISO). */
  resetsAt: z.string(),
})
export type AiBudget = z.infer<typeof AiBudget>

/**
 * AI on or off for one board (reviewer finding DANA-04): the board's own choice, else the workspace
 * default, else on. Board owners (workspace owners and admins included) set the board; workspace owners
 * and admins set the default. The api refuses every AI call on a board where it is off.
 */
export const AiSettings = z.object({
  /** The board's own choice, or null when it follows the workspace default. */
  board: z.boolean().nullable(),
  /** The default for the workspace's boards without their own choice. */
  workspaceDefault: z.boolean(),
  /** Whether AI is on for this board (board ?? workspaceDefault). */
  on: z.boolean(),
  /** The caller may change the board's choice. */
  canManageBoard: z.boolean(),
  /** The caller may change the workspace default. */
  canManageWorkspace: z.boolean(),
})
export type AiSettings = z.infer<typeof AiSettings>

/** PUT /api/boards/:bid/ai/settings (board owners): on, off, or null to follow the workspace default. */
export const PutAiBoardSettingsInput = z.object({ enabled: z.boolean().nullable() }).strict()
export type PutAiBoardSettingsInput = z.infer<typeof PutAiBoardSettingsInput>
/** PUT /api/workspaces/:wid/ai/settings (workspace owners and admins): the default for its boards. */
export const PutAiWorkspaceSettingsInput = z.object({ enabled: z.boolean() }).strict()
export type PutAiWorkspaceSettingsInput = z.infer<typeof PutAiWorkspaceSettingsInput>
/** Board event after the board's choice or its workspace default changed: a hint to re-read AiStatus. */
export const AI_SETTINGS_EVENT = 'ai.settings'

export const AiStatus = z.object({
  enabled: z.boolean(),
  /** Null when enabled. */
  reason: AiOffReason.nullable(),
  /** Summarize into the board, Group into themes, Action items, Generate ideas. */
  canInsert: z.boolean(),
  /** Summarize into a panel (everyone who may use AI on the board). */
  canSummarize: z.boolean(),
  /** The person has acknowledged "Sends the selected text to OpenAI" in this workspace. */
  noticeAccepted: z.boolean(),
  /** Workspace owners only; null for everyone else. */
  budget: AiBudget.nullable(),
  /**
   * AI on/off for this board, for everyone with an account who may view it (so its owners can turn it
   * back on). Null when AI is not configured or switched off for all of Lobby, and for name-only guests.
   */
  settings: AiSettings.nullable(),
})
export type AiStatus = z.infer<typeof AiStatus>

const Common = {
  /** Board text was left out to stay under the input cap (the answer covers the rest only). */
  truncated: z.boolean(),
  /** The workspace budget after this call: workspace owners only, null for everyone else. */
  budget: AiBudget.nullable(),
}

export const AiTheme = z.object({ name: z.string(), noteIds: z.array(AiShapeId) })
export type AiTheme = z.infer<typeof AiTheme>

export const AiActionItem = z.object({ text: z.string(), owner: z.string().nullable() })
export type AiActionItem = z.infer<typeof AiActionItem>

export const AiResult = z.discriminatedUnion('action', [
  z.object({ action: z.literal('summarize'), summary: z.string(), sources: z.number().int(), ...Common }),
  z.object({ action: z.literal('themes'), themes: z.array(AiTheme), ...Common }),
  z.object({ action: z.literal('actions'), items: z.array(AiActionItem), ...Common }),
  z.object({ action: z.literal('ideas'), ideas: z.array(z.string()), ...Common }),
])
export type AiResult = z.infer<typeof AiResult>

/** Error codes of the AI routes (the messages are user-safe and shown as they are). */
export const AI_ERROR_CODES = {
  notConfigured: 'AI_NOT_CONFIGURED',
  turnedOff: 'AI_TURNED_OFF',
  exportDisabled: 'AI_EXPORT_DISABLED',
  boardOff: 'AI_BOARD_OFF',
  noticeRequired: 'AI_NOTICE_REQUIRED',
  nothingToSend: 'AI_NOTHING_TO_SEND',
  nothingToGroup: 'AI_NOTHING_TO_GROUP',
  rateLimited: 'AI_RATE_LIMITED',
  busy: 'AI_BUSY',
  userBudget: 'AI_USER_BUDGET',
  workspaceBudget: 'AI_BUDGET_EXHAUSTED',
  globalBudget: 'AI_GLOBAL_BUDGET',
  unavailable: 'AI_UNAVAILABLE',
  upstream: 'AI_UPSTREAM',
  badOutput: 'AI_BAD_OUTPUT',
  refused: 'AI_REFUSED',
} as const

// ---- Which sticky notes "Group into themes" moves (reviewer findings R9, DANA-10) ------------------------
//
// A board's own prompts are not ideas: the orange "What slowed us down?" notes a template puts at the
// top of a retro column, or an instruction note, stay where they are. The api (which decides what is
// sent) and the web (which counts notes for the menu) apply the same rule:
// - a note whose meta has AI_PROMPT_META_KEY set is a prompt, always;
// - the team's own notes are the ones someone typed (tldraw's `textLastEditedBy` names them), revealed
//   private-brainstorm notes (`meta.drPrivateNote`) and notes AI added (`meta.drAi`);
// - any other note (placed by a template: unattributed and unmarked) counts as a prompt only while the
//   same selection holds at least two of the team's own notes, so a board of sample notes (the Lobby
//   tour's Brainstorm) still groups as a whole.

/** Meta key a template (or anyone) may set on a note that is a prompt or an instruction, not an idea. */
export const AI_PROMPT_META_KEY = 'draftroomPrompt'

export interface AiNoteFacts {
  /** The note's meta (any shape; only a few keys are looked at). */
  meta: unknown
  /** tldraw 5.4.2 `props.textLastEditedBy`: who last typed the note's text, if anyone. */
  textLastEditedBy: unknown
}

const metaRecord = (f: AiNoteFacts) =>
  typeof f.meta === 'object' && f.meta !== null ? (f.meta as Record<string, unknown>) : {}
const isObj = (v: unknown) => typeof v === 'object' && v !== null

/** Marked as a prompt or an instruction. */
export function isMarkedPrompt(f: AiNoteFacts): boolean {
  const v = metaRecord(f)[AI_PROMPT_META_KEY]
  return v !== undefined && v !== null && v !== false && v !== ''
}

/** Typed by someone, revealed from a private brainstorm, or added by AI (and not marked a prompt). */
export function isTeamNote(f: AiNoteFacts): boolean {
  if (isMarkedPrompt(f)) return false
  if (typeof f.textLastEditedBy === 'string' && f.textLastEditedBy !== '') return true
  const m = metaRecord(f)
  return isObj(m.drPrivateNote) || isObj(m.drAi)
}

/** Splits candidate notes into the ideas to group and the prompts that stay where they are. */
export function splitThemeNotes<T>(
  notes: readonly T[],
  facts: (n: T) => AiNoteFacts,
): { ideas: T[]; prompts: T[] } {
  const marked = notes.filter((n) => isMarkedPrompt(facts(n)))
  const rest = notes.filter((n) => !isMarkedPrompt(facts(n)))
  const team = rest.filter((n) => isTeamNote(facts(n)))
  if (team.length >= 2 && team.length < rest.length)
    return { ideas: team, prompts: [...marked, ...rest.filter((n) => !isTeamNote(facts(n)))] }
  return { ideas: rest, prompts: marked }
}
