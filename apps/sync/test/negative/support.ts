// Shared bits of the negative security suite (docs/EXCALIDRAW-MIGRATION.md §6.2 "Negative security suite":
// one test per server rule, against the REAL sync server process on DRAFTROOM_ENGINE=excalidraw, through
// the protocol harness of apps/sync/test/harness/element-stack.ts). Every refusal is checked three ways:
// the op's answer (code), the socket (still open unless the rule closes it), and the store (the test
// snapshot never holds what was refused).

import type { AckResult } from '@draftroom/canvas-schema/protocol'
import { expect } from 'vitest'
import type { ProtocolClient } from '../harness/element-client.ts'
import type { ElementStack } from '../harness/element-stack.ts'
import type { El } from '../harness/elements.ts'

export type Result = AckResult

/** The op was refused with `code`, and the socket stays open. */
export function expectRefused(r: Result, code: string, c?: ProtocolClient): void {
  expect(r, `refused with ${code}`).toMatchObject({ ok: false, code })
  if (c) expect(c.isOpen, 'the socket stays open after a per-op refusal').toBe(true)
}

/** The op was accepted (optionally with the server's `fix`). */
export function expectAccepted(r: Result): Extract<Result, { ok: true }> {
  expect(r, 'accepted').toMatchObject({ ok: true })
  return r as Extract<Result, { ok: true }>
}

/** None of `ids` is stored (live or tombstone). */
export async function expectNotStored(
  st: ElementStack,
  boardId: string,
  ids: readonly string[],
): Promise<void> {
  const snap = await st.snapshot(boardId)
  const stored = snap.elements.map((e) => e.id).filter((id) => ids.includes(id))
  expect(stored, 'refused elements are not stored').toEqual([])
}

/** The stored copy of `id` (throws when there is none). */
export async function storedEl(st: ElementStack, boardId: string, id: string): Promise<El> {
  const el = await st.stored(boardId, id)
  if (!el) throw new Error(`${id} is not stored on ${boardId}`)
  return el
}

/** `customData.lobby` of the stored copy of `id`. */
export async function storedLobby(
  st: ElementStack,
  boardId: string,
  id: string,
): Promise<Record<string, unknown>> {
  return ((await storedEl(st, boardId, id)).customData?.lobby ?? {}) as Record<string, unknown>
}
