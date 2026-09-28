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
    // Alex's "Create and copy link" copies to the clipboard, as it would in his browser.
    const A = await open('alex', DESK, DSF, { permissions: ['clipboard-read', 'clipboard-write'] })
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
            await alex.pause(450)
            await alex.hover(cards.nth(0), { v: 0.4 })
            await alex.pause(500)
            await alex.hover(cards.nth(1), { v: 0.45 })
            await alex.pause(450)
            await alex.clickOn(A.page.getByRole('button', { name: 'New board' }).first())
            const dialog = A.page.getByTestId('create-board-dialog')
            await dialog.waitFor()
            await alex.pause(450)
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
        await clock.at(clock.elapsed + 800)
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
            await alex.pause(700)
            await alex.move(await toScreen(A.page, { x: slot.x - 40, y: slot.y + 140 }), 1000)
          })(),
          (async () => {
            await sam.pause(900)
            await sam.clickOn(noteTool)
            await sam.pause(300)
            await sam.click(await toScreen(S.page, slot), { ms: 900 })
            await waitFor(() => editingId(S.page), 'Sam editing the new note')
            await sam.pause(250)
            await sam.type("Show the villain's first win", 14)
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
        await clock.at(clock.elapsed + 1000)
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
            // Wide enough that the empty slot beside the Story ideas stays left of the style panel, which
            // opens on the right while the Note tool is active (a click there would land on the panel).
            const w = area.w + 320
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
        await alex.pause(250)
        await alex.type('Trailer launch', 14)
        // Scroll so the map has room to grow to the right (both people look at the same spot).
        const root = await shapeByText(A.page, 'Trailer launch')
        const focus = { x: center(root.box).x + 290, y: center(root.box).y + 40 }
        await Promise.all([centerView(A.page, focus, 1, 700), centerView(S.page, focus, 1, 700)])
        const steps: Array<[string, string]> = [
          ['Tab', 'Teaser drop'],
          ['Enter', 'Launch day'],
          ['Enter', 'Creator premiere'],
        ]
        const samWatch = (async () => {
          const vp = await viewport(S.page)
          await sam.pause(900)
          await sam.move({ x: vp.x + vp.w * 0.62, y: vp.y + vp.h * 0.8 }, 1400)
          await sam.pause(1200)
          await sam.move({ x: vp.x + vp.w * 0.8, y: vp.y + vp.h * 0.74 }, 1100)
        })()
        for (const [key, text] of steps) {
          await alex.pause(200)
          await alex.press(key, 300)
          await alex.type(text, 15)
        }
        await alex.pause(300)
        await alex.press('Escape', 200)
        await alex.press('Escape', 200)
        await alex.move({ x: 700, y: 880 }, 600)
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
        await clock.at(clock.elapsed + 900)
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

    // ---- 05 AI: Alex selects the brainstorm's idea notes, AI → "Group into themes"; both see the result ----
    await director.scene(
      '05-ai',
      async (clock) => {
        const notes = await brainstormNotes(A.page)
        const area = union(notes.map((n) => n.box))
        // A brush from the empty frame just below the last row up over the first note: every idea note,
        // not the Gameplay / Story / Community cards to their left.
        const from = await toScreen(A.page, { x: area.x + area.w + 26, y: area.y + area.h + 26 })
        const to = await toScreen(A.page, { x: area.x - 14, y: area.y - 14 })
        await alex.pause(400)
        await alex.move(from, 700)
        await alex.drag(from, to, 1100)
        // The brush also takes Alex's connector from 03 (it lies between the notes): a shift-click on
        // its line takes it out again, so only the notes are sent ("only the notes you select").
        const noteIds = new Set(notes.map((n) => n.id))
        for (const arrow of (await shapes(A.page)).filter((s) => s.type === 'arrow' && inside(s.box, area))) {
          const on = await pointOnShape(A.page, arrow.id)
          if (!on) continue
          await alex.pause(250)
          await A.page.keyboard.down('Shift')
          await alex.click(await toScreen(A.page, on), { ms: 600 })
          await A.page.keyboard.up('Shift')
        }
        const picked = await A.page.evaluate(() =>
          (window.editor as unknown as { getSelectedShapeIds(): string[] }).getSelectedShapeIds(),
        )
        const extra = picked.filter((id) => !noteIds.has(id))
        if (extra.length) log(`[05-ai] the selection still holds ${extra.length} shape(s) that are not notes`)
        const button = A.page.getByTestId('selection-ai')
        await button.waitFor({ timeout: 8000 })
        await alex.pause(450)
        await alex.clickOn(button)
        const menu = A.page.getByTestId('ai-menu')
        await menu.waitFor({ timeout: 8000 })
        await alex.hover(menu.getByTestId('ai-themes'), { ms: 700 })
        await alex.pause(500)
        await alex.clickOn(menu.getByTestId('ai-themes'))
        const regroup = menu.getByTestId('ai-regroup-go')
        const notice = menu.getByTestId('ai-notice-continue')
        const started = A.page
          .getByTestId('ai-busy')
          .or(A.page.getByTestId('ai-done'))
          .or(A.page.getByTestId('ai-error'))
        await regroup.or(notice).or(started).first().waitFor({ timeout: 8000 })
        // The tour's notes already sit under its theme cards: Lobby asks before regrouping them.
        if (await regroup.isVisible().catch(() => false)) {
          await alex.pause(600)
          await alex.clickOn(regroup)
          await notice.or(started).first().waitFor({ timeout: 8000 })
        }
        // First use in this workspace: "Sends the selected text to OpenAI" (what the narration says).
        if (await notice.isVisible().catch(() => false)) {
          await alex.pause(1300)
          await alex.clickOn(notice)
        }
        const done = A.page.getByTestId('ai-done')
        const failed = A.page.getByTestId('ai-error')
        // The busy pill shows for a moment; a real model's longer wait is cut.
        await done
          .or(failed)
          .first()
          .waitFor({ timeout: 1200 })
          .catch(() => {})
        if (
          !(await done
            .or(failed)
            .first()
            .isVisible()
            .catch(() => false))
        ) {
          await clock.cut(() => done.or(failed).first().waitFor({ timeout: 90_000 }))
        }
        if (await failed.isVisible().catch(() => false)) {
          throw new Error(`AI said: ${(await failed.textContent()) ?? 'an error'}`)
        }
        await alex.move({ x: 640, y: 780 }, 600)
        await alex.pause(700)
        // Closer on the tidy clusters, on both screens, so the theme names read.
        const grouped = await aiClusters(A.page)
        // The "Grouped … Undo" notice has been read by now: it would sit over the first theme name.
        await tidy(A.page)
        if (grouped) {
          await Promise.all([
            view(A.page, grouped, { inset: 120, ms: 800 }),
            view(S.page, grouped, { inset: 120, ms: 800 }),
          ])
        }
        await sam.move({ x: 470, y: 700 }, 900)
        await clock.at(clock.elapsed + 1300)
      },
      {
        prepare: async () => {
          await Promise.all([A.page.keyboard.press('Escape'), S.page.keyboard.press('Escape')])
          await A.page.evaluate(() => {
            ;(window.editor as unknown as { selectNone(): void }).selectNone()
          })
          if (!(await aiAvailable(A.page))) {
            throw new SkipScene('AI is not set up on this api (no OpenAI key and no fake server)')
          }
          // The Brainstorm frame's content (themes, notes and the room to their right) on both screens.
          const frame = await frameByName(A.page, '2 · Brainstorm')
          const kids = (await shapes(A.page)).filter((s) => s.parentId === frame.id)
          const box = union(kids.map((s) => s.box))
          await Promise.all([view(A.page, box, { inset: 24 }), view(S.page, box, { inset: 24 })])
          await Promise.all([tidy(A.page), tidy(S.page)])
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
        await alex.type('What should the teaser show?', 30)
        await alex.pause(200)
        const target = dialog.getByTestId('pn-target-new')
        if (!(await target.isChecked())) await alex.clickOn(target)
        await alex.clickOn(dialog.getByTestId('pn-setup-submit'))
        await A.page.getByTestId('pn-panel').waitFor()
        const write = async (who: Actor, page: Page, notes: string[]) => {
          const panel = page.getByTestId('pn-panel')
          if (!(await panel.isVisible())) {
            // Everyone else gets the prompt card ("Add your notes"); the top-bar chip works too.
            const card = page.getByTestId('pn-start-prompt-write')
            await who.clickOn(
              (await card.isVisible().catch(() => false)) ? card : page.getByTestId('pn-chip'),
            )
          }
          await panel.waitFor()
          await who.clickOn(panel.getByTestId('pn-compose-text'), { u: 0.3 })
          for (const text of notes) {
            await who.type(text, 32)
            await who.pause(100)
            await who.clickOn(panel.getByTestId('pn-add'), { ms: 350 })
            await who.pause(120)
            await who.clickOn(panel.getByTestId('pn-compose-text'), { u: 0.3, ms: 350 })
          }
        }
        await Promise.all([
          write(alex, A.page, ['The villain wins round one', 'Save the co-op move for the end']),
          (async () => {
            await S.page
              .getByTestId('pn-start-prompt-write')
              .or(S.page.getByTestId('pn-chip'))
              .first()
              .waitFor({ timeout: 15_000 })
            await sam.pause(300)
            await write(sam, S.page, ['A countdown in a player’s voice'])
          })(),
        ])
        await waitText(A.page.getByTestId('pn-counts'), /3 notes from 2 people/)
        await alex.hover(A.page.getByTestId('pn-counts'), { ms: 450 })
        await alex.pause(350)
        await alex.clickOn(A.page.getByTestId('pn-reveal'), { ms: 500 })
        await waitFor(async () => (await privateNotes(S.page)).length >= 3 || null, 'the revealed notes')
        await alex.pause(300)
        // Both close their panels, then "Show me" on the reveal notice brings each view to the notes.
        await Promise.all([closeDock(A.page, alex), closeDock(S.page, sam)])
        const showMe = async (who: Actor, page: Page) => {
          const button = page.getByTestId('pn-toast-show')
          if (await button.isVisible().catch(() => false)) {
            await who.clickOn(button, { ms: 500 })
            await sleep(600)
          } else {
            const notes = union((await privateNotes(page)).map((n) => n.box))
            await view(page, notes, { inset: 110, ms: 700 })
          }
        }
        await Promise.all([
          showMe(alex, A.page),
          (async () => {
            await sam.pause(200)
            await showMe(sam, S.page)
          })(),
        ])
        await clock.at(clock.elapsed + 1000)
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
          await Promise.all([tidy(A.page), tidy(S.page)])
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
        // Only the "Private ideas" frame's notes can be voted on (the frame holds nothing else).
        const scope = dialog.getByTestId('vote-scope')
        await alex.hover(scope, { ms: 400 })
        const option = await scope
          .locator('option', { hasText: 'Private ideas' })
          .first()
          .getAttribute('value')
        if (option) await scope.selectOption(option)
        await alex.pause(350)
        await alex.clickOn(dialog.getByTestId('vote-setup-submit'), { ms: 500 })
        // Starting the vote brings the facilitator's view to its frame; then Alex zooms in on the notes.
        await A.page.getByTestId('vote-bar').waitFor({ timeout: 15_000 })
        await sleep(450)
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
            await who.pause(400)
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
        await alex.pause(250)
        const panel = A.page.getByTestId('dock-panel-voting')
        await alex.clickOn(panel.getByTestId('vote-reveal'), { ms: 600 })
        await S.page
          .getByTestId('vote-results-card')
          .waitFor({ timeout: 8000 })
          .catch(() => {})
        await alex.hover(panel.getByTestId('vote-results'), { v: 0.3, ms: 600 }).catch(() => {})
        await clock.at(clock.elapsed + 1500)
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
        // Alex: Share → "Share with a client", where one button makes the guest link and copies it.
        await alex.clickOn(A.page.getByTestId('share-button'))
        const dialog = A.page.getByTestId('share-dialog')
        const client = dialog.getByTestId('share-client')
        await client.waitFor({ timeout: 10_000 })
        await alex.pause(500)
        await alex.clickOn(client.getByTestId('review-link-create'), { ms: 600 })
        const row = client.getByTestId('review-link-row').first()
        await row.waitFor({ timeout: 10_000 })
        link = await row.getByTestId('review-link-url').inputValue()
        await alex.hover(row.getByTestId('review-link-copy'), { ms: 450 }).catch(() => {})
        await alex.pause(600)
        await A.page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
        await tidy(A.page)
        // The client opens the link on their phone (the page load is cut).
        const P = await clock.cut(async () => {
          const rec = await open('phone', PHONE, PHONE_DSF, {
            isMobile: true,
            hasTouch: true,
            userAgent:
              'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
          })
          phoneRef.rec = rec
          await rec.page.goto(link)
          await rec.page.getByTestId('invite-guest-name').waitFor({ timeout: 30_000 })
          await sleep(400)
          return rec
        })
        const phone = new Actor('Jordan', P.page, { touch: true })
        win.phone = { start: Date.now(), end: 0 }
        const nameField = P.page.getByTestId('invite-guest-name')
        await phone.pause(700)
        await phone.clickOn(nameField)
        await phone.type(PEOPLE.guest, 10)
        await phone.pause(400)
        await phone.clickOn(P.page.getByTestId('invite-guest-join'))
        // The phone's "Connecting to board…" is cut: the next picture is the board, notes drawn.
        await clock.cut(async () => {
          await boardReady(P.page)
          await waitFor(
            async () => (await privateNotes(P.page)).length >= 3 || null,
            'the board on the phone',
            20_000,
          ).catch(() => {})
          await P.page
            .locator('.tl-shape[data-shape-type="note"]')
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() => {})
          await sleep(500)
        })
        const guestId = await P.page.getByTestId('user-menu').getAttribute('data-user-id')
        // Alex sees the guest arrive: their avatar joins the people on the board.
        const avatar = A.page.locator(`[data-testid="presence-user"][data-user-id="${guestId}"] button`)
        await avatar.waitFor({ timeout: 20_000 })
        await alex.hover(avatar, { ms: 500 })
        await phone.pause(300)
        // The guest (a commenter) leaves a comment on the winning note.
        const commented = await guestComment(P.page, phone, 'Love this one!').catch((e) => {
          log(`[08-guest] guest comment: ${errText(e)}`)
          return false
        })
        if (commented) {
          // Alex's bell lights up with the client's comment; the item opens the thread.
          const bell = A.page.getByTestId('notifications-bell')
          const lit = await waitFor(
            async () => ((await bell.getAttribute('data-unread').catch(() => '0')) ?? '0') !== '0',
            'the new comment in Alex’s bell',
            8000,
          ).catch(() => false)
          const item = A.page.getByTestId('notification-item').filter({ hasText: 'Love this one' }).first()
          let opened = false
          if (lit) {
            await alex.pause(250)
            await alex.clickOn(bell, { ms: 600 })
            if (await item.isVisible({ timeout: 4000 }).catch(() => false)) {
              await alex.pause(700)
              await alex.clickOn(item, { u: 0.4 })
              opened = await A.page
                .getByTestId('thread-popover')
                .waitFor({ timeout: 6000 })
                .then(() => true)
                .catch(() => false)
            }
          }
          if (!opened) {
            await A.page.keyboard.press('Escape')
            const pin = A.page.getByTestId('comment-pin').last()
            await pin.waitFor({ timeout: 15_000 })
            await alex.clickOn(pin)
            await A.page
              .getByTestId('thread-popover')
              .waitFor({ timeout: 10_000 })
              .catch(() => {})
          }
        }
        await alex.pause(1500)
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
          await Promise.all([tidy(A.page), tidy(S.page)])
          await Promise.all([alex.move({ x: 560, y: 760 }, 200), sam.move({ x: 640, y: 780 }, 200)])
        },
      },
    )
    if (phoneRef.rec) await close(phoneRef.rec)
    if (done('08-guest')) return await finish()

    // ---- 09 present to everyone: Sam is invited, joins, and follows Alex's slides ----
    await director.scene(
      '09-present',
      async (clock) => {
        // With the workshop items in it, the 800 px top bar folds Present into its "⋯" menu.
        const present = A.page.getByTestId('present-button')
        if (!(await present.isVisible().catch(() => false))) {
          await alex.clickOn(A.page.getByTestId('topbar-overflow'), { ms: 700 })
          await A.page.getByTestId('topbar-overflow-panel').waitFor({ timeout: 5000 })
          await alex.pause(350)
        }
        await alex.clickOn(present.first(), { ms: 500 })
        await A.page.getByTestId('present-overlay').waitFor({ timeout: 15_000 })
        await alex.pause(350)
        // The presentation bar (it shows while the pointer moves): "Invite everyone".
        const invite = A.page.getByTestId('present-invite')
        await alex.move({ x: 560, y: 760 }, 450)
        await invite.waitFor({ timeout: 8000 })
        await alex.clickOn(invite, { ms: 600 })
        // Sam is asked, not pulled in: the banner, then Join.
        const banner = S.page.getByTestId('live-invite')
        await banner.waitFor({ timeout: 15_000 })
        await sam.pause(600)
        await sam.clickOn(banner.getByTestId('live-join'), { ms: 700 })
        await S.page.getByTestId('present-overlay').waitFor({ timeout: 15_000 })
        await waitText(A.page.getByTestId('live-follower-count'), /1 following/, 10_000).catch(() => {})
        await alex.hover(A.page.getByTestId('live-follower-count'), { ms: 600 }).catch(() => {})
        await sam.move({ x: 700, y: 600 }, 700)
        await alex.pause(500)
        // Two slides on, in step on both screens.
        for (let i = 0; i < 2; i++) {
          await alex.move({ x: 520 + i * 60, y: 700 - i * 30 }, 350)
          await alex.press('ArrowRight', 1250)
        }
        // The end, for everyone.
        await alex.move({ x: 600, y: 760 }, 300)
        const end = A.page.getByTestId('present-exit')
        await end.waitFor({ timeout: 5000 })
        await alex.clickOn(end, { ms: 500 })
        await S.page
          .getByTestId('live-ended-toast')
          .waitFor({ timeout: 8000 })
          .catch(() => {})
        await clock.at(clock.elapsed + 1200)
      },
      {
        prepare: async () => {
          await A.page.keyboard.press('Escape')
          await closeDock(A.page, alex)
          await closeDock(S.page, sam)
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
          await who.pause(500)
          const isOpen = () => auto.evaluate((d) => (d as HTMLDetailsElement).open)
          for (let i = 0; i < 2 && !(await isOpen()); i++) {
            await who.clickOn(page.getByTestId('checkpoint-auto-toggle'), { u: 0.2 })
            await who.pause(350)
          }
          const row = page.getByTestId('checkpoint-auto-row').first()
          await row.waitFor({ timeout: 5000 }).catch(() => {})
          return row
        }
        await Promise.all([
          (async () => {
            // Export: one frame as an image, or the whole tour as a PDF (a page per frame).
            const exportButton = A.page.getByTestId('export-button')
            const overflow = A.page.getByTestId('topbar-overflow-panel')
            if (!(await exportButton.isVisible().catch(() => false))) {
              // Folded into the top bar's "⋯" menu, like Present.
              await alex.clickOn(A.page.getByTestId('topbar-overflow'), { ms: 600 })
              await overflow.waitFor({ timeout: 5000 })
              await alex.pause(250)
            }
            await alex.clickOn(exportButton.first(), { ms: 500 })
            const pdf = A.page.getByTestId('export-pdf')
            await pdf.waitFor()
            await alex.pause(300)
            await alex.clickOn(A.page.getByTestId('export-area-frame'), { ms: 600 })
            await alex.hover(A.page.getByTestId('export-png'), { ms: 500 })
            await alex.pause(250)
            // The PDF is made in the browser; the scene does not wait long for the file.
            const download = A.page.waitForEvent('download', { timeout: 2000 }).catch(() => null)
            await alex.clickOn(pdf, { ms: 600 })
            await download
            await alex.pause(300)
            await A.page.keyboard.press('Escape')
            await alex.pause(200)
            // The "⋯" menu Export came from is still open behind the dialog: it closes before History.
            if (await overflow.isVisible().catch(() => false)) {
              await alex.clickOn(A.page.getByTestId('topbar-overflow'), { ms: 500 })
              await overflow.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
            }
            if (await overflow.isVisible().catch(() => false)) {
              await A.page.keyboard.press('Escape')
              await overflow.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
            }
          })(),
          (async () => {
            await sam.pause(600)
            const row = await openHistory(sam, S.page)
            await sam.pause(400)
            if (await row.count()) await sam.hover(row, { ms: 600, u: 0.35 })
          })(),
        ])
        await openHistory(alex, A.page)
        // The checkpoint taken just before the AI regrouped the brainstorm: the board as it was.
        const rows = A.page.getByTestId('checkpoint-auto-row')
        const beforeAi = rows.filter({ hasText: /Before AI/ }).first()
        const row = (await beforeAi.count()) ? beforeAi : rows.first()
        await alex.pause(300)
        const preview = row.getByTestId('checkpoint-preview')
        if (await preview.count()) {
          await alex.clickOn(preview, { ms: 600 })
          // The earlier version of the board, drawn read-only (wait for it, not its spinner).
          await A.page
            .getByTestId('checkpoint-preview-canvas')
            .waitFor({ timeout: 15_000 })
            .catch(() => {})
          await A.page
            .getByText('Opening the checkpoint')
            .waitFor({ state: 'detached', timeout: 15_000 })
            .catch(() => {})
          await alex.pause(500)
          // Closer on the Brainstorm frame as it was, so it reads: drag it to the middle, then zoom.
          const zoomed = await zoomPreviewOn(alex, A.page, 'Brainstorm').catch((e) => {
            log(`[10-history] preview zoom: ${errText(e)}`)
            return false
          })
          if (!zoomed) await alex.move({ x: 480, y: 560 }, 700)
          await alex.pause(1600)
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

/**
 * Dismisses leftover notices with their ×: Lobby's own toasts (`.dr-notice`: "Grouped … Undo", "Start
 * view set", "… ended the presentation"), tldraw's, and the vote's "Results are in" card.
 */
async function tidy(page: Page) {
  await page.evaluate(() => {
    const close = document.querySelectorAll<HTMLButtonElement>(
      [
        '.dr-notices .dr-notice__close',
        'button[aria-label="Dismiss the results"]',
        '.tlui-toast__close',
        '.tlui-toast__container button[aria-label^="Close"]',
        '.tlui-toast__container button[aria-label^="Dismiss"]',
      ].join(', '),
    )
    for (const b of close) b.click()
    // The keycap of an off-camera Esc (it stays up for about a second) would open the next scene.
    for (const k of document.querySelectorAll('.__demo_key')) k.remove()
    // A dialog that just closed hands focus back to its button, which then shows a focus ring.
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
  })
  await sleep(300)
}

/** Closes the open side panel with its rail button (toasts can sit over the panel's own ×). */
async function closeDock(page: Page, who: Actor) {
  const active = page.locator('[data-testid^="dock-tab-"][aria-pressed="true"]').first()
  if (!(await active.isVisible().catch(() => false))) {
    // A panel whose rail button does not show as pressed: its own × closes it.
    const panelClose = page.locator('[data-testid^="dock-panel-"] button[aria-label^="Close"]').first()
    if (await panelClose.isVisible().catch(() => false)) await who.clickOn(panelClose, { ms: 500 })
    return
  }
  await who.clickOn(active, { ms: 600 })
  await page
    .locator('[data-testid^="dock-panel-"]')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
}

/** The idea notes of the tour's Brainstorm frame (the sticky notes; not the theme cards). */
async function brainstormNotes(page: Page): Promise<ShapeInfo[]> {
  const frame = await frameByName(page, '2 · Brainstorm')
  const notes = (await shapes(page)).filter((s) => s.parentId === frame.id && s.type === 'note')
  if (notes.length < 2) throw new Error('the Brainstorm frame has no idea notes')
  return notes
}

/**
 * In the checkpoint preview (a read-only canvas on the hand tool): drags the named frame to the middle
 * and zooms in on it with the wheel (Ctrl+wheel, as a trackpad pinch sends) until it fills the view.
 * False when the frame is not found.
 */
async function zoomPreviewOn(who: Actor, page: Page, frameName: string): Promise<boolean> {
  const canvas = page.getByTestId('checkpoint-preview-canvas')
  const frameBox = () =>
    page.evaluate((name) => {
      const root = document.querySelector('[data-testid="checkpoint-preview-canvas"]')
      for (const el of root?.querySelectorAll('.tl-shape[data-shape-type="frame"]') ?? []) {
        if (!(el.textContent ?? '').includes(name)) continue
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      }
      return null
    }, frameName)
  const c = await canvas.boundingBox()
  const f = await frameBox()
  if (!c || !f || f.w < 4) return false
  const mid = { x: c.x + c.width / 2, y: c.y + c.height / 2 }
  await who.drag({ x: f.x + f.w / 2, y: f.y + f.h / 2 }, mid, 700)
  await sleep(250)
  const g = (await frameBox()) ?? f
  await who.move({ x: g.x + g.w / 2, y: g.y + g.h / 2 }, 250)
  // Small Ctrl+wheel steps until the frame fills the preview (checked as it grows, not assumed).
  const fills = (b: { w: number; h: number }) => b.w >= c.width * 0.9 || b.h >= c.height * 0.86
  await page.keyboard.down('Control')
  try {
    for (let i = 0; i < 60; i++) {
      const now = await frameBox()
      if (!now || fills(now)) break
      await page.mouse.wheel(0, -10)
      await sleep(25)
    }
  } finally {
    await page.keyboard.up('Control')
  }
  return true
}

/** `b` lies inside `outer` (page bounds). */
const inside = (b: Box, outer: Box) =>
  b.x >= outer.x - 1 &&
  b.y >= outer.y - 1 &&
  b.x + b.w <= outer.x + outer.w + 1 &&
  b.y + b.h <= outer.y + outer.h + 1

/**
 * A page point where a click lands on this shape (a connector's line, not a note under it): points
 * along its bounds' diagonals, nearest the middle first, asked of the editor's own hit test.
 */
async function pointOnShape(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((shapeId) => {
    type P = { x: number; y: number }
    const ed = window.editor as unknown as {
      getShapePageBounds(id: string): { x: number; y: number; w: number; h: number } | undefined
      getShapeAtPoint(p: P, o: object): { id: string } | undefined
      getHitTestMargin(): number
    }
    const b = ed.getShapePageBounds(shapeId)
    if (!b) return null
    const ts = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8]
    for (const t of ts) {
      for (const p of [
        { x: b.x + b.w * t, y: b.y + b.h * t },
        { x: b.x + b.w * t, y: b.y + b.h * (1 - t) },
      ]) {
        const hit = ed.getShapeAtPoint(p, {
          margin: ed.getHitTestMargin(),
          hitInside: true,
          renderingOnly: true,
        })
        if (hit?.id === shapeId) return p
      }
    }
    return null
  }, id)
}

/** The AI's theme labels and the notes under them (page bounds), or null before a grouping. */
async function aiClusters(page: Page): Promise<Box | null> {
  const all = await shapes(page)
  const labels = all.filter((s) => (s.meta.drAi as { kind?: string } | undefined)?.kind === 'theme-label')
  if (!labels.length) return null
  const ids = new Set(labels.flatMap((l) => (l.meta.drAi as { notes?: string[] }).notes ?? []))
  return union([...labels, ...all.filter((s) => ids.has(s.id))].map((s) => s.box))
}

/** The api offers AI on this board (a key or the fake is configured, and AI is on). */
async function aiAvailable(page: Page): Promise<boolean> {
  const board = new URL(page.url()).pathname.split('/b/')[1]?.split('/')[0]
  if (!board) return false
  const res = await page.request.get(`/api/boards/${board}/ai`)
  if (!res.ok()) return false
  return ((await res.json()) as { enabled?: boolean }).enabled === true
}

/** The guest (a commenter) comments on the top-voted note from the phone. */
async function guestComment(page: Page, who: Actor, text: string): Promise<boolean> {
  const tool = page.getByRole('button', { name: 'Comment tool', exact: true }).first()
  if (!(await tool.isVisible().catch(() => false))) throw new Error('no comment tool on the phone')
  await who.clickOn(tool)
  await who.pause(350)
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
  await who.type(text, 15)
  await who.pause(250)
  await page.keyboard.press('Enter')
  await page.getByTestId('thread-popover').waitFor({ timeout: 10_000 })
  await who.pause(500)
  return true
}

export type { Box }
