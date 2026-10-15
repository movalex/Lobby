// OWNER: WS1 (wave Q; landed by the wave Q foundation). Node-only: where the pinned icon packages are installed, for
// the generator (build time) and the tests. Never imported by the web's runtime code.
//
// Found by walking up node_modules from this package, not through `require.resolve`: @tabler/icons's `exports` map
// ("./*" → "./icons/*") hides its package.json and data files from the resolver.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IconSetId } from '@draftroom/contracts'
import { ICON_SET_PACKAGES } from './index.ts'

/** This package's own root (where ../licenses lives). */
export const ICON_SETS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The installed root of a set's package (the real path behind pnpm's link). */
export function iconSetRoot(id: IconSetId): string {
  const name = ICON_SET_PACKAGES[id].packageName
  for (let dir = ICON_SETS_ROOT; ; ) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const up = dirname(dir)
    if (up === dir) throw new Error(`icon-sets: ${name} is not installed`)
    dir = up
  }
}

/** A file of a set's package, by its path relative to the package root. */
export const iconSetFile = (id: IconSetId, file: string): string => join(iconSetRoot(id), file)

/** A set's JSON data file, parsed. */
export function readIconSetJson(id: IconSetId, file: string): unknown {
  return JSON.parse(readFileSync(iconSetFile(id, file), 'utf8'))
}
