// WS1 (wave R): the Miro dialog's steps rendered to markup in Node (the web package has no DOM). The token field is a
// password field the browser does not fill or spell-check; the help, the picker (rows, checks, search, More, the
// pasted link, titles, project), the progress (one row per board, the live region, Cancel, Pause, Resume and its token
// field) and the report (the sentence, the per-type table, notes, the fixed lines, Open board, the CSV, the revoke
// line). Every Miro string is text: a board or team name with markup is escaped, never HTML.
import type { Project } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useMiroImport } from './index.tsx'
import MiroImportDialog from './MiroImportDialog.tsx'
import {
  initialMiroState,
  MIRO_REPORT_LINES,
  MIRO_TOKEN_HELP,
  type MiroAction,
  type MiroState,
  miroReducer,
} from './model.ts'
import { BOARDS, boardView, doneJob, IMP, jobView, PROJECT, TOKEN, W } from './test-kit.ts'
import { MiroImportBody, MiroTitle } from './views.tsx'

const noop = () => {}
const PROJECTS: Project[] = [
  {
    id: PROJECT,
    workspaceId: W,
    name: 'Brand <refresh>',
    createdAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
  } as unknown as Project,
]

const render = (state: MiroState) =>
  renderToStaticMarkup(
    createElement(MiroImportBody, {
      state,
      projects: PROJECTS,
      dispatch: noop,
      onContinue: noop,
      onMore: noop,
      onStart: noop,
      onCancel: noop,
      onPause: noop,
      onResume: noop,
      onClose: noop,
    }),
  )
const at = (actions: MiroAction[], from: MiroState = initialMiroState(null)) =>
  actions.reduce(miroReducer, from)
const tag = (m: string, testId: string) =>
  new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`).exec(m)?.[0] ?? ''
const count = (m: string, testId: string) => m.split(`data-testid="${testId}"`).length - 1

describe('the Miro dialog', () => {
  it('opens checking for an unfinished job (nothing asked yet), with a visible Beta label', () => {
    const m = renderToStaticMarkup(
      createElement(MiroImportDialog, {
        workspaceId: W,
        projects: PROJECTS,
        defaultProjectId: null,
        onClose: noop,
        onFinished: noop,
      }),
    )
    expect(m).toContain('data-testid="miro-import-dialog"')
    expect(m).toContain('<h2')
    expect(m).toContain('Import from Miro')
    expect(tag(m, 'miro-beta')).toContain('class="dr-miro__beta"')
    expect(renderToStaticMarkup(createElement(MiroTitle))).toContain('>Beta</span>')
    expect(m).toContain('role="status"')
    expect(m).not.toContain('data-testid="miro-token"')
  })

  it('the hook renders nothing until opened', () => {
    let dialog: unknown = 'unset'
    function Probe() {
      dialog = useMiroImport({
        workspaceId: W,
        projects: [],
        defaultProjectId: null,
        onFinished: noop,
      }).dialog
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    expect(dialog).toBeNull()
  })

  it('the token step: a password field the browser keeps nothing of, the help, Continue', () => {
    const m = render(at([{ type: 'checked', job: null }]))
    const field = tag(m, 'miro-token')
    expect(field).toContain('type="password"')
    expect(field).toContain('autoComplete="off"')
    expect(field).toContain('spellCheck="false"')
    expect(field).toContain('value=""')
    expect(m).toMatch(/<label for="[^"]+">Miro access token<\/label>/)
    expect(tag(m, 'miro-token-help')).toMatch(/^<details/)
    expect(m).toContain(`<summary>${MIRO_TOKEN_HELP.summary}</summary>`)
    expect(count(m, 'miro-token-submit')).toBe(1)
    expect(tag(m, 'miro-token-submit')).toContain('disabled=""')
    expect(m).not.toContain('data-testid="miro-error"')
  })

  it('an error is an alert in words, never the token', () => {
    const m = render(
      at([
        { type: 'checked', job: null },
        { type: 'token', value: TOKEN },
        { type: 'failed', code: 'MIRO_SCOPE_MISSING' },
      ]),
    )
    expect(tag(m, 'miro-error')).toContain('role="alert"')
    expect(m).toContain('boards:read permission')
    expect(m.split(TOKEN).length - 1).toBe(1) // the field's own value, nowhere else
    expect(tag(m, 'miro-token')).toContain('aria-invalid="true"')
  })

  it('the picker: the team, search, rows with checks, More, the pasted link, the project; names are text', () => {
    const s = at([
      { type: 'token', value: TOKEN },
      { type: 'boards', answer: BOARDS, append: false },
      { type: 'toggle', board: { id: 'uXjVOD1Ab2c=', name: 'Roadmap' } },
    ])
    const m = render({ ...s, projectId: PROJECT })
    expect(m).toContain('Team: <strong>DBC &lt;b&gt;Design&lt;/b&gt;</strong>')
    expect(m).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(m).not.toContain('<img')
    expect(tag(m, 'miro-board-search')).toContain('type="search"')
    expect(count(m, 'miro-board-row')).toBe(2)
    expect(m).toContain('data-board-id="uXjVOD1Ab2c="')
    expect(count(m, 'miro-board-check')).toBe(2)
    expect(m).toMatch(/<input type="checkbox" data-testid="miro-board-check" checked=""/)
    expect(m).toContain('Modified ')
    expect(count(m, 'miro-board-more')).toBe(1)
    expect(count(m, 'miro-paste-link')).toBe(1)
    expect(count(m, 'miro-paste-add')).toBe(1)
    expect(count(m, 'miro-board-title')).toBe(1)
    expect(tag(m, 'miro-board-title')).toContain('value="Roadmap"')
    expect(tag(m, 'miro-board-title')).toContain('maxLength="120"')
    expect(m).toContain('Brand &lt;refresh&gt;')
    expect(m).toMatch(/<option value="prj_0123456789abcdefghij" selected="">/)
    expect(tag(m, 'miro-start')).not.toContain('disabled')
    expect(m).toContain('>Import 1 board</button>')
    // no PDF reference upload
    expect(m).not.toContain('type="file"')
    // all listed: no More
    expect(count(render({ ...s, total: 2 }), 'miro-board-more')).toBe(0)
  })

  it('a bad pasted link says so inline', () => {
    const s = at([
      { type: 'boards', answer: BOARDS, append: false },
      { type: 'link', value: 'https://example.com/x' },
      { type: 'add-link' },
    ])
    const m = render(s)
    expect(m).toContain('data-testid="miro-paste-error"')
    expect(m).toContain('That is not a Miro board link.')
    expect(tag(m, 'miro-start')).toContain('disabled=""')
  })

  it('progress: a row per board with its phase, a polite live region, Cancel and Pause', () => {
    const job = jobView({
      boards: [boardView(), boardView({ id: 'imb_second0123456789', title: 'Retro <3>', status: 'queued' })],
    })
    const m = render(at([{ type: 'checked', job }]))
    expect(tag(m, 'miro-progress')).toContain('data-status="running"')
    expect(count(m, 'miro-board-progress')).toBe(2)
    expect(m).toContain('data-status="queued"')
    expect(m).toContain('Reading items 1,200/2,000')
    expect(m).toContain('Retro &lt;3&gt;')
    expect(tag(m, 'miro-announce')).toContain('aria-live="polite"')
    expect(m).toContain('Board 1 of 2, Roadmap: Reading items<')
    expect(count(m, 'miro-cancel')).toBe(1)
    expect(count(m, 'miro-pause')).toBe(1)
    expect(count(m, 'miro-resume')).toBe(0)
    expect(m).not.toContain('data-testid="miro-report"')
  })

  it('an interrupted job explains itself and asks for the token again to resume', () => {
    const job = jobView({
      status: 'interrupted',
      resumable: true,
      resumeNeedsToken: true,
      boards: [boardView({ status: 'interrupted' })],
    })
    const m = render(at([{ type: 'checked', job }]))
    expect(m).toContain(MIRO_REPORT_LINES.interrupted)
    const field = tag(m, 'miro-resume-token')
    expect(field).toContain('type="password"')
    expect(field).toContain('autoComplete="off"')
    expect(tag(m, 'miro-resume')).toContain('disabled=""')
    expect(count(m, 'miro-pause')).toBe(0)
    expect(count(m, 'miro-cancel')).toBe(1)
    const typed = render(
      at([
        { type: 'checked', job },
        { type: 'resume-token', value: TOKEN },
      ]),
    )
    expect(tag(typed, 'miro-resume')).not.toContain('disabled')
  })

  it('a paused job that does not need the token resumes with one click', () => {
    const job = jobView({ status: 'paused', resumable: true, resumeNeedsToken: false })
    const m = render(at([{ type: 'checked', job }]))
    expect(count(m, 'miro-resume-token')).toBe(0)
    expect(tag(m, 'miro-resume')).not.toContain('disabled')
  })

  it('the report: the sentence, the per-type table, notes, fixed lines, Open board, the CSV, revoke', () => {
    const m = render(at([{ type: 'job', job: doneJob() }]))
    expect(count(m, 'miro-report')).toBe(1)
    expect(count(m, 'miro-board-report')).toBe(1)
    expect(m).toContain(
      '1,912 of 2,000 items imported as native elements (95.6 %), 60 approximated, 28 placeholders, 0 failed',
    )
    expect(m).toContain('<th scope="row">Sticky notes</th>')
    expect(m).toContain('<th scope="col">Approximated</th>')
    expect(m).not.toContain('<th scope="col">Skipped</th>')
    expect(m).toContain('Colours matched to Lobby’s palette: 140')
    expect(m).toContain('brand-new-note: 2')
    expect(m).toContain(MIRO_REPORT_LINES.comments)
    expect(m).toContain(MIRO_REPORT_LINES.notReturned)
    expect(tag(m, 'miro-open-board')).toContain('href="/b/b-roadmap01"')
    const csv = tag(m, 'miro-report-csv')
    expect(csv).toContain(`href="/api/imports/${IMP}/report.csv"`)
    expect(csv).toContain('download=""')
    expect(m).toContain(MIRO_REPORT_LINES.revoke)
    expect(count(m, 'miro-revoke')).toBe(1)
    expect(count(m, 'miro-cancel')).toBe(0)
    expect(count(m, 'miro-pause')).toBe(0)
  })

  it('a failed board says why; a cancelled one says so; neither has Open board', () => {
    const job = jobView({
      status: 'failed',
      boards: [
        boardView({ status: 'failed', errorCode: 'MIRO_BOARD_NOT_VISIBLE' }),
        boardView({
          id: 'imb_second0123456789',
          title: 'Retro',
          status: 'cancelled',
          errorCode: 'IMPORT_CANCELLED',
        }),
      ],
    })
    const m = render(at([{ type: 'job', job }]))
    expect(count(m, 'miro-board-report')).toBe(2)
    expect(m).toContain('The token’s Miro team cannot see this board.')
    expect(m).toContain('Cancelled: this board was not imported.')
    expect(count(m, 'miro-open-board')).toBe(0)
    expect(count(m, 'miro-report-csv')).toBe(1)
  })
})
