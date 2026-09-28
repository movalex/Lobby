// The scene script: two people (Alex, the presenter, on the left; Sam, a teammate, on the right) and a
// client on a phone, driven through the real UI of a fresh local stack. Everything on the boards is
// made here, through the UI. What happens between scenes (signing in, sharing, moving the view) is
// filmed too but cut by the composer: only the scene windows recorded in the timeline are used.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  type Locator,
  type Page,
} from '@playwright/test'
import {
  type Box,
  boardReady,
  center,
  centerView,
  editingId,
  frameByName,
  type ShapeInfo,
  shapeByText,
  shapes,
  toScreen,
  union,
  view,
  viewport,
} from './board.ts'
import { DSF, PANE, PANE_CSS } from './cards.ts'
import { Director, errText, SkipScene } from './director.ts'
import { Actor, type Point, prepareContext, sleep } from './human.ts'
import { type PageRecording, recordPage } from './recorder.ts'
import type { NarrationScene, SceneWindow, Timeline, Track } from './timeline.ts'

export interface RecordOptions {
  webUrl: string
  outDir: string
  narration: NarrationScene[]
  /** Stop after this scene id (for quick iterations). */
  until?: string
  headed?: boolean
  log: (msg: string) => void
}

/** Each desktop window: PANE device pixels in the video, the UI drawn at DSF (cards.ts). */
const DESK = PANE_CSS
const PHONE = { width: 390, height: 844 }
const PHONE_DSF = 2
const PEOPLE = {
  alex: { handle: 'alex', name: 'Alex Rivera' },
  sam: { handle: 'sam', name: 'Sam Lee' },
  guest: 'Jordan',
}
/** The boards already in the lobby when the demo starts (made through the New board dialog). */
const LOBBY_BOARDS: ReadonlyArray<{ template: string; title: string }> = [
  { template: 'Retrospective', title: 'Sprint 14 retro' },
  { template: 'Production plan', title: 'Launch production plan' },
  { template: 'Mood board', title: 'Key art mood board' },
  { template: 'Brainstorm', title: 'Trailer brainstorm' },
]

interface Recorded {
  context: BrowserContext
  page: Page
  rec: PageRecording
  id: Track['id']
}

export async function recordDemo(opts: RecordOptions): Promise<Timeline> {
  const { webUrl, log } = opts
  const videoDir = join(opts.outDir, 'recordings')
  const debugDir = join(opts.outDir, 'debug')
  mkdirSync(videoDir, { recursive: true })
  mkdirSync(debugDir, { recursive: true })
  const director = new Director(opts.narration, log)
  const browser = await chromium.launch({ headless: !opts.headed })
  const recorded: Recorded[] = []

  const colors: Timeline['colors'] = {}
  const open = async (
    id: Track['id'],
    size: { width: number; height: number },
    scale: number,
    extra: BrowserContextOptions = {},
  ) => {
    const context = await browser.newContext({
      viewport: size,
      deviceScaleFactor: scale,
      colorScheme: 'light',
      acceptDownloads: true,
      baseURL: webUrl,
      ...extra,
    })
    await prepareContext(context, { touch: id === 'phone' })
    const page = await context.newPage()
    await page.setContent('<body style="margin:0;background:#f5f6f8"></body>')
    // Recorded at device pixels: the desktops at exactly PANE, the phone at its full resolution.
    const rec = await recordPage(page, join(videoDir, `${id}.mp4`), {
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
    })
    const r: Recorded = { context, page, rec, id }
    recorded.push(r)
    return r
  }
  /** Ends a recording and closes its window. */
  const close = async (r: Recorded) => {
    await r.rec.stop().catch((e) => log(`recording ${r.id}: ${errText(e)}`))
    await r.context.close().catch(() => {})
  }

  const snap = async (tag: string) => {
    for (const r of recorded) {
      if (r.page.isClosed()) continue
      await r.page.screenshot({ path: join(debugDir, `${tag}-${r.id}.png`) }).catch(() => {})
    }
  }

  let stopped = false
  const done = (id: string) => {
    if (opts.until && id === opts.until) stopped = true
    return stopped
  }

  try {
    const A = await open('alex', DESK, DSF)
    const S = await open('sam', DESK, DSF)
    if (A.rec.width !== PANE.w || A.rec.height !== PANE.h) throw new Error('desktop recording size mismatch')
    const alex = new Actor('Alex', A.page, { seed: 11, start: { x: 600, y: 520 } })
    const sam = new Actor('Sam', S.page, { seed: 23, start: { x: 420, y: 600 } })

    // ---- off camera: sign in (Alex first: the first person becomes the owner of the shared studio) ----
    await signIn(A.page, PEOPLE.alex)
    await signIn(S.page, PEOPLE.sam)
    await Promise.all([openStudio(A.page), openStudio(S.page)])
    colors.alex = await avatarColor(A.page)
    colors.sam = await avatarColor(S.page)
    await makeLobbyBoards(browser, webUrl, log)

    director.card('01-intro')

    // ---- 02 dashboard: thumbnails, then a new board from the Lobby tour ----
    let boardUrl = ''
    await director.scene(
      '02-dashboard',
      async (clock) => {
        const cards = A.page.getByTestId('board-card')
        await Promise.all([
          (async () => {
            await alex.pause(700)
            await alex.hover(cards.nth(0), { v: 0.4 })
            await alex.pause(500)
            await alex.hover(cards.nth(1), { v: 0.45 })
            await alex.pause(450)
            await alex.clickOn(A.page.getByRole('button', { name: 'New board' }).first())
            const dialog = A.page.getByTestId('create-board-dialog')
            await dialog.waitFor()
            await alex.pause(700)
            await alex.clickOn(A.page.getByTestId('template-sample'), { v: 0.35 })
            await alex.pause(500)
            await alex.clickOn(A.page.getByTestId('create-board-title'), { u: 0.2 })
            await alex.type('Lobby tour')
            await alex.pause(350)
            await alex.clickOn(A.page.getByTestId('create-board-submit'))
            await boardReady(A.page)
            await waitForFrames(A.page, 6)
            boardUrl = A.page.url().split('?')[0] ?? ''
            await alex.move({ x: 620, y: 700 }, 700)
          })(),
          (async () => {
            const sc = S.page.getByTestId('board-card')
            await sam.pause(1500)
            await sam.hover(sc.nth(2), { v: 0.4 })
            await sam.pause(1600)
            await sam.hover(sc.nth(0), { v: 0.5 })
            await sam.pause(1200)
            await sam.move({ x: 700, y: 820 }, 900)
          })(),
        ])
        await clock.at(clock.elapsed + 1200)
      },
      {
        prepare: async () => {
          // Fresh dashboards, so both show the thumbnails the lobby boards just got.
          await Promise.all([openStudio(A.page), openStudio(S.page)])
          await Promise.all([thumbnailsShown(A.page), thumbnailsShown(S.page)])
          await Promise.all([alex.nudge(), sam.nudge()])
        },
      },
    )
    if (!boardUrl) throw new Error('the Lobby tour was not created; later scenes need it')
    if (done('02-dashboard')) return await finish()

    // ---- off camera: Alex shares the tour with Sam; both open it on the Brainstorm frame ----
    await shareWithTeammate(A.page, 'sam')
    // Leaving the board ends Alex's editing session: the api saves the automatic "After an editing
    // session" checkpoint that scene 10 shows, and the dashboard card gets the tour's thumbnail. The
    // sync server lets a closed session go after about 5 s, so Alex stays away until it is saved.
    await A.page.goto('/')
    const boardId = boardUrl.split('/b/')[1] ?? ''
    await waitFor(
      async () => {
        const res = await A.page.request.get(`/api/boards/${boardId}/snapshots`)
        if (!res.ok()) return false
        const { snapshots } = (await res.json()) as { snapshots: Array<{ kind?: string }> }
        return snapshots.some((s) => s.kind === 'auto')
      },
      'the automatic checkpoint after Alex left the tour',
      45_000,
    ).catch((e) => log(`no automatic checkpoint yet: ${errText(e)}`))
    await Promise.all([A.page.goto(boardUrl), S.page.goto(boardUrl)])
    await Promise.all([boardReady(A.page), boardReady(S.page)])
    await Promise.all([waitForFrames(A.page, 6), waitForFrames(S.page, 6)])

    // ---- 03 real-time collaboration on the Brainstorm frame ----
    let samNote: ShapeInfo | null = null
    await director.scene(
      '03-collab',
      async (clock) => {
        const story2 = await shapeByText(A.page, 'Start at the ending, then rewind', 'note')
        const story1 = await shapeByText(A.page, "Tell it from the villain's side", 'note')
        const boss = await shapeByText(A.page, 'Open on the boss fight. No logo for ten seconds.', 'note')
        const premiere = await shapeByText(A.page, 'Premiere it live with creators', 'note')
        const slot: Point = {
          x: story2.box.x + (story2.box.x - story1.box.x) + story2.box.w / 2,
          y: story2.box.y + story2.box.h / 2,
        }
        const noteTool = S.page.getByRole('button', { name: /^Note/ }).first()
        await Promise.all([
          (async () => {
            // Alex points at the question and the Story theme while Sam gets going.
            const q = await shapeByText(A.page, "Launch trailer:\nwhat's the hook?").catch(() => null)
            if (q) await alex.move(await toScreen(A.page, center(q.box)), 900)
            await alex.pause(600)
            const storyTheme = await shapeByText(A.page, 'Story').catch(() => null)
            if (storyTheme) await alex.move(await toScreen(A.page, center(storyTheme.box)), 800)
            await alex.pause(900)
            await alex.move(await toScreen(A.page, { x: slot.x - 40, y: slot.y + 140 }), 1000)
          })(),
          (async () => {
            await sam.pause(900)
            await sam.clickOn(noteTool)
            await sam.pause(300)
            await sam.click(await toScreen(S.page, slot), { ms: 900 })
            await waitFor(() => editingId(S.page), 'Sam editing the new note')
            await sam.pause(250)
            await sam.type("Show the villain's first win")
            await sam.pause(400)
            await sam.press('Escape', 400)
            await sam.press('Escape', 200)
          })(),
        ])
        samNote = await shapeByText(A.page, "Show the villain's first win", 'note')
        // Alex connects Sam's idea to the boss fight it pays off, with the connector tool.
        await alex.clickOn(A.page.getByRole('button', { name: /^Connector/ }).first())
        await alex.pause(250)
        const from = await toScreen(A.page, {
          x: samNote.box.x + samNote.box.w * 0.35,
          y: samNote.box.y + samNote.box.h * 0.4,
        })
        const to = await toScreen(A.page, {
          x: boss.box.x + boss.box.w * 0.55,
          y: boss.box.y + boss.box.h * 0.6,
        })
        await Promise.all([
          alex.drag(from, to, 900),
          sam.move(
            await toScreen(S.page, { x: premiere.box.x + 20, y: premiere.box.y + premiere.box.h + 90 }),
            1400,
          ),
        ])
        await alex.pause(300)
        await alex.press('Escape', 300)
        // The save indicator: every change is stored as it happens.
        await alex.hover(A.page.getByTestId('save-status'), { ms: 900 })
        await clock.at(clock.elapsed + 1500)
      },
      {
        prepare: async () => {
          for (const [p, who] of [
            [A.page, alex],
            [S.page, sam],
          ] as const) {
            // The themes and their ideas, from just under the frame's intro line, with room for Sam's note.
            const frame = await frameByName(p, '2 · Brainstorm')
            const kids = (await shapes(p)).filter((s) => s.parentId === frame.id)
            const themes = kids.filter((s) => ['Gameplay', 'Story', 'Community'].includes(s.text))
            const area = union([...themes, ...kids.filter((s) => s.type === 'note')].map((s) => s.box))
            const vp = await viewport(p)
            const w = area.w + 130
            await view(p, { x: area.x - 45, y: area.y - 75, w, h: (w * vp.h) / vp.w }, { inset: 0 })
            await who.nudge()
          }
        },
      },
    )
    if (done('03-collab')) return await finish()

    // ---- 04 mind map by keyboard ----
    await director.scene(
      '04-mindmap',
      async (clock) => {
        await alex.clickOn(A.page.getByTestId('tools.dr-mindmap'))
        await waitFor(() => editingId(A.page), 'the central topic to be ready for typing')
        await alex.pause(350)
        await alex.type('Trailer launch')
        // Scroll so the map has room to grow to the right (both people look at the same spot).
        const root = await shapeByText(A.page, 'Trailer launch')
        const focus = { x: center(root.box).x + 290, y: center(root.box).y + 40 }
        await Promise.all([centerView(A.page, focus, 1, 700), centerView(S.page, focus, 1, 700)])
        const steps: Array<[string, string]> = [
          ['Tab', 'Teaser drop'],
          ['Enter', 'Launch day'],
          ['Enter', 'Creator premiere'],
          ['Tab', 'Twitch watch party'],
        ]
        const samWatch = (async () => {
          const vp = await viewport(S.page)
          await sam.pause(900)
          await sam.move({ x: vp.x + vp.w * 0.62, y: vp.y + vp.h * 0.8 }, 1400)
          await sam.pause(2600)
          await sam.move({ x: vp.x + vp.w * 0.8, y: vp.y + vp.h * 0.74 }, 1400)
        })()
        for (const [key, text] of steps) {
          await alex.pause(300)
          await alex.press(key, 350)
          await alex.type(text, 12)
        }
        await alex.pause(400)
        await alex.press('Escape', 300)
        await alex.press('Escape', 300)
        await alex.move({ x: 700, y: 880 }, 700)
        await samWatch
        // The whole map, tidy, on both screens.
        const map = (await shapes(A.page)).filter((s) => s.meta.drMindmap)
        if (map.length) {
          const b = union(map.map((s) => s.box))
          await Promise.all([
            view(A.page, b, { inset: 110, ms: 800 }),
            view(S.page, b, { inset: 110, ms: 800 }),
          ])
        }
        await clock.at(clock.elapsed + 1400)
      },
      {
        prepare: async () => {
          if ((await A.page.getByTestId('tools.dr-mindmap').count()) === 0) {
            throw new SkipScene('mind maps are not in this build (no Mind map tool)')
          }
          // Empty canvas well under the Brainstorm frame.
          const frame = await frameByName(A.page, '2 · Brainstorm')
          const spot = { x: frame.box.x + 700, y: frame.box.y + frame.box.h + 700 }
          await Promise.all([centerView(A.page, spot, 1), centerView(S.page, spot, 1)])
          await A.page.keyboard.press('Escape')
          await Promise.all([alex.nudge(), sam.nudge()])
        },
      },
    )
    if (done('04-mindmap')) return await finish()

    // ---- 05 AI: group the brainstorm into themes (only when the ai feature is in the build) ----
    await director.scene(
      '05-ai',
      async (clock) => {
        const action = await findAiGroupAction(A.page, alex)
        if (!action) throw new Error('the AI action went away')
        await alex.clickOn(action)
        await acceptAiNotice(A.page, alex)
        await waitForAiResult(A.page)
        await alex.pause(800)
        await clock.at(clock.elapsed + 1200)
      },
      {
        prepare: async () => {
          const frame = await frameByName(A.page, '2 · Brainstorm')
          await Promise.all([view(A.page, frame.box, { inset: 30 }), view(S.page, frame.box, { inset: 30 })])
          // Off camera: is there a "Group into themes" action at all? (select the notes, look, let go)
          const found = await findAiGroupAction(A.page, alex)
          await A.page.keyboard.press('Escape')
          await A.page.keyboard.press('Escape')
          if (!found)
            throw new SkipScene('AI "Group into themes" is not in this build (features/ai is a stub)')
          await Promise.all([alex.nudge(), sam.nudge()])
        },
      },
    )
    if (done('05-ai')) return await finish()

    // ---- 06 private brainstorm ----
    await director.scene(
      '06-private',
      async (clock) => {
        await alex.clickOn(A.page.getByTestId('dock-tab-private-notes'))
        await alex.clickOn(A.page.getByTestId('pn-start-panel'))
        const dialog = A.page.getByTestId('pn-setup-dialog')
        await dialog.waitFor()
        await alex.pause(250)
        await alex.clickOn(dialog.getByTestId('pn-prompt-input'), { u: 0.3 })
        await alex.type('What should the teaser show?', 15)
        await alex.pause(200)
        const target = dialog.getByTestId('pn-target-new')
        if (!(await target.isChecked())) await alex.clickOn(target)
        await alex.clickOn(dialog.getByTestId('pn-setup-submit'))
        await A.page.getByTestId('pn-panel').waitFor()
        const write = async (who: Actor, page: Page, notes: string[]) => {
          const panel = page.getByTestId('pn-panel')
          if (!(await panel.isVisible())) await who.clickOn(page.getByTestId('pn-chip'))
          await panel.waitFor()
          await who.clickOn(panel.getByTestId('pn-compose-text'), { u: 0.3 })
          for (const text of notes) {
            await who.type(text, 18)
            await who.pause(150)
            await who.clickOn(panel.getByTestId('pn-add'), { ms: 450 })
            await who.pause(250)
            await who.clickOn(panel.getByTestId('pn-compose-text'), { u: 0.3, ms: 400 })
          }
        }
        await Promise.all([
          write(alex, A.page, ['The villain wins round one', 'Save the co-op move for the end']),
          (async () => {
            await S.page.getByTestId('pn-chip').waitFor({ timeout: 15_000 })
            await sam.pause(300)
            await write(sam, S.page, ['A countdown in a player’s voice'])
          })(),
        ])
        await waitText(A.page.getByTestId('pn-counts'), /3 notes from 2 people/)
        await alex.hover(A.page.getByTestId('pn-counts'), { ms: 500 })
        await alex.pause(700)
        await alex.clickOn(A.page.getByTestId('pn-reveal'))
        await waitFor(async () => (await privateNotes(S.page)).length >= 3 || null, 'the revealed notes')
        await alex.pause(700)
        // Both close their panels, then "Show me" on the reveal notice brings each view to the notes.
        await Promise.all([closeDock(A.page, alex), closeDock(S.page, sam)])
        const showMe = async (who: Actor, page: Page) => {
          const button = page.getByTestId('pn-toast-show')
          if (await button.isVisible().catch(() => false)) {
            await who.clickOn(button, { ms: 600 })
            await sleep(700)
          } else {
            const notes = union((await privateNotes(page)).map((n) => n.box))
            await view(page, notes, { inset: 110, ms: 700 })
          }
        }
        await Promise.all([
          showMe(alex, A.page),
          (async () => {
            await sam.pause(350)
            await showMe(sam, S.page)
          })(),
        ])
        await clock.at(clock.elapsed + 1500)
      },
      {
        prepare: async () => {
          await Promise.all([A.page.keyboard.press('Escape'), S.page.keyboard.press('Escape')])
          await A.page.evaluate(() => {
            ;(window.editor as unknown as { selectNone(): void }).selectNone()
          })
          // Empty canvas to the right of the mind map, just under the Plan and Mood board frames (their
          // bottom edges stay in view, so the canvas does not offer "Back to content").
          const plan = await frameByName(A.page, '3 · Plan')
          const spot = { x: plan.box.x + plan.box.w + 80, y: plan.box.y + plan.box.h + 530 }
          await Promise.all([centerView(A.page, spot, 0.9), centerView(S.page, spot, 0.9)])
          await Promise.all([alex.nudge(), sam.nudge()])
        },
      },
    )
    if (done('06-private')) return await finish()

    // ---- 07 dot voting ----
    await director.scene(
      '07-vote',
      async (clock) => {
        await alex.clickOn(A.page.getByTestId('dock-tab-voting'))
        await alex.clickOn(A.page.getByTestId('vote-start-panel'))
        const dialog = A.page.getByTestId('vote-setup-dialog')
        await dialog.waitFor()
        await alex.pause(250)
        const perPerson = dialog.getByTestId('vote-per-person')
        await alex.clickOn(perPerson)
        await perPerson.fill('')
        await alex.type('2')
        const scope = dialog.getByTestId('vote-scope')
        await alex.hover(scope, { ms: 450 })
        const option = await scope
          .locator('option', { hasText: 'Private ideas' })
          .first()
          .getAttribute('value')
        if (option) await scope.selectOption(option)
        await alex.pause(250)
        const types = dialog.getByTestId('vote-types')
        await alex.hover(types, { ms: 350 })
        await types.selectOption('note')
        await alex.pause(250)
        await alex.clickOn(dialog.getByTestId('vote-setup-submit'))
        // Starting the vote brings the facilitator's view to its frame; then Alex zooms in on the notes.
        await A.page.getByTestId('vote-bar').waitFor({ timeout: 15_000 })
        await sleep(700)
        const noteBox = union((await privateNotes(A.page)).map((n) => n.box))
        await view(A.page, noteBox, { inset: 60, ms: 500 })
        const notes = await privateNotes(A.page)
        const byText = (t: string) => notes.find((n) => n.text.startsWith(t)) ?? notes[0]
        /** The starter is in the vote already; everyone else accepts the prompt. */
        const join = async (who: Actor, page: Page) => {
          const prompt = page.getByTestId('vote-join-prompt')
          const bar = page.getByTestId('vote-bar')
          await waitFor(
            async () => (await bar.isVisible()) || (await prompt.isVisible()),
            'the vote to reach this person',
          )
          if (!(await bar.isVisible())) {
            await who.pause(400)
            await who.clickOn(prompt.getByTestId('vote-join'))
            await bar.waitFor()
          }
        }
        const vote = async (who: Actor, page: Page, picks: string[]) => {
          for (const t of picks) {
            const n = byText(t)
            if (!n) continue
            await who.click(await toScreen(page, { x: n.box.x + n.box.w * 0.5, y: n.box.y + n.box.h * 0.6 }))
            await who.pause(600)
          }
        }
        await Promise.all([
          (async () => {
            await join(alex, A.page)
            await vote(alex, A.page, ['The villain wins', 'Save the co-op'])
          })(),
          (async () => {
            await join(sam, S.page)
            await vote(sam, S.page, ['The villain wins', 'A countdown'])
            await sam.clickOn(S.page.getByTestId('vote-done'))
          })(),
        ])
        await alex.pause(400)
        const panel = A.page.getByTestId('dock-panel-voting')
        await alex.clickOn(panel.getByTestId('vote-reveal'))
        await S.page
          .getByTestId('vote-results-card')
          .waitFor({ timeout: 8000 })
          .catch(() => {})
        await alex.hover(panel.getByTestId('vote-results'), { v: 0.3, ms: 700 }).catch(() => {})
        await clock.at(clock.elapsed + 2000)
      },
      {
        prepare: async () => {
          // A known client race (see the demo README): a participant who is not the starter can keep a
          // stale "Revealing…" chip after the reveal. The server's state is final; a reload shows it.
          await sleep(1500)
          if (
            await S.page
              .getByTestId('pn-chip')
              .isVisible()
              .catch(() => false)
          ) {
            log('[07-vote] Sam still shows the finished brainstorm chip; reloading his tab off camera')
            await S.page.reload()
            await boardReady(S.page)
            await waitForFrames(S.page, 7)
          }
          await Promise.all([tidy(A.page), tidy(S.page)])
          const notes = union((await privateNotes(A.page)).map((n) => n.box))
          await Promise.all([view(A.page, notes, { inset: 110 }), view(S.page, notes, { inset: 110 })])
          await Promise.all([alex.nudge(), sam.nudge()])
        },
      },
    )
    if (done('07-vote')) return await finish()

    // ---- 08 a client joins from a phone with just a name ----
    let link = ''
    const phoneRef: { rec: Recorded | null } = { rec: null }
    await director.scene(
      '08-guest',
      async (clock, win) => {
        const P = phoneRef.rec
        if (!P) throw new Error('no phone')
        const phone = new Actor('Jordan', P.page, { touch: true })
        win.phone = { start: clock.start, end: 0 }
        const nameField = P.page.getByTestId('invite-guest-name')
        await phone.pause(900)
        await phone.clickOn(nameField)
        await phone.type(PEOPLE.guest, 8)
        await phone.pause(500)
        await phone.clickOn(P.page.getByTestId('invite-guest-join'))
        await boardReady(P.page)
        const guestId = await P.page.getByTestId('user-menu').getAttribute('data-user-id')
        // Alex sees the guest arrive: their avatar joins the people on the board.
        const avatar = A.page.locator(`[data-testid="presence-user"][data-user-id="${guestId}"] button`)
        await avatar.waitFor({ timeout: 20_000 })
        await alex.hover(avatar, { ms: 700 })
        await phone.pause(1200)
        // The guest (a commenter) leaves a comment on the winning note.
        const commented = await guestComment(P.page, phone, 'Love this one!').catch((e) => {
          log(`[08-guest] guest comment: ${errText(e)}`)
          return false
        })
        if (commented) {
          const pin = A.page.getByTestId('comment-pin').last()
          await pin.waitFor({ timeout: 15_000 })
          await alex.clickOn(pin)
          await A.page
            .getByTestId('thread-popover')
            .waitFor({ timeout: 10_000 })
            .catch(() => {})
        }
        await alex.pause(1800)
        win.phone.end = Date.now()
        await clock.at(clock.elapsed + 300)
      },
      {
        prepare: async () => {
          await closeDock(A.page, alex)
          await closeDock(S.page, sam)
          const notes = union((await privateNotes(A.page)).map((n) => n.box))
          await view(A.page, notes, { inset: 110 })
          await view(S.page, notes, { inset: 110 })
          // The client lands on the brainstorm: Alex makes this the board's start view (main menu).
          await setStartView(A.page).catch((e) => log(`[08-guest] start view: ${errText(e)}`))
          link = await createGuestReviewLink(A.page)
          const P = await open('phone', PHONE, PHONE_DSF, {
            isMobile: true,
            hasTouch: true,
            userAgent:
              'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
          })
          phoneRef.rec = P
          await P.page.goto(link)
          await P.page.getByTestId('invite-guest-name').waitFor({ timeout: 30_000 })
          await Promise.all([tidy(A.page), tidy(S.page)])
          await Promise.all([alex.move({ x: 560, y: 760 }, 200), sam.move({ x: 640, y: 780 }, 200)])
        },
      },
    )
    if (phoneRef.rec) await close(phoneRef.rec)
    if (done('08-guest')) return await finish()

    // ---- 09 present mode, bringing everyone along ----
    await director.scene(
      '09-present',
      async (clock) => {
        const everyone = await presentToEveryone(A.page, alex)
        if (!everyone) {
          // No "present to everyone" in this build: gather everyone first, so Sam follows the slides.
          await alex.clickOn(A.page.getByTestId('timer-pill'))
          await alex.clickOn(A.page.getByTestId('summon-button'))
          await alex.pause(700)
          await alex.clickOn(A.page.getByTestId('present-button'))
        }
        await A.page.getByTestId('present-overlay').waitFor({ timeout: 15_000 })
        await alex.move({ x: 700, y: 900 }, 600)
        for (let i = 0; i < 4; i++) {
          await alex.pause(1500)
          await alex.press('ArrowRight', 100)
        }
        await alex.pause(1600)
        await clock.at(clock.elapsed + 300)
      },
      {
        prepare: async () => {
          await A.page.keyboard.press('Escape')
          await closeDock(A.page, alex)
          await A.page.evaluate(() => {
            ;(window.editor as unknown as { selectNone(): void }).selectNone()
          })
          await Promise.all([tidy(A.page), tidy(S.page)])
          await Promise.all([alex.nudge(), sam.nudge()])
        },
      },
    )
    if (done('09-present')) return await finish()

    // ---- 10 export and history ----
    await director.scene(
      '10-history',
      async (clock) => {
        /** History panel → the "Automatic" checkpoints, opened. */
        const openHistory = async (who: Actor, page: Page) => {
          await who.clickOn(page.getByTestId('dock-tab-history'))
          const auto = page.getByTestId('checkpoint-auto')
          await auto.waitFor({ timeout: 10_000 })
          // The panel restores the section's last open state as it loads: let it settle first.
          await who.pause(700)
          const isOpen = () => auto.evaluate((d) => (d as HTMLDetailsElement).open)
          for (let i = 0; i < 2 && !(await isOpen()); i++) {
            await who.clickOn(page.getByTestId('checkpoint-auto-toggle'), { u: 0.2 })
            await who.pause(400)
          }
          const row = page.getByTestId('checkpoint-auto-row').first()
          await row.waitFor({ timeout: 5000 }).catch(() => {})
          return row
        }
        await Promise.all([
          (async () => {
            // Export: one frame as an image, or the whole tour as a PDF (a page per frame).
            await alex.clickOn(A.page.getByTestId('export-button'))
            const pdf = A.page.getByTestId('export-pdf')
            await pdf.waitFor()
            await alex.pause(500)
            await alex.clickOn(A.page.getByTestId('export-area-frame'))
            await alex.hover(A.page.getByTestId('export-png'), { ms: 600 })
            await alex.pause(400)
            const download = A.page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
            await alex.clickOn(pdf)
            await download
            await alex.pause(700)
            await A.page.keyboard.press('Escape')
            await alex.pause(200)
          })(),
          (async () => {
            await sam.pause(700)
            const row = await openHistory(sam, S.page)
            await sam.pause(500)
            if (await row.count()) await sam.hover(row, { ms: 700, u: 0.35 })
          })(),
        ])
        const row = await openHistory(alex, A.page)
        await alex.pause(400)
        const preview = row.getByTestId('checkpoint-preview')
        if (await preview.count()) {
          await alex.clickOn(preview)
          // The earlier version of the board, drawn read-only (wait for it, not its spinner).
          await A.page
            .getByTestId('checkpoint-preview-canvas')
            .waitFor({ timeout: 15_000 })
            .catch(() => {})
          await A.page
            .getByText('Opening the checkpoint')
            .waitFor({ state: 'detached', timeout: 15_000 })
            .catch(() => {})
          await alex.pause(400)
          await alex.move({ x: 480, y: 560 }, 700)
          await alex.pause(1800)
        }
        await clock.at(clock.elapsed + 800)
      },
      {
        prepare: async () => {
          await A.page.keyboard.press('Escape')
          await S.page.keyboard.press('Escape')
          await A.page
            .getByTestId('present-overlay')
            .waitFor({ state: 'detached', timeout: 5000 })
            .catch(() => {})
          const frame = await frameByName(A.page, '2 · Brainstorm')
          await Promise.all([view(A.page, frame.box, { inset: 40 }), view(S.page, frame.box, { inset: 40 })])
          await Promise.all([tidy(A.page), tidy(S.page)])
          await Promise.all([alex.move({ x: 620, y: 640 }, 200), sam.move({ x: 700, y: 700 }, 200)])
        },
      },
    )
    if (done('10-history')) return await finish()

    director.card('11-outro')
    return await finish()
  } catch (e) {
    log(`recording stopped: ${errText(e)}`)
    await snap('fatal')
    throw e
  } finally {
    await snap('last')
    for (const r of recorded) await close(r)
    await browser.close().catch(() => {})
  }

  async function finish(): Promise<Timeline> {
    await snap('end')
    for (const r of recorded) await close(r)
    const tracks: Track[] = recorded.map((r) => ({
      id: r.id,
      file: r.rec.file,
      createdAt: r.rec.createdAt,
      width: r.rec.width,
      height: r.rec.height,
    }))
    return { tracks, scenes: director.scenes as SceneWindow[], colors }
  }
}

/** The person's colour, as their avatar in the account button shows it. */
async function avatarColor(page: Page): Promise<string | undefined> {
  return page
    .locator('[data-testid="dev-identity-badge"] .dr-avatar, [data-testid="user-menu"] .dr-avatar')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor)
    .catch(() => undefined)
}

// ---- off-camera steps (all through the UI) ----------------------------------------------------------

async function signIn(page: Page, who: { handle: string; name: string }) {
  await page.goto('/signin')
  await page.getByTestId('signin-form').waitFor({ timeout: 30_000 })
  await page.getByTestId('signin-handle').fill(who.handle)
  await page.getByTestId('signin-name').fill(who.name)
  await page.getByTestId('signin-submit').click()
  await page.getByTestId('signin-form').waitFor({ state: 'detached', timeout: 30_000 })
  await page.getByTestId('dashboard').waitFor({ timeout: 30_000 })
}

/** The shared studio workspace, through the workspace switcher. */
async function openStudio(page: Page) {
  if (!/\/w\//.test(page.url())) await page.goto('/')
  await page.getByTestId('dashboard').waitFor({ timeout: 30_000 })
  const switcher = page.getByRole('button', { name: /^Switch workspace/ })
  if (/Dev Studio/.test((await switcher.getAttribute('aria-label')) ?? '')) {
    await page.reload()
  } else {
    await switcher.click()
    await page.getByRole('menuitem', { name: /Dev Studio/ }).click()
  }
  await page.getByTestId('dashboard').waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => /Dev Studio/.test(document.body.innerText))
}

/**
 * The lobby's existing boards, made in a separate (unfilmed) window: New board → template → title →
 * open it long enough for its thumbnail → Share → "Workspace can edit" so Sam's dashboard lists it too.
 */
async function makeLobbyBoards(browser: Browser, webUrl: string, log: (m: string) => void) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: webUrl })
  try {
    const page = await context.newPage()
    await signIn(page, PEOPLE.alex)
    await openStudio(page)
    for (const b of LOBBY_BOARDS) {
      await page.getByRole('button', { name: 'New board' }).first().click()
      const dialog = page.getByTestId('create-board-dialog')
      await dialog.waitFor()
      await dialog.getByTestId('template-card').filter({ hasText: b.template }).first().click()
      await dialog.getByTestId('create-board-title').fill(b.title)
      await dialog.getByTestId('create-board-submit').click()
      await boardReady(page)
      await waitFor(async () => (await shapes(page)).length >= 3, `the ${b.template} template on the board`)
      // A board of several frames gets the whole board as its start view, which its thumbnail then shows
      // (otherwise the card shows a 16:10 crop of the first frame, which for these templates is a strip).
      if ((await shapes(page)).filter((s) => s.type === 'frame').length > 1) {
        await sleep(500)
        await page.evaluate(() => {
          ;(window.editor as unknown as { zoomToFit(): void }).zoomToFit()
        })
        await setStartView(page)
      }
      await page.getByTestId('share-button').click()
      const share = page.getByTestId('share-dialog')
      await share
        .getByRole('combobox', { name: 'Workspace access' })
        .selectOption({ label: 'Workspace can edit' })
      await sleep(800)
      await page.keyboard.press('Escape')
      await share.waitFor({ state: 'detached' })
      // The thumbnail is drawn once the board has been quiet for 3 s, and sent when it closes.
      await sleep(4500)
      await page.goto('/')
      await openStudio(page)
      log(`lobby board ready: ${b.title}`)
    }
  } finally {
    await context.close()
  }
}

async function thumbnailsShown(page: Page) {
  await page
    .waitForFunction(
      () => {
        const cards = [...document.querySelectorAll('[data-testid="board-card"]')]
        return cards.length > 0 && cards.every((c) => c.querySelector('img')?.complete)
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {})
}

async function shareWithTeammate(page: Page, handle: string) {
  await page.getByTestId('share-button').click()
  const dialog = page.getByTestId('share-dialog')
  await dialog.getByRole('combobox', { name: 'Invite by @handle, name or email' }).fill(handle)
  await dialog.getByText(/they get access right away/).waitFor()
  await dialog.getByTestId('share-invite-submit').click()
  await dialog.getByTestId('member-row').filter({ hasText: 'Sam Lee' }).waitFor({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
}

async function createGuestReviewLink(page: Page): Promise<string> {
  await page.getByTestId('share-button').click()
  const dialog = page.getByTestId('share-dialog')
  await dialog.getByTestId('review-link-guests').check()
  await dialog.getByTestId('review-link-create').click()
  const row = dialog.getByTestId('review-link-row').first()
  await row.waitFor()
  const url = await row.getByTestId('review-link-url').inputValue()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  return url
}

/** Main menu → Board → "Set current view as start view". */
async function setStartView(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Board', exact: true }).click()
  const item = page.getByRole('menuitem', { name: /Set current view as start view/ })
  await item.waitFor({ timeout: 5000 })
  await item.click()
  await sleep(600)
  await page.keyboard.press('Escape')
}

// ---- in-scene helpers --------------------------------------------------------------------------------

async function waitFor<T>(
  read: () => Promise<T | null | undefined>,
  what: string,
  timeout = 20_000,
): Promise<T> {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const v = await read()
    if (v) return v
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function waitText(loc: Locator, re: RegExp, timeout = 15_000) {
  await waitFor(async () => re.test((await loc.textContent().catch(() => '')) ?? ''), `text ${re}`, timeout)
}

async function waitForFrames(page: Page, n: number) {
  await waitFor(
    async () => (await shapes(page)).filter((s) => s.type === 'frame').length >= n,
    `${n} frames`,
    30_000,
  )
}

/** Notes revealed from the private brainstorm (in the "Private ideas" frame). */
async function privateNotes(page: Page): Promise<ShapeInfo[]> {
  const all = await shapes(page)
  const frame = all.find((s) => s.type === 'frame' && /Private ideas/.test(s.name))
  if (!frame) return []
  return all.filter((s) => s.type === 'note' && s.parentId === frame.id)
}

/** Off camera: dismisses leftover notices (toasts, the vote's "Results are in" card) with their ×. */
async function tidy(page: Page) {
  await page.evaluate(() => {
    const close = document.querySelectorAll<HTMLButtonElement>(
      [
        'button[aria-label="Dismiss the results"]',
        '.tlui-toast__close',
        '.tlui-toast__container button[aria-label^="Close"]',
        '.tlui-toast__container button[aria-label^="Dismiss"]',
      ].join(', '),
    )
    for (const b of close) b.click()
    // A dialog that just closed hands focus back to its button, which then shows a focus ring.
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
  })
  await sleep(300)
}

/** Closes the open side panel with its rail button (toasts can sit over the panel's own ×). */
async function closeDock(page: Page, who: Actor) {
  const active = page.locator('[data-testid^="dock-tab-"][aria-pressed="true"]').first()
  if (!(await active.isVisible().catch(() => false))) return
  await who.clickOn(active, { ms: 600 })
  await page
    .locator('[data-testid^="dock-panel-"]')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
}

/** Selects the Brainstorm frame's notes and looks for the AI "Group into themes" action. */
async function findAiGroupAction(page: Page, who: Actor): Promise<Locator | null> {
  const frame = await frameByName(page, '2 · Brainstorm')
  const notes = (await shapes(page)).filter((s) => s.parentId === frame.id && s.type === 'note')
  if (notes.length === 0) return null
  const area = union(notes.map((n) => n.box))
  const from = await toScreen(page, { x: area.x - 40, y: area.y - 40 })
  const to = await toScreen(page, { x: area.x + area.w + 40, y: area.y + area.h + 40 })
  await who.drag(from, to, 900)
  const named = /group into themes/i
  const direct = page.getByRole('button', { name: named }).or(page.getByRole('menuitem', { name: named }))
  if (
    await direct
      .first()
      .isVisible()
      .catch(() => false)
  )
    return direct.first()
  const ai = page.getByRole('button', { name: /^(AI|Ask AI|AI actions)\b/i }).first()
  if (await ai.isVisible().catch(() => false)) {
    await who.clickOn(ai)
    if (
      await direct
        .first()
        .isVisible({ timeout: 2000 })
        .catch(() => false)
    )
      return direct.first()
    await page.keyboard.press('Escape')
  }
  // The canvas context menu.
  await page.mouse.click(to.x - 60, to.y - 60, { button: 'right' })
  const item = page.getByRole('menuitem', { name: named }).first()
  if (await item.isVisible({ timeout: 2000 }).catch(() => false)) return item
  await page.keyboard.press('Escape')
  return null
}

/** The first-use notice ("Sends the selected text to OpenAI"): go ahead. */
async function acceptAiNotice(page: Page, who: Actor) {
  const notice = page.getByText(/Sends the selected text to OpenAI/i).first()
  if (!(await notice.isVisible({ timeout: 2500 }).catch(() => false))) return
  const go = page.getByRole('button', { name: /^(Continue|OK|Send|Allow|Group|Go ahead|Got it)/i }).last()
  if (await go.isVisible().catch(() => false)) await who.clickOn(go)
}

async function waitForAiResult(page: Page) {
  // Done when no progress indicator mentions AI any more (or after a minute at most).
  const busy = page.getByText(/(Grouping|Thinking|Asking AI|Working)…?/i).first()
  await busy.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  await busy.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {})
}

/** "Present to everyone", when this build has it. Returns false when it does not. */
async function presentToEveryone(page: Page, who: Actor): Promise<boolean> {
  const direct = page.getByRole('button', { name: /present to everyone/i }).first()
  if (await direct.isVisible().catch(() => false)) {
    await who.clickOn(direct)
    return true
  }
  return false
}

/** The guest (a commenter) comments on the top-voted note from the phone. */
async function guestComment(page: Page, who: Actor, text: string): Promise<boolean> {
  const tool = page.getByRole('button', { name: 'Comment tool', exact: true }).first()
  if (!(await tool.isVisible().catch(() => false))) throw new Error('no comment tool on the phone')
  await who.clickOn(tool)
  await who.pause(500)
  const notes = await privateNotes(page)
  const target = notes.find((n) => n.text.startsWith('The villain wins')) ?? notes[0]
  if (!target) return false
  const vp = await viewport(page)
  // Near the note's top right corner, so the pin does not cover its words.
  let p = await toScreen(page, {
    x: target.box.x + target.box.w * 0.8,
    y: target.box.y + target.box.h * 0.16,
  })
  if (p.x < vp.x || p.y < vp.y || p.x > vp.x + vp.w || p.y > vp.y + vp.h) p = center(vp)
  await who.click(p)
  const composer = page.getByTestId('new-comment-popover').getByTestId('comment-composer')
  await composer.waitFor({ timeout: 10_000 })
  // Keys typed before the composer has focus would go to the board.
  await who.clickOn(composer)
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'comment-composer',
    undefined,
    { timeout: 5000 },
  )
  await who.type(text, 9)
  await who.pause(300)
  await page.keyboard.press('Enter')
  await page.getByTestId('thread-popover').waitFor({ timeout: 10_000 })
  await who.pause(900)
  return true
}

export type { Box }
