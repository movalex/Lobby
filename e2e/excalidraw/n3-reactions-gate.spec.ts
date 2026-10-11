// OWNER: 3f (workshops; wave N, WS3; N3-1). The page offers reacting exactly where the room says REACTIONS_REV (13) or
// later: the room's `contracts` frame is the whole gate. Against a room that says 12 (the deployed sync before the wave N
// deploy, or after a rollback to it, the plan's rollback pair (b)) no reaction UI shows anywhere and the page pushes no
// reaction key; against a room that says 13 the same places offer it. The test reads the revision the room announced
// and checks the branch it is in, so it holds on either side of the sync deploy (DRAFTROOM_REACTIONS is on, so the
// rev-13 branch can react).
//
//   cd e2e && E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n3-reactions-gate.spec.ts --project=chromium --workers=1
import { itemCenterOnScreen, select } from '../tests/support/canvas.ts'
import { expect, expectItemsEverywhere, hoverNote, seed, showAll, test } from './workshops-kit.ts'

test.use({ syncEnv: { DRAFTROOM_REACTIONS: 'on' } })

test('the reaction UI is there exactly when the room says 13 or later, and below that nothing shows or is pushed', async ({
  join,
}) => {
  const a = await join('alice')
  await seed(a.page, { notes: [{ id: 'n3g-note', x: 40, y: 60, text: 'Warm-up game' }] })
  await expectItemsEverywhere([a], ['n3g-note'])
  await showAll(a.page)
  await expect
    .poll(() =>
      a.page.evaluate(() =>
        (
          window as unknown as { __lobbyBoard: { canvas: { room: { contractsRev(): number | null } } } }
        ).__lobbyBoard.canvas.room.contractsRev(),
      ),
    )
    .not.toBeNull()
  const rev = await a.page.evaluate(() =>
    (
      window as unknown as { __lobbyBoard: { canvas: { room: { contractsRev(): number | null } } } }
    ).__lobbyBoard.canvas.room.contractsRev(),
  )
  const offered = (rev ?? 0) >= 13

  await hoverNote(a.page, 'n3g-note')
  await select(a.page, ['n3g-note'])
  await expect(a.page.getByTestId('selection-bar')).toBeVisible()
  if (offered) {
    await expect(a.page.getByTestId('note-reaction-add')).toBeVisible()
    await expect(a.page.getByTestId('selection-reactions')).toBeVisible()
  } else {
    await a.page.waitForTimeout(500)
    await expect(a.page.getByTestId('note-reactions-layer')).toHaveCount(0)
    await expect(a.page.getByTestId('selection-reactions')).toHaveCount(0)
  }
  const at = await itemCenterOnScreen(a.page, 'n3g-note')
  await a.page.mouse.click(at.x, at.y, { button: 'right' })
  await expect(a.page.getByTestId('context-menu')).toBeVisible()
  await expect(a.page.getByTestId('context-menu.reactions-react')).toHaveCount(offered ? 1 : 0)
  await a.page.keyboard.press('Escape')

  // the palette names the command either way; below 13 it says why it cannot run
  await a.page.keyboard.press('ControlOrMeta+k')
  await a.page.getByTestId('command-palette-input').fill('React to a note')
  if (!offered) await expect(a.page.getByText('Reactions are not available on this board yet')).toBeVisible()
  await a.page.keyboard.press('Escape')

  // a page that is not offered reacting never pushes a reaction key
  if (!offered)
    expect(
      a.net
        .sentPushes()
        .flatMap((p) => p.ops)
        .filter((op) => Object.keys(op.c ?? {}).some((k) => k.startsWith('react:'))),
    ).toEqual([])
})
