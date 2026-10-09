// API schemas for ai-assist (docs/WAVE4-CONTRACTS.md §4). Browser-safe. Owned by the ai-assist owner; for
// wave L, W1 (the AI engine on the api) is its sole owner. Wave L's additions (the foundation commit, before
// any workstream builds on them) are all additive: six new actions, a run id on every result, an optional
// `at` rect on every input, the vote-weighted 'actions' (voteSessionId, AiActionItem.votes) and the
// ephemeral board events AI_EVENTS. Old web builds never send the new actions (LOBBY_CLIENT_REV unchanged).
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

/** The four actions every build since wave 4 knows (old web builds send only these). */
export const AI_LEGACY_ACTIONS = ['summarize', 'themes', 'actions', 'ideas'] as const
/**
 * Wave L (W1): recap (Wrap up, Catch me up), ask (Ask this board), command (plain-language board commands),
 * diagram (Diagram from words), sort (sort by a lens) and score (2x2 placement). The ledger accepts any
 * lowercase action name since migration 0028_ai_actions, so a later action needs no migration.
 */
export const AI_WAVE_L_ACTIONS = ['recap', 'ask', 'command', 'diagram', 'sort', 'score'] as const
export const AI_ACTIONS = [...AI_LEGACY_ACTIONS, ...AI_WAVE_L_ACTIONS] as const
export const AiAction = z.enum(AI_ACTIONS)
export type AiAction = z.infer<typeof AiAction>
export type AiLegacyAction = (typeof AI_LEGACY_ACTIONS)[number]
export type AiWaveLAction = (typeof AI_WAVE_L_ACTIONS)[number]
/**
 * The ledger's action name rule (migration 0028_ai_actions: ai_usage.action CHECK). Every AI_ACTIONS member
 * matches it (contracts test); a new action name must too.
 */
export const AI_LEDGER_ACTION_PATTERN = /^[a-z][a-z_-]{0,31}$/

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

// ---- wave L limits (W1; the api clamps the model's output to these) ------------------------------------

/** Ask this board: the question, in characters after trimming. */
export const AI_ASK_QUESTION_MAX = 300
/** Ask this board: the answer, after cleaning. */
export const AI_ANSWER_MAX_CHARS = 800
/** Ask this board: numbered sources at most, each naming at most AI_CITATION_MAX_IDS items. */
export const AI_CITATIONS_MAX = 8
export const AI_CITATION_MAX_IDS = 5
/** Recap: how far back `since` may reach (older is clamped to this). */
export const AI_RECAP_MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
export const AI_RECAP_TITLE_MAX_CHARS = 80
export const AI_RECAP_SUMMARY_MAX_CHARS = 600
export const AI_RECAP_LINE_MAX_CHARS = 160
export const AI_RECAP_DECISIONS_MAX = 8
export const AI_RECAP_ACTIONS_MAX = 12
export const AI_RECAP_QUESTIONS_MAX = 8
/** Ids one recap line (a decision, an action, a question) may cite. */
export const AI_RECAP_LINE_MAX_IDS = 20
/** Recap's server-made "top voted" list (from revealed tallies, never from the model). */
export const AI_RECAP_TOP_VOTED_MAX = 20
/** Diagram from words: the typed description, in characters after trimming. */
export const AI_DIAGRAM_PROMPT_MAX_CHARS = 500
export const AI_DIAGRAM_MAX_NODES = 40
export const AI_DIAGRAM_MAX_EDGES = 60
export const AI_DIAGRAM_LABEL_MAX_CHARS = 60
export const AI_DIAGRAM_EDGE_LABEL_MAX_CHARS = 24
/** Plain-language board commands: the instruction, in characters after trimming. */
export const AI_COMMAND_INSTRUCTION_MAX = 200
export const AI_COMMAND_MAX_OPS = 12
export const AI_COMMAND_MAX_IDS_PER_OP = 200
export const AI_COMMAND_EXPLAIN_MAX_CHARS = 160
export const AI_COMMAND_TAG_MAX_CHARS = 30
export const AI_COMMAND_FRAME_NAME_MAX_CHARS = 80
/** Sort by a lens: the lens, in characters after trimming. */
export const AI_SORT_LENS_MAX_CHARS = 80
/** 2x2 placement: integer scores on each axis, from AI_SCORE_MIN to AI_SCORE_MAX. */
export const AI_SCORE_MIN = -5
export const AI_SCORE_MAX = 5
export const AI_SCORE_AXIS_NAME_MAX_CHARS = 24
export const AI_SCORE_AXIS_END_MAX_CHARS = 16

/**
 * A run id (wave L, L1-1): `air_` and 20 random base62 characters, minted by the api once per run and
 * returned as AiResult.runId. The client writes it into `customData.lobby.ai.run` (canvas-schema AiValue)
 * for provenance and "Remove this AI result"; the api never stores it (ai_usage keeps counts only).
 */
export const AI_RUN_ID_PATTERN = /^air_[0-9A-Za-z]{20}$/
export const AiRunId = z.string().regex(AI_RUN_ID_PATTERN)
export type AiRunId = z.infer<typeof AiRunId>

/**
 * Where on the board the caller is working (scene units): the selection's bounds, sent with a run so the
 * live "is using AI here" shimmer (AI_EVENTS) can show it. Optional; the api clamps it to canvas-schema's
 * COORD_LIMIT before publishing it, and never reads it for anything else.
 */
export const AiRect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
})
export type AiRect = z.infer<typeof AiRect>
const At = AiRect.optional()

const VoteSessionRef = z.string().regex(/^vot_[0-9A-Za-z]{10,40}$/)

/** Lobby's 13 colour names (board-ops LOBBY_COLOR_NAMES; the contracts test keeps the two lists equal). */
export const AI_COLOR_NAMES = [
  'black',
  'blue',
  'green',
  'grey',
  'light-blue',
  'light-green',
  'light-red',
  'light-violet',
  'orange',
  'red',
  'violet',
  'yellow',
  'white',
] as const
export const AiColorName = z.enum(AI_COLOR_NAMES)
export type AiColorName = z.infer<typeof AiColorName>

const OpIds = z.array(AiShapeId).min(1).max(AI_COMMAND_MAX_IDS_PER_OP)
/**
 * One plain-language board command op (L1-4, L3-3): the closed, non-destructive set the local grammar
 * (web features/ai/command/grammar.ts) and the AI fallback both produce, and the web compiles into one
 * transact. There is no delete, unlock, ungroup or text edit, and no way to name one: an op outside this
 * union is refused (the api's plan drops it). `recolor` takes palette names only.
 */
export const AiCommandOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('select'), ids: OpIds }),
  z.object({ op: z.literal('recolor'), ids: OpIds, color: AiColorName }),
  z.object({
    op: z.literal('setFill'),
    ids: OpIds,
    fill: z.enum(['solid', 'hachure', 'cross-hatch', 'zigzag']),
  }),
  z.object({
    op: z.literal('align'),
    ids: OpIds,
    edge: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
  }),
  z.object({ op: z.literal('distribute'), ids: OpIds, axis: z.enum(['horizontal', 'vertical']) }),
  z.object({ op: z.literal('arrangeGrid'), ids: OpIds }),
  z.object({ op: z.literal('tag'), ids: OpIds, tag: z.string().trim().min(1).max(AI_COMMAND_TAG_MAX_CHARS) }),
  z.object({
    op: z.literal('wrapInFrame'),
    ids: OpIds,
    name: z.string().trim().min(1).max(AI_COMMAND_FRAME_NAME_MAX_CHARS),
  }),
  z.object({ op: z.literal('lock'), ids: OpIds }),
  z.object({ op: z.literal('zoomTo'), ids: OpIds }),
])
export type AiCommandOp = z.infer<typeof AiCommandOp>
export const AI_COMMAND_OP_NAMES = [
  'select',
  'recolor',
  'setFill',
  'align',
  'distribute',
  'arrangeGrid',
  'tag',
  'wrapInFrame',
  'lock',
  'zoomTo',
] as const satisfies readonly AiCommandOp['op'][]
/** The ops a 'find' command may return (view is enough: they only select and move the local camera). */
export const AI_COMMAND_FIND_OPS = ['select', 'zoomTo'] as const satisfies readonly AiCommandOp['op'][]

/** A 2x2 axis (L1-6 score): its name and the words at its low and high ends. */
export const AiScoreAxis = z.object({
  name: z.string().trim().min(1).max(AI_SCORE_AXIS_NAME_MAX_CHARS),
  low: z.string().trim().min(1).max(AI_SCORE_AXIS_END_MAX_CHARS),
  high: z.string().trim().min(1).max(AI_SCORE_AXIS_END_MAX_CHARS),
})
export type AiScoreAxis = z.infer<typeof AiScoreAxis>

/** Recap's window: everything edited since a time (ms since the epoch), or what is inside these shapes. */
export const AiRecapScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('since'), since: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('shapes'), shapeIds: ShapeIds.min(1) }),
])
export type AiRecapScope = z.infer<typeof AiRecapScope>

export const AiRunInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('summarize'),
    shapeIds: ShapeIds.min(1),
    /** 'insert' adds a text block next to the selection (edit); 'panel' only answers (view). */
    mode: z.enum(['insert', 'panel']),
    acknowledged: Acknowledged,
    at: At,
  }),
  z.object({ action: z.literal('themes'), shapeIds: ShapeIds.min(1), acknowledged: Acknowledged, at: At }),
  z.object({
    action: z.literal('actions'),
    shapeIds: ShapeIds.min(1),
    /**
     * Wave L (L1-7): order the items by this revealed vote of the same board (404 for another board's, 409
     * AI_VOTE_NOT_REVEALED before its reveal). Absent: today's 'actions', unchanged.
     */
    voteSessionId: VoteSessionRef.optional(),
    acknowledged: Acknowledged,
    at: At,
  }),
  z.object({
    action: z.literal('ideas'),
    /** Optional context: the selection the ideas go next to. */
    shapeIds: ShapeIds,
    prompt: z.string().trim().min(1).max(AI_PROMPT_MAX_CHARS),
    count: z.number().int().min(AI_IDEAS_MIN).max(AI_IDEAS_MAX),
    acknowledged: Acknowledged,
    at: At,
  }),
  // ---- wave L (W1) ----
  z.object({
    action: z.literal('recap'),
    scope: AiRecapScope,
    /** 'panel' answers privately (view); 'insert' is for "Add as Recap frame" (edit on an active board). */
    mode: z.enum(['insert', 'panel']),
    acknowledged: Acknowledged,
    at: At,
  }),
  z.object({
    action: z.literal('ask'),
    question: z.string().trim().min(1).max(AI_ASK_QUESTION_MAX),
    /** Empty: the whole board. */
    shapeIds: ShapeIds,
    acknowledged: Acknowledged,
    at: At,
  }),
  z.object({
    action: z.literal('command'),
    instruction: z.string().trim().min(1).max(AI_COMMAND_INSTRUCTION_MAX),
    /** 'find' (view) returns only select and zoomTo ops; 'do' (edit) any op of AiCommandOp. */
    mode: z.enum(['find', 'do']),
    /** Empty: the whole board, within the caps. */
    shapeIds: ShapeIds,
    acknowledged: Acknowledged,
    at: At,
  }),
  z
    .object({
      action: z.literal('diagram'),
      /** Selected notes and texts the diagram is made from (the api reads them). */
      shapeIds: ShapeIds,
      prompt: z.string().trim().min(1).max(AI_DIAGRAM_PROMPT_MAX_CHARS).optional(),
      direction: z.enum(['down', 'right']),
      acknowledged: Acknowledged,
      at: At,
    })
    .refine((v) => v.shapeIds.length > 0 || v.prompt !== undefined, {
      message: 'a diagram needs a description or a selection',
      path: ['prompt'],
    }),
  z.object({
    action: z.literal('sort'),
    shapeIds: ShapeIds.min(1),
    lens: z.string().trim().min(1).max(AI_SORT_LENS_MAX_CHARS),
    acknowledged: Acknowledged,
    at: At,
  }),
  z.object({
    action: z.literal('score'),
    shapeIds: ShapeIds.min(1),
    axes: z.tuple([AiScoreAxis, AiScoreAxis]),
    acknowledged: Acknowledged,
    at: At,
  }),
])
export type AiRunInput = z.infer<typeof AiRunInput>
/** A run input of one of the four actions every build knows (the api's handlers of those take this). */
export type AiLegacyRunInput = Extract<AiRunInput, { action: AiLegacyAction }>

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
  /** Wave L (L1-1): this run's id, for provenance (`customData.lobby.ai.run`) and "Remove this AI result". */
  runId: AiRunId,
}

export const AiTheme = z.object({ name: z.string(), noteIds: z.array(AiShapeId) })
export type AiTheme = z.infer<typeof AiTheme>

export const AiActionItem = z.object({
  text: z.string(),
  owner: z.string().nullable(),
  /** Wave L (L1-7): the revealed vote count behind the item, when the run named a voteSessionId. */
  votes: z.number().int().nonnegative().optional(),
})
export type AiActionItem = z.infer<typeof AiActionItem>

/** A recap line (a decision, a question) and the items it comes from. */
export const AiRecapLine = z.object({ text: z.string(), ids: z.array(AiShapeId).max(AI_RECAP_LINE_MAX_IDS) })
export type AiRecapLine = z.infer<typeof AiRecapLine>
export const AiRecapAction = z.object({
  task: z.string(),
  /** Kept only when it appears verbatim in an item that was sent (the api's rule). */
  owner: z.string().nullable(),
  ids: z.array(AiShapeId).max(AI_RECAP_LINE_MAX_IDS),
})
export type AiRecapAction = z.infer<typeof AiRecapAction>
/** One revealed vote result in the recap window, computed by the api from the tallies (ties share a rank). */
export const AiTopVoted = z.object({
  id: AiShapeId,
  votes: z.number().int().positive(),
  rank: z.number().int().positive(),
})
export type AiTopVoted = z.infer<typeof AiTopVoted>
/** One numbered source of an answer: the items `[n]` refers to (n = its place in `citations`, from 1). */
export const AiCitation = z.object({ ids: z.array(AiShapeId).min(1).max(AI_CITATION_MAX_IDS) })
export type AiCitation = z.infer<typeof AiCitation>
export const AI_DIAGRAM_NODE_KINDS = ['process', 'decision', 'terminal', 'io'] as const
export const AiDiagramNodeKind = z.enum(AI_DIAGRAM_NODE_KINDS)
export type AiDiagramNodeKind = z.infer<typeof AiDiagramNodeKind>
/** A diagram node: `id` is the api's own (n1 to n40), never the model's. */
export const AiDiagramNode = z.object({
  id: z.string().regex(/^n[1-9][0-9]{0,2}$/),
  label: z.string().max(AI_DIAGRAM_LABEL_MAX_CHARS),
  kind: AiDiagramNodeKind,
})
export type AiDiagramNode = z.infer<typeof AiDiagramNode>
export const AiDiagramEdge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().max(AI_DIAGRAM_EDGE_LABEL_MAX_CHARS),
})
export type AiDiagramEdge = z.infer<typeof AiDiagramEdge>
/** A note's 2x2 scores; `unscored` when the model left it out (then x = y = 0). */
export const AiScore = z.object({
  id: AiShapeId,
  x: z.number().int().min(AI_SCORE_MIN).max(AI_SCORE_MAX),
  y: z.number().int().min(AI_SCORE_MIN).max(AI_SCORE_MAX),
  unscored: z.literal(true).optional(),
})
export type AiScore = z.infer<typeof AiScore>

/** The result members over the per-call fields `common` (AiResult: Common; AiClientResult: runId optional). */
const aiResultMembers = <C extends z.ZodRawShape>(common: C) =>
  [
    z.object({ action: z.literal('summarize'), summary: z.string(), sources: z.number().int(), ...common }),
    z.object({ action: z.literal('themes'), themes: z.array(AiTheme), ...common }),
    z.object({ action: z.literal('actions'), items: z.array(AiActionItem), ...common }),
    z.object({ action: z.literal('ideas'), ideas: z.array(z.string()), ...common }),
    // ---- wave L (W1) ----
    z.object({
      action: z.literal('recap'),
      title: z.string().max(AI_RECAP_TITLE_MAX_CHARS),
      summary: z.string().max(AI_RECAP_SUMMARY_MAX_CHARS),
      decisions: z.array(AiRecapLine).max(AI_RECAP_DECISIONS_MAX),
      actions: z.array(AiRecapAction).max(AI_RECAP_ACTIONS_MAX),
      questions: z.array(AiRecapLine).max(AI_RECAP_QUESTIONS_MAX),
      topVoted: z.array(AiTopVoted).max(AI_RECAP_TOP_VOTED_MAX),
      /** The window's start as the api applied it (ms since the epoch), or null for a 'shapes' scope. */
      windowFrom: z.number().int().nonnegative().nullable(),
      ...common,
    }),
    z.object({
      action: z.literal('ask'),
      answer: z.string().max(AI_ANSWER_MAX_CHARS),
      /** 'no': the board does not say (the web shows "The board doesn't say"). */
      found: z.enum(['yes', 'partial', 'no']),
      citations: z.array(AiCitation).max(AI_CITATIONS_MAX),
      ...common,
    }),
    z.object({
      action: z.literal('command'),
      mode: z.enum(['find', 'do']),
      ops: z.array(AiCommandOp).max(AI_COMMAND_MAX_OPS),
      explain: z.string().max(AI_COMMAND_EXPLAIN_MAX_CHARS),
      ...common,
    }),
    z.object({
      action: z.literal('diagram'),
      direction: z.enum(['down', 'right']),
      nodes: z.array(AiDiagramNode).max(AI_DIAGRAM_MAX_NODES),
      edges: z.array(AiDiagramEdge).max(AI_DIAGRAM_MAX_EDGES),
      ...common,
    }),
    z.object({ action: z.literal('sort'), lens: z.string(), themes: z.array(AiTheme), ...common }),
    z.object({
      action: z.literal('score'),
      axes: z.tuple([AiScoreAxis, AiScoreAxis]),
      scores: z.array(AiScore),
      ...common,
    }),
  ] as const

export const AiResult = z.discriminatedUnion('action', aiResultMembers(Common))
export type AiResult = z.infer<typeof AiResult>

/**
 * What a web parses an /ai/run answer with (wave L foundation review): AiResult with `runId` optional, so a
 * web on a wave K api still works (the api rolled back with DRAFTROOM_ALLOW_NEWER_SCHEMA while the web stays,
 * or a deploy out of order): a wave K api sends no run id, and a strict parse would fail every AI call. Every
 * other field is AiResult's, and a run id that is sent must still be a valid one. The api's own output stays
 * AiResult (runId required; its tests pin it). A missing run id means "no provenance run": aiCustomData then
 * writes `lobby.ai` without `run`, as before wave L. Only the four legacy actions can come back without one
 * (a wave K api refuses the wave L actions with 400).
 */
export const AiClientResult = z.discriminatedUnion(
  'action',
  aiResultMembers({ ...Common, runId: AiRunId.optional() }),
)
export type AiClientResult = z.infer<typeof AiClientResult>

// ---- live AI awareness (wave L, L1-1 / L2-1e): ephemeral board events, never stored ---------------------
//
// Published on the board event hub (GET /api/boards/:bid/events) by the api's run(): `ai.working` once the
// gate passed and the ledger reserved the call, `ai.done` after it settled (success or failure); neither for
// a refused call. The payloads carry no board content, prompt or answer: the run id, the board display name
// already shown to everyone, the action and where (the clamped `at`, or null). Old web builds ignore
// unknown event types (K6-5's throw-safe listeners); a new field an old parse does not know is stripped.

export const AI_EVENTS = { working: 'ai.working', done: 'ai.done' } as const
export const AiWorkingEvent = z.object({
  runId: AiRunId,
  /** The runner's board display name (what presence already shows). */
  name: z.string().max(200),
  action: AiAction,
  rect: AiRect.nullable(),
})
export type AiWorkingEvent = z.infer<typeof AiWorkingEvent>
export const AiDoneEvent = z.object({ runId: AiRunId })
export type AiDoneEvent = z.infer<typeof AiDoneEvent>
/** A client clears a shimmer whose `ai.done` never came after this long (L2-1e). */
export const AI_WORKING_TTL_MS = 30_000

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
  /** Wave L (L1-7): 'actions' named a vote that is not revealed yet (409). */
  voteNotRevealed: 'AI_VOTE_NOT_REVEALED',
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
