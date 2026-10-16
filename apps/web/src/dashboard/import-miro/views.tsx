// OWNER: WS1 (wave R, import from Miro). The dialog's steps as plain views of the model's state (./model.ts): the
// token, the board picker, the progress and the report. No request and no effect here (MiroImportDialog.tsx runs
// them), so each step renders to markup in a Node test. Every Miro string is rendered as React text, never as HTML.
import {
  type ImportBoardView,
  type ImportJobView,
  MIRO_IMPORT_LIMITS,
  type Project,
} from '@draftroom/contracts'
import { type RefObject, useEffect, useId, useRef } from 'react'
import { boardPath, linkClick } from '../../lib/routing.ts'
import { importReportHref } from '../imports/client.ts'
import {
  formatCount,
  isFinished,
  MIRO_REPORT_LINES,
  MIRO_TOKEN_HELP,
  type MiroAction,
  type MiroState,
  miroErrorMessage,
  modifiedLine,
  noteRows,
  phaseLine,
  pickedName,
  progressAnnouncement,
  startLabel,
  summarySentence,
  titleValue,
  typeRows,
} from './model.ts'

export interface MiroViewProps {
  state: MiroState
  projects: readonly Project[]
  dispatch(action: MiroAction): void
  onContinue(): void
  onMore(): void
  onStart(): void
  onCancel(): void
  onPause(): void
  onResume(): void
  onClose(): void
}

/** The dialog's title: its name and a visible "Beta" label. */
export function MiroTitle() {
  return (
    <>
      Import from Miro{' '}
      <span className="dr-miro__beta" data-testid="miro-beta">
        Beta
      </span>
    </>
  )
}

/** The step the state is on. */
export function MiroImportBody(props: MiroViewProps) {
  switch (props.state.step) {
    case 'checking':
      return (
        <div className="dr-miro">
          <p className="dr-muted" role="status">
            Looking for an import you started…
          </p>
        </div>
      )
    case 'token':
      return <TokenStep {...props} />
    case 'pick':
      return <PickStep {...props} />
    case 'job':
      return <JobStep {...props} />
  }
}

/** A step takes the keyboard when it appears (the control that had it, Continue or Import, is gone). */
function useFocusOnMount(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [ref])
}

function ErrorLine({ error, id }: { error: string | null; id?: string }) {
  if (!error) return null
  return (
    <p id={id} className="dr-field-error" role="alert" data-testid="miro-error">
      {error}
    </p>
  )
}

function TokenStep({ state: s, dispatch, onContinue, onClose }: MiroViewProps) {
  const tokenId = useId()
  const errorId = useId()
  const field = useRef<HTMLInputElement>(null)
  useFocusOnMount(field)
  return (
    <form
      className="dr-form dr-miro"
      data-testid="miro-token-step"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        onContinue()
      }}
    >
      <p className="dr-dialog__desc">
        Lobby reads your Miro boards with a token you create in Miro, and builds a new private board from each
        one. Your Miro boards do not change.
      </p>
      <label htmlFor={tokenId}>Miro access token</label>
      <input
        ref={field}
        id={tokenId}
        type="password"
        className="dr-input dr-input--block"
        data-testid="miro-token"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={s.token}
        onChange={(e) => dispatch({ type: 'token', value: e.target.value })}
        aria-invalid={s.error ? true : undefined}
        aria-describedby={s.error ? errorId : undefined}
      />
      <details className="dr-miro__help" data-testid="miro-token-help">
        <summary>{MIRO_TOKEN_HELP.summary}</summary>
        <ol>
          {MIRO_TOKEN_HELP.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p>{MIRO_TOKEN_HELP.teamNote}</p>
      </details>
      <ErrorLine error={s.error} id={errorId} />
      <div className="dr-dialog__actions">
        <button type="button" className="dr-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          className="dr-btn dr-btn--primary"
          data-testid="miro-token-submit"
          disabled={s.busy || !s.token.trim()}
        >
          {s.busy ? 'Checking…' : 'Continue'}
        </button>
      </div>
    </form>
  )
}

function PickStep({ state: s, projects, dispatch, onMore, onStart, onClose }: MiroViewProps) {
  const base = useId()
  const search = useRef<HTMLInputElement>(null)
  useFocusOnMount(search)
  const searchId = `${base}-search`
  const linkId = `${base}-link`
  const linkErrorId = `${base}-link-error`
  const pickedHead = `${base}-picked`
  const projectId = `${base}-project`
  const full = s.picked.length >= MIRO_IMPORT_LIMITS.boardsPerJob
  const pickedIds = new Set(s.picked.map((p) => p.id))
  const choices = projects.filter((p) => !p.archivedAt || p.id === s.projectId)
  return (
    <div className="dr-form dr-miro" data-testid="miro-picker">
      <p className="dr-miro__team">
        <span data-testid="miro-team">
          Team: <strong>{s.team ?? ''}</strong>
        </span>{' '}
        <button type="button" className="dr-linkbtn" onClick={() => dispatch({ type: 'change-token' })}>
          Use another token
        </button>
      </p>
      <label htmlFor={searchId}>Search boards</label>
      <input
        ref={search}
        id={searchId}
        type="search"
        className="dr-input dr-input--block"
        data-testid="miro-board-search"
        autoComplete="off"
        maxLength={MIRO_IMPORT_LIMITS.queryChars}
        value={s.query}
        onChange={(e) => dispatch({ type: 'query', value: e.target.value })}
      />
      <p className="dr-miro__count" data-testid="miro-board-count">
        {formatCount(s.boards.length)} of {formatCount(s.total)} {s.total === 1 ? 'board' : 'boards'} shown ·{' '}
        {formatCount(s.picked.length)} selected (at most {MIRO_IMPORT_LIMITS.boardsPerJob})
      </p>
      {s.boards.length > 0 ? (
        <ul className="dr-miro__boards" aria-label="Miro boards">
          {s.boards.map((b) => {
            const checked = pickedIds.has(b.id)
            const date = modifiedLine(b.modifiedAt)
            return (
              <li key={b.id} className="dr-miro__board" data-testid="miro-board-row" data-board-id={b.id}>
                <label className="dr-check dr-miro__boardlabel">
                  <input
                    type="checkbox"
                    data-testid="miro-board-check"
                    checked={checked}
                    disabled={!checked && full}
                    onChange={() => dispatch({ type: 'toggle', board: { id: b.id, name: b.name } })}
                  />
                  <span className="dr-miro__name">{b.name.trim() || 'Untitled board'}</span>
                  {date && <span className="dr-miro__date">{date}</span>}
                </label>
              </li>
            )
          })}
        </ul>
      ) : (
        !s.busy && (
          <p className="dr-muted" data-testid="miro-board-empty">
            {s.query.trim() ? 'No boards match that search.' : 'This token cannot see any boards.'}
          </p>
        )
      )}
      {s.boards.length < s.total && (
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-miro__more"
          data-testid="miro-board-more"
          disabled={s.busy}
          onClick={onMore}
        >
          More boards
        </button>
      )}
      <label htmlFor={linkId}>Paste a board link instead</label>
      <div className="dr-row">
        <input
          id={linkId}
          className="dr-input"
          data-testid="miro-paste-link"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://miro.com/app/board/…"
          value={s.link}
          onChange={(e) => dispatch({ type: 'link', value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            e.preventDefault()
            dispatch({ type: 'add-link' })
          }}
          aria-invalid={s.linkError ? true : undefined}
          aria-describedby={s.linkError ? linkErrorId : undefined}
        />
        <button
          type="button"
          className="dr-btn"
          data-testid="miro-paste-add"
          disabled={!s.link.trim()}
          onClick={() => dispatch({ type: 'add-link' })}
        >
          Add
        </button>
      </div>
      {s.linkError && (
        <p id={linkErrorId} className="dr-field-error" data-testid="miro-paste-error">
          {s.linkError}
        </p>
      )}
      {s.picked.length > 0 && (
        <section className="dr-miro__picked" aria-labelledby={pickedHead}>
          <h3 id={pickedHead} className="dr-miro__subhead">
            New boards ({formatCount(s.picked.length)})
          </h3>
          <ul>
            {s.picked.map((p, i) => {
              const fieldId = `${base}-title-${i}`
              return (
                <li key={p.id} data-testid="miro-picked" data-board-id={p.id}>
                  <label htmlFor={fieldId}>
                    {pickedName(p)}
                    <span className="dr-sr-only">: title of the new board</span>
                  </label>
                  <div className="dr-row">
                    <input
                      id={fieldId}
                      className="dr-input"
                      data-testid="miro-board-title"
                      autoComplete="off"
                      maxLength={MIRO_IMPORT_LIMITS.titleChars}
                      placeholder={p.name ?? 'Miro’s name'}
                      value={titleValue(s, p)}
                      onChange={(e) => dispatch({ type: 'title', id: p.id, value: e.target.value })}
                    />
                    <button
                      type="button"
                      className="dr-btn dr-btn--sm"
                      aria-label={`Remove ${pickedName(p)}`}
                      onClick={() => dispatch({ type: 'unpick', id: p.id })}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      <label htmlFor={projectId}>
        Project <span className="dr-optional">(optional)</span>
      </label>
      <select
        id={projectId}
        className="dr-input dr-input--block dr-select"
        data-testid="miro-project"
        value={s.projectId}
        onChange={(e) => dispatch({ type: 'project', value: e.target.value })}
      >
        <option value="">No project</option>
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <p className="dr-muted dr-miro__hint">
        New boards are private: only you can open them until you share them.
      </p>
      <ErrorLine error={s.error} />
      <div className="dr-dialog__actions">
        <button type="button" className="dr-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--primary"
          data-testid="miro-start"
          disabled={s.busy || s.picked.length === 0}
          onClick={onStart}
        >
          {startLabel(s.picked.length)}
        </button>
      </div>
    </div>
  )
}

function JobStep({ state: s, dispatch, onCancel, onPause, onResume, onClose }: MiroViewProps) {
  const tokenId = useId()
  // Close takes the keyboard, never Cancel or Pause: a reflex Enter must not stop the import.
  const close = useRef<HTMLButtonElement>(null)
  useFocusOnMount(close)
  const job = s.job
  const finished = job !== null && isFinished(job.status)
  const active = job === null || job.status === 'queued' || job.status === 'running'
  const resumable = job?.resumable === true
  const needsToken = resumable && job?.resumeNeedsToken === true
  return (
    <div className="dr-form dr-miro" data-testid="miro-progress" data-status={job?.status ?? 'queued'}>
      <p className="dr-sr-only" aria-live="polite" data-testid="miro-announce">
        {progressAnnouncement(job)}
      </p>
      {job ? (
        <ul className="dr-miro__rows" aria-label="Boards in this import">
          {job.boards.map((b) => (
            <li key={b.id} className="dr-miro__row" data-testid="miro-board-progress" data-status={b.status}>
              <span className="dr-miro__name">{b.title}</span>
              <span className="dr-miro__phase">{phaseLine(b)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dr-muted">Starting the import…</p>
      )}
      {job?.status === 'interrupted' && (
        <p className="dr-miro__note" data-testid="miro-interrupted">
          {MIRO_REPORT_LINES.interrupted}
        </p>
      )}
      {job?.status === 'paused' && (
        <p className="dr-miro__note">Paused. Boards already imported stay; resume to import the rest.</p>
      )}
      {active && <p className="dr-muted dr-miro__hint">Closing this window does not stop the import.</p>}
      {needsToken && (
        <>
          <label htmlFor={tokenId}>Miro access token</label>
          <input
            id={tokenId}
            type="password"
            className="dr-input dr-input--block"
            data-testid="miro-resume-token"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={s.resumeToken}
            onChange={(e) => dispatch({ type: 'resume-token', value: e.target.value })}
          />
        </>
      )}
      {finished && job && <Report job={job} />}
      <ErrorLine error={s.error} />
      <div className="dr-dialog__actions">
        {!finished && (
          <button
            type="button"
            className="dr-btn"
            data-testid="miro-cancel"
            disabled={s.busy || job === null}
            onClick={onCancel}
          >
            Cancel import
          </button>
        )}
        {active && (
          <button
            type="button"
            className="dr-btn"
            data-testid="miro-pause"
            disabled={s.busy || job === null}
            onClick={onPause}
          >
            Pause
          </button>
        )}
        <button
          ref={close}
          type="button"
          className={finished ? 'dr-btn dr-btn--primary' : 'dr-btn'}
          data-testid="miro-close"
          onClick={onClose}
        >
          Close
        </button>
        {resumable && (
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="miro-resume"
            disabled={s.busy || (needsToken && !s.resumeToken.trim())}
            onClick={onResume}
          >
            Resume
          </button>
        )}
      </div>
    </div>
  )
}

function Report({ job }: { job: ImportJobView }) {
  const headId = useId()
  return (
    <section className="dr-miro__report" data-testid="miro-report" aria-labelledby={headId}>
      <h3 id={headId} className="dr-miro__subhead">
        Report
      </h3>
      {job.boards.map((b) => (
        <BoardReport key={b.id} board={b} />
      ))}
      <p className="dr-miro__fixed">{MIRO_REPORT_LINES.comments}</p>
      <p className="dr-miro__fixed">{MIRO_REPORT_LINES.notReturned}</p>
      <p>
        <a
          className="dr-btn dr-btn--sm"
          data-testid="miro-report-csv"
          href={importReportHref(job.importId)}
          download
        >
          Download report (.csv)
        </a>
      </p>
      <p className="dr-miro__revoke" data-testid="miro-revoke">
        {MIRO_REPORT_LINES.revoke}
      </p>
    </section>
  )
}

function BoardReport({ board: b }: { board: ImportBoardView }) {
  const href = b.boardId ? boardPath(b.boardId) : null
  return (
    <article className="dr-miro__boardreport" data-testid="miro-board-report" data-status={b.status}>
      <h4 className="dr-miro__boardtitle">{b.title}</h4>
      {b.status === 'done' && b.summary ? (
        <Summary board={b} summary={b.summary} />
      ) : b.status === 'done' ? (
        <p>Imported.</p>
      ) : b.status === 'cancelled' ? (
        <p>Cancelled: this board was not imported.</p>
      ) : (
        <p data-testid="miro-board-error">Not imported: {miroErrorMessage(b.errorCode)}</p>
      )}
      {href && (
        <a className="dr-btn dr-btn--sm" data-testid="miro-open-board" href={href} onClick={linkClick(href)}>
          Open board
        </a>
      )}
    </article>
  )
}

function Summary({
  board,
  summary,
}: {
  board: ImportBoardView
  summary: NonNullable<ImportBoardView['summary']>
}) {
  const rows = typeRows(summary)
  const notes = noteRows(summary)
  const skipped = rows.some((r) => r.counts.skipped > 0)
  return (
    <>
      <p data-testid="miro-summary">{summarySentence(summary)}</p>
      {rows.length > 0 && (
        <div className="dr-miro__tablewrap">
          <table className="dr-miro__table" data-testid="miro-type-table">
            <caption className="dr-sr-only">Items of {board.title} by type</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Native</th>
                <th scope="col">Approximated</th>
                <th scope="col">Placeholders</th>
                <th scope="col">Failed</th>
                {skipped && <th scope="col">Skipped</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.type} data-type={r.type}>
                  <th scope="row">{r.label}</th>
                  <td>{formatCount(r.counts.native)}</td>
                  <td>{formatCount(r.counts.approximate)}</td>
                  <td>{formatCount(r.counts.placeholder)}</td>
                  <td>{formatCount(r.counts.failed)}</td>
                  {skipped && <td>{formatCount(r.counts.skipped)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {notes.length > 0 && (
        <ul className="dr-miro__notes" aria-label={`Notes on ${board.title}`}>
          {notes.map((note) => (
            <li key={note.code} data-note={note.code}>
              {note.label}: {formatCount(note.count)}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
