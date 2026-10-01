/**
 * A3, Node side: the sync process's runtime (plain `node`, Node 24, the `default` = prod build of
 * `@excalidraw/element`), with the server's table text metrics installed. Reads the labels as JSON on
 * stdin (default: the A3 corpus) and prints the layouts as JSON on stdout.
 *
 *   node apps/web/test/engine-probe/a3/node-layout.ts [--no-kerning] < labels.json
 */
import { readFileSync } from 'node:fs'
import {
  createTableTextMetrics,
  installServerTextMetrics,
} from '../../../../../packages/canvas-schema/src/engine/text-metrics.ts'
import { buildCorpus, type CorpusLabel } from './corpus.ts'
import { layoutLabels } from './layout-labels.ts'

const kerning = !process.argv.includes('--no-kerning')
const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
const labels: CorpusLabel[] = stdin.trim() ? JSON.parse(stdin) : buildCorpus()
const t0 = performance.now()
const provider = installServerTextMetrics(createTableTextMetrics(undefined, { kerning }))
const t1 = performance.now()
const layouts = layoutLabels(labels)
const ms = performance.now() - t1
process.stdout.write(
  JSON.stringify({
    runtime: {
      node: process.version,
      platform: process.platform,
      hasDocument: typeof (globalThis as { document?: unknown }).document !== 'undefined',
    },
    kerning,
    setupMs: t1 - t0,
    ms,
    stats: provider.stats,
    layouts,
  }),
)
