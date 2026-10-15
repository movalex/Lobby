// Wave Q (WS1): the icon catalog's loader against the generated files served by a fake fetch: the index once, each
// shard once and only when asked, same-origin paths under /lobby-assets/icons/, validation, and the errors (a 404, the
// SPA's index.html where a file should be, a schema mismatch, no index in this build), retried after a failure.
import { ICON_ASSET_PREFIX } from '@draftroom/contracts'
import { pinnedIcons } from '@draftroom/icon-sets/generate'
import { beforeAll, describe, expect, it } from 'vitest'
import { builtIconIndexFile, IconLoadError, loadIconCatalog } from './catalog.ts'

const served = () => new Map(pinnedIcons().files.map((f) => [`${ICON_ASSET_PREFIX}${f.name}`, f.content]))

/** A fetch that serves `files` and records every request. */
function fakeFetch(files: Map<string, string>, override?: (url: string) => Response | null) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const o = override?.(url)
    if (o) return o
    const body = files.get(url)
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const indexFile = () => pinnedIcons().indexFile

// the generation (about 4 s alone, more under the full suite's load) runs once, in a hook with room for it
beforeAll(() => {
  pinnedIcons()
}, 120_000)

describe('loadIconCatalog', () => {
  it('reads the index once, then each shard once and only when an icon in it is asked for', async () => {
    const f = fakeFetch(served())
    const catalog = await loadIconCatalog({ fetch: f.fetch, indexFile: indexFile() })
    expect(f.calls.map((c) => c.url)).toEqual([`${ICON_ASSET_PREFIX}${indexFile()}`])
    expect(f.calls[0]?.init?.credentials).toBe('same-origin')
    expect(catalog.entries.length).toBe(pinnedIcons().index.icons.length)
    expect(catalog.version('lucide')).toBe('1.49.0')
    expect(catalog.version('tabler')).toBe('3.48.0')
    const entry = catalog.get('lucide:arrow-right')
    if (!entry) throw new Error('no lucide:arrow-right')
    const [a, b] = await Promise.all([catalog.geometry(entry.key), catalog.geometry(entry.key)])
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]?.url).toBe(`${ICON_ASSET_PREFIX}${pinnedIcons().index.shards[entry.shard]}`)
    // another icon of the same shard: no new request
    const sibling = catalog.entries.find((e) => e.shard === entry.shard && e.key !== entry.key)
    if (sibling) await catalog.geometry(sibling.key)
    expect(f.calls).toHaveLength(2)
    expect(catalog.search('arrow-right')[0]?.name).toBe('arrow-right')
    // every request stayed under the prefix (same origin)
    expect(f.calls.every((c) => c.url.startsWith(ICON_ASSET_PREFIX))).toBe(true)
  })

  it('rejects with IconLoadError: no index in this build, a 404, an HTML page, a schema mismatch', async () => {
    const code = async (p: Promise<unknown>) => {
      try {
        await p
        return 'resolved'
      } catch (e) {
        return e instanceof IconLoadError ? e.code : `other: ${String(e)}`
      }
    }
    // the tests are no build of the web app: no define
    expect(builtIconIndexFile()).toBeNull()
    const load = (fetch: typeof globalThis.fetch, file: string | null = indexFile()) =>
      code(loadIconCatalog({ fetch, indexFile: file }))
    expect(await load(fakeFetch(served()).fetch, null)).toBe('unavailable')
    expect(await load(fakeFetch(new Map()).fetch)).toBe('not-found')
    const html = fakeFetch(served(), () => new Response('<!doctype html><html></html>', { status: 200 }))
    expect(await load(html.fetch)).toBe('invalid')
    const wrong = fakeFetch(served(), () => new Response('{"format":"lobby-icon-index","version":2}'))
    expect(await load(wrong.fetch)).toBe('invalid')
    const down = fakeFetch(served(), () => new Response('', { status: 503 }))
    expect(await load(down.fetch)).toBe('unavailable')
    const offline = (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch
    expect(await load(offline)).toBe('unavailable')
  })

  it('fetches a failed shard again on the next ask; an unknown icon is not-found', async () => {
    let failShards = true
    const failing = (url: string) => {
      if (failShards && url.includes('/shard-')) return new Response('', { status: 500 })
      return null
    }
    const f = fakeFetch(served(), failing)
    const catalog = await loadIconCatalog({ fetch: f.fetch, indexFile: indexFile() })
    const key = 'tabler:heart'
    await expect(catalog.geometry(key)).rejects.toBeInstanceOf(IconLoadError)
    failShards = false
    expect((await catalog.geometry(key)).length).toBeGreaterThan(0)
    expect(f.calls.filter((c) => c.url.includes('/shard-'))).toHaveLength(2)
    await expect(catalog.geometry('lucide:not-an-icon')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses a shard whose content is not the shard the index names', async () => {
    const files = served()
    const index = pinnedIcons().index
    const entry = index.icons.find((e) => e[1] === 'heart' && e[0] === 'lucide')
    if (!entry) throw new Error('no lucide:heart')
    const other = (entry[4] + 1) % index.shards.length
    // shard n's name serving shard n+1's content
    files.set(
      `${ICON_ASSET_PREFIX}${index.shards[entry[4]]}`,
      files.get(`${ICON_ASSET_PREFIX}${index.shards[other]}`) ?? '',
    )
    const catalog = await loadIconCatalog({ fetch: fakeFetch(files).fetch, indexFile: indexFile() })
    await expect(catalog.geometry('lucide:heart')).rejects.toMatchObject({ code: 'invalid' })
  })
})
