// zod jitless (docs/EXCALIDRAW-MIGRATION.md §2.12; cut-over G3): the probe `new Function('')` must never
// run under Lobby's CSP. public/zod-jitless.js, a blocking classic script in index.html's <head>, sets it on
// zod's global config object before any bundle runs (a module could not: Vite merges a page's module scripts
// into one entry whose shared chunks, zod among them, run before the entry's own statements).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { globalConfig } from 'zod/v4/core'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const script = read('../../public/zod-jitless.js')

describe('zod jitless before any bundle', () => {
  it('the script sets jitless on the object zod reads its config from (whichever of the two runs first)', () => {
    // zod is already evaluated here (the import above): the script must write into zod's existing object
    expect(globalConfig.jitless).toBeUndefined()
    new Function(script)()
    expect(globalConfig.jitless).toBe(true)
    // the other order: a fresh global gets the object zod will adopt with `??=`
    const fresh: { __zod_globalConfig?: Record<string, unknown> } = {}
    new Function('globalThis', script)(fresh)
    expect(fresh.__zod_globalConfig).toEqual({ jitless: true })
  })

  it('is classic and dependency-free', () => {
    const code = script.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/\b(import|export|require)\b/)
  })

  it('index.html loads it as a same-origin classic script in <head>, before every module script', () => {
    const html = read('../../index.html')
    const tag = html.indexOf('<script src="/zod-jitless.js"></script>')
    expect(tag).toBeGreaterThan(-1)
    expect(tag).toBeLessThan(html.indexOf('</head>'))
    expect(tag).toBeLessThan(html.indexOf('<script type="module"'))
    // no inline script anywhere: the CSP's script-src is 'self' with no hash
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull()
  })
})
