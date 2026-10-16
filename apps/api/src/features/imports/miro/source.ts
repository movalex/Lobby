// The 'miro' import source (wave R, WS1; docs/WAVE-R-CONTRACTS.md §2.3, §3): one Miro board of a job, run by the
// import runner (../runner.ts) on the invisible importing board it made:
//   validating  the board is visible to the token (GET /v2/boards/{id})
//   reading     its items, connectors and groups (cursor pages), tags and the items of each tag, and the members a
//               card names (offset pages); over MIRO_IMPORT_LIMITS (items, connectors) the board fails IMPORT_TOO_LARGE
//   files       each image and document becomes a version of the board (./files.ts), deduplicated by resource, at
//               most IMPORT_CONCURRENCY.fileStreamsPerJob at once; until files are on (MIRO_DOWNLOAD_HOSTS, or the
//               local-dev seam's files origin) none is asked for: each is `file-not-imported-yet`
//   converting  sync converts and stores it (POST /internal/boards/:bid/seed, `miro-v2`) and answers with the report
// The runner activates the board after, or discards it with its files. `step.checkpoint()` runs before every
// request (the client's own), between pages and between files. The token is `step.secrets[0]` (it was never stored:
// a resume asks for it again); errors are codes only (MiroError → ImportFailure). Nothing here logs.
import {
  IMPORT_CODES,
  IMPORT_CONCURRENCY,
  ImportBoardReport,
  MIRO_API_ORIGIN,
  MIRO_BOARD_ID_PATTERN,
  MIRO_CODES,
  MIRO_DOWNLOAD_HOSTS,
  MIRO_IMPORT_LIMITS,
} from '@draftroom/contracts'
import {
  fileRefOf,
  isRecord,
  MIRO_SEED_FORMAT,
  type MiroConnector,
  type MiroFileOutcome,
  type MiroFileRef,
  type MiroGroup,
  type MiroItem,
  type MiroSeedBody,
  type MiroTag,
  slimConnector,
  slimGroup,
  slimItem,
  slimTag,
} from '@draftroom/miro-import/sources'
import {
  type EgressDeps,
  egressDeps,
  MIRO_EGRESS_USER_AGENT,
  miroEgressPolicy,
  type RedactedSecret,
} from '../../../egress/index.ts'
import { SyncSeedConflict, SyncUnavailable } from '../../../sync-internal.ts'
import type { FeatureContext } from '../../context.ts'
import { ImportFailure, type ImportSourceRunner, type ImportStep } from '../runner.ts'
import { MiroClient, MiroError } from './client.ts'
import { type FileBudget, storeMiroFile } from './files.ts'

/** How a Miro import reaches Miro (the egress policy and where its API is), and whether files are on. */
export interface MiroReach {
  readonly egress: EgressDeps
  readonly apiOrigin: string
  /** whether the import asks for files at all (MIRO_DOWNLOAD_HOSTS, or the local-dev seam's files origin) */
  readonly filesOn: boolean
  readonly sleep?: (ms: number) => Promise<void>
}

/** The reach this api has: Miro itself, or the fake Miro's origins behind the local-dev guard (config.ts). */
export function miroReachOf(ctx: FeatureContext): MiroReach {
  const test = ctx.config.miroTestOrigins
  return {
    egress: egressDeps(miroEgressPolicy(test), MIRO_EGRESS_USER_AGENT),
    apiOrigin: test?.api ?? MIRO_API_ORIGIN,
    filesOn: MIRO_DOWNLOAD_HOSTS.length > 0 || Boolean(test?.files),
  }
}

/** A MiroError as the row's code (an ImportFailure); anything else as it is. */
export async function asImportFailure<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof MiroError) throw new ImportFailure(e.code)
    throw e
  }
}

const SEED_BUSY_TRIES = 5
const SEED_BUSY_WAIT_MS = 3_000

export function miroImportSource(
  ctx: FeatureContext,
  reach: MiroReach = miroReachOf(ctx),
): ImportSourceRunner {
  return {
    source: 'miro',
    resumeNeedsSecrets: true,
    runBoard: (step) => asImportFailure(() => runMiroBoard(ctx, step, reach)),
  }
}

async function runMiroBoard(ctx: FeatureContext, step: ImportStep, reach: MiroReach) {
  const token = step.secrets[0] as RedactedSecret | undefined
  if (!token) throw new ImportFailure(IMPORT_CODES.secretRequired)
  const boardId = step.sourceRef ?? ''
  if (!MIRO_BOARD_ID_PATTERN.test(boardId)) throw new ImportFailure(MIRO_CODES.boardNotVisible)
  const client = new MiroClient(reach.egress, token, {
    apiOrigin: reach.apiOrigin,
    checkpoint: () => step.checkpoint(),
    ...(reach.sleep ? { sleep: reach.sleep } : {}),
  })
  const path = `/v2/boards/${boardId}`

  step.progress({ phase: 'validating' })
  const board = await client.board(boardId)

  step.progress({ phase: 'reading', items: { read: 0, total: null } })
  const items = await client.cursorList(`${path}/items`, {
    max: MIRO_IMPORT_LIMITS.itemsPerBoard,
    onPage: (read, total) => step.progress({ items: { read, total } }),
  })
  if (items.over) throw new ImportFailure(IMPORT_CODES.tooLarge)
  const connectors = await client.cursorList(`${path}/connectors`, {
    max: MIRO_IMPORT_LIMITS.connectorsPerBoard,
  })
  if (connectors.over) throw new ImportFailure(IMPORT_CODES.tooLarge)
  const groups = await client.cursorList(`${path}/groups`, { max: MIRO_IMPORT_LIMITS.itemsPerBoard })
  const tags = (await client.offsetList(`${path}/tags`, { max: 400 })).data
    .map(slimTag)
    .filter((t): t is MiroTag => t !== null)
  const tagItems: Record<string, string[]> = {}
  for (const tag of tags) {
    const tagged = await client.offsetList(`${path}/items`, {
      max: MIRO_IMPORT_LIMITS.itemsPerBoard,
      query: { tag_id: tag.id },
    })
    tagItems[tag.id] = tagged.data.flatMap((x) => (isRecord(x) && typeof x.id === 'string' ? [x.id] : []))
  }
  const slim = items.data.map(slimItem).filter((i): i is MiroItem => i !== null)
  step.progress({ items: { read: slim.length, total: slim.length } })
  const members: Record<string, string> = {}
  if (slim.some((i) => i.type === 'card' && typeof i.data?.assigneeId === 'string')) {
    const list = await client.offsetList(`${path}/members`, { max: 10_000 })
    for (const m of list.data)
      if (isRecord(m) && typeof m.id === 'string' && typeof m.name === 'string')
        members[m.id] = m.name.slice(0, 200)
  }

  // files: each resource once, whatever number of items show it
  const refs = new Map<string, MiroFileRef>()
  const refOfItem = new Map<string, MiroFileRef | null>()
  for (const raw of items.data) {
    if (!isRecord(raw) || (raw.type !== 'image' && raw.type !== 'document') || typeof raw.id !== 'string')
      continue
    const ref = fileRefOf(raw, boardId)
    refOfItem.set(raw.id, ref)
    if (ref && !refs.has(ref.key)) refs.set(ref.key, ref)
  }
  const outcomes = new Map<string, MiroFileOutcome>()
  if (refs.size && reach.filesOn) {
    step.progress({ phase: 'files', files: { done: 0, failed: 0, total: refs.size, bytes: 0 } })
    const budget: FileBudget = { files: 0, bytes: 0 }
    const queue = [...refs.values()]
    let done = 0
    let failed = 0
    let stopped = false
    const work = async () => {
      for (let ref = queue.shift(); ref && !stopped; ref = queue.shift()) {
        await step.checkpoint()
        const outcome = await storeMiroFile(ctx, step, client, reach.egress, ref, budget)
        outcomes.set(ref.key, outcome)
        if ('stored' in outcome) done++
        else failed++
        step.progress({ files: { done, failed, total: refs.size, bytes: budget.bytes } })
      }
    }
    const streams = Math.min(IMPORT_CONCURRENCY.fileStreamsPerJob, queue.length)
    // a stream that stops (a pause, a cancel, the quota) stops the others at their next file; the board is left to
    // the runner only once none of them is still writing a version of it
    const ends = await Promise.allSettled(
      Array.from({ length: streams }, () =>
        work().catch((e: unknown) => {
          stopped = true
          throw e
        }),
      ),
    )
    const first = ends.find((e): e is PromiseRejectedResult => e.status === 'rejected')
    if (first) throw first.reason
  }
  const files: Record<string, MiroFileOutcome> = {}
  for (const [itemId, ref] of refOfItem) {
    if (!reach.filesOn) files[itemId] = { failed: 'file-not-imported-yet' }
    else if (!ref) files[itemId] = { failed: 'file-failed' }
    else files[itemId] = outcomes.get(ref.key) ?? { failed: 'file-failed' }
  }

  await step.checkpoint()
  step.progress({ phase: 'converting' })
  const body: MiroSeedBody = {
    format: MIRO_SEED_FORMAT,
    board: { id: boardId, name: board.name.slice(0, 200) },
    items: slim,
    connectors: connectors.data.map(slimConnector).filter((c): c is MiroConnector => c !== null),
    groups: groups.data.map(slimGroup).filter((g): g is MiroGroup => g !== null),
    tags,
    tagItems,
    members,
    files,
  }
  const answer = await seed(ctx, step, body)
  const report = ImportBoardReport.safeParse(answer.report)
  if (!report.success) throw new ImportFailure(IMPORT_CODES.seedFailed)
  return {
    report: report.data,
    counts: {
      items: slim.length,
      connectors: body.connectors.length,
      files: [...outcomes.values()].filter((o) => 'stored' in o).length,
    },
  }
}

/** Sync's seed of the board (a few tries while its conversions are busy). */
async function seed(ctx: FeatureContext, step: ImportStep, body: MiroSeedBody) {
  const seedMiro = ctx.sync.seedMiro?.bind(ctx.sync)
  if (!seedMiro) throw new ImportFailure(IMPORT_CODES.seedFailed)
  for (let attempt = 1; ; attempt++) {
    try {
      return await seedMiro(step.boardId, body)
    } catch (e) {
      if (e instanceof SyncUnavailable && e.status === 413) throw new ImportFailure(IMPORT_CODES.tooLarge)
      if (e instanceof SyncUnavailable && e.status === 503 && attempt < SEED_BUSY_TRIES) {
        await new Promise((r) => setTimeout(r, SEED_BUSY_WAIT_MS))
        await step.checkpoint()
        continue
      }
      // a board that already has canvas data (a resume after its seed), or sync refused or was unreachable
      if (e instanceof SyncSeedConflict || e instanceof SyncUnavailable)
        throw new ImportFailure(IMPORT_CODES.seedFailed)
      throw e
    }
  }
}
