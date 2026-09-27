// Milestone-0 demonstration 4: A loses its network (context.setOffline) while B keeps editing. A edits
// a different shape offline. Back online, both converge, and A's stale copy of B's shape does not
// overwrite B's newer edits (the client re-sends only the fields it changed, never a snapshot).
// Since milestone 1 every reconnect first fetches a fresh board ticket from the api, so going offline
// also cuts A off from the api; the reconnect below proves that path recovers too.
import type { Page } from '@playwright/test'
import { edit, expectConn, expectConverged, getShape } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'

const X = 'shape:edited-by-bob'
const Y = 'shape:edited-by-alice-offline'
const Z = 'shape:created-by-bob'

const facts = async (page: Page, id: string) => {
  const s = await getShape(page, id)
  return s ? { x: s.x, y: s.y, color: s.props.color } : null
}

test('offline A + online B: both converge and B’s edits survive A’s reconnect', async ({ session }) => {
  const a = await session('alice')
  const b = await session('bob')
  await edit(
    b.page,
    (ed, ids) =>
      ed.createShapes([
        { id: ids.x, type: 'geo', x: 100, y: 120, props: { w: 160, h: 110, color: 'black' } },
        { id: ids.y, type: 'geo', x: 420, y: 120, props: { w: 160, h: 110, color: 'black' } },
      ]),
    { x: X, y: Y },
  )
  await expectConverged(b.page, [a.page])

  await a.context.setOffline(true)
  await expectConn(a.page, 'offline')
  await expect(a.page.getByTestId('offline-banner')).toContainText('kept in this tab only')
  await expect(a.page.getByTestId('conn-status')).toHaveText('Offline')

  // B edits X (move + recolor) and adds Z while A is cut off.
  await edit(
    b.page,
    (ed, ids) => {
      ed.updateShape({ id: ids.x, type: 'geo', x: 140, y: 300, props: { color: 'red' } })
      ed.createShape({ id: ids.z, type: 'note', x: 700, y: 120 })
    },
    { x: X, z: Z },
  )
  // The server has B's edit (a fresh session sees it) and A really has not received it.
  const probe = await session('carol')
  await expect.poll(() => facts(probe.page, X)).toEqual({ x: 140, y: 300, color: 'red' })
  await probe.context.close()
  expect(await facts(a.page, X)).toEqual({ x: 100, y: 120, color: 'black' })
  await expectConn(a.page, 'offline')

  // A edits a different shape while offline; the change stays in A's tab for now.
  await edit(
    a.page,
    (ed, id) => ed.updateShape({ id, type: 'geo', x: 460, y: 320, props: { color: 'blue' } }),
    Y,
  )
  await capture('offline-state.png', a.page, test.info())
  expect(await facts(b.page, Y)).toEqual({ x: 420, y: 120, color: 'black' })

  await a.context.setOffline(false)
  await expectConn(a.page, 'online')
  await expect(a.page.getByTestId('offline-banner')).toHaveCount(0)
  await expect(a.page.getByTestId('conn-status')).toHaveText('Live')

  // A's offline edit reaches B; B's edits (made while A was away) reach A and are NOT replaced.
  await expect.poll(() => facts(b.page, Y)).toEqual({ x: 460, y: 320, color: 'blue' })
  await expect.poll(() => facts(a.page, X)).toEqual({ x: 140, y: 300, color: 'red' })
  await expect.poll(() => getShape(a.page, Z).then((s) => s?.type ?? null)).toBe('note')
  await expectConverged(a.page, [b.page])
  const fresh = await session('dave')
  await expectConverged(a.page, [fresh.page])
  expect(await facts(fresh.page, X)).toEqual({ x: 140, y: 300, color: 'red' })
  expect(await facts(fresh.page, Y)).toEqual({ x: 460, y: 320, color: 'blue' })
})
