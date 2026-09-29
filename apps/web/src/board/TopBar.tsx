// The tldraw board page's top bar: the shared layout (./TopBarFrame.tsx) with the tldraw page's people
// list, live-presentation chip and BOARD_FEATURES controls. The Excalidraw page renders the same frame
// with its registries (canvas/board/**).
import type { Board } from '@draftroom/contracts'
import type { Editor } from 'tldraw'
import { FeatureTopBarItems, PINNED_TOP_BAR_FEATURES } from '../features/FeatureHost.tsx'
import { LiveChip, PeopleTopBar } from '../features/people/index.tsx'
import type { BoardFeature, FeatureContext } from '../features/types.ts'
import type { BoardRole } from '../lib/permissions.ts'
import type { SaveStatusView } from '../sync-quality/SaveStatus.tsx'
import { type ConnState, TopBarFrame } from './TopBarFrame.tsx'

export type { ConnState } from './TopBarFrame.tsx'
export { BoardAccount } from './TopBarFrame.tsx'

export function TopBar({
  features,
  featureCtx,
  board,
  role,
  workspace,
  selfUserId,
  conn,
  save,
  editor,
  onRename,
  onShare,
  onRequestAccess,
}: {
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
  selfUserId: string
  /** The socket only ("Live"): never evidence that anything was saved. */
  conn: ConnState
  /** What the server has acknowledged (sync-quality/saveTracker.ts). */
  save: SaveStatusView
  editor: Editor | null
  onRename(title: string): void
  onShare(): void
  /** The role pill opens the request-more-access flow (PRI-09b). */
  onRequestAccess(): void
  /** Feature slot (features/FeatureHost.tsx): compact controls placed before Share. */
  features: readonly BoardFeature[]
  featureCtx: FeatureContext | null
}) {
  return (
    <TopBarFrame
      board={board}
      role={role}
      workspace={workspace}
      conn={conn}
      save={save}
      onRename={onRename}
      onShare={onShare}
      onRequestAccess={onRequestAccess}
      liveChip={<LiveChip ctx={featureCtx} />}
      people={(max) => <PeopleTopBar editor={editor} ctx={featureCtx} selfUserId={selfUserId} max={max} />}
      items={(mode) =>
        mode === 'all' ? (
          <FeatureTopBarItems features={features} ctx={featureCtx} />
        ) : mode === 'pinned' ? (
          <FeatureTopBarItems features={features} ctx={featureCtx} only={PINNED_TOP_BAR_FEATURES} />
        ) : (
          <FeatureTopBarItems features={features} ctx={featureCtx} except={PINNED_TOP_BAR_FEATURES} stacked />
        )
      }
    />
  )
}
