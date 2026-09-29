// The Excalidraw-engine protocol harness checks itself (./element-stack.ts): the builders make valid wire
// elements; the server really runs the element engine (a tldraw `connect` is refused, the test snapshot
// route exists); a raw client and the headless engine core converge on the snapshot; the fail-commit hook
// and a SIGKILL restart work; the fake api sees only authorized calls; and nothing a server sent failed the
// frozen schemas.

import { checkElement } from '@draftroom/canvas-schema/elements'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { bump } from '../../../web/src/canvas/sync/headless/index.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { fileRef } from './element-api.ts'
import { newBoardId, useElementStacks } from './element-stack.ts'
import {
  arrow,
  assetId,
  bindArrow,
  diamond,
  ellipse,
  frame,
  freedraw,
  image,
  line,
  noteWithLabel,
  rect,
  text,
  versionId,
} from './elements.ts'

const h = useElementStacks()

describe('the element harness', () => {
  it('every builder makes an element the strict schema accepts', () => {
    const [n, t] = noteWithLabel('n1', 'hi')
    const r = rect('r1')
    const a = bindArrow(arrow('a1', { x: 105, y: 50 }), r, null)
    for (const el of [
      n,
      t,
      r,
      a,
      ellipse('e1'),
      diamond('d1'),
      frame('f1'),
      text('t1'),
      line('l1'),
      freedraw('p1'),
      image('i1', versionId(1)),
    ]) {
      const res = checkElement(el)
      expect(res, `${el.type} ${el.id}`).toMatchObject({ ok: true })
    }
  })

  it('runs the element engine: a raw client and the headless core converge on the test snapshot', async () => {
    const st = await h.stack()
    const b = newBoardId()
    st.api.addFile(fileRef(versionId(1), assetId(1)))
    const a = await st.client({ boardId: b, user: 'alice' })
    const [n, t] = noteWithLabel('n1', 'from raw')
    const ack = await a.create([n, t, image('i1', versionId(1), { x: 300 })])
    expect(ack.r.map((r) => r.ok)).toEqual([true, true, true])
    const core = await st.headless({ boardId: b, user: 'bob' })
    expect(core.scene.get('n1')?.type).toBe('stickynote')
    core.edit((m) => m.set('n1', bump(m.get('n1') as SceneElement, { x: 40 })))
    core.core.flush()
    await core.saved(20_000)
    await a.until(() => a.confirmed.get('n1')?.x === 40, 'the core’s move')
    const snap = await st.converged(b, [a, core])
    expect(snap.elements.map((e) => e.id).sort()).toEqual(['i1', 'n1', 'n1.t'])
    expect(a.schemaErrors).toEqual([])
    expect(st.api.fileRefCalls.map((c) => c.ids)).toEqual([[versionId(1)]])
    expect(st.api.unauthorized).toBe(0)
  })

  it('refuses a tldraw client (CLIENT_TOO_OLD): this is not the tldraw engine', async () => {
    const st = await h.stack()
    const c = await st.socket({ boardId: newBoardId(), user: 'alice' })
    c.send({ type: 'connect', protocolVersion: 7 })
    expect(await c.untilClosed()).toMatchObject({ code: 4099, reason: 'CLIENT_TOO_OLD' })
  })

  it('fail-commit: the next COMMIT fails with UNAVAILABLE and nothing is stored; the retry lands', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r0')])
    await st.failCommit(b, 1)
    const failed = await a.pushNow([{ k: 'c', el: rect('r1') }]).ack
    expect(failed.r[0]).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    expect(await st.stored(b, 'r1')).toBeUndefined()
    // the room reopens its board file: sessions get 4000 RECONNECT and come back
    expect(await a.untilClosed()).toMatchObject({ code: 4000 })
    const again = await st.client({ boardId: b, user: 'alice', tab: 'tab-alice-2' })
    expect((await again.createOne(rect('r1'))).ok).toBe(true)
    expect((await st.stored(b, 'r1'))?.type).toBe('rectangle')
  })

  it('a SIGKILLed server restarts on the same data dir with every acked element', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1'), rect('r2', { x: 200 })])
    const before = await st.snapshot(b)
    await st.server.restart()
    const c = await st.client({ boardId: b, user: 'carol' })
    expect(await c.hash()).toBe(await hashElements(before.elements))
    expect((await st.snapshot(b)).clock).toBe(before.clock)
  })
})
