// Screenshots of real test runs. They always go to the test's output dir (attached to the report);
// with E2E_SCREENSHOTS=1 they are also written to docs/screenshots/ (the committed product shots).
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { REPO_ROOT } from './stack.ts'

const DOCS_DIR = join(REPO_ROOT, 'docs/screenshots')

async function publish(name: string, path: string, testInfo: TestInfo) {
  await testInfo.attach(name, { path, contentType: 'image/png' })
  if (process.env.E2E_SCREENSHOTS === '1') {
    mkdirSync(DOCS_DIR, { recursive: true })
    copyFileSync(path, join(DOCS_DIR, name))
  }
}

export async function capture(name: string, target: Page | Locator, testInfo: TestInfo) {
  const path = testInfo.outputPath(name)
  await target.screenshot({ path, animations: 'disabled' })
  await publish(name, path, testInfo)
}

/** Two browser windows next to each other in one image (ffmpeg is already required by the worker). */
export async function captureSideBySide(name: string, left: Page, right: Page, testInfo: TestInfo) {
  const l = testInfo.outputPath(`left-${name}`)
  const r = testInfo.outputPath(`right-${name}`)
  await left.screenshot({ path: l, animations: 'disabled' })
  await right.screenshot({ path: r, animations: 'disabled' })
  const out = testInfo.outputPath(name)
  const ff = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      l,
      '-i',
      r,
      '-filter_complex',
      '[0]pad=iw+12:ih:0:0:color=0x374151[a];[a][1]hstack=inputs=2',
      out,
    ],
    { windowsHide: true, encoding: 'utf8' },
  )
  if (ff.status !== 0) throw new Error(`ffmpeg could not combine screenshots: ${ff.stderr}`)
  await publish(name, out, testInfo)
}
