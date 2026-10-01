/**
 * Static reading of the pinned Excalidraw bundles for the engine probe suite (plan §6.5).
 * Paths are the installed packages under `apps/web/node_modules/@excalidraw/*`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PINNED = '0.18.0-1118751'

const pkgDir = (name: string) =>
  fileURLToPath(new URL(`../../node_modules/@excalidraw/${name}/`, import.meta.url))

export const packageVersion = (name: string): string =>
  (JSON.parse(readFileSync(join(pkgDir(name), 'package.json'), 'utf8')) as { version: string }).version

export type Build = 'dev' | 'prod'

export const distFile = (name: string, build: Build, file = 'index.js') =>
  join(pkgDir(name), 'dist', build, file)

export const readDist = (name: string, build: Build, file = 'index.js') =>
  readFileSync(distFile(name, build, file), 'utf8')

/** every `.js` file of a build except `index.js` (chunks, workers) */
export const otherJsFiles = (name: string, build: Build) =>
  readdirSync(join(pkgDir(name), 'dist', build)).filter((f) => f.endsWith('.js') && f !== 'index.js')

export const count = (src: string, re: RegExp) =>
  (src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length

/** The editor-open table of plan §2.9.2: call sites of each function that opens the text editor. */
export const EDITOR_OPEN_CALLS = { startTextEditing: 7, handleTextWysiwyg: 2 } as const
type EditorOpenName = keyof typeof EDITOR_OPEN_CALLS

/** call sites (`.name(`) and every mention of each name; a matching bundle has mentions = calls + 1 */
export const editorOpenCounts = (src: string) => {
  const out = {} as Record<EditorOpenName, { calls: number; mentions: number }>
  for (const name of Object.keys(EDITOR_OPEN_CALLS) as EditorOpenName[]) {
    out[name] = {
      calls: count(src, new RegExp(`\\.${name}\\(`)),
      mentions: count(src, new RegExp(`\\b${name}\\b`)),
    }
  }
  return out
}

/** The probe's verdict: null when the bundle matches the table, else the counts that differ. */
export const editorOpenMismatch = (src: string) => {
  const got = editorOpenCounts(src)
  const bad = (Object.keys(EDITOR_OPEN_CALLS) as EditorOpenName[]).filter(
    (name) =>
      got[name].calls !== EDITOR_OPEN_CALLS[name] || got[name].mentions !== EDITOR_OPEN_CALLS[name] + 1,
  )
  return bad.length ? Object.fromEntries(bad.map((name) => [name, got[name]])) : null
}

export interface CallSite {
  line: number
  /** innermost named function, then its parents: `name@line` */
  enclosing: string[]
}

const DEF_PATTERNS = [
  /__publicField\(this, "(\w+)"/,
  /^\s*(?:async\s+)?(\w+)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\{\s*$/,
  /^\s*(\w+):\s*(?:async\s*)?\(/,
  /^\s*(?:const|var|let)\s+(\w+)\s*=/,
  /^\s*(\w+)\(.*\{$/,
]
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return'])
const indentOf = (s: string) => /^\s*/.exec(s)?.[0].length ?? 0

/**
 * Call sites `.name(` in an unminified build, with the enclosing named functions found by walking up
 * to lines of smaller indentation.
 */
export const callSites = (src: string, name: string): CallSite[] => {
  const lines = src.split('\n')
  const out: CallSite[] = []
  lines.forEach((line, i) => {
    if (!line.includes(`.${name}(`)) return
    let min = indentOf(line)
    const enclosing: string[] = []
    for (let j = i - 1; j >= 0 && enclosing.length < 3; j--) {
      const l = lines[j] ?? ''
      if (!l.trim()) continue
      const ind = indentOf(l)
      if (ind >= min || l.trim().startsWith('}')) continue
      min = ind
      for (const p of DEF_PATTERNS) {
        const m = p.exec(l)
        if (m?.[1] && !KEYWORDS.has(m[1])) {
          enclosing.push(`${m[1]}@${j + 1}`)
          break
        }
      }
    }
    out.push({ line: i + 1, enclosing })
  })
  return out
}
