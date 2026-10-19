// OWNER: WS2 (wave V, V1). A named scale run with the keyboard only: the facilitator reaches "Poll or word cloud" in
// the Facilitate menu with the arrow keys, sets up a 1-5 scale with end labels and Anonymous off (the dialog says what
// that means), and a participant answers from the start notice with Tab and the arrow keys; the numbers have names a
// screen reader reads ("5, Completely"). After the reveal the facilitator alone sees who answered what; the
// participant never sees a name. Results to board makes the scale's chart.
import { namedScaleByKeyboard, test, withLive } from './v1-kit.ts'

test('a named 1-5 scale, set up and answered with the keyboard; names reach the facilitator alone, after the reveal', async ({
  join,
}) => {
  const alice = await withLive(await join('alice'))
  const bob = await withLive(await join('bob', 'editor'))
  await namedScaleByKeyboard(alice, bob)
})
