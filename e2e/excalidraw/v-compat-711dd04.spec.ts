// OWNER: WS5 (wave V, the stale pair; docs/WAVE-V-CONTRACTS.md §7, EXCALIDRAW-CONTRACTS.md §0b). A tab of the web
// deployed before wave V (711dd04, CONTRACTS_REV 14, wave T; a build of it with dev auth, served on this run's web
// origin by l-compat-kit.ts serveOldWeb) beside a tab of this tree's web, on one board, through this tree's api (every
// wave V switch on: e2e/tests/support/stack.ts) and sync. Wave V changes no wire: `git diff 711dd04 --
// packages/canvas-schema` holds only a test, so the old tab's frames are parsed with this package's own schemas (they
// ARE 711dd04's; packages/canvas-schema/src/wave-v-kinds.test.ts proves the kinds against the frozen rev 11 to 13 ones
// too). The old tab's board socket is NOT relayed: CDP hands over every frame it gets (watchOldSocket).
//
// 1. The placements: this tree's facilitator writes what "Results to board" and breakouts write (a poll chart: a
//    frame of bars and texts, `kind: 'poll-chart'`; a word cloud: a frame of free texts, `'word-cloud'`, and a word
//    as a sticky note; two group frames, `'breakout-frame'`), each in one transact. The old tab receives each, drops
//    no frame, pushes nothing while it only receives, holds them with their kinds (renders them: they are in its
//    scene with the server's geometry), and its own move of the chart commits and keeps the create-only kind.
// 2. Its Facilitate menu keeps working: it starts the timer, raises a hand and starts a vote, and this tree's tab
//    sees each.
// 3. The hidden features (skipped, saying so, until the wave V routes have landed on the branch under test: WS1's
//    activities, WS4's breakouts): this tree's api runs a poll, a word cloud and breakouts on the board (the old tab
//    has an open event stream, so the auto mode deals it into a group; a group summon and a broadcast go to it); the
//    old tab, which has no listener for any of the new events and never calls a new route, keeps its board live, gets
//    the timer's next event, and throws nothing.
// After each: every tab holds the server's board (convergence hashes), the old socket dropped nothing, was never told
// CLOSING, never reconnected; no page error in the old tab.
//
// Run (the old build is made outside the repo, as l-compat-kit.ts describes; 711dd04's own steps):
//   git archive 711dd049 | tar -x -C <dir> && cd <dir> && pnpm install --frozen-lockfile --offline --ignore-scripts
//   VITE_DRAFTROOM_DEV_AUTH=1 GIT_COMMIT=711dd049aaaa pnpm --filter @draftroom/web exec vite build --outDir <dist>
//   cd <this tree>/e2e && E2E_OLD_WEB_DIST=<dist> E2E_OLD_WEB_COMMIT=711dd04 E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/v-compat-711dd04.spec.ts --project=chromium --workers=1
// (On Windows keep <dir> short: the install's paths pass 260 characters under the session scratchpad.)
// Without E2E_OLD_WEB_DIST it is skipped, saying so.
import type { Page } from '@playwright/test'
import * as Rev14 from '../../packages/canvas-schema/src/protocol.ts'
import {
  ACTIVITY_LIMITS,
  activitiesPath,
  activityActionPath,
  activityPath,
  breakoutActionPath,
  breakoutsPath,
} from '../../packages/contracts/src/index.ts'
import type { Api } from '../tests/support/api.ts'
import {
  type CanvasElement,
  type CanvasSession,
  expect,
  expectSaved,
  hash,
  item,
  saveState,
  test,
  updateItem,
} from '../tests/support/canvas.ts'
import { serverSnapshot, storedElement } from '../tests/support/excalidraw.ts'
import type { Users } from '../tests/support/users.ts'
import { closeWorkshopPopover, openWorkshopPopover, workshopState } from '../tests/support/workshops.ts'
import { handsChip, setHand } from '../tests/support/workshops-2.ts'
import { withCanvas } from './canvas-ux-kit.ts'
import {
  OLD_WEB_COMMIT,
  OLD_WEB_DIST,
  OLD_WEB_LAUNCH,
  OLD_WEB_SKIP_REASON,
  type OldFrameSchemas,
  type OldSocketWatch,
  serveOldWeb,
  watchOldSocket,
} from './l-compat-kit.ts'
import { openTab, sidOf } from './l6-kit.ts'

test.use({ viewport: { width: 1440, height: 900 }, launchOptions: OLD_WEB_LAUNCH })

/** 711dd04's schemas: this package's (wave V changed none of it; see the header). */
const REV14_SCHEMAS: OldFrameSchemas = Rev14 as unknown as OldFrameSchemas

const kindOf = (el: CanvasElement | null | undefined) =>
  ((el?.customData?.lobby ?? {}) as { kind?: unknown }).kind ?? null
const pushes = (s: OldSocketWatch) => s.sent.filter((t) => t === 'push').length
const roomRev = (page: Page) => withCanvas(page, (c) => c.room.contractsRev(), null)

interface OldPair {
  readonly a: CanvasSession
  readonly b: CanvasSession
  readonly s: OldSocketWatch
  readonly served: string[]
  readonly pageErrors: string[]
}

/** alice on this tree's web, bob (an editor) on the 711dd04 build, watched. */
async function openPair(
  browser: Parameters<typeof openTab>[0],
  board: string,
  users: Users,
  canvasSession: (u: string) => Promise<CanvasSession>,
): Promise<OldPair> {
  const a = await canvasSession('alice')
  const served: string[] = []
  const pageErrors: string[] = []
  let sock: OldSocketWatch | null = null
  const b = await openTab(browser, board, users, 'bob', {
    role: 'editor',
    beforeOpen: async (page) => {
      await serveOldWeb(page.context(), OLD_WEB_DIST as string, served)
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
      sock = await watchOldSocket(page, REV14_SCHEMAS)
    },
  })
  return { a, b, s: sock as unknown as OldSocketWatch, served, pageErrors }
}

async function expectOldBuild(p: OldPair) {
  test.info().annotations.push({ type: 'previous web', description: `${OLD_WEB_COMMIT} (${OLD_WEB_DIST})` })
  expect(p.served.some((x) => x.startsWith('/assets/'))).toBe(true)
  await expect.poll(() => p.s.connectUrls.length).toBeGreaterThan(0)
  for (const u of p.s.connectUrls) expect(new URL(u).searchParams.get('rev')).toBe('14')
  await expect.poll(() => roomRev(p.a.page)).toBe(14)
  await expect.poll(() => roomRev(p.b.page)).toBe(14)
}

/** Every tab holds the server's board; the old socket dropped nothing, was never closed, never reconnected. */
async function expectOldTabHealthy(p: OldPair, stack: Parameters<typeof serverSnapshot>[0], board: string) {
  const server = await serverSnapshot(stack, board)
  await expect.poll(() => hash(p.a.page)).toBe(server.hash)
  await expect.poll(() => hash(p.b.page)).toBe(server.hash)
  await p.s.settled()
  expect(p.s.dropped, 'frames the 711dd04 web’s socket would drop').toEqual([])
  expect(p.s.closing).toEqual([])
  expect(p.s.extensions, 'one board socket handshake: no reconnect').toHaveLength(1)
  expect(p.pageErrors, 'page errors in the 711dd04 web').toEqual([])
  await expect(p.b.page.getByTestId('conn-status')).not.toHaveAttribute('data-state', /offline|error/)
}

interface Placed {
  readonly chart: string
  readonly cloud: string
  readonly note: string
  readonly groups: readonly string[]
  readonly all: readonly string[]
}

/**
 * What wave V's facilitator writes, as WS2's "Results to board" and WS4's "Make N frames" do: one transact each,
 * ordinary creates with the create-only `customData.lobby.kind`.
 */
async function place(page: Page): Promise<Placed> {
  return withCanvas(
    page,
    (c) => {
      const id = (p: string) => {
        const bytes = new Uint8Array(12)
        crypto.getRandomValues(bytes)
        return `${p}${Array.from(bytes, (x) => (x % 36).toString(36)).join('')}`
      }
      const kind = (k: string) => ({ lobby: { kind: k } })
      const text = (
        tx: { create(k: string, p: object): string },
        frameId: string,
        k: string,
        x: number,
        y: number,
        words: string,
        fontSize = 20,
      ) =>
        tx.create('text', {
          id: id('vt'),
          x,
          y,
          text: words,
          originalText: words,
          fontFamily: 6,
          fontSize,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: '#1e1e1e',
          frameId,
          autoResize: true,
          customData: kind(k),
        })
      const all: string[] = []
      const chart = id('vc')
      c.transact('e2e: a poll chart', (tx) => {
        tx.create('frame', {
          id: chart,
          x: 0,
          y: 0,
          width: 640,
          height: 360,
          name: 'Which city?',
          customData: kind('poll-chart'),
        })
        all.push(chart)
        ;[
          ['Lisbon', 6],
          ['Oslo', 3],
          ['Rome', 1],
        ].forEach(([label, n], i) => {
          const r = tx.create('rectangle', {
            id: id('vb'),
            x: 40,
            y: 60 + i * 90,
            width: 40 * Number(n),
            height: 60,
            backgroundColor: '#a5d8ff',
            fillStyle: 'solid',
            strokeColor: '#1971c2',
            strokeWidth: 1,
            roughness: 0,
            frameId: chart,
            customData: kind('poll-chart'),
          })
          all.push(r, text(tx, chart, 'poll-chart', 300, 75 + i * 90, `${label} · ${n}`))
        })
      })
      const cloud = id('vw')
      c.transact('e2e: a word cloud', (tx) => {
        tx.create('frame', {
          id: cloud,
          x: 800,
          y: 0,
          width: 640,
          height: 360,
          name: 'One word',
          customData: kind('word-cloud'),
        })
        all.push(cloud)
        ;[
          ['bold', 96, 60, 60],
          ['warm', 48, 340, 80],
          ['@here', 24, 360, 220],
        ].forEach(([w, size, x, y]) => {
          all.push(text(tx, cloud, 'word-cloud', 800 + Number(x), Number(y), String(w), Number(size)))
        })
      })
      const note = id('vn')
      c.transact('e2e: a word as a sticky note', (tx) => {
        tx.create('note', {
          id: note,
          labelId: `${note}.t`,
          x: 1500,
          y: 0,
          size: 200,
          text: 'bold · 5',
          customData: kind('word-cloud'),
        })
      })
      all.push(note)
      const groups = [id('vg'), id('vg')]
      c.transact('e2e: two breakout frames', (tx) => {
        groups.forEach((g, i) => {
          tx.create('frame', {
            id: g,
            x: i * 700,
            y: 500,
            width: 640,
            height: 400,
            name: `Group ${i + 1}`,
            customData: kind('breakout-frame'),
          })
        })
      })
      all.push(...groups)
      return { chart, cloud, note, groups, all }
    },
    null,
  )
}

test('v-compat: the 711dd04 web beside placed poll charts, word clouds and breakout frames: every frame, nothing pushed, its own move, its Facilitate menu', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  test.skip(!OLD_WEB_DIST, OLD_WEB_SKIP_REASON)
  test.setTimeout(240_000)
  const p = await openPair(browser, board, users, canvasSession)
  const { a, b, s } = p
  try {
    await test.step('bob is the deployed 711dd04 build (rev 14 in its connect URL), the room says 14', async () => {
      await expectOldBuild(p)
    })
    const bsid = await sidOf(b.page)
    let placed: Placed | null = null

    await test.step('alice places a poll chart, a word cloud (and a word as a note) and two breakout frames: bob holds each with its kind, drops no frame and pushes nothing', async () => {
      const before = pushes(s)
      placed = await place(a.page)
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
      for (const id of placed.all)
        await expect.poll(() => item(b.page, id).then((e) => e?.id ?? null), { message: id }).toBe(id)
      for (const [id, k] of [
        [placed.chart, 'poll-chart'],
        [placed.cloud, 'word-cloud'],
        [placed.note, 'word-cloud'],
        ...placed.groups.map((g) => [g, 'breakout-frame'] as const),
      ] as const) {
        expect(kindOf(await item(b.page, id)), id).toBe(k)
        expect(kindOf(await storedElement(stack, board, id)), id).toBe(k)
      }
      // bob's scene draws them where the server has them (a chart bar, a cloud word)
      const bar = (await item(a.page, placed.all[1] as string)) as CanvasElement
      expect(await item(b.page, bar.id)).toMatchObject({
        x: bar.x,
        y: bar.y,
        width: bar.width,
        height: bar.height,
      })
      await expectSaved(b.page)
      await s.settled()
      expect(s.dropped).toEqual([])
      expect(pushes(s), 'bob only received').toBe(before)
    })

    await test.step('bob moves the poll chart: it commits and keeps its kind (create-only)', async () => {
      const chart = (placed as unknown as Placed).chart
      await updateItem(b.page, chart, { x: 40, y: 20 })
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      await expect.poll(async () => (await storedElement(stack, board, chart))?.x).toBe(40)
      expect(kindOf(await storedElement(stack, board, chart))).toBe('poll-chart')
      await expect.poll(async () => (await item(a.page, chart))?.x).toBe(40)
    })

    await test.step('bob’s Facilitate menu works: he starts the timer, raises a hand and starts a vote; alice sees each', async () => {
      const pop = await openWorkshopPopover(b.page)
      await pop.getByTestId('timer-preset-5').click()
      await pop.getByTestId('timer-start').click()
      await closeWorkshopPopover(b.page)
      await expect(a.page.getByTestId('facilitate-button')).toHaveAttribute('data-timer-state', 'running')
      await setHand(b.page, true)
      await expect(handsChip(a.page)).toHaveAttribute('data-count', '1')
      const vpop = await openWorkshopPopover(b.page)
      await vpop.getByTestId('vote-start').click()
      const dialog = b.page.getByTestId('vote-setup-dialog')
      await expect(dialog).toBeVisible()
      await dialog.getByTestId('vote-setup-submit').click()
      await expect(dialog).toHaveCount(0)
      const api = await users.api('alice')
      await expect
        .poll(async () => (await workshopState(api, board)).vote?.session.status ?? null)
        .toBe('open')
      await expect(a.page.getByTestId('facilitate-pill-vote')).toBeVisible()
      // tidy: bob closes the vote and lowers his hand
      const vid = (await workshopState(api, board)).vote?.session.id as string
      expect((await (await users.api('bob')).fetch('POST', `/api/votes/${vid}/close`)).status()).toBe(200)
      await setHand(b.page, false)
    })

    await test.step('every tab holds the server’s board; bob’s socket dropped nothing, was never closed by the room, never reconnected; his page threw nothing', async () => {
      await expectOldTabHealthy(p, stack, board)
      expect(await sidOf(b.page)).toBe(bsid)
    })
  } finally {
    await b.context.close()
  }
})

/** Whether the branch under test serves the wave V routes (pending routes answer 404 like unknown ones). */
async function routesLanded(api: Api, board: string): Promise<{ activities: boolean; breakouts: boolean }> {
  const [act, brk] = await Promise.all([
    api.fetch('GET', activityPath(board)),
    api.fetch('GET', breakoutsPath(board)),
  ])
  return { activities: act.status() === 200, breakouts: brk.status() === 200 }
}

const json = async <T>(r: Awaited<ReturnType<Api['fetch']>>, want: number): Promise<T> => {
  expect(r.status(), await r.text()).toBe(want)
  return (await r.json()) as T
}

test('v-compat: the 711dd04 web while this api runs a poll, a word cloud and breakouts on its board: no new route called, its board live, its timer still follows', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  test.skip(!OLD_WEB_DIST, OLD_WEB_SKIP_REASON)
  const alice = await users.api('alice')
  await users.grant(board, 'bob', 'editor')
  await users.grant(board, 'carol', 'editor')
  const landed = await routesLanded(alice, board)
  test.skip(
    !landed.activities || !landed.breakouts,
    `the wave V routes have not landed on this branch (activities: ${landed.activities}, breakouts: ${landed.breakouts}); WS1 and WS4 land them`,
  )
  test.setTimeout(240_000)
  const p = await openPair(browser, board, users, canvasSession)
  const { a, b, s } = p
  const newRoutes: string[] = []
  b.page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (
      /\/api\/(?:activities|breakouts|join)\/|\/api\/boards\/[^/]+\/(?:activity|activities|breakouts)$/.test(
        path,
      )
    )
      newRoutes.push(`${r.method()} ${path}`)
  })
  const bob = await users.api('bob')
  const carol = await users.api('carol')
  try {
    await test.step('bob is the deployed 711dd04 build', async () => {
      await expectOldBuild(p)
    })
    const bsid = await sidOf(b.page)
    const before = pushes(s)
    {
      // two frames for the groups (this tree's tab makes them, as "Make N frames" does)
      const placed = await place(a.page)
      await expectSaved(a.page)
      for (const id of placed.groups)
        await expect.poll(() => item(b.page, id).then((e) => e?.id ?? null)).toBe(id)

      await test.step('a poll: started, answered by bob and carol, revealed', async () => {
        type St = { activity: { id: string; status: string } }
        const st = await json<St>(
          await alice.fetch('POST', activitiesPath(board), {
            kind: 'poll',
            prompt: 'Which city?',
            config: { options: ['Lisbon', 'Oslo', 'Rome'] },
          }),
          201,
        )
        const aid = st.activity.id
        for (const [who, choice] of [
          [bob, 0],
          [carol, 1],
        ] as const)
          await json(
            await who.fetch('POST', activityActionPath(aid, 'answer'), {
              answer: { kind: 'poll', choices: [choice] },
            }),
            200,
          )
        const done = await json<St>(await alice.fetch('POST', activityActionPath(aid, 'reveal')), 200)
        expect(done.activity.status).toBe('revealed')
      })

      await test.step('a word cloud: started, answered, a word hidden, revealed', async () => {
        type St = { activity: { id: string; status: string } }
        const st = await json<St>(
          await alice.fetch('POST', activitiesPath(board), {
            kind: 'words',
            prompt: 'One word for the brief',
            config: { maxWords: ACTIVITY_LIMITS.wordsPerPersonDefault },
          }),
          201,
        )
        const aid = st.activity.id
        await json(
          await bob.fetch('POST', activityActionPath(aid, 'answer'), {
            answer: { kind: 'words', words: ['Bold', 'warm'] },
          }),
          200,
        )
        await json(
          await carol.fetch('POST', activityActionPath(aid, 'answer'), {
            answer: { kind: 'words', words: ['bold', 'nope'] },
          }),
          200,
        )
        await json(await alice.fetch('POST', activityActionPath(aid, 'hide'), { word: 'nope' }), 200)
        await json(await alice.fetch('POST', activityActionPath(aid, 'reveal')), 200)
      })

      await test.step('breakouts: dealt out automatically (bob’s open stream included), a broadcast, a group summon, the end', async () => {
        type Br = {
          session: { id: string; groups: { id: string }[] }
          members: { userId: string; groupId: string }[]
        }
        const br = await json<Br>(
          await alice.fetch('POST', breakoutsPath(board), {
            groups: placed.groups.map((g, i) => ({ name: `Group ${i + 1}`, frameId: `shape:${g}` })),
            mode: 'auto',
          }),
          201,
        )
        const brk = br.session.id
        const bobsGroup = br.members.find((m) => m.userId === b.id)?.groupId ?? 'g1'
        expect(
          (
            await alice.fetch('POST', breakoutActionPath(brk, 'broadcast'), {
              text: 'Five minutes left',
              groupId: null,
            })
          ).status(),
        ).toBe(204)
        const cam = await withCanvas(b.page, (c) => c.viewport.get(), null)
        expect(
          (await alice.fetch('POST', breakoutActionPath(brk, 'summon'), { groupId: bobsGroup })).status(),
        ).toBe(204)
        // the 711dd04 web has no listener for a group summon: its camera stays where it was
        await b.page.waitForTimeout(1_500)
        expect(await withCanvas(b.page, (c) => c.viewport.get(), null)).toEqual(cam)
        await json(await alice.fetch('POST', breakoutActionPath(brk, 'end')), 200)
      })
    }

    await test.step('bob’s tab called no wave V route, pushed nothing, and its event stream still follows: alice’s timer reaches it', async () => {
      expect(newRoutes, 'wave V routes the 711dd04 web called').toEqual([])
      expect(pushes(s), 'bob only received').toBe(before)
      const pop = await openWorkshopPopover(a.page)
      await pop.getByTestId('timer-preset-5').click()
      await pop.getByTestId('timer-start').click()
      await closeWorkshopPopover(a.page)
      await expect(b.page.getByTestId('facilitate-button')).toHaveAttribute('data-timer-state', 'running')
    })

    await test.step('every tab holds the server’s board; bob’s socket dropped nothing, never reconnected; his page threw nothing', async () => {
      await expectOldTabHealthy(p, stack, board)
      expect(await sidOf(b.page)).toBe(bsid)
    })
  } finally {
    await b.context.close()
  }
})
