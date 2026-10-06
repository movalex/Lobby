// RT-03 (realtime audit, wave J3), through the real server process: while an anonymous dot vote is open
// a peer's `button` is relayed as 'up' (a dot is cast with a click on an object, so a button going down
// over one, next to the vote's counts, told who voted for what); `sel` is dropped as before (A2). The
// pointer still moves (what stays: see presence.ts). Outside a vote, and in a vote that is not anonymous
// (none exists today; the contract has the field), the button is relayed as sent.

import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import type { RawClient } from './support/client.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

const press = (c: RawClient, x: number) =>
  c.send({
    type: 'presence',
    pointer: { x, y: 40 },
    button: 'down',
    sel: ['note-1'],
    view: null,
    idle: false,
    editing: null,
  })

/** What `watcher` was last told about `user`'s cursor once it reached x. */
async function seenAt(watcher: RawClient, user: string, x: number) {
  const mine = () =>
    watcher
      .of('presence')
      .flatMap((f) => f.peers)
      .filter((p) => p.sid.startsWith(`${user}:`) && p.pointer?.x === x)
  await watcher.until(() => mine().length > 0, `${user} at ${x}`)
  const p = mine().at(-1)
  return { button: p?.button, sel: p?.sel }
}

async function setVote(st: ElementStack, b: string, voteOpen: boolean, anonymous: boolean, c: RawClient) {
  const res = await callInternal(st.server.url, 'POST', `/internal/boards/${b}/workshop-state`, {
    body: { voteOpen, anonymous },
  })
  expect(res.status).toBe(204)
  await c.until(
    () => c.of('workshop').some((w) => w.voteOpen === voteOpen && w.anonymous === anonymous),
    'workshop state',
  )
}

describe('RT-03: presence during an anonymous vote', () => {
  it('the button is relayed as up (and sel dropped) only while an anonymous vote is open', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const voter = await st.client({ boardId: b, user: 'voter' })
    const watcher = await st.client({ boardId: b, user: 'watcher' })

    press(voter, 10)
    expect(await seenAt(watcher, 'voter', 10)).toEqual({ button: 'down', sel: ['note-1'] })

    await setVote(st, b, true, true, voter)
    press(voter, 20)
    // the cursor still moves; the click and the selection do not show
    expect(await seenAt(watcher, 'voter', 20)).toEqual({ button: 'up', sel: null })

    // a vote that is not anonymous (the contract's field; Lobby has none today): the button shows
    await setVote(st, b, true, false, voter)
    press(voter, 30)
    expect(await seenAt(watcher, 'voter', 30)).toEqual({ button: 'down', sel: null })

    await setVote(st, b, false, false, voter)
    press(voter, 40)
    expect(await seenAt(watcher, 'voter', 40)).toEqual({ button: 'down', sel: ['note-1'] })
    // the voter's own messages are never refused for it
    expect(voter.closeCode).toBeNull()
  })
})
