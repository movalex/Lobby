// Hotfix H2 (wave M follow-up 0, docs/PROGRESS.md) through the REAL sync server process: the real engine core
// (the headless client) and the real lease client, alice's socket through the verifier's proxy, which holds
// every frame the room sends her from the moment her label's create goes up. The frame order the browser
// showed: the label's create, the words typed, Escape and its `lease.release`, then the room's `changes` with
// the label as created (empty) and its ack. The words were never pushed (the label stayed empty for everyone
// while alice's page said Saved), and a label made after the grant had its words pushed after the release,
// by a non-holder: refused (LEASED) as soon as someone else took the lease in between.
import { describe, expect, it } from 'vitest'
import { LeaseClient } from '../../../web/src/canvas/lease/client.ts'
import { bump } from '../../../web/src/canvas/sync/headless/index.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { headless, sleep, startProxy, until } from '../verifier-v1/support.ts'
import { label, note } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 120_000
const WORDS = 'Let the villain narrate the ending'
const editing = { editingTextElementId: 'N.t' }

/** A push of the client's that creates a text element (the label Excalidraw makes when its editor opens). */
const isTextCreate = (frame: string): boolean => {
  try {
    const m = JSON.parse(frame) as { type?: string; ops?: { k: string; el?: { type?: string } }[] }
    return m.type === 'push' && (m.ops ?? []).some((op) => op.k === 'c' && op.el?.type === 'text')
  } catch {
    return false
  }
}

/** Where the words went up and where the release did, in the client's own frames (-1: not sent). */
const orderOf = (up: readonly string[]) => ({
  words: up.findIndex((f) => f.includes('"type":"push"') && f.includes(JSON.stringify(WORDS))),
  release: up.findIndex((f) => f.includes('"type":"lease.release"')),
})

async function board() {
  const st = await h.stack()
  const b = newBoardId()
  const px = await startProxy(st.server.wsUrl)
  px.recordUp = true
  const A = headless(px.url, b, 'alice')
  await A.connect()
  const B = headless(st.server.wsUrl, b, 'bob')
  await B.connect()
  A.edit((m) => m.set('N', note('N', { x: 0, y: 0 }) as unknown as SceneElement))
  A.core.flush()
  await A.saved()
  await until(() => B.scene.has('N'), 'bob has the note')
  const leaseClient = (c: typeof A) => {
    const w = c.core.welcome
    if (!w) throw new Error('no welcome')
    return new LeaseClient(c.core.leaseConnect, { sid: w.sid, uid: w.you.uid, name: w.you.name })
  }
  return { st, b, px, A, B, leaseOf: leaseClient }
}

/** Excalidraw's startTextEditing on the unlabelled note: the label (empty) and the note's binding. */
function openLabel(A: ReturnType<typeof headless>): void {
  A.edit((m) => {
    const n = m.get('N')
    if (!n) throw new Error('no note')
    m.set('N', bump(n, { boundElements: [{ id: 'N.t', type: 'text' }] }))
    m.set(
      'N.t',
      label('N.t', 'N', {
        x: 70,
        y: 88,
        width: 60,
        height: 25,
        text: '',
        originalText: '',
      }) as unknown as SceneElement,
    )
  }, editing)
}

const storedText = async (st: Awaited<ReturnType<typeof board>>['st'], b: string) =>
  ((await st.snapshot(b)).elements.find((e) => e.id === 'N.t') as { originalText?: string } | undefined)
    ?.originalText ?? null

describe('H2: words typed into a just-made label, the editor left before the room confirmed its create (real room)', () => {
  it(
    'the New element order (the label made while the acquire is pending): the words land, pushed before the release',
    async () => {
      const { st, b, px, A, B, leaseOf } = await board()
      const lease = leaseOf(A)
      px.holdDownFrom = isTextCreate
      const granted = lease.acquire('N')
      openLabel(A) // the editor opens at once: the label is made while the lease is pending
      expect((await granted).granted).toBe(true)
      await until(() => px.holding, 'the label’s create went up')
      A.change('N.t', { originalText: WORDS, text: WORDS, width: 180 }, editing)
      A.gesture() // Escape: Excalidraw's submit, the editor closes
      lease.release('N') // EditorLease.endSession
      await sleep(300) // whatever alice sends now goes up; the room's answers are held
      expect(px.heldDown.some((f) => f.includes('"type":"ack"'))).toBe(true)
      px.releaseDown()
      await A.saved(20_000)
      await sleep(200)
      expect(await storedText(st, b)).toBe(WORDS)
      const order = orderOf(px.up)
      expect(order.words, 'the words went up').toBeGreaterThan(-1)
      expect(order.release, 'the release went up after them').toBeGreaterThan(order.words)
      await until(
        () => (B.scene.get('N.t') as { originalText?: string } | undefined)?.originalText === WORDS,
        'bob',
      )
      await A.close()
      await B.close()
      await px.close()
    },
    T,
  )

  it(
    'a label made after the grant; bob asks for the lease right after alice left the editor: denied, and alice’s words land',
    async () => {
      const { st, b, px, A, B, leaseOf } = await board()
      const lease = leaseOf(A)
      expect((await lease.acquire('N')).granted).toBe(true)
      px.holdDownFrom = isTextCreate
      openLabel(A) // Lobby's own request: the label is made once the grant is here
      A.core.flush()
      await until(() => px.holding, 'the label’s create went up')
      A.change('N.t', { originalText: WORDS, text: WORDS, width: 180 }, editing)
      A.gesture()
      lease.release('N')
      await sleep(200)
      // bob, not held back: his acquire reaches the room after alice's frames so far
      const bob = leaseOf(B)
      const answer = await bob.acquire('N')
      px.releaseDown()
      await A.saved(20_000)
      await sleep(200)
      expect(await storedText(st, b), 'alice’s words are stored').toBe(WORDS)
      expect(answer.granted, 'bob is told alice still has the note while her words are on their way').toBe(
        false,
      )
      const order = orderOf(px.up)
      expect(order.release).toBeGreaterThan(order.words)
      // and once they are written, the lease is free for bob
      await until(() => !lease.holderOf('N'), 'the room broadcast alice’s release')
      expect((await bob.acquire('N')).granted).toBe(true)
      await A.close()
      await B.close()
      await px.close()
    },
    T,
  )
})
