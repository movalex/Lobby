// reader-frames.ts: a message frame is serialized once per reader revision (once in all when nothing in it is newer
// than its reader), in the form canvas-schema's `frameForReader` gives that revision; and the room writes to a
// session's socket through `Session.send` only (the one send point), so no frame type can skip the rule.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { CONTRACTS_REV, type ServerMessage, UNANNOUNCED_REV } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it, vi } from 'vitest'
import { catchUpFrame, frameOf, MessageFrame, presenceFrame } from './reader-frames.ts'

const frameEl = {
  id: 'f1',
  type: 'frame',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roundness: null,
  roughness: 0,
  opacity: 100,
  seed: 1,
  version: 4,
  versionNonce: 9,
  index: 'a0',
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: 2,
  created: 1,
  link: null,
  locked: false,
  name: 'Warm-up',
  customData: { lobby: { present: { index: 0, mins: 5 } } },
} as unknown as WireElement

const minsChanges: ServerMessage = {
  type: 'changes',
  clock: 4,
  ops: [{ k: 'p', id: 'f1', v: 4, vn: 9, pv: 3, updated: 2, c: { present: { index: 0, mins: 5 } } }],
}

describe('MessageFrame', () => {
  it('a rev-12 reader gets the message as it is; a rev-11 reader the `c` op of the stored element', () => {
    const f = frameOf(minsChanges, (id) => (id === 'f1' ? frameEl : undefined))
    expect(JSON.parse(f.json(CONTRACTS_REV))).toEqual(minsChanges)
    expect(JSON.parse(f.json(UNANNOUNCED_REV))).toEqual({
      type: 'changes',
      clock: 4,
      ops: [{ k: 'c', el: frameEl }],
    })
    // a newer reader than this room reads this room's form
    expect(f.json(CONTRACTS_REV + 3)).toBe(f.json(CONTRACTS_REV))
  })

  it('is serialized once per reader revision, and once in all when nothing in it is newer than its reader', () => {
    const spy = vi.spyOn(JSON, 'stringify')
    try {
      const f = frameOf(minsChanges, () => frameEl)
      for (let i = 0; i < 50; i++) {
        f.json(12)
        f.json(11)
      }
      expect(spy).toHaveBeenCalledTimes(2)
      spy.mockClear()
      const plain = frameOf({ type: 'lease', id: 'n1', holder: null })
      for (let i = 0; i < 50; i++) {
        plain.json(12)
        plain.json(11)
        plain.json(9)
      }
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('formed frames (catch-up, presence) are sent as built', () => {
    expect(catchUpFrame('{"type":"changes","clock":1,"ops":[]}').text).toBe(
      '{"type":"changes","clock":1,"ops":[]}',
    )
    expect(presenceFrame('{"type":"presence","peers":[]}').text).toBe('{"type":"presence","peers":[]}')
    expect(frameOf({ type: 'pong' })).toBeInstanceOf(MessageFrame)
  })
})

describe('the one send point', () => {
  it("the room writes to a session's outbound queue only in Session.send", () => {
    const src = readFileSync(join(import.meta.dirname, 'element-room.ts'), 'utf8')
    const writes = src.split('\n').filter((l) => /\.out\.send\(/.test(l))
    // the three branches of Session.send itself, nothing else (a frame sent around it skips frameForReader)
    expect(writes.map((l) => l.trim())).toEqual([
      'if (frame instanceof MessageFrame) this.out.send(frame.json(this.reader))',
      'else if (frame instanceof Uint8Array || frame instanceof Promise) this.out.send(frame)',
      'else this.out.send(frame.text)',
    ])
    // and no frame is serialized ad hoc for a session: every JSON frame is a frameOf, catchUpFrame or presenceFrame
    expect(src).not.toMatch(/s\.send\(JSON\.stringify/)
    expect(src).not.toMatch(/broadcast\(JSON\.stringify/)
  })
})
