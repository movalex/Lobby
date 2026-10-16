// OWNER: the wave R foundation (the lead). The dashboard's Import control (docs/WAVE-R-CONTRACTS.md §7): today's
// "Import" button (a Lobby board, .json), or, once its switch and at least one more entry are on, an "Import" menu:
//
//   Lobby backup (.lobby)…   WS4 (dashboard/import-backup): restore a backup as a new board
//   Lobby board (.json)…     today's file input (DashboardPage), unchanged
//   Import from Miro (beta)… WS1 (dashboard/import-miro): the token, the board picker, progress, the report
//
// Creators only, as today (the dashboard shows it only with `canCreate`). An entry whose handler is missing is left out
// (WS1 and WS4 pass theirs), so the menu never offers what this build cannot do.
import { MenuButton } from '../../ui/Menu.tsx'
import { type ImportMenuFlags, importMenuFlags } from './flags.ts'

export type ImportAction = 'backup' | 'json' | 'miro'

export const IMPORT_MENU_LABELS: Readonly<Record<ImportAction, string>> = {
  backup: 'Lobby backup (.lobby)…',
  json: 'Lobby board (.json)…',
  miro: 'Import from Miro (beta)…',
}

/** The entries offered, in order; a single entry means no menu (today's button). */
export function importMenuEntries(
  flags: ImportMenuFlags,
  handlers: { backup?: unknown; miro?: unknown },
): { action: ImportAction; label: string }[] {
  if (!flags.menu) return [{ action: 'json', label: IMPORT_MENU_LABELS.json }]
  const actions: ImportAction[] = [
    ...(flags.backup && handlers.backup ? (['backup'] as const) : []),
    'json',
    ...(flags.miro && handlers.miro ? (['miro'] as const) : []),
  ]
  return actions.map((action) => ({ action, label: IMPORT_MENU_LABELS[action] }))
}

export function ImportMenu({
  importing,
  onJson,
  onBackup,
  onMiro,
  flags = importMenuFlags(),
}: {
  importing: boolean
  /** opens today's .json file input */
  onJson(): void
  /** WS4: opens the restore dialog */
  onBackup?: () => void
  /** WS1: opens the Miro dialog */
  onMiro?: () => void
  flags?: ImportMenuFlags
}) {
  const entries = importMenuEntries(flags, { backup: onBackup, miro: onMiro })
  if (entries.length === 1)
    return (
      <button
        type="button"
        className="dr-btn"
        data-testid="import-board"
        disabled={importing}
        title="Import a board exported from Lobby (.json)"
        onClick={onJson}
      >
        {importing ? 'Importing…' : 'Import'}
      </button>
    )
  return (
    <MenuButton
      label="Import"
      className="dr-btn"
      testId="import-menu"
      align="start"
      items={entries}
      onSelect={(action: ImportAction) => {
        if (action === 'json') onJson()
        else if (action === 'backup') onBackup?.()
        else onMiro?.()
      }}
    >
      {importing ? 'Importing…' : 'Import'}
    </MenuButton>
  )
}
