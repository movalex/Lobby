// OWNER: WS1 (wave R, import from Miro). The dialog's words and its state, as pure functions (tested in Node: the web
// package renders components to markup, it has no DOM): the token help, the error messages, the progress line of a
// board, the report's sentence, its per-type table and its notes, and the dialog's reducer.
//
// Every Miro string (a team or board name) is data: the dialog renders it as React text, never as HTML.
import {
  IMPORT_CONCURRENCY,
  IMPORT_FINISHED_STATUSES,
  IMPORT_RESUMABLE_STATUSES,
  type ImportBoardReport,
  type ImportBoardView,
  type ImportItemResult,
  type ImportJobView,
  type ListMiroBoardsResponse,
  MIRO_CODE_MESSAGES,
  MIRO_IMPORT_LIMITS,
  MIRO_TOKEN_PATTERN,
  type MiroBoardSummary,
  parseMiroBoardLink,
  type StartMiroImportInput,
} from '@draftroom/contracts'

// ---- fixed words -------------------------------------------------------------------------------------------------

/**
 * "How to get a token". UNVERIFIED until the owner's probe (scripts/miro-probe.mjs) confirms whether a personal token
 * reaches the team's boards without a Miro admin's install: change the words here only.
 */
export const MIRO_TOKEN_HELP = {
  summary: 'How to get a token (2 minutes)',
  steps: [
    'In Miro, open your avatar → Settings → Your apps → + Create new app. Name it “Lobby import”, pick your developer team, leave “Expire user authorization token” unticked, and click Create app.',
    'Under Permissions, tick boards:read (only that).',
    'Click Install app and get OAuth token, choose the team that holds your boards, then Install & authorize, and copy the token.',
    'Paste it here. Lobby uses it only for this import; it is never saved.',
  ],
  teamNote:
    'A token reaches only the boards of the team you installed the app in. If your boards are in another team, a Miro team admin may need to install the app there.',
} as const

export const MIRO_REPORT_LINES = {
  comments: 'Comments stay in Miro: Miro’s API does not return them.',
  notReturned:
    'Miro’s API does not return pen drawings, stickers, emoji, code blocks, mockups or kanban boards, so they are not on the new board.',
  revoke: 'Done? Revoke the token in Miro: Settings → Your apps → (your app) → uninstall.',
  interrupted: 'Lobby restarted while this import ran. Paste the token again to go on.',
} as const

/** The report's notes (the converter's codes, packages/miro-import) in words; an unknown note shows its code. */
export const MIRO_NOTE_LABELS: Readonly<Record<string, string>> = {
  'color-substituted': 'Colours matched to Lobby’s palette',
  'font-substituted': 'Fonts replaced',
  'text-formatting-lost': 'Bold, italics and links in text dropped',
  'text-truncated': 'Long texts shortened',
  'shape-approximated': 'Shapes drawn as rectangles',
  'shape-polygon': 'Shapes drawn as outlines',
  'frame-nested': 'Frames inside frames drawn as boxes',
  'frame-fill-dropped': 'Frame fills dropped',
  'connector-curved': 'Curved connectors drawn as curves (approximate)',
  'connector-unsupported': 'Connectors Miro could not describe drawn straight',
  'connector-end-unbound': 'Connector ends left unattached',
  'connector-caption-extra': 'Extra connector captions dropped',
  'connector-cap-approximated': 'Arrowheads approximated',
  'file-not-imported-yet': 'Images and documents: not imported yet (shown as placeholders)',
  'file-host-refused': 'Files from an unexpected address refused',
  'file-failed': 'Files that could not be downloaded',
  'file-too-large': 'Files over the size limit',
  'card-as-shape': 'Cards drawn as boxes',
  'app-card-as-shape': 'App cards drawn as boxes',
  'embed-as-link': 'Embeds turned into links',
  'table-not-imported': 'Tables not imported (placeholders)',
  'doc-not-imported': 'Docs not imported (placeholders)',
  'preview-not-imported': 'Link previews not imported (placeholders)',
  'unknown-type': 'Items of an unknown kind (placeholders)',
  'no-geometry': 'Items without a position (placed in a frame)',
  'group-dropped': 'Groups that could not be kept',
  'tag-dropped': 'Tags over the limit dropped',
  'tag-color-substituted': 'Tag colours matched',
  'link-dropped': 'Links that could not be kept',
  'position-clamped': 'Items moved inside the canvas',
  'element-invalid': 'Items Lobby could not store',
  'over-limit': 'Items over the board’s limits skipped',
}

/** Miro's item types in words (the report's per-type table); an unknown key shows as it is. */
export const MIRO_TYPE_LABELS: Readonly<Record<string, string>> = {
  sticky_note: 'Sticky notes',
  shape: 'Shapes',
  text: 'Texts',
  frame: 'Frames',
  connector: 'Connectors',
  image: 'Images',
  document: 'Documents',
  card: 'Cards',
  app_card: 'App cards',
  embed: 'Embeds',
  preview: 'Previews',
  doc_format: 'Docs',
  data_table_format: 'Tables',
  unknown: 'Other items',
  group: 'Groups',
  tag: 'Tags',
}

/** The words for a key of a table (never a property of Object's prototype), or undefined. */
const lookup = (table: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined
export const noteLabel = (code: string): string => lookup(MIRO_NOTE_LABELS, code) ?? code
export const typeLabel = (type: string): string => lookup(MIRO_TYPE_LABELS, type) ?? type

// ---- errors ------------------------------------------------------------------------------------------------------

const n = (x: number) => x.toLocaleString('en-US')

const IMPORT_MESSAGES: Readonly<Record<string, string>> = {
  IMPORT_BUSY:
    'Another import is running (yours, or as many as this workspace allows). Try again when it has finished.',
  IMPORT_DAILY_LIMIT: `You started ${IMPORT_CONCURRENCY.startsPerPersonPerDay} imports today, the daily limit. Try again tomorrow.`,
  IMPORT_TOO_LARGE: `That is more than Lobby imports at once: at most ${n(MIRO_IMPORT_LIMITS.itemsPerBoard)} items, ${n(MIRO_IMPORT_LIMITS.connectorsPerBoard)} connectors and ${n(MIRO_IMPORT_LIMITS.filesPerBoard)} files per board, and ${MIRO_IMPORT_LIMITS.boardsPerJob} boards per import.`,
  QUOTA_EXCEEDED: 'This workspace’s storage is full, so the files could not be kept.',
  IMPORT_WRONG_STATE: 'The import has already moved on; what you see below is up to date.',
  CREATOR_REQUIRED: 'Only people who can create boards in this workspace can import boards.',
  FORBIDDEN: 'You don’t have permission to import boards here.',
  NOT_FOUND: 'That import is not there any more, or importing is not available on this server.',
  IMPORT_SEED_FAILED: 'Lobby could not build a board from this content.',
  IMPORT_INTERRUPTED: 'Lobby restarted while this board was importing.',
  IMPORT_CANCELLED: 'Cancelled: this board was not imported.',
  IMPORT_EXPIRED: 'This import waited more than a day and was removed. Start it again.',
  IMPORT_SECRET_REQUIRED: 'Paste the Miro token again to go on.',
  INTERNAL: 'Something went wrong in Lobby while importing this board.',
  unavailable: 'Importing from Miro is not available right now. Check your connection and try again.',
}
export const MIRO_FALLBACK_MESSAGE = 'That did not work. Try again in a moment.'

/** What to tell the person about an error code (the api's, a board's, or 'unavailable'). Never the token. */
export function miroErrorMessage(code: string | null | undefined): string {
  if (!code) return MIRO_FALLBACK_MESSAGE
  return lookup(MIRO_CODE_MESSAGES, code) ?? lookup(IMPORT_MESSAGES, code) ?? MIRO_FALLBACK_MESSAGE
}

/** A pasted token, trimmed, if it can be one (the api checks it again); never echoed. */
export function cleanToken(raw: string): string | null {
  const t = raw.trim()
  return MIRO_TOKEN_PATTERN.test(t) ? t : null
}

// ---- jobs and progress -------------------------------------------------------------------------------------------

export const isFinished = (status: ImportJobView['status']) => IMPORT_FINISHED_STATUSES.includes(status)
export const isWaiting = (status: ImportJobView['status']) => IMPORT_RESUMABLE_STATUSES.includes(status)
/** The dialog stops polling once a job has finished or waits for its starter (paused, interrupted). */
export const stopsPolling = (job: ImportJobView) => isFinished(job.status) || isWaiting(job.status)

/** The person's own Miro job to show when the dialog opens (the newest unfinished one), if any. */
export function unfinishedMiroJob(jobs: readonly ImportJobView[]): ImportJobView | null {
  return jobs.find((j) => j.source === 'miro' && !isFinished(j.status)) ?? null
}

const of = (done: number, total: number | null) => (total === null ? n(done) : `${n(done)}/${n(total)}`)

/** A board's line under its title: "Reading items 1,200/2,000", "Images and documents 37/120", "Imported". */
export function phaseLine(board: ImportBoardView): string {
  switch (board.status) {
    case 'done':
      return 'Imported'
    case 'failed':
      return `Not imported: ${miroErrorMessage(board.errorCode)}`
    case 'cancelled':
      return 'Cancelled'
    case 'paused':
      return 'Paused'
    case 'interrupted':
      return 'Stopped: Lobby restarted'
    case 'queued':
      return 'Waiting'
    case 'running':
      break
  }
  const p = board.progress
  switch (p.phase) {
    case 'queued':
      return 'Waiting'
    case 'validating':
      return 'Checking the token'
    case 'reading':
      return `Reading items ${of(p.items.read, p.items.total)}`
    case 'files': {
      const failed = p.files.failed > 0 ? `, ${n(p.files.failed)} failed` : ''
      return `Images and documents ${of(p.files.done, p.files.total)}${failed}`
    }
    case 'converting':
      return 'Building the board'
    case 'activating':
    case 'finished':
      return 'Finishing'
    case 'cleaning':
      return 'Cleaning up'
  }
}

/** A phase without its numbers: what the live region announces (so it speaks at phase changes, not every tick). */
function phaseWord(board: ImportBoardView): string {
  if (board.status !== 'running') return phaseLine(board)
  switch (board.progress.phase) {
    case 'reading':
      return 'Reading items'
    case 'files':
      return 'Images and documents'
    default:
      return phaseLine(board)
  }
}

/** The live region's words for a job: the board being worked on and its phase, or how the job ended. */
export function progressAnnouncement(job: ImportJobView | null): string {
  if (!job) return 'Starting the import'
  const count = job.boards.length
  if (isFinished(job.status)) {
    const done = job.boards.filter((b) => b.status === 'done').length
    return `Import finished: ${done} of ${count} ${count === 1 ? 'board' : 'boards'} imported`
  }
  if (job.status === 'paused') return 'Import paused'
  if (job.status === 'interrupted') return 'Import stopped: Lobby restarted'
  const at = job.boards.findIndex((b) => b.status === 'running')
  const i = at >= 0 ? at : job.boards.findIndex((b) => b.status === 'queued')
  const board = job.boards[i]
  if (!board) return 'Importing'
  return `Board ${i + 1} of ${count}, ${board.title}: ${phaseWord(board)}`
}

// ---- the report --------------------------------------------------------------------------------------------------

type Summary = Omit<ImportBoardReport, 'rows'>
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`

/** The share of `part` in `total`, one decimal, never rounded up to 100 % ("95.6 %"). */
export function percent(part: number, total: number): string {
  if (total <= 0) return '0.0 %'
  const tenths = Math.floor((part * 1000) / total)
  return `${(tenths / 10).toFixed(1)} %`
}

/** "1,912 of 2,000 items imported as native elements (95.6 %), 60 approximated, 28 placeholders, 0 failed". */
export function summarySentence(s: Summary): string {
  const c = s.counts
  if (s.total === 0) return 'Miro returned no items for this board.'
  const items = s.total === 1 ? 'item' : 'items'
  const parts = [
    `${n(c.native)} of ${n(s.total)} ${items} imported as native elements (${percent(c.native, s.total)})`,
    `${n(c.approximate)} approximated`,
    plural(c.placeholder, 'placeholder', 'placeholders'),
    `${n(c.failed)} failed`,
  ]
  if (c.skipped > 0) parts.push(`${n(c.skipped)} skipped`)
  return parts.join(', ')
}

export interface TypeRow {
  type: string
  label: string
  counts: Record<ImportItemResult, number>
  total: number
}

/** The per-type table, most items first (ties by label). */
export function typeRows(s: Summary): TypeRow[] {
  const rows = Object.entries(s.byType).map(([type, by]) => {
    const counts: Record<ImportItemResult, number> = {
      native: by.native ?? 0,
      approximate: by.approximate ?? 0,
      placeholder: by.placeholder ?? 0,
      failed: by.failed ?? 0,
      skipped: by.skipped ?? 0,
    }
    const total = counts.native + counts.approximate + counts.placeholder + counts.failed + counts.skipped
    return { type, label: typeLabel(type), counts, total }
  })
  return rows.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
}

/** The notes, most frequent first; a note that never happened is left out. */
export function noteRows(s: Summary): { code: string; label: string; count: number }[] {
  return Object.entries(s.notes)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({ code, label: noteLabel(code), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export const formatCount = n

/** "Modified Oct 3, 2026" (the viewer's locale), or '' for a missing or unreadable date. */
export function modifiedLine(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return `Modified ${d.toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

// ---- the dialog's state ------------------------------------------------------------------------------------------

/** A board the person picked: from the list (with its name) or from a pasted link (its name unknown: null). */
export interface PickedBoard {
  id: string
  name: string | null
}

export type MiroStep = 'checking' | 'token' | 'pick' | 'job'

export interface MiroState {
  step: MiroStep
  /** the pasted token: this dialog's memory only (never stored, never in a URL, never logged) */
  token: string
  busy: boolean
  error: string | null
  team: string | null
  boards: MiroBoardSummary[]
  total: number
  query: string
  picked: PickedBoard[]
  /** titles the person typed, by Miro board id */
  titles: Record<string, string>
  projectId: string
  link: string
  linkError: string | null
  importId: string | null
  job: ImportJobView | null
  /** the token pasted again to resume (prefilled with the one still in memory) */
  resumeToken: string
}

export function initialMiroState(projectId: string | null): MiroState {
  return {
    step: 'checking',
    token: '',
    busy: false,
    error: null,
    team: null,
    boards: [],
    total: 0,
    query: '',
    picked: [],
    titles: {},
    projectId: projectId ?? '',
    link: '',
    linkError: null,
    importId: null,
    job: null,
    resumeToken: '',
  }
}

export type MiroAction =
  | { type: 'checked'; job: ImportJobView | null }
  | { type: 'token'; value: string }
  | { type: 'busy' }
  | { type: 'failed'; code: string }
  | { type: 'boards'; answer: ListMiroBoardsResponse; append: boolean }
  | { type: 'query'; value: string }
  | { type: 'toggle'; board: PickedBoard }
  | { type: 'unpick'; id: string }
  | { type: 'title'; id: string; value: string }
  | { type: 'project'; value: string }
  | { type: 'link'; value: string }
  | { type: 'add-link' }
  | { type: 'started'; importId: string }
  | { type: 'job'; job: ImportJobView }
  | { type: 'resume-token'; value: string }
  | { type: 'change-token' }

export const LINK_MESSAGES = {
  invalid: 'That is not a Miro board link. Copy it from the board’s address bar or its Share menu.',
  full: `At most ${MIRO_IMPORT_LIMITS.boardsPerJob} boards per import.`,
} as const

const full = (s: MiroState) => s.picked.length >= MIRO_IMPORT_LIMITS.boardsPerJob

export function miroReducer(s: MiroState, a: MiroAction): MiroState {
  switch (a.type) {
    case 'checked':
      return a.job
        ? { ...s, step: 'job', importId: a.job.importId, job: a.job }
        : { ...s, step: s.step === 'checking' ? 'token' : s.step }
    case 'token':
      return { ...s, token: a.value, error: null }
    case 'busy':
      return { ...s, busy: true, error: null }
    case 'failed':
      return { ...s, busy: false, error: miroErrorMessage(a.code) }
    case 'boards': {
      const known = new Set(a.append ? s.boards.map((b) => b.id) : [])
      const more = a.answer.boards.filter((b) => !known.has(b.id))
      return {
        ...s,
        step: 'pick',
        busy: false,
        error: null,
        team: a.answer.team.name,
        boards: a.append ? [...s.boards, ...more] : a.answer.boards,
        total: a.answer.total,
      }
    }
    case 'query':
      return { ...s, query: a.value }
    case 'toggle': {
      if (s.picked.some((p) => p.id === a.board.id)) return miroReducer(s, { type: 'unpick', id: a.board.id })
      if (full(s)) return s
      return { ...s, picked: [...s.picked, a.board] }
    }
    case 'unpick': {
      const { [a.id]: _gone, ...titles } = s.titles
      return { ...s, picked: s.picked.filter((p) => p.id !== a.id), titles }
    }
    case 'title':
      return { ...s, titles: { ...s.titles, [a.id]: a.value.slice(0, MIRO_IMPORT_LIMITS.titleChars) } }
    case 'project':
      return { ...s, projectId: a.value }
    case 'link':
      return { ...s, link: a.value, linkError: null }
    case 'add-link': {
      const id = parseMiroBoardLink(s.link)
      if (!id) return { ...s, linkError: LINK_MESSAGES.invalid }
      if (s.picked.some((p) => p.id === id)) return { ...s, link: '', linkError: null }
      if (full(s)) return { ...s, linkError: LINK_MESSAGES.full }
      const listed = s.boards.find((b) => b.id === id)
      return { ...s, link: '', linkError: null, picked: [...s.picked, { id, name: listed?.name ?? null }] }
    }
    case 'started':
      return { ...s, step: 'job', busy: false, error: null, importId: a.importId, resumeToken: s.token }
    case 'job':
      return { ...s, step: 'job', busy: false, importId: a.job.importId, job: a.job }
    case 'resume-token':
      return { ...s, resumeToken: a.value, error: null }
    case 'change-token':
      return { ...s, step: 'token', error: null }
  }
}

/** The title to send for a picked board: only one the person changed (trimmed, not empty, not Miro's own). */
export function titleToSend(board: PickedBoard, typed: string | undefined): string | undefined {
  if (typed === undefined) return undefined
  const t = typed.trim().slice(0, MIRO_IMPORT_LIMITS.titleChars)
  if (!t || t === (board.name ?? '').trim()) return undefined
  return t
}

/** The start request's body (without the token, which the client adds). */
export function startInput(s: MiroState): StartMiroImportInput {
  const boards = s.picked.map((p) => {
    const title = titleToSend(p, s.titles[p.id])
    return title === undefined ? { miroBoardId: p.id } : { miroBoardId: p.id, title }
  })
  return s.projectId ? { boards, projectId: s.projectId } : { boards }
}

/** The value of a picked board's title field: what the person typed, else Miro's name. */
export const titleValue = (s: MiroState, p: PickedBoard): string => s.titles[p.id] ?? p.name ?? ''

export const startLabel = (count: number) => `Import ${count} ${count === 1 ? 'board' : 'boards'}`

/** "Board uXjVOD1Ab2c=" for a pasted board whose name the list did not show. */
export const pickedName = (p: PickedBoard) => (p.name?.trim() ? p.name : `Board ${p.id}`)
