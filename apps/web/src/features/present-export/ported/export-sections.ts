// The Export dialog's kind slot (wave T foundation; docs/WAVE-T-CONTRACTS.md §6.3): a section a feature adds to the
// dialog, after its PDF and CSV sections, for an export kind of its own: WS3's storyboard PDF sheet and image
// sequence (with timings CSV and EDL), WS4's card table CSV. A section is offered per canvas (`offered`: its switch,
// and whether the board holds anything for it) and runs its export through the dialog's own busy state, status line
// and Cancel (`run`), so every kind looks and fails alike. The dialog is only open when the board's export policy lets
// this person export (sharing/export-policy.ts), and every file goes through ../download.ts like the others (the e2e
// download rule counts a File System Access picker as a download).
//
// With no section registered, the dialog is exactly as before.
import type { ComponentType } from 'react'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'

export type ExportSectionId = 'storyboard-sheet' | 'storyboard-sequence' | 'card-table-csv'

export interface ExportSectionProps {
  readonly canvas: LobbyCanvas
  readonly boardTitle: string
  /** the ids selected when the dialog opened (live) */
  readonly selectedIds: readonly string[]
  /** another export is running: every button of the dialog is disabled */
  readonly disabled: boolean
  /**
   * Runs one export with the dialog's busy state: `task` resolves the status line's words ("Downloaded …"), throws
   * ExportCancelled when the person cancelled, or any error (the dialog's general failure words).
   */
  run(task: (signal: AbortSignal) => Promise<string>): Promise<void>
}

export interface ExportSectionSpec {
  readonly id: ExportSectionId
  /** order among the sections (low first) */
  readonly order: number
  /** whether this canvas gets the section now (its switch, and something to export) */
  offered(canvas: LobbyCanvas): boolean
  readonly Section: ComponentType<ExportSectionProps>
}

const sections = new Map<ExportSectionId, ExportSectionSpec>()

/** Adds (or replaces) a section; returns its removal. Registered once, at module load or on the feature's mount. */
export function registerExportSection(spec: ExportSectionSpec): () => void {
  sections.set(spec.id, spec)
  return () => {
    if (sections.get(spec.id) === spec) sections.delete(spec.id)
  }
}

/** The sections this canvas is offered, in order. */
export const exportSectionsFor = (canvas: LobbyCanvas): ExportSectionSpec[] =>
  [...sections.values()]
    .filter((s) => s.offered(canvas))
    .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
