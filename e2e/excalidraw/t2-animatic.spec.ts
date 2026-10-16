// Wave T, WS3 (T2): the animatic player in the browser, measured on the swap timestamps the stage records
// (data-swaps: the panel, performance.now() when it was drawn, the playhead, the sound's time):
//  - a 6-panel storyboard plays its panels in storyboard order, each swap within 50 ms of its time (the playhead and
//    the wall clock), and ends on the last panel; the keys work and are modal (Esc closes; the board's chrome back);
//  - with a sound track (a WAV attachment the api byte-checked: served inline as audio/wav), the swaps follow the
//    sound's own time within 50 ms;
//  - Present storyboard shows the panels as slides in storyboard order (not the frames' reading order);
//  - nothing leaves Lobby's origins.
// Needs a sync that takes planning keys (t2-kit.ts PLANNING_SYNC_ENV and WS1's rules).
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { expectSlideOnScreen } from './present-kit.ts'
import {
  foreignRequests,
  makeWav,
  openAnimatic,
  PLANNING_SYNC_ENV,
  placeFileCard,
  planningSwitches,
  player,
  playThrough,
  seedStoryboard,
  setHead,
  sixPanels,
  stage,
  startsOf,
  upload,
} from './t2-kit.ts'

test.use({ syncEnv: PLANNING_SYNC_ENV })

/** The 50 ms target (docs: the design §3.1), on desktop Chromium. */
const TOLERANCE_MS = 50
const DURATIONS = [700, 1300, 500, 900, 1100, 600]
const TOTAL = DURATIONS.reduce((a, b) => a + b, 0)
const STARTS = startsOf(DURATIONS)

test.describe('T2 animatic', () => {
  test('a 6-panel animatic: in storyboard order, every swap within 50 ms of its time; modal keys; Esc closes', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const foreign = foreignRequests(a.context)
    await planningSwitches(a.page)
    await seedStoryboard(a.page, {
      head: 't2-h',
      title: 'Spot 30',
      settings: { aspect: '16:9', fps: 25 },
      // laid out right to left: the order is sb:pos, not where the frames are
      panels: sixPanels('t2-h', DURATIONS, { reversed: true }),
    })
    await openAnimatic(a.page, 't2-h-p3')
    await expect(player(a.page)).toHaveAttribute('aria-label', 'Animatic: Spot 30')
    await expect(a.page.getByTestId('animatic-time')).toHaveText(`0:00.0 / 0:0${TOTAL / 1000}`)

    const swaps = await playThrough(a.page, TOTAL)
    expect(swaps.map((s) => s.i)).toEqual([0, 1, 2, 3, 4, 5])
    const first = swaps[0]
    if (!first) throw new Error('no swap')
    for (const s of swaps.slice(1)) {
      const late = s.pos - (STARTS[s.i] as number)
      expect(late, `panel ${s.i + 1}: the playhead at the swap`).toBeGreaterThanOrEqual(0)
      expect(late, `panel ${s.i + 1}: the playhead at the swap`).toBeLessThan(TOLERANCE_MS)
      const wall = s.at - first.at - ((STARTS[s.i] as number) - first.pos)
      expect(Math.abs(wall), `panel ${s.i + 1}: the wall clock at the swap`).toBeLessThan(TOLERANCE_MS)
    }
    await expect(stage(a.page)).toHaveAttribute('data-panel-index', '5')
    await expect(a.page.getByTestId('animatic-chip')).toContainText('SH 06 · 0.6 s')

    // keys: modal (the board never sees them), the panels by the arrows, Home/End, the fields subtitle
    await a.page.keyboard.press('Home')
    await expect(stage(a.page)).toHaveAttribute('data-panel-index', '0')
    await a.page.keyboard.press('ArrowRight')
    await a.page.keyboard.press('ArrowRight')
    await expect(stage(a.page)).toHaveAttribute('data-panel-index', '2')
    await a.page.keyboard.press('ArrowLeft')
    await expect(stage(a.page)).toHaveAttribute('data-panel-index', '1')
    await a.page.keyboard.press('f')
    await expect(a.page.getByTestId('animatic-fields')).toContainText('Dialogue 2 hello')
    await expect(a.page.getByTestId('animatic-fields')).toContainText('Camera 2 wide')
    await a.page.keyboard.press('End')
    await expect(stage(a.page)).toHaveAttribute('data-panel-index', '5')
    // the tool keys do nothing while it is open
    await a.page.keyboard.press('r')
    expect(
      await a.page.evaluate(() =>
        (window as unknown as { lobbyCanvas: { tool(): string | null } }).lobbyCanvas.tool(),
      ),
    ).not.toBe('rectangle')
    // loop: plays past the end back to the first panel
    await a.page.getByTestId('animatic-loop').click()
    await expect(a.page.getByTestId('animatic-loop')).toHaveAttribute('aria-pressed', 'true')
    await a.page.keyboard.press('Escape')
    await expect(player(a.page)).toHaveCount(0)
    // the board's chrome is back (focus mode off)
    await expect(a.page.getByTestId('present-button')).toBeVisible()
    expect(foreign).toEqual([])
  })

  test('with a sound track: a WAV attachment (served inline as audio/wav) is the clock; swaps within 50 ms of its time', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    const foreign = foreignRequests(a.context)
    await planningSwitches(a.page)
    const wav = await upload(users, board, 'scratch vo.wav', 'audio/wav', makeWav(TOTAL + 2000))
    expect(wav).toMatchObject({ kind: 'other', mimeType: 'audio/wav' })
    // served inline with its audio type, nosniff (the api's byte check agreed)
    const res = await (await users.api('alice')).request.get(
      `${WEB_URL}/files/${wav.assetId}/${wav.versionId}/original?board=${board}`,
    )
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toBe('audio/wav')
    expect(res.headers()['content-disposition']).toMatch(/^inline/)
    expect(res.headers()['x-content-type-options']).toBe('nosniff')

    await seedStoryboard(a.page, {
      head: 't2-s',
      title: 'With sound',
      settings: { aspect: '16:9' },
      panels: sixPanels('t2-s', DURATIONS),
    })
    await placeFileCard(a.page, 't2-wav', wav, { x: 0, y: 600 })
    await setHead(a.page, 't2-s', { aspect: '16:9', audio: 't2-wav' })
    await openAnimatic(a.page, 't2-s-p1')
    await expect(a.page.getByTestId('animatic-status')).toContainText('Sound: scratch vo.wav')
    await a.page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="animatic-audio"]') as HTMLMediaElement | null
      return !!el && el.readyState >= 3
    })

    const swaps = await playThrough(a.page, TOTAL)
    expect(swaps.map((s) => s.i)).toEqual([0, 1, 2, 3, 4, 5])
    for (const s of swaps.slice(1)) {
      expect(s.a, `panel ${s.i + 1}: the sound's time was read`).toBeDefined()
      const late = (s.a as number) - (STARTS[s.i] as number)
      expect(late, `panel ${s.i + 1}: the sound's time at the swap`).toBeGreaterThan(-TOLERANCE_MS)
      expect(late, `panel ${s.i + 1}: the sound's time at the swap`).toBeLessThan(TOLERANCE_MS)
    }
    // the sound stopped with the pictures
    expect(
      await a.page.evaluate(
        () => (document.querySelector('[data-testid="animatic-audio"]') as HTMLMediaElement | null)?.paused,
      ),
    ).toBe(true)
    expect(foreign).toEqual([])
  })

  test('Present storyboard: the panels as slides in storyboard order', async ({ canvasSession }) => {
    const a = await canvasSession('alice')
    await planningSwitches(a.page)
    await seedStoryboard(a.page, {
      head: 't2-p',
      title: 'Deck',
      settings: { aspect: '16:9' },
      panels: sixPanels('t2-p', [1000, 1000, 1000], { reversed: true }),
    })
    await a.page.evaluate(() =>
      (window as unknown as { lobbyCanvas: { select(ids: string[]): void } }).lobbyCanvas.select(['t2-p-p2']),
    )
    await waitForCanvas(a.page)
    await a.page.keyboard.press('ControlOrMeta+k')
    await a.page.getByTestId('command-palette-input').fill('Present storyboard')
    await a.page
      .locator('[data-testid="command-palette-option"]', { hasText: 'Present storyboard' })
      .first()
      .click()
    // it opens on the selected panel, and → goes on in storyboard order (p3 is left of p2 on the board)
    await expectSlideOnScreen(a.page, 't2-p-p2')
    await a.page.keyboard.press('ArrowRight')
    await expectSlideOnScreen(a.page, 't2-p-p3')
    await a.page.keyboard.press('Home')
    await expectSlideOnScreen(a.page, 't2-p-p1')
    await a.page.keyboard.press('Escape')
  })
})
