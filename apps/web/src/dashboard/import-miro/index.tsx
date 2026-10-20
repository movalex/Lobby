// OWNER: WS1 (wave R, import from Miro). What the dashboard mounts: `useMiroImport(…)` gives the Import menu's
// "From Miro…" handler (`open`) and the dialog to render (`dialog`, null while closed). The dialog is its own chunk,
// fetched the first time it opens (as the Share dialog is: dashboard-bundle.test.ts), and unmounts when it closes,
// which drops the token it held.
import type { Project } from '@draftroom/contracts'
import { lazy, type ReactNode, Suspense, useCallback, useState } from 'react'
import { ownedImport } from '../../lib/stale-chunk.ts'
import { LazyDialogBoundary } from '../LazyDialogBoundary.tsx'

// owned: a chunk that is gone gets the boundary's notice, not a reload (lib/stale-chunk.ts ownedImport)
const MiroImportDialog = lazy(ownedImport(() => import('./MiroImportDialog.tsx')))

export function useMiroImport({
  workspaceId,
  projects,
  defaultProjectId,
  onFinished,
}: {
  workspaceId: string
  projects: readonly Project[]
  /** the project the dashboard shows (the new boards' default destination), or null */
  defaultProjectId: string | null
  /** a board of an import became a board: reload the list */
  onFinished(): void
}): { open(): void; dialog: ReactNode } {
  const [shown, setShown] = useState(false)
  const open = useCallback(() => setShown(true), [])
  const close = useCallback(() => setShown(false), [])
  const dialog = shown ? (
    <LazyDialogBoundary what="Import from Miro" onClose={close}>
      <Suspense fallback={null}>
        <MiroImportDialog
          workspaceId={workspaceId}
          projects={projects}
          defaultProjectId={defaultProjectId}
          onClose={close}
          onFinished={onFinished}
        />
      </Suspense>
    </LazyDialogBoundary>
  ) : null
  return { open, dialog }
}
