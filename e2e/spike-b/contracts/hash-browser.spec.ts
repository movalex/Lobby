// The browser half of the hash.ts check (docs/EXCALIDRAW-MIGRATION.md §8.6.2 gate: "hash.ts giving the
// same digest in Node and in a browser for one sample map with tombstones"). hash.ts has no imports, so
// the page runs exactly its source with the types stripped (Node's own stripper), over WebCrypto in a
// secure context. The Node half and the pinned digest: packages/canvas-schema/src/hash.test.ts.
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { hashElements } from '../../../packages/canvas-schema/src/hash.ts'
import { HASH_SAMPLE, HASH_SAMPLE_DIGEST } from '../../../packages/canvas-schema/src/hash-sample.ts'

const HASH_SOURCE = fileURLToPath(new URL('../../../packages/canvas-schema/src/hash.ts', import.meta.url))
// never bound: page.route answers it (a localhost origin is a secure context, so crypto.subtle exists)
const PAGE_URL = 'http://localhost:7859/spike-b-hash'

test('hash.ts gives the same digest in Chromium as in Node for the sample map with tombstones', async ({
  page,
}) => {
  const js = `${stripTypeScriptTypes(readFileSync(HASH_SOURCE, 'utf8'))}\nglobalThis.__lobbyHash = hashElements\n`
  await page.route(PAGE_URL, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>hash</title>' }),
  )
  await page.goto(PAGE_URL)
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)
  await page.addScriptTag({ type: 'module', content: js })
  await page.waitForFunction(
    () => typeof (globalThis as { __lobbyHash?: unknown }).__lobbyHash === 'function',
  )
  const browserDigest = await page.evaluate(
    (els) => (globalThis as unknown as { __lobbyHash: (e: unknown[]) => Promise<string> }).__lobbyHash(els),
    HASH_SAMPLE as unknown[],
  )
  const nodeDigest = await hashElements(HASH_SAMPLE)
  expect(nodeDigest).toBe(HASH_SAMPLE_DIGEST)
  expect(browserDigest).toBe(nodeDigest)
  // order of elements and keys does not matter in the browser either
  const shuffled = [...HASH_SAMPLE].reverse().map((e) => Object.fromEntries(Object.entries(e).reverse()))
  expect(
    await page.evaluate(
      (els) => (globalThis as unknown as { __lobbyHash: (e: unknown[]) => Promise<string> }).__lobbyHash(els),
      shuffled as unknown[],
    ),
  ).toBe(HASH_SAMPLE_DIGEST)
})
