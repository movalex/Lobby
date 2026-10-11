import type { ClientMessage, PatchOp } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { LeaseClient } from '../../lease/client.ts'
import { bump } from '../headless/scene.ts'
import { note, text } from '../testing/elements.ts'
import { stored } from '../testing/fakeRoom.ts'
import { createHarness, type TestClient } from '../testing/harness.ts'

// Hotfix H2 (wave M follow-up 0, docs/PROGRESS.md): the words typed into a label that was just made were lost
// when the editor closed before the room confirmed the label's create. The frame order the browser showed:
// the label's create pushed, the words typed, Escape and its `lease.release`, and only then the room's
// `changes` with the label as created (empty) and the create's ack. The words could not ride the release's
// flush (no patch can be built on a create the room has not confirmed), so the release went first; and the
// label, made while the New element rule's acquire was still pending, kept its "needs the grant" mark after
// the grant, so once released dropUngranted threw the words away while Saved showed.
//
// Here every frame goes through the manual clock: A's link is 300 ms round trip, so A types and leaves the
// editor while its label's create is on its way.

const NOTE = 'n1'
const LABEL = 'n1.t'
const WORDS = 'Let the villain narrate the ending'
const editing = { editingTextElementId: LABEL }

/** Records every frame `c` sends, when it sends it (the room reads them a half round trip later). */
const outbox = new WeakMap<TestClient, ClientMessage[]>()
function recordSends(c: TestClient): void {
  const log: ClientMessage[] = []
  outbox.set(c, log)
  const t = c.transport as unknown as { send(m: ClientMessage): void }
  const send = t.send.bind(t)
  t.send = (m) => {
    log.push(JSON.parse(JSON.stringify(m)) as ClientMessage)
    send(m)
  }
}

/** What A sent, in order: each push's ops (kind, id, groups or created text), and the lease messages. */
function sent(c: TestClient): string[] {
  return (outbox.get(c) ?? []).flatMap((m: ClientMessage) => {
    if (m.type === 'push')
      return m.ops.map((op) =>
        op.k === 'c'
          ? `c ${(op.el as { id: string }).id} ${JSON.stringify((op.el as { originalText?: string }).originalText ?? null)}`
          : `p ${op.id} ${Object.keys((op as PatchOp).g ?? {})
              .sort()
              .join(',')}`,
      )
    if (m.type === 'lease.acquire' || m.type === 'lease.release') return [`${m.type} ${m.id}`]
    return []
  })
}

/** The label Excalidraw makes when the editor opens on an unlabelled note (startTextEditing), and its binding. */
function openLabel(a: TestClient): void {
  a.edit((m) => {
    const n = m.get(NOTE)
    if (!n) throw new Error('no note')
    m.set(NOTE, bump(n, { boundElements: [{ id: LABEL, type: 'text' }] }))
    m.set(
      LABEL,
      text(LABEL, 'a1', {
        containerId: NOTE,
        text: '',
        originalText: '',
        textAlign: 'center',
        verticalAlign: 'middle',
        versionNonce: 77,
      }),
    )
  }, editing)
}

const typeWords = (a: TestClient, words = WORDS) =>
  a.change(LABEL, { originalText: words, text: words, width: 180 }, editing)

function setup() {
  const h = createHarness({ seed: [stored(note(NOTE, 'a0'))] })
  const a = h.client('alice', { latencyMs: 300 })
  const b = h.client('bob')
  recordSends(a)
  h.settle()
  const toA: { type: string; id?: string }[] = []
  const lease = a.core.leaseConnect((m) => toA.push(m as never))
  const aHolder = { sid: a.core.sid as string, uid: 'alice', name: 'alice' }
  return { h, a, b, lease, toA, aHolder }
}

describe('H2: words typed into a label whose create the room has not confirmed, the editor closed before', () => {
  it('the New element order (label made while the acquire is pending): the words go up before the release, and land', async () => {
    const { h, a, b, lease } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a) // the editor opens at once: the label is made while the lease is pending
    h.clock.advance(320) // the grant is back; the label's create goes up 50 ms later
    h.clock.advance(60)
    expect(sent(a).filter((s) => s.startsWith(`c ${LABEL}`))).toEqual([`c ${LABEL} ""`])
    typeWords(a) // typed while the label's create is on its way (its echo and ack are 300 ms out)
    h.clock.advance(10)
    a.gesture() // Escape: Excalidraw's submit, the editor closes
    lease.send({ type: 'lease.release', id: NOTE })
    // nothing can go up for the words yet, and the release waits behind them: the lease is still A's
    h.clock.advance(1)
    expect(sent(a)).not.toContain(`lease.release ${NOTE}`)
    expect(a.core.leaseState().held).toEqual([NOTE])
    expect(a.core.saveStatus.state).not.toBe('saved')
    h.settle()
    // the room's echo of the create made the words pushable: they went up, as the holder's, then the release
    const order = sent(a)
    const words = order.findIndex((s) => s.startsWith(`p ${LABEL} `) && s.includes('text'))
    const release = order.indexOf(`lease.release ${NOTE}`)
    expect(words).toBeGreaterThan(-1)
    expect(release).toBeGreaterThan(words)
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(a.get(LABEL)?.originalText).toBe(WORDS)
    expect(b.get(LABEL)?.originalText).toBe(WORDS)
    expect(h.room.leases.has(NOTE)).toBe(false)
    expect(a.core.saveStatus.state).toBe('saved')
    expect(await a.hash()).toBe(await h.roomHash())
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('a label made after the grant (Lobby’s own request): the words still go up before the release, never as a non-holder’s write', async () => {
    const { h, a, lease } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    h.settle() // granted
    openLabel(a)
    h.clock.advance(60) // the label's create is up
    typeWords(a)
    h.clock.advance(10)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    expect(sent(a)).not.toContain(`lease.release ${NOTE}`)
    h.settle()
    const order = sent(a)
    const words = order.findIndex((s) => s.startsWith(`p ${LABEL} `) && s.includes('text'))
    expect(words).toBeGreaterThan(-1)
    expect(order.indexOf(`lease.release ${NOTE}`)).toBeGreaterThan(words)
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('the browser’s order (the create’s echo and ack reach A only after Escape): the room sees no release before the words', async () => {
    const { h, a, lease } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a)
    h.clock.advance(380) // granted; the label's create is up (it reaches the room 150 ms after it left)
    typeWords(a)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    h.clock.advance(140) // the create reached the room, its echo and ack are on their way back to A
    expect(h.room.elements.get(LABEL)?.originalText).toBe('')
    expect(h.room.leases.get(NOTE)?.sid).toBe(a.core.sid) // no release reached the room before the words
    h.clock.advance(160) // the echo, then the ack, reach A: the words go up, then the release
    h.settle()
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(h.room.leases.has(NOTE)).toBe(false)
    expect(a.core.leaseState().held).toEqual([])
  })

  it('another session asks for the lease right after A left the editor: denied while A’s words are unsent; A’s words land, then B gets it', async () => {
    const { h, a, b, lease } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a)
    h.clock.advance(380)
    typeWords(a)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    h.clock.advance(5)
    const toB: { type: string }[] = []
    const bl = b.core.leaseConnect((m) => toB.push(m as never))
    bl.send({ type: 'lease.acquire', req: 1, id: NOTE }) // B's acquire reaches the room at once
    h.clock.advance(1)
    expect(toB.map((m) => m.type)).toContain('lease.deny')
    h.settle()
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(h.room.leases.has(NOTE)).toBe(false)
    bl.send({ type: 'lease.acquire', req: 2, id: NOTE })
    h.settle()
    expect(h.room.leases.get(NOTE)?.sid).toBe(b.core.sid)
    expect(b.get(LABEL)?.originalText).toBe(WORDS)
    expect(await a.hash()).toBe(await h.roomHash())
    expect(await b.hash()).toBe(await h.roomHash())
  })

  it('the editor opened again before the echo: the held-back release is not sent, the lease stays A’s, the words go once confirmed', async () => {
    const { h, a, lease } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a)
    h.clock.advance(380)
    typeWords(a)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    h.clock.advance(5)
    lease.send({ type: 'lease.acquire', req: 2, id: NOTE }) // a double-click on the note again
    h.settle()
    expect(sent(a)).not.toContain(`lease.release ${NOTE}`)
    expect(h.room.leases.get(NOTE)?.sid).toBe(a.core.sid)
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    a.change(LABEL, { originalText: `${WORDS}!`, text: `${WORDS}!`, width: 184 }, editing)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    h.settle()
    expect(h.room.elements.get(LABEL)?.originalText).toBe(`${WORDS}!`)
    expect(h.room.leases.has(NOTE)).toBe(false)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('the label’s create refused: the held-back release still goes (nothing is left to wait for)', () => {
    const { h, a, lease } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a)
    h.clock.advance(320) // granted
    // the room refuses the label's create when it arrives (LEASED: as far as the room knows, the note's
    // lease is someone else's by then)
    h.room.leases.set(NOTE, { sid: 'carol:tab1', uid: 'carol', name: 'carol' })
    h.clock.advance(60)
    typeWords(a)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    h.clock.advance(1)
    expect(sent(a)).not.toContain(`lease.release ${NOTE}`)
    h.settle()
    expect(h.room.elements.has(LABEL)).toBe(false)
    expect(sent(a)).toContain(`lease.release ${NOTE}`)
    expect(a.core.leaseState().held).toEqual([])
  })

  it('the label’s create answered UNAVAILABLE: the release waits for its retry, which carries the words', async () => {
    const { h, a, lease } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a)
    h.clock.advance(320) // granted
    h.room.failNext = 1 // the label's create meets a failed COMMIT
    h.clock.advance(60)
    typeWords(a)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    h.settle()
    const order = sent(a)
    const words = order.indexOf(`c ${LABEL} ${JSON.stringify(WORDS)}`)
    expect(words).toBeGreaterThan(-1)
    expect(order.indexOf(`lease.release ${NOTE}`)).toBeGreaterThan(words)
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(h.room.leases.has(NOTE)).toBe(false)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('the socket drops while the release is held back: after the welcome the words go up, then the release', async () => {
    const { h, a, lease, aHolder } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a)
    h.clock.advance(380)
    typeWords(a)
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    h.clock.advance(200) // the create committed; its echo and ack are on their way
    // the socket goes (its frames with it); the room keeps A's lease (a reconnecting tab keeps it, §2.9.3)
    ;(a.transport as unknown as { drop(): void }).drop()
    ;(a.transport as unknown as { close(code: number, reason: string): void }).close(1006, 'cut')
    h.room.leases.set(NOTE, aHolder)
    h.clock.advance(100)
    ;(a.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(h.room.leases.has(NOTE)).toBe(false)
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('H2: the grant ends a pending text change’s wait for it (needsLease)', () => {
  it('a label made and typed while the acquire was pending, released offline before its create was confirmed: after the reconnect the words land', async () => {
    const { h, a, lease, aHolder } = setup()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a) // made while pending: marked as waiting for the grant
    h.clock.advance(380) // granted; the label's create is up
    typeWords(a)
    h.clock.advance(100) // the create committed (its echo and ack still on their way)
    // the socket drops before the echo; the editor closes and is released offline (not sent: §2.9.3)
    ;(a.transport as unknown as { close(code: number, reason: string): void }).close(1006, 'cut')
    a.gesture()
    lease.send({ type: 'lease.release', id: NOTE })
    // the room still names A (its TTL), so the next welcome's tail releases it behind the pushes
    h.room.leases.set(NOTE, aHolder)
    h.clock.advance(100)
    ;(a.transport as unknown as { reopen(): void }).reopen()
    h.settle()
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(a.get(LABEL)?.originalText).toBe(WORDS)
    expect(h.room.leases.has(NOTE)).toBe(false)
    expect(await a.hash()).toBe(await h.roomHash())
  })

  it('a deny still sends a pending change back (the mark goes only with a grant)', async () => {
    const { h, a, b, lease } = setup()
    b.core.leaseConnect(() => {}).send({ type: 'lease.acquire', req: 1, id: NOTE })
    h.settle()
    lease.send({ type: 'lease.acquire', req: 1, id: NOTE })
    openLabel(a)
    typeWords(a)
    h.settle() // the deny
    a.gesture()
    h.settle()
    expect(h.room.elements.has(LABEL)).toBe(false)
    expect(a.get(LABEL)).toBeUndefined()
    expect(sent(a).some((s) => s.startsWith(`c ${LABEL}`))).toBe(false)
    expect(await a.hash()).toBe(await h.roomHash())
  })
})

describe('H2: through the lease client (the browser’s own path: LeaseClient over the core’s lease transport)', () => {
  it('acquire, the label made at once, the grant, the words, the release before the echo: the client lets go at once, the core only after the words', async () => {
    const { h, a, b } = setup()
    const client = new LeaseClient(a.core.leaseConnect, {
      sid: a.core.sid as string,
      uid: 'alice',
      name: 'alice',
    })
    const outcome = client.acquire(NOTE)
    openLabel(a)
    h.clock.advance(320)
    await expect(outcome).resolves.toMatchObject({ granted: true, id: NOTE })
    h.clock.advance(60) // the label's create is up
    typeWords(a)
    a.gesture()
    client.release(NOTE) // EditorLease.endSession: the editor is gone
    expect(client.isHeld(NOTE)).toBe(false) // the editor's side is done: nothing can be typed under it any more
    expect(a.core.leaseState().held).toEqual([NOTE]) // the core keeps it until the words are out
    h.settle()
    const order = sent(a)
    const words = order.findIndex((s) => s.startsWith(`p ${LABEL} `) && s.includes('text'))
    expect(words).toBeGreaterThan(-1)
    expect(order.indexOf(`lease.release ${NOTE}`)).toBeGreaterThan(words)
    expect(h.room.elements.get(LABEL)?.originalText).toBe(WORDS)
    expect(b.get(LABEL)?.originalText).toBe(WORDS)
    expect(client.holderOf(NOTE)).toBeNull() // the room's broadcast of the release reached the client
    expect(await a.hash()).toBe(await h.roomHash())
  })
})
