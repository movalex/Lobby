// OWNER: WS2 (wave V, V1). The live activities' WEB half in real browsers before (and independently of) WS1's api: the
// activity routes are answered by an in-test fake with the contracts' wire shapes (docs/WAVE-V-CONTRACTS.md §2.3:
// ActivityState, the workshop.activity event, delivered into each page's board event stream), while everything else
// is the real stack: the board page, the real sync server that validates and stores every placed element, the real
// event stream, a name-only guest on a real workshop link on a 375 px phone. What it proves that the v1-poll /
// v1-word-cloud specs (the whole stack, WS1's api included) prove again: the setup dialog, the answer sheet on a phone,
// the notices, Results to board as ONE undo step whose every element the sync accepts with its kind and stores with
// the facilitator as author, receivers pushing nothing, a word cloud inside its frame, notes in their frame.
import type { BrowserContext, Page, Route } from '@playwright/test'
import { expectSaved, pushedOps } from '../tests/support/canvas.ts'
import { serverSnapshot } from '../tests/support/excalidraw.ts'
import { captureEventStreams, injectBoardEvent } from './ai-kit.ts'
import {
  answerPoll,
  answerWords,
  expect,
  focusCanvas,
  guestJoins,
  namedScaleByKeyboard,
  openActivityPanel,
  panel,
  placed,
  startActivity,
  stringsIn,
  test,
  withLive,
  workshopLink,
} from './v1-kit.ts'

// The fake hands its events to each page's EventSource (ai-kit injectBoardEvent: the cookie transport). Under
// E2E_DIRECT_EVENTS=1 the api serves the stream on its own origin and the page reads it with a fetch, which nothing
// can be handed to, so this file pins the same-origin stream, as l2-ai-pills does (the integration: both of its tests
// timed out waiting for a start notice in that mode). The real-api specs (v1-poll, v1-word-cloud, v1-scale-keyboard)
// run on either transport.
test.use({ apiEnv: { DRAFTROOM_EVENTS_ORIGIN: '' } })

type Json = Record<string, unknown>

/** The fake: one board's activity, answers by person, the contracts' aggregates. */
class FakeActivities {
  activity: Json | null = null
  readonly answers = new Map<string, Json>()
  readonly hidden = new Set<string>()
  readonly pages: { page: Page; who: string }[] = []
  /** who is who, for a named activity's answers (GET …/answers, managers, after the reveal) */
  readonly people = new Map<string, { userId: string; name: string }>()
  private n = 0
  readonly boardId: string
  readonly manager: string
  constructor(boardId: string, manager: string) {
    this.boardId = boardId
    this.manager = manager
  }

  private results(): Json | null {
    const a = this.activity
    if (!a) return null
    const list = [...this.answers.values()]
    if (a.kind === 'poll') {
      const counts = ((a.config as { options: string[] }).options ?? []).map(() => 0)
      for (const x of list) for (const c of x.choices as number[]) counts[c] = (counts[c] ?? 0) + 1
      return { kind: 'poll', answered: list.length, counts }
    }
    if (a.kind === 'scale') {
      const { min, max } = a.config as { min: number; max: number }
      const counts = new Array(max - min + 1).fill(0)
      const vs = list.map((x) => x.value as number).sort((p, q) => p - q)
      for (const v of vs) counts[v - min]++
      const mean = vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null
      const mid = vs.length >> 1
      const median = vs.length ? (vs.length % 2 ? vs[mid] : ((vs[mid - 1] ?? 0) + (vs[mid] ?? 0)) / 2) : null
      return { kind: 'scale', answered: vs.length, counts, mean, median }
    }
    const groups = new Map<string, Map<string, number>>()
    let hiddenSeen = 0
    for (const x of list)
      for (const w of x.words as string[]) {
        const key = w.normalize('NFKC').trim().toLowerCase()
        if (this.hidden.has(key)) {
          hiddenSeen++
          continue
        }
        const g = groups.get(key) ?? new Map<string, number>()
        g.set(w, (g.get(w) ?? 0) + 1)
        groups.set(key, g)
      }
    const words = [...groups.values()]
      .map((g) => {
        const spell = [...g.entries()].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]?.[0] ?? ''
        return { text: spell, count: [...g.values()].reduce((s, v) => s + v, 0) }
      })
      .sort((p, q) => q.count - p.count || (p.text < q.text ? -1 : 1))
    return { kind: 'words', answered: list.length, words, distinct: words.length, hidden: hiddenSeen }
  }

  state(who: string): Json {
    const manage = who === this.manager
    const revealed = this.activity?.status === 'revealed'
    return {
      activity: this.activity,
      answered: this.answers.size,
      myAnswer:
        (!revealed || !this.activity?.anonymous) && this.answers.get(who) ? this.answers.get(who) : null,
      results: this.activity && (manage || revealed) ? this.results() : null,
      canManage: manage,
      starterLeft: false,
      hiddenWords: manage ? [...this.hidden] : [],
      serverNow: new Date().toISOString(),
    }
  }

  private async broadcast() {
    const a = this.activity
    if (!a) return
    const event = {
      activity: a,
      answered: this.answers.size,
      results: a.status === 'revealed' ? this.results() : null,
    }
    for (const p of this.pages) await injectBoardEvent(p.page, 'workshop.activity', event).catch(() => 0)
  }

  /** Answers the activity routes for `who` in `context` (before the page loads). */
  async serve(context: BrowserContext, who: string) {
    await context.route(/\/api\/(boards\/[^/]+\/activit(y|ies)|activities\/[^/]+\/[a-z]+)(\?.*)?$/, (route) =>
      this.handle(route, who),
    )
  }

  private async handle(route: Route, who: string) {
    const req = route.request()
    const path = new URL(req.url()).pathname
    const body = (req.postDataJSON() ?? {}) as Json
    const ok = (v: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(v) })
    if (req.method() === 'GET' && path.endsWith('/activity')) return ok(this.state(who))
    if (req.method() === 'GET' && path.endsWith('/activities')) return ok({ activities: [] })
    if (req.method() === 'GET' && path.endsWith('/answers')) {
      if (who !== this.manager || this.activity?.status !== 'revealed' || this.activity.anonymous)
        return ok({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404)
      return ok({
        answers: [...this.answers].flatMap(([w, answer]) => {
          const p = this.people.get(w)
          return p ? [{ ...p, answer }] : []
        }),
      })
    }
    if (req.method() === 'POST' && path.endsWith('/activities')) {
      this.answers.clear()
      this.hidden.clear()
      this.activity = {
        id: `act_fake${String(++this.n).padStart(12, '0')}`,
        boardId: this.boardId,
        kind: body.kind,
        prompt: body.prompt,
        config: body.config,
        anonymous: body.anonymous ?? true,
        resultsLive: body.resultsLive ?? false,
        status: 'open',
        createdBy: 'usr_0000000000fake',
        createdAt: new Date().toISOString(),
        endsAt: null,
        closedAt: null,
        revealedAt: null,
        placedAt: null,
      }
      await ok(this.state(who), 201)
      await this.broadcast()
      return
    }
    const action = path.split('/').pop()
    const a = this.activity
    if (!a) return ok({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404)
    if (action === 'answer') this.answers.set(who, body.answer as Json)
    if (action === 'close') Object.assign(a, { status: 'closed', closedAt: new Date().toISOString() })
    if (action === 'reveal')
      Object.assign(a, {
        status: 'revealed',
        closedAt: new Date().toISOString(),
        revealedAt: new Date().toISOString(),
      })
    if (action === 'placed') Object.assign(a, { placedAt: new Date().toISOString() })
    if (action === 'hide') {
      const key = String(body.word).normalize('NFKC').trim().toLowerCase()
      if (body.hidden === false) this.hidden.delete(key)
      else this.hidden.add(key)
    }
    await ok(this.state(who))
    await this.broadcast()
  }
}

test('the web half with a fake activity api: a poll and a word cloud, a phone guest, placements the real sync stores', async ({
  join,
  board,
  browser,
  stack,
}, testInfo) => {
  const shot = (p: Page, name: string) => p.screenshot({ path: testInfo.outputPath(name) })
  const fake = new FakeActivities(board, 'alice')
  const alice = await join('alice')
  const bob = await join('bob', 'editor')
  for (const [s, who] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const) {
    await fake.serve(s.context, who)
    await captureEventStreams(s.page)
    await withLive(s)
    fake.pages.push({ page: s.page, who })
  }
  const opened: BrowserContext[] = []
  try {
    // the guest: a fresh 375 px phone, routed and captured before it loads
    const link = await workshopLink(alice, board)
    const guest = await guestJoinsRouted(browser, link, fake, opened)
    fake.pages.push({ page: guest.page, who: 'guest' })

    // ---- a poll ----
    await startActivity(alice.page, { kind: 'poll', prompt: 'Which day?', options: ['Mon', 'Wed', 'Fri'] })
    await expect(alice.page.getByTestId('facilitate-pill-activities')).toHaveText('Poll')
    await expect(bob.page.getByTestId('la-start-toast')).toContainText('Poll: Which day?')
    await answerPoll(bob.page, [2])
    await expect(guest.page.getByTestId('la-start-toast')).toBeVisible()
    const sheet = await openActivityPanel(guest.page)
    const box = await sheet.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 376).toBe(true)
    const send = await sheet.getByTestId('la-answer-send').boundingBox()
    expect(send && send.height >= 44).toBe(true)
    await shot(guest.page, 'phone-sheet.png')
    await answerPoll(guest.page, [0])
    await shot(guest.page, 'phone-answered.png')
    await expect(panel(alice.page).getByTestId('la-answered')).toHaveAttribute('data-count', '2', {
      timeout: 20_000,
    })
    await shot(alice.page, 'facilitator-live.png')
    await expect(panel(bob.page).getByTestId('la-results-later')).toBeVisible()

    await panel(alice.page).getByTestId('la-reveal').click()
    await expect(bob.page.getByTestId('la-results-toast')).toBeVisible()
    await expect(panel(bob.page).getByTestId('la-poll-results')).toBeVisible()
    const before = [(await pushedOps(bob.page)).length, (await pushedOps(guest.page)).length]
    await panel(alice.page).getByTestId('la-to-board').click()
    await expect(alice.page.getByTestId('la-toast')).toContainText('on the board')
    await shot(alice.page, 'poll-on-board.png')
    await expectSaved(alice.page)
    const chart = await placed(alice.page, 'poll-chart')
    expect(chart.filter((e) => e.type === 'rectangle')).toHaveLength(2)
    const stored = (await serverSnapshot(stack, board)).elements.filter(
      (e) => !e.isDeleted && (e.customData as { lobby?: { kind?: unknown } })?.lobby?.kind === 'poll-chart',
    )
    expect(stored).toHaveLength(chart.length)
    for (const e of stored) {
      expect(
        (e.customData as { lobbyServer?: { createdBy?: { uid?: unknown } } }).lobbyServer?.createdBy?.uid,
      ).toBe(alice.id)
      expect(stringsIn(e).join('\n')).not.toContain(bob.id)
      expect(stringsIn(e).join('\n')).not.toContain(guest.id)
    }
    for (const p of [bob.page, guest.page])
      await expect.poll(async () => (await placed(p, 'poll-chart')).length).toBe(chart.length)
    expect([(await pushedOps(bob.page)).length, (await pushedOps(guest.page)).length]).toEqual(before)
    await focusCanvas(alice.page)
    await alice.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await placed(alice.page, 'poll-chart')).length).toBe(0)
    await expectSaved(alice.page)

    // ---- a word cloud ----
    await panel(alice.page).getByTestId('la-start').click()
    await startActivityInOpenDialog(alice.page)
    await answerWords(bob.page, ['Agile', 'Speed', 'coffee'])
    await answerWords(guest.page, ['agile', 'speed'])
    const live = panel(alice.page).getByTestId('la-words-results')
    await expect(live.locator('li').first()).toContainText('Agile')
    await shot(alice.page, 'facilitator-words.png')
    await live.getByRole('button', { name: 'Hide the word coffee' }).click()
    await expect(live).not.toContainText('coffee')
    await panel(alice.page).getByTestId('la-reveal').click()
    await expect(panel(guest.page).getByTestId('la-words-results').locator('li')).toHaveCount(2)
    await panel(alice.page).getByTestId('la-to-board').click()
    await expectSaved(alice.page)
    await shot(alice.page, 'cloud-on-board.png')
    const cloud = await placed(alice.page, 'word-cloud')
    const frame = cloud.find((e) => e.type === 'frame')
    const words = cloud.filter((e) =>
      ['Agile', 'Speed'].includes((e as unknown as { text?: string }).text ?? ''),
    )
    expect(words).toHaveLength(2)
    for (const w of words) {
      expect(w.frameId).toBe(frame?.id)
      expect(w.x + w.width).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.width ?? 0) + 1)
    }
    await panel(alice.page).getByTestId('la-to-board-notes').click()
    await expectSaved(alice.page)
    const notes = (await placed(alice.page, 'word-cloud')).filter((e) => e.type === 'stickynote')
    expect(notes).toHaveLength(2)
    const frames = (await placed(alice.page, 'word-cloud')).filter((e) => e.type === 'frame')
    expect(frames).toHaveLength(2)
    for (const n of notes) expect(frames.map((f) => f.id)).toContain(n.frameId)
    expect(
      (await serverSnapshot(stack, board)).elements.filter(
        (e) => !e.isDeleted && (e.customData as { lobby?: { kind?: unknown } })?.lobby?.kind === 'word-cloud',
      ).length,
    ).toBe((await placed(alice.page, 'word-cloud')).length)
  } finally {
    for (const c of opened) await c.close()
  }
})

/** The setup dialog is open: a word cloud of up to three words. */
async function startActivityInOpenDialog(page: Page) {
  const d = page.getByTestId('la-setup-dialog')
  await expect(d).toBeVisible()
  await d.getByTestId('la-kind-words').check()
  await d.getByTestId('la-prompt-input').fill('One word for this sprint?')
  await d.getByTestId('la-setup-submit').click()
  await expect(d).toHaveCount(0)
  await expect(panel(page)).toHaveAttribute('data-kind', 'words')
}

/** guestJoins, with the fake's routes and the event capture installed before the page loads. */
async function guestJoinsRouted(
  browser: Parameters<typeof guestJoins>[0],
  url: string,
  fake: FakeActivities,
  opened: BrowserContext[],
) {
  const real = browser.newContext.bind(browser)
  const patched = Object.create(browser) as typeof browser
  patched.newContext = async (o?: Parameters<typeof browser.newContext>[0]) => {
    const c = await real(o)
    await fake.serve(c, 'guest')
    await c.addInitScript(() => {
      const w = window as unknown as { EventSource: typeof EventSource; __lobbyEventSources?: EventSource[] }
      if (w.__lobbyEventSources) return
      const Real = w.EventSource
      const open: EventSource[] = []
      w.__lobbyEventSources = open
      w.EventSource = class extends Real {
        constructor(u: string | URL, init?: EventSourceInit) {
          super(u, init)
          open.push(this)
        }
      }
    })
    return c
  }
  return guestJoins(patched, url, 'Gus Guest', opened)
}

test('the web half with a fake activity api: a named scale by keyboard, names for the facilitator alone', async ({
  join,
  board,
}) => {
  const fake = new FakeActivities(board, 'alice')
  const alice = await join('alice')
  const bob = await join('bob', 'editor')
  for (const [s, who] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const) {
    await fake.serve(s.context, who)
    await captureEventStreams(s.page)
    await withLive(s)
    fake.pages.push({ page: s.page, who })
    fake.people.set(who, { userId: s.id, name: s.name })
  }
  await namedScaleByKeyboard(alice, bob)
})
