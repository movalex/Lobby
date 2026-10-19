// OWNER: WS2 (wave W, background removal; docs/WAVE-W-CONTRACTS.md §4.1 step 4). What may be offered, and the one write.
//
//   - offered on ONE selected image (not a placed PDF page, not a card) that this tab may write (not read-only, not
//     locked), whose file is a PNG, JPEG or WebP within REMOVE_BG_LIMITS.maxInputBytes, to a person with an account
//     (the api refuses name-only guests anyway), and only while the web switch AND the api's offer are on
//     (formatsEnabled('removeBackground'): DRAFTROOM_REMOVE_BACKGROUND and a worker with the capability seen recently);
//   - the swap: the element's `fileId` and `customData.lobby.file` move to the new version in ONE canvas.transact, so
//     it is one undo step and undo puts the original back. Its box, crop, alt text, tags and every other key stay (the
//     result has the source's proportions). Only a `ver_` id and the version's facts are written: never a data:, blob:
//     or signed URL (the loader fills the picture from the stored version). Nothing is written when the element no
//     longer shows the source (it was replaced, deleted, locked or the board turned read-only meanwhile).

import { REMOVE_BG_LIMITS } from '@draftroom/contracts'
import type { CanvasElement, CanvasFeatureContext } from '../../canvas/api/index.ts'
import { type FileFacts, factsOf, fileItemKind } from '../../file-card/ported/model.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { formatsEnabled } from '../formats/flags.ts'

export const REMOVE_BG_COMMAND_ID = 'image.remove-background'
export const REMOVE_BG_LABEL = 'Remove background (beta)'
/** The undo step's name (the history panel and the undo toast read it). */
export const REMOVE_BG_STEP = 'Remove background'

type Ctx = Pick<CanvasFeatureContext, 'canvas' | 'me'>

/** Why this element's file cannot have its background removed (null: it can), from its facts alone. */
export function fileRefusal(facts: FileFacts): string | null {
  if (facts.kind !== 'image' || !REMOVE_BG_LIMITS.inputMimeTypes.includes(facts.mimeType))
    return 'Background removal works on PNG, JPEG and WebP images.'
  if (facts.sizeBytes > REMOVE_BG_LIMITS.maxInputBytes) return 'This image is too large (25 MB at most).'
  return null
}

/** The one selected image this tab may remove the background of, or null. `offered` is the switches' answer. */
export function removeBgTarget(
  ctx: Ctx,
  ids: readonly string[],
  offered: () => boolean = () => formatsEnabled('removeBackground'),
): CanvasElement | null {
  if (ids.length !== 1 || !offered()) return null
  const el = ctx.canvas.get(ids[0] as string)
  if (!el || el.isDeleted || fileItemKind(el) !== 'image') return null
  const facts = factsOf(el)
  if (!facts || fileRefusal(facts)) return null
  if (ctx.canvas.readOnly() || ctx.canvas.isLocked(el.id)) return null
  if (knownUserKind(ctx.me.user.id) === 'guest') return null
  return el
}

export type SwapOutcome = 'swapped' | 'gone' | 'changed' | 'locked'

/**
 * Points element `id` at `result` if it still shows `sourceVersionId`: one transact (one undo step) that writes only
 * `fileId` and `customData.lobby.file`.
 */
export function swapToResult(
  ctx: Pick<CanvasFeatureContext, 'canvas'>,
  id: string,
  sourceVersionId: string,
  result: FileFacts,
): SwapOutcome {
  const canvas = ctx.canvas
  const el = canvas.get(id)
  if (!el || el.isDeleted) return 'gone'
  const now = factsOf(el)
  const fileId = (el as { fileId?: string | null }).fileId
  if (!now || now.versionId !== sourceVersionId || fileId !== sourceVersionId) return 'changed'
  if (canvas.readOnly() || canvas.isLocked(id)) return 'locked'
  if (!/^ver_[0-9A-Za-z]{10,40}$/.test(result.versionId) || !/^ast_[0-9A-Za-z]{10,40}$/.test(result.assetId))
    return 'changed'
  canvas.transact(REMOVE_BG_STEP, (tx) =>
    tx.update(id, {
      fileId: result.versionId,
      // every other lobby key (alt text, tags, slot, present) stays: it is the same picture without its background
      customData: { lobby: { file: { ...result } } },
    }),
  )
  return 'swapped'
}
