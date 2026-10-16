// OWNER: WS4 (wave T; registered empty by the wave T foundation, docs/WAVE-T-CONTRACTS.md §1, §6.4). The 'card-table'
// feature on the Excalidraw board page: the card table (T4).
//
//  - the Cards dock panel (./Panel.tsx): every card on the board (or the selection's), search, filters, sort, inline
//    edits (each one undo step), "Show on board", CSV out under the export policy and CSV in (./Import.tsx);
//  - the palette's `card-table.open` and a board-menu entry;
//  - the Export dialog's `card-table-csv` section (present-export/ported/export-sections.ts).
//
// While its switch is off (features/planning/flags.ts PLANNING_FLAGS.table) the feature contributes nothing.
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CanvasPanelSpec,
  CommandSpec,
  LobbyCanvas,
  MenuEntrySpec,
} from '../../canvas/api/index.ts'
import { cardsOf } from '../cards/bridge.ts'
import { TableIcon } from '../cards/icons.tsx'
import { todayLocal } from '../cards/model.ts'
import { planningShown } from '../planning/index.ts'
import { type ExportSectionProps, registerExportSection } from '../present-export/ported/export-sections.ts'
import { CARD_TABLE_PANEL_ID, CardTablePanel, downloadTableCsv } from './Panel.tsx'
import { tableRows } from './rows.ts'
import './card-table.css'

export { CARD_TABLE_PANEL_ID }

export const PANELS: readonly CanvasPanelSpec[] = [
  { id: CARD_TABLE_PANEL_ID, label: 'Cards', icon: TableIcon, order: 57, component: CardTablePanel },
]

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: 'card-table.open',
    label: 'Card table',
    group: 'Plan',
    keywords: ['cards', 'table', 'list', 'csv', 'spreadsheet', 'status', 'assignee', 'due'],
    readOnlyAllowed: true,
    run: (ctx) => ctx.openPanel(CARD_TABLE_PANEL_ID),
  },
]

export const MAIN_MENU: readonly MenuEntrySpec[] = [
  { id: 'card-table-open', group: 'view', order: 40, label: 'Card table', command: 'card-table.open' },
]

/** The feature contexts by canvas, for the Export section (it gets the canvas only). */
const contexts = new WeakMap<LobbyCanvas, CanvasFeatureContext>()

function CsvSection({ canvas, boardTitle, selectedIds, disabled, run }: ExportSectionProps) {
  const ctx = contexts.get(canvas)
  if (!ctx) return null
  const sel = new Set(selectedIds)
  const all = () => tableRows(ctx, cardsOf(canvas), todayLocal())
  const some = selectedIds.length > 0 && all().some((r) => sel.has(r.id))
  return (
    <section className="dr-pe-section" aria-labelledby="dr-ct-export-h" data-testid="export-card-table">
      <h3 id="dr-ct-export-h" className="dr-pe-section__title">
        Card table
      </h3>
      <p className="dr-pe-text">
        Every card's title, status, assignee, dates, tags and link, as a spreadsheet.
      </p>
      <div className="dr-pe-actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="export-card-table-csv"
          disabled={disabled}
          onClick={() => void run(async () => downloadTableCsv(boardTitle, all()))}
        >
          Download all cards (CSV)
        </button>
        {some && (
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="export-card-table-csv-selection"
            disabled={disabled}
            onClick={() =>
              void run(async () =>
                downloadTableCsv(
                  boardTitle,
                  all().filter((r) => sel.has(r.id)),
                ),
              )
            }
          >
            Selected cards only
          </button>
        )}
      </div>
    </section>
  )
}

function mount(ctx: CanvasFeatureContext): () => void {
  contexts.set(ctx.canvas, ctx)
  const off = registerExportSection({
    id: 'card-table-csv',
    order: 30,
    offered: (canvas) => contexts.has(canvas) && canvas.index.withLobbyKey('card:status').length > 0,
    Section: CsvSection,
  })
  return () => {
    off()
    contexts.delete(ctx.canvas)
  }
}

/** The feature for this page's switch: everything with it on, nothing with it off. */
export function cardTableFeature(on: boolean): CanvasFeature {
  if (!on) return { id: 'card-table' }
  return { id: 'card-table', panels: PANELS, commands: COMMANDS, mainMenu: MAIN_MENU, onMount: mount }
}

export const feature: CanvasFeature = cardTableFeature(planningShown('table'))
