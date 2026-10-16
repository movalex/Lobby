// The frozen fixtures the stale-pair tests parse the room's frames with (docs/EXCALIDRAW-CONTRACTS.md §0b, the
// per-reader downgrade rule): packages/canvas-schema/test/fixtures/rev<rev>-<commit>, each written once by
// scripts/freeze-protocol-fixture.mjs and never edited (wave N, N2-1: rev12-3c83611, the web deployed on staging
// since hotfix H2, whose canvas-schema is byte-identical to the deployed sync 104c6e0's; wave T, T-0: rev13-6769e07,
// the web deployed since wave S, whose canvas-schema is byte-identical to the deployed sync ba1704c's). Pinned here:
//  - every file carries the script's header: the source path, the commit, the revision and the blob;
//  - the folder's protocol.ts says the revision its name says (rev12-3c83611: CONTRACTS_REV 12);
//  - where git can read the commit (not a shallow clone): each blob id is that path's at the commit, the body is
//    `git show <commit>:<path>` with only the script's import swap, and the folder was added by one commit and never
//    changed since (no later commit, no change in the working tree).

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as Rev11 from '../test/fixtures/rev11-437b4e7/protocol.ts'
import * as Rev12 from '../test/fixtures/rev12-3c83611/protocol.ts'
import * as Rev13 from '../test/fixtures/rev13-6769e07/protocol.ts'

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url))
const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** Each frozen file and the path it was frozen from (scripts/freeze-protocol-fixture.mjs FILES). */
const SOURCES: Record<string, string> = {
  'protocol.ts': 'packages/canvas-schema/src/protocol.ts',
  'custom-data.ts': 'packages/canvas-schema/src/custom-data.ts',
  'doc.ts': 'packages/canvas-schema/src/doc.ts',
  'elements.ts': 'packages/canvas-schema/src/elements.ts',
  'hash.ts': 'packages/canvas-schema/src/hash.ts',
  'limits.ts': 'packages/canvas-schema/src/limits.ts',
  'contracts-tags.ts': 'packages/contracts/src/tags.ts',
  'contracts-mindmap.ts': 'packages/contracts/src/mindmap.ts',
}
/** The files a freeze from wave N on adds (custom-data.ts imports reactions.ts, which reads contracts' workshops). */
const SOURCES_SINCE_13: Record<string, string> = {
  ...SOURCES,
  'reactions.ts': 'packages/canvas-schema/src/reactions.ts',
  'contracts-workshops.ts': 'packages/contracts/src/workshops.ts',
}
/** The script's `@draftroom/contracts` import swaps (undone here to compare with the commit's file). */
const SWAPS: Record<string, { from: string; to: string }> = {
  'custom-data.ts': {
    from: "import { MINDMAP_SIDES, parseTagValue } from '@draftroom/contracts'\n",
    to: "import { MINDMAP_SIDES } from './contracts-mindmap.ts'\nimport { parseTagValue } from './contracts-tags.ts'\n",
  },
  'doc.ts': {
    from: "import { parseTagValue } from '@draftroom/contracts'\n",
    to: "import { parseTagValue } from './contracts-tags.ts'\n",
  },
  // in place (reactions.ts has no zod import): undone the same way, by removing each line where it stands
  'reactions.ts': {
    from: "import { REACTION_CODES, type ReactionCode } from '@draftroom/contracts'\n",
    to: "import { REACTION_CODES, type ReactionCode } from './contracts-workshops.ts'\n",
  },
}

const FOLDERS = [
  {
    dir: 'rev13-6769e07',
    commit: '6769e07',
    rev: 13,
    which: 'the web deployed on staging since wave S',
    sources: SOURCES_SINCE_13,
  },
  {
    dir: 'rev12-3c83611',
    commit: '3c83611',
    rev: 12,
    which: 'the web deployed on staging since hotfix H2 (wave M)',
    sources: SOURCES,
  },
  {
    dir: 'rev11-437b4e7',
    commit: '437b4e7',
    rev: 11,
    which: 'the web deployed on staging since wave K',
    sources: SOURCES,
  },
] as const

const git = (...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}
/**
 * The frozen file's header and its body. The script's header is eight lines, then what was changed: one line
 * ("these header lines only.") or the two of an import swap.
 */
function split(text: string): { header: string[]; body: string } {
  const lines = text.split('\n')
  const n = lines[7]?.endsWith('Changed from the commit:')
    ? lines[8] === '// these header lines only.'
      ? 9
      : 10
    : 0
  return { header: lines.slice(0, n), body: lines.slice(n).join('\n') }
}

describe('the frozen protocol fixtures (written once by scripts/freeze-protocol-fixture.mjs, never edited)', () => {
  it('rev13-6769e07, rev12-3c83611 and rev11-437b4e7 say the revision their names say', () => {
    expect(Rev13.CONTRACTS_REV).toBe(13)
    expect(Rev12.CONTRACTS_REV).toBe(12)
    expect(Rev11.CONTRACTS_REV).toBe(11)
  })

  for (const f of FOLDERS) {
    describe(f.dir, () => {
      const dir = join(FIXTURES, f.dir)
      const files = readdirSync(dir).sort()

      it('holds exactly the frozen modules, each with the header naming its source, the commit and its blob', () => {
        expect(files).toEqual(Object.keys(f.sources).sort())
        for (const name of files) {
          const { header } = split(readFileSync(join(dir, name), 'utf8'))
          expect(header[0], name).toBe('// FROZEN FIXTURE, never edit. This is')
          expect(header[1], name).toBe(`//   ${f.sources[name]}`)
          expect(header[2], name).toBe(`// of commit ${f.commit} (${f.which}: CONTRACTS_REV ${f.rev}), as`)
          expect(header[3], name).toMatch(
            new RegExp(`^// \`git show ${f.commit}:<that path>\` gives it \\(blob [0-9a-f]{12}\\)\\. `),
          )
        }
      })

      const known = git('cat-file', '-e', `${f.commit}^{commit}`) !== null
      it.skipIf(!known)(
        'is the commit’s files byte for byte (but the header and the import swap), added once, never changed',
        () => {
          for (const name of files) {
            const src = f.sources[name] as string
            const text = readFileSync(join(dir, name), 'utf8')
            const { header, body } = split(text)
            const blob = /\(blob ([0-9a-f]{12})\)/.exec(header[3] ?? '')?.[1]
            expect(git('rev-parse', `${f.commit}:${src}`)?.trim().slice(0, 12), name).toBe(blob)
            const swap = SWAPS[name]
            const want = git('show', `${f.commit}:${src}`) as string
            // the swap took the import out and put the frozen copies' after zod's: compared without either
            if (swap) expect(body.replace(swap.to, ''), name).toBe(want.replace(swap.from, ''))
            else expect(body, name).toBe(want)
          }
          // one commit added the folder, and nothing touched it since (in history or in the working tree)
          const log = (git('log', '--format=%H', '--', `packages/canvas-schema/test/fixtures/${f.dir}`) ?? '')
            .trim()
            .split('\n')
            .filter(Boolean)
          expect(log, 'commits that touch the folder').toHaveLength(1)
          const added = (
            git(
              'log',
              '--diff-filter=A',
              '--format=%H',
              '--',
              `packages/canvas-schema/test/fixtures/${f.dir}`,
            ) ?? ''
          ).trim()
          expect(added).toBe(log[0])
          expect(
            git('status', '--porcelain', '--', `packages/canvas-schema/test/fixtures/${f.dir}`),
            'uncommitted changes in the folder',
          ).toBe('')
        },
      )
    })
  }
})
