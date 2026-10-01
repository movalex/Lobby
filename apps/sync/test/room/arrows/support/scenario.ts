// One ElementRoom service per test file, opened lazily INSIDE each test (so a room that cannot start
// fails every room test on its own, and the client-side tests of the same file still run), closed after
// the file. Frozen with the tests (lead-owned).

import { afterAll } from 'vitest'
import { openRoomService, type Room, type RoomService } from './room.ts'

let service: Promise<RoomService> | null = null
let boards = 0

/** A fresh board on this file's room service (created on first use). */
export async function freshBoard(label: string): Promise<Room> {
  service ??= openRoomService()
  const s = await service
  return s.board(
    `b-arr-${label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)}-${++boards}`,
  )
}

afterAll(async () => {
  const s = service
  service = null
  if (!s) return
  try {
    await (await s).close()
  } catch {
    // a service that never started has nothing to close
  }
})
