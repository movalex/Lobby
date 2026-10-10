// Wave L compat refix, round 1 (the rev-11 hold): an offline queue the deployed web (437b4e7, rev 11) left, taken
// over after a reload by the rev-12 web, against the REAL sync server. The rev-11 web writes `present` whole as
// {index, skip}; the room keeps the stored minutes for a write from a rev-11 socket (lobbyWriteOf), but the
// reloaded page sends the queue on a socket whose connect URL names rev 12, which the room writes whole: one
// offline reorder and a reload erased the frame's planned minutes for everyone, with Saved showing. The engine
// core on a Map scene, a memory offline store carried to a second core ("the reloaded page"), as v1-offline.
// The queue is put in 437b4e7's form (no writer revision: its OfflineEntry and LostPushRecord have none).
// Both cases failed before the fix (the stored present was {index: 2}).
import { CONNECT_REV_PARAM, CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { LobbyEngineCore } from '../../../web/src/canvas/sync/core/engine.ts'
import { createMemoryOfflineStore } from '../../../web/src/canvas/sync/core/offline-memory.ts'
import { bump, createMapScene } from '../../../web/src/canvas/sync/headless/scene.ts'
import { createSocketTransport } from '../../../web/src/canvas/sync/transport/socket.ts'
import type { OfflineEntry, SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { frame } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { TicketWebSocket } from '../harness/tickets.ts'
import { sleep, startProxy, until } from './support.ts'

const h = useElementHarness()

/** A page: no `rev` in its connect URL is the rev-11 web (437b4e7), `rev=12` the wave L web. */
function makeCore(
  syncUrl: string,
  boardId: string,
  user: string,
  tab: string,
  initial: readonly OfflineEntry[],
  rev: number | null,
) {
  const scene = createMapScene()
  const store = createMemoryOfflineStore(initial)
  const base = syncUrl.replace(/^http/, 'ws')
  const q: Record<string, string> = { sessionId: tab, ticket: ticketFor(boardId, user) }
  if (rev !== null) q[CONNECT_REV_PARAM] = String(rev)
  const transport = createSocketTransport({
    url: async () => `${base}/connect/${boardId}?${new URLSearchParams(q)}`,
    WebSocketImpl: TicketWebSocket,
    backoffMs: [50, 100, 200],
  })
  const core = new LobbyEngineCore({ transport, scene, tab, offline: store })
  return {
    core,
    scene,
    store: store as unknown as { entries(): readonly OfflineEntry[] },
    edit(fn: (m: Map<string, SceneElement>) => void) {
      fn(scene.map)
      core.onSceneChange(scene.read())
    },
    start() {
      core.start()
      transport.connect()
    },
    stop() {
      core.stop()
      transport.close(1000, 'reload')
    },
  }
}

/** 437b4e7's queue: the same shape, with no writer revision on the entry or its lost records. */
const as437b4e7 = (entries: readonly OfflineEntry[]): OfflineEntry[] =>
  (structuredClone(entries) as (OfflineEntry & { rev?: number })[]).map(({ rev: _rev, ...e }) => ({
    ...e,
    ...(e.lost ? { lost: e.lost.map(({ rev: _r, ...r }) => r as (typeof e.lost)[number]) } : {}),
  })) as OfflineEntry[]

/** 437b4e7's Frames panel (presentWith): `present` written whole, without the minutes it never knew. */
const reorder = (el: SceneElement, index: number): SceneElement => {
  const cd = ((el as { customData?: Record<string, unknown> }).customData ?? {}) as Record<string, unknown>
  const lobby = (cd.lobby ?? {}) as Record<string, unknown>
  return bump(el, { customData: { ...cd, lobby: { ...lobby, present: { index } } } })
}

const presentOf = (el: unknown) =>
  (el as { customData?: { lobby?: { present?: unknown } } } | undefined)?.customData?.lobby?.present

describe('a rev-11 page queue taken over by the rev-12 web after a reload (real sync server)', () => {
  for (const kind of ['offline', 'lost'] as const)
    it(`${kind === 'offline' ? 'an offline reorder' : 'a reorder out without an ack at the close'} keeps the planned minutes`, async () => {
      const st = await h.stack()
      const b = newBoardId()
      // the facilitator (rev-12 web) plans 7 minutes on f1
      const fac = makeCore(st.server.url, b, 'alice', 'tab-fac', [], CONTRACTS_REV)
      fac.start()
      await until(() => fac.core.saveStatus.state === 'saved' && !!fac.core.sid, 'fac welcome')
      fac.edit((m) =>
        m.set(
          'f1',
          frame('f1', {
            name: 'Warm-up',
            customData: { lobby: { present: { index: 0, mins: 7 } } },
          }) as unknown as SceneElement,
        ),
      )
      fac.core.flush()
      await until(() => fac.core.saveStatus.state === 'saved', 'f1 saved')
      fac.stop()
      // Bob's tab of the deployed web (no rev): it has the minutes in its copy
      const px = await startProxy(st.server.wsUrl)
      const tab = 'tab-bob'
      const A1 = makeCore(px.url, b, 'bob', tab, [], null)
      A1.start()
      await until(
        () => A1.core.saveStatus.state === 'saved' && presentOf(A1.scene.map.get('f1')) !== undefined,
        'A1 has f1',
      )
      expect(presentOf(A1.scene.map.get('f1'))).toEqual({ index: 0, mins: 7 })
      if (kind === 'offline') {
        px.dropUp = true
        px.dropDown = true
        px.cutAll()
        await until(() => A1.core.saveStatus.state === 'offline', 'offline')
      } else px.dropUp = true // the push goes out and never reaches the room: no ack
      A1.edit((m) => m.set('f1', reorder(m.get('f1') as SceneElement, 2)))
      A1.core.flush()
      await sleep(100)
      A1.core.persistNow()
      await sleep(50)
      const entries = as437b4e7(A1.store.entries())
      const f1 = entries.find((e) => e.element.id === 'f1')
      if (kind === 'offline') expect(f1?.groups).toContain('c:present')
      else expect(f1?.lost?.length).toBe(1)
      A1.stop()
      await px.close()
      // the reload: the rev-12 web takes over the queue on a socket that names rev 12
      const A2 = makeCore(st.server.url, b, 'bob', tab, entries, CONTRACTS_REV)
      A2.start()
      await until(() => !!A2.core.sid, 'A2 welcome')
      await until(
        () => presentOf(A2.scene.map.get('f1')) !== undefined && A2.core.saveStatus.state === 'saved',
        'A2 saved',
      )
      const deadline = Date.now() + 5_000
      let stored: unknown
      while (Date.now() < deadline) {
        const snap = await st.snapshot(b)
        stored = presentOf(snap.elements.find((e) => e.id === 'f1'))
        if ((stored as { index?: number } | undefined)?.index === 2) break
        await sleep(20)
      }
      expect(stored).toEqual({ index: 2, mins: 7 })
      expect(presentOf(A2.scene.map.get('f1'))).toEqual({ index: 2, mins: 7 })
      A2.stop()
    }, 60_000)
})
