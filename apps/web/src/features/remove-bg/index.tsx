// OWNER: WS2 (wave W, background removal; docs/WAVE-W-CONTRACTS.md §4). The 'remove-bg' feature on the Excalidraw board
// page:
//   - "Remove background (beta)" on one selected ready image: the edit menu's row (file-card/ported/edit-media.tsx
//     editMenu, one row) and the palette command 'image.remove-background' (held while the contracts list it pending,
//     PENDING_PALETTE_COMMAND_IDS, as ai.capture and breakouts.start were: the lead releases it at integration);
//   - the tracker (./run.ts): this tab's ops followed by their `file.op` events (GET /api/file-ops/:op on reconnects and
//     every few seconds while one is pending), and on done the element's `fileId` and `customData.lobby.file` swapped to
//     the new version in ONE canvas.transact (./model.ts: one undo step; undo puts the original back; never a data:,
//     blob: or signed URL).
// Offered only while its web switch (features/formats/flags.ts FORMATS_FLAGS.removeBackground) AND the api's offer
// (DRAFTROOM_REMOVE_BACKGROUND and a worker that reported the remove-bg capability recently) are on: off, it offers
// nothing and makes no request (the tracker only listens, and has nothing to follow).
import { PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import type { CanvasFeature, CommandSpec } from '../../canvas/api/index.ts'
import { REMOVE_BG_COMMAND_ID, REMOVE_BG_LABEL, removeBgTarget } from './model.ts'
import { mountTracker, startRemoveBackground } from './run.ts'

/** Whether the contracts still hold the palette command pending (then the palette does not offer it). */
export const removeBgCommandHeld = (pending: readonly string[] = PENDING_PALETTE_COMMAND_IDS): boolean =>
  pending.includes(REMOVE_BG_COMMAND_ID)

export const REMOVE_BG_COMMANDS: readonly CommandSpec[] = [
  {
    id: REMOVE_BG_COMMAND_ID,
    label: REMOVE_BG_LABEL,
    group: 'Edit',
    keywords: ['background', 'remove', 'cut out', 'cutout', 'transparent', 'image', 'photo'],
    disabledReason: (ctx) =>
      removeBgTarget(ctx, ctx.canvas.selection) ? null : 'Select one PNG, JPEG or WebP image you can edit',
    run: (ctx) => void startRemoveBackground(ctx, ctx.canvas.selection),
  },
]

export const feature: CanvasFeature = {
  id: 'remove-bg',
  commands: removeBgCommandHeld() ? [] : REMOVE_BG_COMMANDS,
  onMount: (ctx) => mountTracker(ctx),
}
