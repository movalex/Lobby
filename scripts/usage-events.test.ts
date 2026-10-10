// Wave M (S3, M5-5; landed by the wave M foundation, OWNER: W5): every countUsage call in apps/web counts an event of
// the contract's fixed list (packages/contracts/src/usage.ts USAGE_EVENTS). The type allows nothing else; this reads
// the source as text so a cast, a stale literal or a template with an unknown prefix fails here too:
//  - a string literal must be a USAGE_EVENTS member;
//  - a template literal `name:${…}` must start with one of USAGE_PARAM_EVENTS' names and a colon (its value is typed
//    by the parameter list), and one without `${` must be a member;
//  - any other argument (a typed variable) is left to the typecheck.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { USAGE_EVENTS, USAGE_PARAM_EVENTS } from '../packages/contracts/src/usage.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WEB = join(ROOT, 'apps/web/src')
/** The counter itself (its own signature and docs mention countUsage). */
const SKIP = new Set(['lib/usage.ts'])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

export interface UsageCallProblem {
  at: string
  arg: string
  why: string
}

const EVENTS: ReadonlySet<string> = new Set(USAGE_EVENTS)
const PARAM_PREFIXES = Object.keys(USAGE_PARAM_EVENTS).map((n) => `${n}:`)

/** The countUsage calls of one file's text whose argument is not a known event. */
export function usageCallProblems(
  text: string,
  file: string,
): { calls: number; problems: UsageCallProblem[] } {
  const problems: UsageCallProblem[] = []
  let calls = 0
  for (const m of text.matchAll(/\bcountUsage\(\s*/g)) {
    calls++
    const start = (m.index ?? 0) + m[0].length
    const line = text.slice(0, m.index).split('\n').length
    const at = `${file}:${line}`
    const q = text[start]
    if (q === "'" || q === '"') {
      const end = text.indexOf(q, start + 1)
      const arg = text.slice(start + 1, end)
      if (!EVENTS.has(arg)) problems.push({ at, arg, why: 'not a USAGE_EVENTS member' })
    } else if (q === '`') {
      const end = text.indexOf('`', start + 1)
      const arg = text.slice(start + 1, end)
      const hole = arg.indexOf('${')
      if (hole < 0) {
        if (!EVENTS.has(arg)) problems.push({ at, arg, why: 'not a USAGE_EVENTS member' })
      } else if (!PARAM_PREFIXES.includes(arg.slice(0, hole)))
        problems.push({ at, arg, why: 'not a template starting with a parameterised event and a colon' })
    }
  }
  return { calls, problems }
}

describe('countUsage call sites (apps/web/src)', () => {
  it('the scanner: literals and template prefixes are checked, typed variables are left to tsc', () => {
    // `%{` stands for a template hole (a dollar sign and a brace), so the samples stay plain strings
    const hole = (s: string) => s.replaceAll('%{', `${'$'}{`)
    const sample = hole(
      [
        "countUsage('coach.shown')",
        'countUsage("palette.open:key")',
        'countUsage(`palette.run:%{id}`)',
        'countUsage(`open.cold`)',
        'countUsage(event)',
        "countUsage('coach.shwon')",
        'countUsage(`board:%{boardId}`)',
        "countUsage( 'palette.run:nope' )",
        'countUsage(`palette.open`)',
      ].join('\n'),
    )
    const { calls, problems } = usageCallProblems(sample, 'sample.ts')
    expect(calls).toBe(9)
    expect(problems.map((p) => p.arg)).toEqual([
      'coach.shwon',
      hole('board:%{boardId}'),
      'palette.run:nope',
      'palette.open',
    ])
    expect(problems[0]?.at).toBe('sample.ts:6')
  })

  it('every call in the web app counts a contract event', () => {
    const problems: UsageCallProblem[] = []
    let calls = 0
    for (const f of sources(WEB)) {
      const rel = relative(WEB, f).replaceAll('\\', '/')
      if (SKIP.has(rel)) continue
      const r = usageCallProblems(readFileSync(f, 'utf8'), rel)
      calls += r.calls
      problems.push(...r.problems)
    }
    expect(problems).toEqual([])
    // Not a target: the foundation lands the counter with no call site; the workstreams add them.
    expect(calls).toBeGreaterThanOrEqual(0)
  })
})
