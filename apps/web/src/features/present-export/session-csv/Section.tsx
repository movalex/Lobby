// OWNER: WS5 (wave V, the session summary; docs/WAVE-V-CONTRACTS.md §5). The Export dialog's "Session results (CSV)"
// section (its kind slot, ../ported/export-sections.ts id `session-csv`): every live activity's results on this board
// as one formula-safe spreadsheet (./csv.ts). With the Recap frame (Wrap up, "Add as Recap frame") it is the session
// summary to take away.
//
// Offered while the summary's switch is on (features/live liveEnabled('summary')) and the api runs live activities
// (its switch, GET /api/auth/config `live.activities`: off, the list route is an unknown route). The dialog itself
// opens only under the board's export policy, and the file goes through ../download.ts like every other export (the
// e2e download rule counts a File System Access picker as a download). Registered by ../../ai/recap/recap.ts.
import { type ActivitySummary, activitiesPath, ListActivitiesResponse } from '@draftroom/contracts'
import type { CanvasFeatureContext, CommandSpec, LobbyCanvas } from '../../../canvas/api/index.ts'
import { getAiCtx } from '../../ai/ported/runtime.ts'
import { liveEnabled, liveSwitches } from '../../live/index.ts'
import { downloadBlob } from '../download.ts'
import { exportFilename } from '../filename.ts'
import { getController } from '../ported/controller.ts'
import { csvBlob } from '../ported/csv.ts'
import type { ExportSectionProps, ExportSectionSpec } from '../ported/export-sections.ts'
import { sessionCsv } from './csv.ts'

/** The file's qualifier: "<board> - Session results.csv". */
export const SESSION_CSV_QUALIFIER = 'Session results'

/** Every activity the api lists for this board (aggregates only: ./csv.ts). */
export async function loadSessionActivities(
  ctx: Pick<CanvasFeatureContext, 'api' | 'board'>,
  signal?: AbortSignal,
): Promise<ActivitySummary[]> {
  const r = await ctx.api.request('GET', activitiesPath(ctx.board.id), {
    schema: ListActivitiesResponse,
    ...(signal ? { signal } : {}),
  })
  return r.activities
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one.replace(/y$/, 'ie')}s`}`

/** Fetches, writes and downloads the file; the dialog's status words. */
export async function downloadSessionCsv(
  ctx: Pick<CanvasFeatureContext, 'api' | 'board'>,
  boardTitle: string,
  signal?: AbortSignal,
  now: number = Date.now(),
): Promise<string> {
  const list = await loadSessionActivities(ctx, signal)
  if (!list.length)
    return 'No poll, scale or word cloud has run on this board yet: there is nothing to export.'
  const name = exportFilename(boardTitle || 'Board', 'csv', SESSION_CSV_QUALIFIER)
  downloadBlob(csvBlob(sessionCsv(list, now)), name)
  return `Downloaded “${name}” (${plural(list.length, 'activity')}).`
}

/** Whether this canvas gets the section (see the header). */
export function sessionCsvOffered(canvas: LobbyCanvas): boolean {
  return liveEnabled('summary') && liveSwitches.get().activities === true && !!getAiCtx(canvas)
}

function SessionCsvSection({ canvas, boardTitle, disabled, run }: ExportSectionProps) {
  const ctx = getAiCtx(canvas)
  if (!ctx) return null
  return (
    <section
      className="dr-pe-section"
      aria-labelledby="dr-session-csv-h"
      data-testid="export-session-csv-section"
    >
      <h3 id="dr-session-csv-h" className="dr-pe-section__title">
        Session results
      </h3>
      <p className="dr-pe-text">
        Every poll, scale and word cloud of this board with its counts, as a spreadsheet. Counts only: never
        who answered what.
      </p>
      <div className="dr-pe-actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="export-session-csv"
          disabled={disabled}
          onClick={() => void run((signal) => downloadSessionCsv(ctx, boardTitle, signal))}
        >
          Download session results (CSV)
        </button>
      </div>
    </section>
  )
}

export const SESSION_CSV_COMMAND_ID = 'session-summary.csv'

/**
 * The palette's "Download session results (CSV)" (the wave V integration; registered by the present-export feature): the
 * same file as the section, offered while the section would be, under the same export policy (the controller says why
 * when it refuses, as the dialog would).
 */
export const SESSION_CSV_COMMAND: CommandSpec = {
  id: SESSION_CSV_COMMAND_ID,
  label: 'Download session results (CSV)',
  group: 'Export',
  keywords: ['session', 'summary', 'results', 'csv', 'spreadsheet', 'poll', 'word cloud'],
  readOnlyAllowed: true,
  available: () => liveEnabled('summary') && liveSwitches.get().activities === true,
  run: async (ctx) => {
    const c = getController(ctx.canvas)
    c.attach({ id: ctx.board.id, title: ctx.board.title, notify: ctx.notify })
    // not allowed to export here: openExport only says why (and opens nothing)
    if (!c.exportAllowed()) return c.openExport()
    try {
      const text = await downloadSessionCsv(ctx, ctx.board.title)
      ctx.notify({ key: 'session-csv', text, testId: 'session-csv-toast' })
    } catch {
      ctx.notify({
        key: 'session-csv',
        text: 'The session results could not be downloaded. Try again.',
        tone: 'error',
        testId: 'session-csv-toast',
      })
    }
  },
}

export const SESSION_CSV_SECTION: ExportSectionSpec = {
  id: 'session-csv',
  // after wave T's storyboard sheet (10), image sequence and card table
  order: 50,
  offered: sessionCsvOffered,
  Section: SessionCsvSection,
}
