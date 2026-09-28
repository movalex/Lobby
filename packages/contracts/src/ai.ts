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

/** Why AI is not offered to this person on this board (the web hides the feature for every reason). */
export const AI_OFF_REASONS = ['not-configured', 'turned-off', 'guest', 'export-policy'] as const
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
