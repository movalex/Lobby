// OWNER: W5 (wave L). 'present-export.export' {frameIds} (workshops/commands.ts PresentExportArgs): the frames a
// caller (W2's "Export recap as PDF") wants the Export dialog to open on. The dialog picks its PDF pages from the
// selection (ExportDialog `pickPdfFrames`), so the command selects those frames and opens it on the PDF.
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { presentExportArgs } from '../../workshops/commands.ts'

/** The ids in `args.frameIds` that are frames on the board now (anything else is left out); none without args. */
export function exportFrameIds(canvas: Pick<LobbyCanvas, 'get'>, args: unknown): string[] {
  return (presentExportArgs(args).frameIds ?? []).filter((id) => {
    const el = canvas.get(id)
    return el?.type === 'frame' && !(el as { isDeleted?: boolean }).isDeleted
  })
}
