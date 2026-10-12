// W3 (wave M, M3-6, S1.2): a board link pasted into a chat tool or a meeting invite unfurls as a generic "Lobby board".
// The tags are static in index.html: every /b/<id> serves the same page, so no board's title, thumbnail or word can be in
// them. This builds the real index.html through Vite (its head scripts and entry swapped for a stub: only the meta tags
// matter here) with VITE_PUBLIC_ORIGIN set, as Render's build has it (render.yaml), and reads the page it emits.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Rolldown } from 'vite'
import { describe, expect, it } from 'vitest'

// the build's own plugin (apps/web/vite.config.ts): the page below is built with it, as the real build is
const { dropUnsetPublicOrigin } = await import('../../vite.config.ts')

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = readFileSync(path.join(WEB, 'index.html'), 'utf8')
const ORIGIN = 'https://lobby.example'

/** The real index.html, built by Vite with the origin set; the page as it is served to a crawler. */
async function builtIndex(env: string | null): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'lobby-link-preview-'))
  const before = process.env.VITE_PUBLIC_ORIGIN
  try {
    // only the scripts differ: the head scripts and the entry are other tests' business (theme.test.ts, zod-jitless.test.ts)
    const html = SOURCE.replace(/<script\b[^>]*>\s*<\/script>/g, '').replace(
      '</body>',
      '<script type="module" src="/main.js"></script></body>',
    )
    writeFileSync(path.join(root, 'index.html'), html)
    writeFileSync(path.join(root, 'main.js'), 'console.log(1)\n')
    if (env === null) delete process.env.VITE_PUBLIC_ORIGIN
    else process.env.VITE_PUBLIC_ORIGIN = env
    const out = (await build({
      configFile: false,
      root,
      envDir: root,
      plugins: [dropUnsetPublicOrigin()],
      logLevel: 'silent',
      build: { write: false, outDir: path.join(root, 'dist'), emptyOutDir: true },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[]
    const asset = (Array.isArray(out) ? out : [out])
      .flatMap((o) => o.output)
      .find((o) => o.fileName === 'index.html')
    if (asset?.type !== 'asset') throw new Error('no index.html emitted')
    return String(asset.source)
  } finally {
    if (before === undefined) delete process.env.VITE_PUBLIC_ORIGIN
    else process.env.VITE_PUBLIC_ORIGIN = before
    rmSync(root, { recursive: true, force: true })
  }
}

/** The meta tags of a page as name-or-property → content. */
function metas(html: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of html.matchAll(/<meta\b([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>()
    for (const a of (m[1] as string).matchAll(/([\w:-]+)="([^"]*)"/g))
      attrs.set(a[1] as string, a[2] as string)
    const key = attrs.get('property') ?? attrs.get('name')
    if (key) out.set(key, attrs.get('content') ?? '')
  }
  return out
}

/** Every tag that says how a link to the app looks when it is pasted somewhere. */
const PREVIEW_KEYS = [
  'og:site_name',
  'og:title',
  'og:description',
  'og:type',
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:image:alt',
  'twitter:card',
  'robots',
]

describe('the link preview tags in index.html (M3-6)', () => {
  let page = ''
  let loaded = false
  const html = async () => {
    if (!loaded) {
      page = await builtIndex(ORIGIN)
      loaded = true
    }
    return page
  }

  it('are in the built page: a generic title and description, a website, a summary card, and noindex', async () => {
    const m = metas(await html())
    expect(m.get('og:title')).toBe('Lobby board')
    expect(m.get('og:description')).toBe('Open to view in Lobby')
    expect(m.get('og:type')).toBe('website')
    expect(m.get('og:site_name')).toBe('Lobby')
    expect(m.get('twitter:card')).toBe('summary')
    expect(m.get('robots')).toMatch(/\bnoindex\b/)
    // the page keeps its own, unchanged tags
    expect(m.get('application-name')).toBe('Lobby')
    expect(m.get('theme-color')).toBe('#213150')
  })

  it('og:image is an absolute URL on this site’s own origin (VITE_PUBLIC_ORIGIN) to a brand PNG that ships in public/', async () => {
    const image = metas(await html()).get('og:image') as string
    expect(image).toBe(`${ORIGIN}/icon-512.png`)
    const url = new URL(image)
    expect(url.protocol).toBe('https:')
    expect(url.origin).toBe(ORIGIN)
    const file = path.join(WEB, 'public', url.pathname)
    expect(existsSync(file)).toBe(true)
    const bytes = readFileSync(file)
    // a PNG, as large as the tags say
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const m = metas(page)
    expect(String(bytes.readUInt32BE(16))).toBe(m.get('og:image:width'))
    expect(String(bytes.readUInt32BE(20))).toBe(m.get('og:image:height'))
  })

  it('contain no template placeholder once built (the origin is the one name, and it is replaced)', async () => {
    const built = await html()
    expect(built).not.toMatch(/%[A-Za-z_][A-Za-z0-9_]*%/)
    expect(built).not.toMatch(/\$\{|\{\{|<%/)
    for (const key of PREVIEW_KEYS) expect(metas(built).get(key), key).toBeTruthy()
    // the source names exactly one: the origin
    expect([...SOURCE.matchAll(/%[A-Za-z_][A-Za-z0-9_]*%/g)].map((x) => x[0])).toEqual([
      '%VITE_PUBLIC_ORIGIN%',
    ])
  })

  it('are static: nothing in them can be a board’s title, thumbnail or words', async () => {
    const m = metas(await html())
    // a closed list of values, byte for byte: any text in a tag that is not here is new and needs a review
    expect(Object.fromEntries(PREVIEW_KEYS.map((k) => [k, m.get(k)]))).toEqual({
      'og:site_name': 'Lobby',
      'og:title': 'Lobby board',
      'og:description': 'Open to view in Lobby',
      'og:type': 'website',
      'og:image': `${ORIGIN}/icon-512.png`,
      'og:image:width': '512',
      'og:image:height': '512',
      'og:image:alt': 'Lobby',
      'twitter:card': 'summary',
      robots: 'noindex, nofollow',
    })
    // no board id, no per-request word: the page is the same file for every address
    const tags = PREVIEW_KEYS.map((k) => m.get(k)).join(' ')
    expect(tags).not.toMatch(/\bb-[a-z0-9]{6,}/i)
    expect(tags).not.toMatch(/\/b\//)
    // and no code of the app writes these tags: a board’s words can never reach them in the browser either
    for (const file of sourceFiles(path.join(WEB, 'src'))) {
      const text = readFileSync(file, 'utf8')
      expect(text, path.relative(WEB, file)).not.toMatch(/['"`]og:(?:title|description|image|type)['"`]/)
      expect(text, path.relative(WEB, file)).not.toMatch(/meta\[(?:property|name)=['"]?(?:og|twitter):/)
    }
  })

  it('N1 (wave M follow-up 3): a build without the origin has no og:image tags and no placeholder (nothing else is lost)', async () => {
    const built = await builtIndex(null)
    // no literal %VITE_PUBLIC_ORIGIN% in an og:image a crawler would try to fetch
    expect([...built.matchAll(/%[A-Za-z_][A-Za-z0-9_]*%/g)].map((x) => x[0])).toEqual([])
    const m = metas(built)
    for (const k of ['og:image', 'og:image:width', 'og:image:height', 'og:image:alt'])
      expect(m.has(k), k).toBe(false)
    // the rest of the card is still there
    expect(m.get('og:title')).toBe('Lobby board')
    expect(m.get('og:description')).toBe('Open to view in Lobby')
    expect(m.get('twitter:card')).toBe('summary')
    expect(m.get('robots')).toMatch(/\bnoindex\b/)
  })

  it('a blank origin counts as unset (an empty variable in the environment)', async () => {
    const built = await builtIndex('   ')
    expect([...built.matchAll(/%[A-Za-z_][A-Za-z0-9_]*%/g)]).toEqual([])
    expect(metas(built).has('og:image')).toBe(false)
  })
})

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
