// API schemas for the per-board export policy (docs/WAVE3-CONTRACTS.md "export-control"). Browser-safe.
// Owned by the export-control owner.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// `exportPolicy`: 'everyone' (the default, and the behaviour before wave 3) or 'editors'. With
// 'editors', viewers and commenters (guests included: the rule follows the board role) cannot export
// the board (PNG, SVG, PDF, CSV, the .lobby.json archive), copy it (Ctrl/Cmd+C, Copy as PNG/SVG),
// duplicate it or restore a checkpoint as a new board, or download original files. File previews and
// the PDF page images that render on the board keep working for everyone. This is not a data-protection
// feature: anyone who can see the board can still take screenshots.

import { type BoardRole, roleAtLeast } from '@draftroom/permissions'
import { z } from 'zod'

export const EXPORT_POLICIES = ['everyone', 'editors'] as const
export const ExportPolicy = z.enum(EXPORT_POLICIES)
export type ExportPolicy = z.infer<typeof ExportPolicy>

/** A board without a stored policy behaves like this. */
export const DEFAULT_EXPORT_POLICY: ExportPolicy = 'everyone'

/**
 * Whether someone with `role` may export, copy and download on a board with `policy`. The board role
 * decides, never the board status: an owner of an archived board can still export it.
 */
export function exportAllowedFor(role: BoardRole | null | undefined, policy: ExportPolicy): boolean {
  if (!role) return false
  return policy === 'everyone' || roleAtLeast(role, 'editor')
}

/** `GET /api/boards/:bid/export-policy` (view) and the answer to `PUT` (board owners). */
export const ExportPolicyState = z.object({
  exportPolicy: ExportPolicy,
  /** Whether the CALLER may export, copy and download on this board. */
  canExport: z.boolean(),
})
export type ExportPolicyState = z.infer<typeof ExportPolicyState>

/** `PUT /api/boards/:bid/export-policy` (manage_access: board owners). */
export const PutExportPolicyInput = z.object({ exportPolicy: ExportPolicy }).strict()
export type PutExportPolicyInput = z.infer<typeof PutExportPolicyInput>

/**
 * Board events (published after the change committed). The payload is the board's policy only, the
 * same for every viewer; each client works out its own `canExport` from its role.
 */
export const EXPORT_CONTROL_EVENTS = { policy: 'export-control.policy' } as const
export const ExportPolicyEvent = z.object({ exportPolicy: ExportPolicy })
export type ExportPolicyEvent = z.infer<typeof ExportPolicyEvent>

/** The refusal every enforced route answers with (403). */
export const EXPORT_DISABLED_CODE = 'EXPORT_DISABLED'
export const EXPORT_DISABLED_MESSAGE = 'The board owner turned off exporting for viewers.'
