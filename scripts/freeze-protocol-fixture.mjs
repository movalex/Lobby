// Freezes the wire schemas a deployed web build parses server frames with, as a test fixture (the per-reader
// downgrade rule, docs/EXCALIDRAW-CONTRACTS.md §0b): canvas-schema's protocol.ts and every module it imports
// (custom-data, doc, elements, hash, limits; from wave N also reactions) and the @draftroom/contracts modules those
// import (tags, mindmap; from wave N also workshops), each exactly as `git show <commit>:<path>` gives it, with
// a header naming the commit and the blob, and the `@draftroom/contracts` import pointed at the frozen copies
// beside it. The stale-pair tests parse the room's frames with them (packages/canvas-schema/src/reader-rule.test.ts,
// reader-rule-rev13.test.ts, apps/sync/test/element-room/stale-reader-rev11.test.ts, e2e/excalidraw/l-compat-kit.ts).
//
//   node scripts/freeze-protocol-fixture.mjs <commit> <rev> <which web> [<out dir>]
//     which web: words for the header, e.g. 'the web deployed on staging since wave K'
//     out dir: packages/canvas-schema/test/fixtures/rev<rev>-<commit> by default
//
// The rev-11 fixture is this script's output for: 437b4e7 11 'the web deployed on staging since wave K'.
//
// Run it for the build that is deployed when CONTRACTS_REV is bumped (the web that will stay open for days), then
// point the stale-pair tests at the new folder. Never edit a frozen file.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [commit, rev, which, outArg] = process.argv.slice(2)
if (!commit || !/^[0-9a-f]{7,40}$/.test(commit) || !rev || !/^[0-9]{1,4}$/.test(rev) || !which) {
  console.error('usage: node scripts/freeze-protocol-fixture.mjs <commit> <rev> <which web> [<out dir>]')
  process.exit(2)
}
const out = outArg ?? join('packages/canvas-schema/test/fixtures', `rev${rev}-${commit}`)
const FILES = [
  ['protocol.ts', 'packages/canvas-schema/src/protocol.ts'],
  ['custom-data.ts', 'packages/canvas-schema/src/custom-data.ts'],
  ['doc.ts', 'packages/canvas-schema/src/doc.ts'],
  ['elements.ts', 'packages/canvas-schema/src/elements.ts'],
  ['hash.ts', 'packages/canvas-schema/src/hash.ts'],
  ['limits.ts', 'packages/canvas-schema/src/limits.ts'],
  ['contracts-tags.ts', 'packages/contracts/src/tags.ts'],
  ['contracts-mindmap.ts', 'packages/contracts/src/mindmap.ts'],
  // wave N (CONTRACTS_REV 13 on): custom-data.ts imports ./reactions.ts, which reads REACTION_CODES from the
  // contracts' workshops.ts. Optional: a commit before wave N has neither file (the rev-12 and rev-11 freezes).
  ['reactions.ts', 'packages/canvas-schema/src/reactions.ts', { optional: true }],
  [
    'contracts-workshops.ts',
    'packages/contracts/src/workshops.ts',
    { optional: true, onlyWith: 'packages/canvas-schema/src/reactions.ts' },
  ],
]
/** What each frozen file imports from @draftroom/contracts, and the frozen copies that hold it. */
const CONTRACTS_IMPORTS = {
  'custom-data.ts': {
    from: "import { MINDMAP_SIDES, parseTagValue } from '@draftroom/contracts'\n",
    to: "import { MINDMAP_SIDES } from './contracts-mindmap.ts'\nimport { parseTagValue } from './contracts-tags.ts'\n",
    note: [
      'these header lines, and its `@draftroom/contracts` import, which reads the frozen copies',
      'beside it (contracts-mindmap.ts, contracts-tags.ts).',
    ],
  },
  'reactions.ts': {
    from: "import { REACTION_CODES, type ReactionCode } from '@draftroom/contracts'\n",
    to: "import { REACTION_CODES, type ReactionCode } from './contracts-workshops.ts'\n",
    // no zod import in this file: the frozen copy's import stays where the original was
    inPlace: true,
    note: [
      'these header lines, and its `@draftroom/contracts` import, which reads the frozen copy',
      'beside it (contracts-workshops.ts).',
    ],
  },
  'doc.ts': {
    from: "import { parseTagValue } from '@draftroom/contracts'\n",
    to: "import { parseTagValue } from './contracts-tags.ts'\n",
    note: [
      'these header lines, and its `@draftroom/contracts` import, which reads the frozen copy',
      'beside it (contracts-tags.ts).',
    ],
  },
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** Whether `path` exists at `commit` (an optional file may not). */
const exists = (path) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}:${path}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

mkdirSync(out, { recursive: true })
for (const [name, src, opts] of FILES) {
  if (opts?.optional && !exists(opts.onlyWith ?? src)) continue
  const blob = git('rev-parse', `${commit}:${src}`).trim().slice(0, 12)
  let body = git('show', `${commit}:${src}`)
  let note = ['these header lines only.']
  const swap = CONTRACTS_IMPORTS[name]
  if (swap) {
    if (!body.includes(swap.from))
      throw new Error(`${src} at ${commit}: its @draftroom/contracts import changed`)
    // the frozen copies sort after zod (biome's import order): the import goes right after zod's (in place in a
    // file without zod)
    body = swap.inPlace
      ? body.replace(swap.from, swap.to)
      : body
          .replace(swap.from, '')
          .replace("import { z } from 'zod'\n", `import { z } from 'zod'\n${swap.to}`)
    note = swap.note
  }
  const header = [
    '// FROZEN FIXTURE, never edit. This is',
    `//   ${src}`,
    `// of commit ${commit} (${which}: CONTRACTS_REV ${rev}), as`,
    `// \`git show ${commit}:<that path>\` gives it (blob ${blob}). The deployed web parses every server`,
    '// frame with these schemas (its socket transport, apps/web/src/canvas/sync/transport/socket.ts at that',
    '// commit: `ServerMessage.safeParse` on each text frame, the gzip snapshot through `decodeSnapshotFrame`),',
    "// so the stale-pair tests parse the room's frames with them (docs/EXCALIDRAW-CONTRACTS.md §0b, the",
    '// per-reader downgrade rule). Changed from the commit:',
    ...note.map((l) => `// ${l}`),
    '',
  ].join('\n')
  writeFileSync(join(out, name), header + body)
  console.log(`${join(out, name)} (blob ${blob})`)
}
