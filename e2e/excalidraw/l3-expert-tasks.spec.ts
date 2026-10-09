// W3 (wave L, L3-2): ten scripted expert tasks, done twice on the same board: "before" through the UI that was
// there before the palette (the context menu, the board menu, the dock, the toolbar, the zoom menu), "after"
// through Ctrl/Cmd+K. Each run records the wall time (ms, the browser driven at machine speed, so it measures
// the steps and the waits, not a person's hand) and the inputs (clicks and key presses, each typed character
// one). The numbers are attached to the test (l3-expert-tasks.json) and printed; the test asserts only that
// every task gets done both ways, never a speed.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l3-expert-tasks.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  clickItem,
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  select,
  setTool,
  setViewport,
  test,
  tool,
} from '../tests/support/canvas.ts'
import { focusCanvas, inView } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

interface Run {
  readonly ms: number
  readonly inputs: number
}

/** Counts the inputs of one way of doing a task. */
class Hands {
  inputs = 0
  private readonly page: Page
  constructor(page: Page) {
    this.page = page
  }
  async click(testId: string) {
    this.inputs++
    await this.page.getByTestId(testId).click()
  }
  async rightClick(id: string) {
    this.inputs++
    await clickItem(this.page, id, { button: 'right' })
  }
  async clickLocator(selector: string) {
    this.inputs++
    await this.page.locator(selector).click()
  }
  async press(key: string) {
    this.inputs++
    await this.page.keyboard.press(key)
  }
  async type(text: string) {
    this.inputs += [...text].length
    await this.page.keyboard.type(text)
  }
  /** Ctrl/Cmd+K, the words, Enter (the board has the keyboard). */
  async palette(words: string) {
    await focusCanvas(this.page)
    await this.press('ControlOrMeta+k')
    await expect(this.page.getByTestId('command-palette-input')).toBeFocused()
    await this.type(words)
    await this.press('Enter')
    await expect(this.page.getByTestId('command-palette')).toHaveCount(0)
  }
}

interface Task {
  readonly name: string
  /** puts the board back the way the task starts */
  setup(page: Page): Promise<void>
  before(h: Hands, page: Page): Promise<void>
  after(h: Hands, page: Page): Promise<void>
  /** the task is done */
  done(page: Page): Promise<void>
}

async function timed(page: Page, task: Task, way: 'before' | 'after'): Promise<Run> {
  await task.setup(page)
  const h = new Hands(page)
  const t0 = Date.now()
  await (way === 'before' ? task.before(h, page) : task.after(h, page))
  await task.done(page)
  return { ms: Date.now() - t0, inputs: h.inputs }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}

test('ten expert tasks, before (menus, dock, toolbar) and after (Ctrl/Cmd+K): every one gets done both ways; the times and inputs are recorded', async ({
  canvasSession,
}, testInfo) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const page = a.page
  const notes: string[] = []
  for (const x of [0, 260, 900]) {
    notes.push(await createNote(page, { x, y: 0, text: `Note ${x}` }))
    await expectSaved(page)
  }
  const retro = await createItem(page, 'frame', { x: 6000, y: 4000, width: 800, height: 600, name: 'Retro' })
  await expectSaved(page)
  const [n1, n2, n3] = notes as [string, string, string]
  const home = () => setViewport(page, { x: -200, y: -200, zoom: 1 })
  const locked = async () => (await item(page, n1))?.locked === true
  const unlock = async () => {
    if (await locked()) {
      await select(page, [n1])
      await focusCanvas(page)
      await page.keyboard.press('ControlOrMeta+Shift+l')
      await expect.poll(locked).toBe(false)
    }
  }

  const tasks: Task[] = [
    {
      name: 'lock the selected note',
      setup: async () => {
        await unlock()
        await select(page, [n1])
      },
      before: async (h) => {
        await h.rightClick(n1)
        await h.click('context-menu.toggle-lock')
      },
      after: (h) => h.palette('lock'),
      done: async () => {
        await expect.poll(locked).toBe(true)
        await unlock()
      },
    },
    {
      name: 'go to the frame "Retro"',
      setup: async () => {
        await home()
        await expect.poll(() => inView(page, [retro])).toBe(false)
      },
      before: async (h) => {
        await h.click('dock-tab-frames')
        // the row's name button (W5's run-of-show stepper now sits in the row, under it)
        await h.clickLocator(`[data-testid="frame-row"][data-frame-id="${retro}"] .dr-cux-frame__name`)
      },
      after: (h) => h.palette('retro'),
      done: async () => {
        await expect.poll(() => inView(page, [retro])).toBe(true)
      },
    },
    {
      name: 'distribute three notes horizontally',
      setup: async () => {
        await home()
        await select(page, [n1, n2, n3])
      },
      before: async (h) => {
        await h.rightClick(n2)
        await h.click('context-menu-sub.arrange-button')
        await h.click('context-menu.distribute-horizontal')
      },
      after: (h) => h.palette('dh'),
      done: async () => {
        await expect(page.getByTestId('context-menu')).toHaveCount(0)
        await expect.poll(async () => Math.round((await item(page, n2))?.x ?? 0)).toBe(450)
        await page.keyboard.press('ControlOrMeta+z')
        await expect.poll(async () => Math.round((await item(page, n2))?.x ?? 0)).toBe(260)
      },
    },
    {
      name: 'bring a note to the front',
      setup: async () => {
        await select(page, [n1])
      },
      before: async (h) => {
        await h.rightClick(n1)
        await h.click('context-menu-sub.reorder-button')
        await h.click('context-menu.bring-to-front')
      },
      after: (h) => h.palette('front'),
      done: async () => {
        await expect(page.getByTestId('context-menu')).toHaveCount(0)
        await expectSaved(page)
      },
    },
    {
      name: 'zoom to fit',
      setup: async () => {
        await setViewport(page, { x: 20_000, y: 20_000, zoom: 2 })
      },
      before: async (h) => {
        await h.click('minimap.zoom-menu-button')
        await h.click('zoom-menu.zoom-to-fit')
      },
      after: (h) => h.palette('fit'),
      done: async () => {
        await expect.poll(() => inView(page, [n1, retro])).toBe(true)
      },
    },
    {
      name: 'pick the note tool',
      setup: async () => {
        await setTool(page, 'select')
      },
      before: (h) => h.click('tools.note'),
      after: (h) => h.palette('note tool'),
      done: async () => {
        await expect.poll(() => tool(page)).toBe('note')
        await setTool(page, 'select')
      },
    },
    {
      name: 'turn "Always snap" on or off',
      setup: async () => {},
      before: async (h) => {
        await h.click('main-menu.button')
        await h.click('main-menu-sub.preferences-button')
        await h.click('main-menu.toggle-snap-mode')
      },
      after: (h) => h.palette('always snap'),
      done: async () => {
        await expect(page.getByTestId('main-menu-root')).toHaveCount(0)
      },
    },
    {
      name: 'open the keyboard shortcuts',
      setup: async () => {},
      before: async (h) => {
        await h.click('main-menu.button')
        await h.click('main-menu.keyboard-shortcuts')
      },
      after: (h) => h.palette('shortcuts'),
      done: async () => {
        await expect(page.getByTestId('shortcuts-dialog')).toBeVisible()
        await page.getByTestId('shortcuts-dialog-close').click()
        await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0)
      },
    },
    {
      name: 'open board search',
      setup: async () => {},
      before: (h) => h.click('dock-tab-search'),
      after: (h) => h.palette('search board'),
      done: async () => {
        await expect(page.getByTestId('search-input')).toBeFocused()
        await page.keyboard.press('Escape')
      },
    },
    {
      name: 'open the templates',
      setup: async () => {
        // both ways toggle the picker: start from it closed
        if (await page.getByTestId('template-picker').count())
          await page.getByTestId('tools.dr-templates').click()
        await expect(page.getByTestId('template-picker')).toHaveCount(0)
      },
      before: (h) => h.click('tools.dr-templates'),
      after: (h) => h.palette('templates'),
      done: async () => {
        await expect(page.getByTestId('template-picker')).toBeVisible()
        await page.getByTestId('tools.dr-templates').click()
        await expect(page.getByTestId('template-picker')).toHaveCount(0)
        await focusCanvas(page)
      },
    },
  ]

  const rows: { task: string; before: Run; after: Run }[] = []
  for (const task of tasks) {
    await test.step(task.name, async () => {
      const before = await timed(page, task, 'before')
      const after = await timed(page, task, 'after')
      rows.push({ task: task.name, before, after })
    })
  }
  const summary = {
    tasks: rows,
    median: {
      beforeMs: median(rows.map((r) => r.before.ms)),
      afterMs: median(rows.map((r) => r.after.ms)),
      beforeInputs: median(rows.map((r) => r.before.inputs)),
      afterInputs: median(rows.map((r) => r.after.inputs)),
    },
  }
  await testInfo.attach('l3-expert-tasks.json', {
    body: JSON.stringify(summary, null, 2),
    contentType: 'application/json',
  })
  console.log('[l3 expert tasks]', JSON.stringify(summary))
  expect(rows).toHaveLength(10)
})
