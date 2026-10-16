// WS1 (wave R): the Miro dialog's words and state. The progress line of each phase, the live region's words (phase
// changes, not counts), the report's sentence, per-type table and notes, the error messages (never a token), the
// help text, and the reducer: picking (at most 50), pasted links, titles sent only when changed, the start body.
import {
  IMPORT_PHASES,
  MIRO_CODE_MESSAGES,
  MIRO_IMPORT_LIMITS,
  type MiroBoardSummary,
  StartMiroImportInput,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  cleanToken,
  initialMiroState,
  LINK_MESSAGES,
  MIRO_FALLBACK_MESSAGE,
  MIRO_NOTE_LABELS,
  MIRO_REPORT_LINES,
  MIRO_TOKEN_HELP,
  type MiroAction,
  type MiroState,
  miroErrorMessage,
  miroReducer,
  noteLabel,
  noteRows,
  percent,
  phaseLine,
  progressAnnouncement,
  startInput,
  startLabel,
  stopsPolling,
  summarySentence,
  titleToSend,
  typeLabel,
  typeRows,
  unfinishedMiroJob,
} from './model.ts'
import { BOARDS, boardView, doneJob, IMP, jobView, PROJECT, SUMMARY, TOKEN } from './test-kit.ts'

const run = (actions: MiroAction[], from: MiroState = initialMiroState(null)) =>
  actions.reduce(miroReducer, from)
const progress = (
  phase: (typeof IMPORT_PHASES)[number],
  items = { read: 1200, total: 2000 as number | null },
) => boardView({ progress: { phase, items, files: { done: 37, failed: 0, total: 120, bytes: 0 } } })

describe('the progress line', () => {
  it('says what each phase does', () => {
    expect(phaseLine(progress('validating'))).toBe('Checking the token')
    expect(phaseLine(progress('reading'))).toBe('Reading items 1,200/2,000')
    expect(phaseLine(progress('reading', { read: 1200, total: null }))).toBe('Reading items 1,200')
    expect(phaseLine(progress('files'))).toBe('Images and documents 37/120')
    expect(phaseLine(progress('converting'))).toBe('Building the board')
    expect(phaseLine(progress('activating'))).toBe('Finishing')
    expect(phaseLine(progress('cleaning'))).toBe('Cleaning up')
    expect(phaseLine(progress('queued'))).toBe('Waiting')
    for (const phase of IMPORT_PHASES) expect(phaseLine(progress(phase))).not.toBe('')
  })

  it('counts failed files, and an unknown total reads as a count', () => {
    const b = boardView({
      progress: {
        phase: 'files',
        items: { read: 0, total: null },
        files: { done: 12, failed: 3, total: null, bytes: 0 },
      },
    })
    expect(phaseLine(b)).toBe('Images and documents 12, 3 failed')
  })

  it('a board that is not running says how it ended or waits', () => {
    expect(phaseLine(boardView({ status: 'queued' }))).toBe('Waiting')
    expect(phaseLine(boardView({ status: 'done' }))).toBe('Imported')
    expect(phaseLine(boardView({ status: 'cancelled' }))).toBe('Cancelled')
    expect(phaseLine(boardView({ status: 'paused' }))).toBe('Paused')
    expect(phaseLine(boardView({ status: 'interrupted' }))).toBe('Stopped: Lobby restarted')
    expect(phaseLine(boardView({ status: 'failed', errorCode: 'MIRO_BOARD_NOT_VISIBLE' }))).toBe(
      `Not imported: ${MIRO_CODE_MESSAGES.MIRO_BOARD_NOT_VISIBLE}`,
    )
  })

  it('the live region speaks at phase changes, not at every count', () => {
    const at = (read: number) =>
      progressAnnouncement(jobView({ boards: [progress('reading', { read, total: 2000 })] }))
    expect(at(100)).toBe('Board 1 of 1, Roadmap: Reading items')
    expect(at(1900)).toBe(at(100))
    expect(progressAnnouncement(jobView({ boards: [progress('converting')] }))).toBe(
      'Board 1 of 1, Roadmap: Building the board',
    )
    expect(progressAnnouncement(null)).toBe('Starting the import')
    expect(progressAnnouncement(jobView({ status: 'paused' }))).toBe('Import paused')
    expect(progressAnnouncement(doneJob())).toBe('Import finished: 1 of 1 board imported')
  })

  it('polling stops once a job has finished or waits for its starter', () => {
    expect(stopsPolling(jobView({ status: 'running' }))).toBe(false)
    expect(stopsPolling(jobView({ status: 'queued' }))).toBe(false)
    for (const status of ['paused', 'interrupted', 'done', 'failed', 'cancelled'] as const)
      expect(stopsPolling(jobView({ status }))).toBe(true)
  })

  it('the dialog reopens on the person’s newest unfinished Miro job only', () => {
    const backup = jobView({ source: 'lobby-backup', importId: 'imp_backup0123456789' })
    const old = jobView({ status: 'done', importId: 'imp_old0123456789ab' })
    const paused = jobView({ status: 'paused' })
    expect(unfinishedMiroJob([backup, old, paused])?.importId).toBe(IMP)
    expect(unfinishedMiroJob([backup, old])).toBeNull()
    expect(unfinishedMiroJob([])).toBeNull()
  })
})

describe('the report', () => {
  it('the sentence counts every result (skipped only when there is one)', () => {
    expect(summarySentence(SUMMARY)).toBe(
      '1,912 of 2,000 items imported as native elements (95.6 %), 60 approximated, 28 placeholders, 0 failed',
    )
    const skipped = { ...SUMMARY, total: 2003, counts: { ...SUMMARY.counts, skipped: 3, placeholder: 1 } }
    expect(summarySentence(skipped)).toBe(
      '1,912 of 2,003 items imported as native elements (95.4 %), 60 approximated, 1 placeholder, 0 failed, 3 skipped',
    )
    expect(summarySentence({ ...SUMMARY, total: 0 })).toBe('Miro returned no items for this board.')
  })

  it('a share is never rounded up to 100 %', () => {
    expect(percent(1999, 2000)).toBe('99.9 %')
    expect(percent(9999, 10000)).toBe('99.9 %')
    expect(percent(2000, 2000)).toBe('100.0 %')
    expect(percent(0, 0)).toBe('0.0 %')
  })

  it('the per-type table uses Miro’s types in words, most items first; an unknown type shows as it is', () => {
    const rows = typeRows({ ...SUMMARY, byType: { ...SUMMARY.byType, mind_map_node: { placeholder: 1 } } })
    expect(rows.map((r) => r.label)).toEqual([
      'Sticky notes',
      'Connectors',
      'Images',
      'Frames',
      'mind_map_node',
    ])
    expect(rows[1]).toMatchObject({
      type: 'connector',
      total: 460,
      counts: { native: 400, approximate: 60, placeholder: 0, failed: 0, skipped: 0 },
    })
    expect(typeLabel('data_table_format')).toBe('Tables')
    expect(typeLabel('unknown')).toBe('Other items')
    expect(typeLabel('toString')).toBe('toString')
  })

  it('notes in words with their count, most frequent first; an unknown note shows its code', () => {
    expect(noteRows(SUMMARY)).toEqual([
      { code: 'color-substituted', label: 'Colours matched to Lobby’s palette', count: 140 },
      { code: 'connector-curved', label: 'Curved connectors drawn as curves (approximate)', count: 60 },
      { code: 'file-host-refused', label: 'Files from an unexpected address refused', count: 28 },
      { code: 'brand-new-note', label: 'brand-new-note', count: 2 },
    ])
    expect(noteRows({ ...SUMMARY, notes: { 'group-dropped': 0 } })).toEqual([])
    expect(noteLabel('constructor')).toBe('constructor')
    expect(Object.keys(MIRO_NOTE_LABELS)).toHaveLength(32)
    for (const code of Object.keys(MIRO_NOTE_LABELS)) expect(code).toMatch(/^[a-z][a-z0-9-]{0,47}$/)
  })

  it('the fixed lines', () => {
    expect(MIRO_REPORT_LINES.comments).toBe('Comments stay in Miro: Miro’s API does not return them.')
    expect(MIRO_REPORT_LINES.revoke).toBe(
      'Done? Revoke the token in Miro: Settings → Your apps → (your app) → uninstall.',
    )
    expect(MIRO_REPORT_LINES.interrupted).toBe(
      'Lobby restarted while this import ran. Paste the token again to go on.',
    )
  })
})

describe('words for errors and help', () => {
  it('Miro codes read MIRO_CODE_MESSAGES; job codes and unavailable their own; anything else a fallback', () => {
    for (const [code, message] of Object.entries(MIRO_CODE_MESSAGES))
      expect(miroErrorMessage(code)).toBe(message)
    for (const code of [
      'IMPORT_BUSY',
      'IMPORT_DAILY_LIMIT',
      'IMPORT_TOO_LARGE',
      'CREATOR_REQUIRED',
      'FORBIDDEN',
      'unavailable',
    ]) {
      expect(miroErrorMessage(code)).not.toBe(MIRO_FALLBACK_MESSAGE)
    }
    expect(miroErrorMessage('IMPORT_DAILY_LIMIT')).toContain('10 imports today')
    expect(miroErrorMessage('IMPORT_TOO_LARGE')).toContain('10,000 items')
    expect(miroErrorMessage('SOMETHING_NEW')).toBe(MIRO_FALLBACK_MESSAGE)
    expect(miroErrorMessage(null)).toBe(MIRO_FALLBACK_MESSAGE)
    expect(miroErrorMessage('__proto__')).toBe(MIRO_FALLBACK_MESSAGE)
  })

  it('a pasted token is trimmed and shape-checked', () => {
    expect(cleanToken(`  ${TOKEN}\n`)).toBe(TOKEN)
    expect(cleanToken('short')).toBeNull()
    expect(cleanToken('has spaces inside it, so not a token')).toBeNull()
  })

  it('the help names the four steps and the team rule', () => {
    expect(MIRO_TOKEN_HELP.summary).toBe('How to get a token (2 minutes)')
    expect(MIRO_TOKEN_HELP.steps).toHaveLength(4)
    expect(MIRO_TOKEN_HELP.steps[1]).toBe('Under Permissions, tick boards:read (only that).')
    expect(MIRO_TOKEN_HELP.teamNote).toContain('a Miro team admin may need to install the app there')
  })
})

describe('the dialog’s state', () => {
  const listed = (over: Partial<MiroState> = {}) =>
    run(
      [
        { type: 'token', value: TOKEN },
        { type: 'boards', answer: BOARDS, append: false },
      ],
      {
        ...initialMiroState(null),
        ...over,
      },
    )
  const summary = (i: number): MiroBoardSummary => ({
    id: `board${String(i).padStart(4, '0')}`,
    name: `Board ${i}`,
    modifiedAt: null,
    viewLink: null,
  })

  it('opens on the token step, or on the unfinished job', () => {
    expect(run([{ type: 'checked', job: null }]).step).toBe('token')
    const s = run([{ type: 'checked', job: jobView() }])
    expect([s.step, s.importId]).toEqual(['job', IMP])
    expect(initialMiroState(PROJECT).projectId).toBe(PROJECT)
    expect(initialMiroState(null).projectId).toBe('')
  })

  it('a listing moves to the picker; More boards appends without repeats', () => {
    const s = listed()
    expect([s.step, s.team, s.total, s.boards.length]).toEqual(['pick', BOARDS.team.name, 120, 2])
    const more = miroReducer(s, {
      type: 'boards',
      answer: { ...BOARDS, offset: 2, boards: [BOARDS.boards[1] as MiroBoardSummary, summary(3)] },
      append: true,
    })
    expect(more.boards.map((b) => b.id)).toEqual(['uXjVOD1Ab2c=', 'uXjVOD9Zz9z=', 'board0003'])
    const searched = miroReducer(more, {
      type: 'boards',
      answer: { ...BOARDS, boards: [summary(7)] },
      append: false,
    })
    expect(searched.boards.map((b) => b.id)).toEqual(['board0007'])
  })

  it('a failure shows its words and keeps the step', () => {
    const s = run([
      { type: 'checked', job: null },
      { type: 'busy' },
      { type: 'failed', code: 'MIRO_TOKEN_INVALID' },
    ])
    expect([s.step, s.busy, s.error]).toEqual(['token', false, MIRO_CODE_MESSAGES.MIRO_TOKEN_INVALID])
    expect(miroReducer(s, { type: 'token', value: 'x' }).error).toBeNull()
  })

  it('picks and unpicks; at most MIRO_IMPORT_LIMITS.boardsPerJob', () => {
    let s = listed()
    s = miroReducer(s, { type: 'toggle', board: { id: 'uXjVOD1Ab2c=', name: 'Roadmap' } })
    expect(s.picked).toEqual([{ id: 'uXjVOD1Ab2c=', name: 'Roadmap' }])
    s = miroReducer(s, { type: 'title', id: 'uXjVOD1Ab2c=', value: 'Q4' })
    s = miroReducer(s, { type: 'toggle', board: { id: 'uXjVOD1Ab2c=', name: 'Roadmap' } })
    expect([s.picked, s.titles]).toEqual([[], {}])
    for (let i = 0; i < MIRO_IMPORT_LIMITS.boardsPerJob + 5; i++)
      s = miroReducer(s, { type: 'toggle', board: { id: summary(i).id, name: summary(i).name } })
    expect(s.picked).toHaveLength(MIRO_IMPORT_LIMITS.boardsPerJob)
    s = run([{ type: 'link', value: 'https://miro.com/app/board/uXjVZZZZZZ8=/' }, { type: 'add-link' }], s)
    expect(s.linkError).toBe(LINK_MESSAGES.full)
  })

  it('a pasted link adds its board (named when the list knows it); a bad link says so', () => {
    let s = run(
      [{ type: 'link', value: 'https://evil.example/app/board/uXjVOD1Ab2c=/' }, { type: 'add-link' }],
      listed(),
    )
    expect([s.picked, s.linkError]).toEqual([[], LINK_MESSAGES.invalid])
    s = run(
      [
        { type: 'link', value: 'https://miro.com/app/board/uXjVOD1Ab2c=/?share_link_id=1' },
        { type: 'add-link' },
      ],
      s,
    )
    expect([s.picked, s.link, s.linkError]).toEqual([[{ id: 'uXjVOD1Ab2c=', name: 'Roadmap' }], '', null])
    s = run([{ type: 'link', value: 'https://miro.com/app/board/uXjVAAAAAAA=/' }, { type: 'add-link' }], s)
    expect(s.picked[1]).toEqual({ id: 'uXjVAAAAAAA=', name: null })
    s = run([{ type: 'link', value: 'https://miro.com/app/board/uXjVOD1Ab2c=/' }, { type: 'add-link' }], s)
    expect(s.picked).toHaveLength(2)
  })

  it('a title is sent only when the person changed it; the project only when one is chosen', () => {
    const roadmap = { id: 'uXjVOD1Ab2c=', name: 'Roadmap' }
    expect(titleToSend(roadmap, undefined)).toBeUndefined()
    expect(titleToSend(roadmap, ' Roadmap ')).toBeUndefined()
    expect(titleToSend(roadmap, '   ')).toBeUndefined()
    expect(titleToSend(roadmap, ' Q4 roadmap ')).toBe('Q4 roadmap')
    expect(titleToSend({ id: 'x', name: null }, 'Mine')).toBe('Mine')
    let s = run(
      [
        { type: 'toggle', board: roadmap },
        { type: 'link', value: 'https://miro.com/app/board/uXjVAAAAAAA=/' },
        { type: 'add-link' },
        { type: 'title', id: 'uXjVAAAAAAA=', value: 'From a link' },
      ],
      listed(),
    )
    expect(startInput(s)).toEqual({
      boards: [{ miroBoardId: 'uXjVOD1Ab2c=' }, { miroBoardId: 'uXjVAAAAAAA=', title: 'From a link' }],
    })
    s = miroReducer(s, { type: 'project', value: PROJECT })
    expect(startInput(s).projectId).toBe(PROJECT)
    expect(StartMiroImportInput.safeParse(startInput(s)).success).toBe(true)
    expect(startInput(s)).not.toHaveProperty('referencePdf')
    expect(miroReducer(s, { type: 'title', id: 'x', value: 'a'.repeat(500) }).titles.x).toHaveLength(
      MIRO_IMPORT_LIMITS.titleChars,
    )
    expect([startLabel(1), startLabel(3)]).toEqual(['Import 1 board', 'Import 3 boards'])
  })

  it('started → the job step; its views replace each other; the token stays in memory for a resume', () => {
    let s = run([{ type: 'busy' }, { type: 'started', importId: IMP }], listed())
    expect([s.step, s.importId, s.job, s.busy, s.resumeToken]).toEqual(['job', IMP, null, false, TOKEN])
    s = miroReducer(s, {
      type: 'job',
      job: jobView({ status: 'paused', resumable: true, resumeNeedsToken: true }),
    })
    expect(s.job?.status).toBe('paused')
    expect(miroReducer(s, { type: 'resume-token', value: 'abc' }).resumeToken).toBe('abc')
  })
})
