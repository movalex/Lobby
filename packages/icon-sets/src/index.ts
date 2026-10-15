// OWNER: WS1 (wave Q, the icons; landed by the wave Q foundation). The two icon sets the Elements panel offers, as
// pinned data packages (docs/WAVE-Q-CONTRACTS.md §3):
//
//   lucide-static 1.49.0 (ISC; its Feather-derived icons MIT, both texts in one LICENSE)
//   @tabler/icons 3.48.0 (MIT), the outline style only
//
// Both are exact pins in the pnpm catalog, data only (SVG and JSON: no code of theirs runs, no dependencies, no install
// scripts), and reach the board as generated, content-hashed index and shard files under /lobby-assets/icons/ (WS1's
// generator and Vite plugin; contracts icons.ts). Nothing here is imported by the board page at run time.
//
// Where each set keeps its data (read from the installed packages by the foundation, 2026-10-14):
//   - Lucide: `icon-nodes.json` (name → [[element, attributes], …]: path, circle, rect, line, ellipse, polyline,
//     polygon), `tags.json` (name → tags). No categories: Lucide's categories live in its repository, not in the
//     package, so the panel files Lucide icons under their tags only. `icons/*.svg` also holds the alias names.
//   - Tabler: `icons.json` (name → {name, category, tags, styles: {outline?, filled?}}: 41 categories, every icon has an
//     outline style), `tabler-nodes-outline.json` (name → [[path, {d}], …]: paths only), `icons/outline/*.svg`.
//     The filled style (`tabler-nodes-filled.json`) is left out (holed fills cannot be drawn as Excalidraw fills).
//
// Pure data: the paths are relative to each package's root; ./files.ts resolves them in Node (the generator).

import type { IconSetId } from '@draftroom/contracts'

export interface IconSetPackage {
  /** the set's id in the icon index and the mark keys (contracts icons.ts ICON_SET_IDS) */
  readonly id: IconSetId
  /** the npm package (exact pin in pnpm-workspace.yaml's catalog) */
  readonly packageName: string
  readonly version: string
  /** the SPDX licence its package.json states */
  readonly licence: string
  /** the licence text shipped by this package (../licenses/), a byte copy of the package's LICENSE */
  readonly licenceFile: string
  /** shown in the panel's footer and in LICENSES.txt */
  readonly credit: string
  /** the per-icon geometry: name → [[element, attributes], …] */
  readonly nodesFile: string
  /** the tags (and, for Tabler, the category) of each icon */
  readonly metaFile: string
  /** how `metaFile` is shaped */
  readonly metaShape: 'name-to-tags' | 'tabler-icons-json'
}

export const ICON_SET_PACKAGES: Readonly<Record<IconSetId, IconSetPackage>> = {
  lucide: {
    id: 'lucide',
    packageName: 'lucide-static',
    version: '1.49.0',
    licence: 'ISC',
    licenceFile: 'licenses/lucide-static-LICENSE.txt',
    credit: 'Lucide (ISC; icons derived from Feather: MIT)',
    nodesFile: 'icon-nodes.json',
    metaFile: 'tags.json',
    metaShape: 'name-to-tags',
  },
  tabler: {
    id: 'tabler',
    packageName: '@tabler/icons',
    version: '3.48.0',
    licence: 'MIT',
    licenceFile: 'licenses/tabler-icons-LICENSE.txt',
    credit: 'Tabler Icons (MIT)',
    nodesFile: 'tabler-nodes-outline.json',
    metaFile: 'icons.json',
    metaShape: 'tabler-icons-json',
  },
}

/** One element of an icon as its set's nodes file stores it: `['path', {d: '…'}]`, `['circle', {cx, cy, r}]`, … */
export type IconNode = readonly [element: string, attributes: Readonly<Record<string, string | number>>]

/** An entry of Tabler's `icons.json` (the fields the generator reads). */
export interface TablerIconMeta {
  readonly name: string
  readonly category: string
  readonly tags: readonly (string | number)[]
  readonly styles: { readonly outline?: unknown; readonly filled?: unknown }
}
