// OWNER: WS1 (wave R, import from Miro). "Import from Miro" (docs/WAVE-R-CONTRACTS.md §3, §7): the token, the board
// picker, the progress and the report, in one dialog. Its own chunk (./index.tsx loads it when "From Miro…" is chosen).
//
// The token lives in this component's state only: never in the browser's storage, a URL or a log, and gone when the
// dialog closes (it unmounts). It reaches the api only in a JSON body (./client.ts). Closing the dialog does not stop
// a job; opening it again shows the person's unfinished Miro job instead of the token step.
import {
  IMPORT_POLL_MS,
  type ImportJobView,
  type ListMiroBoardsInput,
  MIRO_CODES,
  MIRO_IMPORT_LIMITS,
  type Project,
} from '@draftroom/contracts'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Dialog } from '../../ui/Dialog.tsx'
import {
  cancelImport,
  getImportJob,
  ImportRequestError,
  listImportJobs,
  pauseImport,
  resumeImport,
} from '../imports/client.ts'
import { listMiroBoards, startMiroImport } from './client.ts'
import {
  cleanToken,
  initialMiroState,
  isFinished,
  miroReducer,
  startInput,
  stopsPolling,
  unfinishedMiroJob,
} from './model.ts'
import { MiroImportBody, MiroTitle } from './views.tsx'
import './import-miro.css'

/** How long the search box waits after the last key before it asks again. */
export const MIRO_SEARCH_DEBOUNCE_MS = 350

const codeOf = (e: unknown) => (e instanceof ImportRequestError ? e.code : 'unavailable')

export default function MiroImportDialog({
  workspaceId,
  projects,
  defaultProjectId,
  onClose,
  onFinished,
}: {
  workspaceId: string
  projects: readonly Project[]
  defaultProjectId: string | null
  onClose(): void
  /** a board of the job became a board (the dashboard reloads its list) */
  onFinished(): void
}) {
  const [s, dispatch] = useReducer(miroReducer, defaultProjectId, initialMiroState)

  // Opening: the person's own unfinished Miro job, if there is one, else the token step.
  useEffect(() => {
    let live = true
    void listImportJobs(workspaceId, { mine: true }).then((jobs) => {
      if (live) dispatch({ type: 'checked', job: unfinishedMiroJob(jobs) })
    })
    return () => {
      live = false
    }
  }, [workspaceId])

  // The board list: the latest request wins (a search typed while the previous one ran).
  const seq = useRef(0)
  const listedFor = useRef('')
  const load = useCallback(
    (token: string, query: string, offset: number) => {
      const mine = ++seq.current
      listedFor.current = query
      dispatch({ type: 'busy' })
      const input: ListMiroBoardsInput = { ...(query ? { query } : {}), ...(offset > 0 ? { offset } : {}) }
      listMiroBoards(workspaceId, token, input).then(
        (answer) => {
          if (mine === seq.current) dispatch({ type: 'boards', answer, append: offset > 0 })
        },
        (e: unknown) => {
          if (mine === seq.current) dispatch({ type: 'failed', code: codeOf(e) })
        },
      )
    },
    [workspaceId],
  )

  // The search box, debounced; the list it shows answers `listedFor`.
  useEffect(() => {
    if (s.step !== 'pick') return
    const query = s.query.trim().slice(0, MIRO_IMPORT_LIMITS.queryChars)
    if (query === listedFor.current) return
    const t = setTimeout(() => load(s.token, query, 0), MIRO_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [s.step, s.query, s.token, load])

  // Progress: poll the job until it has finished or waits for its starter (paused, interrupted).
  const importId = s.importId
  const polling = s.step === 'job' && importId !== null && !(s.job && stopsPolling(s.job))
  useEffect(() => {
    if (!polling || importId === null) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const view = await getImportJob(importId)
      if (!live) return
      if (view) dispatch({ type: 'job', job: view })
      if (!view || !stopsPolling(view)) timer = setTimeout(() => void tick(), IMPORT_POLL_MS)
    }
    timer = setTimeout(() => void tick(), 0)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [polling, importId])

  // Each board that becomes a board refreshes the dashboard's list.
  const onFinishedRef = useRef(onFinished)
  onFinishedRef.current = onFinished
  const doneCount = s.job?.boards.filter((b) => b.status === 'done').length ?? 0
  useEffect(() => {
    if (doneCount > 0) onFinishedRef.current()
  }, [doneCount])

  const act = (run: () => Promise<ImportJobView>) => {
    dispatch({ type: 'busy' })
    run().then(
      (job) => dispatch({ type: 'job', job }),
      (e: unknown) => dispatch({ type: 'failed', code: codeOf(e) }),
    )
  }

  /** Cancel and Pause: the job's own write, its answer the new view. */
  const onJob = (write: (importId: string) => Promise<ImportJobView>) => {
    const job = s.job
    if (job && !s.busy) act(() => write(job.importId))
  }

  const onContinue = () => {
    if (s.busy) return
    const token = cleanToken(s.token)
    if (!token) {
      dispatch({ type: 'failed', code: MIRO_CODES.tokenInvalid })
      return
    }
    dispatch({ type: 'token', value: token })
    load(token, '', 0)
  }

  const onStart = () => {
    if (s.busy || s.picked.length === 0) return
    dispatch({ type: 'busy' })
    startMiroImport(workspaceId, s.token, startInput(s)).then(
      (r) => dispatch({ type: 'started', importId: r.importId }),
      (e: unknown) => dispatch({ type: 'failed', code: codeOf(e) }),
    )
  }

  const onResume = () => {
    const job = s.job
    if (!job || s.busy) return
    if (!job.resumeNeedsToken) {
      act(() => resumeImport(job.importId))
      return
    }
    const token = cleanToken(s.resumeToken)
    if (!token) {
      dispatch({ type: 'failed', code: MIRO_CODES.tokenInvalid })
      return
    }
    act(() => resumeImport(job.importId, token))
  }

  const finished = s.job !== null && isFinished(s.job.status)
  return (
    <Dialog
      title={<MiroTitle />}
      description={finished ? undefined : 'Each Miro board becomes a new private Lobby board.'}
      onClose={onClose}
      testId="miro-import-dialog"
      size="lg"
    >
      <MiroImportBody
        state={s}
        projects={projects}
        dispatch={dispatch}
        onContinue={onContinue}
        onMore={() => load(s.token, listedFor.current, s.boards.length)}
        onStart={onStart}
        onCancel={() => onJob(cancelImport)}
        onPause={() => onJob(pauseImport)}
        onResume={onResume}
        onClose={onClose}
      />
    </Dialog>
  )
}
