// Generates the tables of docs/EXCALIDRAW-CONTRACTS.md §2 and §6-§7 from the frozen sources
// (apps/web/src/canvas/api/impl.ts LOBBY_CANVAS_MEMBERS, tldraw-map.ts) and a scan of apps/web/src.
//
//   cd apps/web && node ../../docs/research/excalidraw/wave1/gen-contract-tables.ts > <out.md>
//
// (run from apps/web so `react` resolves for lib/signals.ts). Node 24 strips the types.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOBBY_CANVAS_MEMBERS } from '../../../../apps/web/src/canvas/api/impl.ts'
import { OWNERS } from '../../../../apps/web/src/canvas/api/owners.ts'
import { EDITOR_MEMBERS, fileOwner, TLDRAW_SYMBOLS } from '../../../../apps/web/src/canvas/api/tldraw-map.ts'

const SRC = fileURLToPath(new URL('../../../../apps/web/src/', import.meta.url))
const files: string[] = []
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    const rel = relative(SRC, p).replace(/\\/g, '/')
    if (rel === 'canvas') continue
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(n)) files.push(p)
  }
}
walk(SRC)

const uses = new Map<string, { count: number; files: Set<string> }>()
const fileRows: { file: string; owner: string; members: number; symbols: number; test: boolean }[] = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const rel = relative(SRC, f).replace(/\\/g, '/')
  const members = [...src.matchAll(/\beditor\??\.([a-zA-Z_]+)/g)].map((m) => m[1] as string)
  const symbols = [...src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(?:tldraw|@tldraw\/[a-z-]+)'/g)].flatMap(
    (m) => (m[1] ?? '').split(',').filter((s) => s.trim()),
  )
  const star = /import\s+\*\s+as\s+\w+\s+from\s+'(?:tldraw|@tldraw\/[a-z-]+)'/.test(src) ? 1 : 0
  for (const m of members) {
    const u = uses.get(m) ?? { count: 0, files: new Set<string>() }
    u.count++
    u.files.add(rel)
    uses.set(m, u)
  }
  if (members.length || symbols.length || star)
    fileRows.push({
      file: rel,
      owner: fileOwner(rel) ?? '?',
      members: new Set(members).size,
      symbols: symbols.length + star,
      test: /\.test\.tsx?$/.test(rel),
    })
}

const esc = (s: string) => s.replace(/\|/g, '\\|')
const memberOwner = (t: string): string => {
  if (t === 'dropped') return '—'
  const [kind, rest = ''] = t.split(/:(.*)/s)
  if (kind === 'canvas') return LOBBY_CANVAS_MEMBERS.find((m) => m.path === rest)?.owner ?? '?'
  if (kind === 'feature') return rest
  if (kind === 'registry') return 'registry'
  return 'contracts'
}
const out: string[] = []

out.push('### 2.1 LobbyCanvas members (generated)\n')
out.push('| Member | Owner | Today |')
out.push('|---|---|---|')
for (const m of LOBBY_CANVAS_MEMBERS) {
  const today =
    m.status === 'core'
      ? 'C0 port (real)'
      : m.status === 'composed'
        ? 'composed (real)'
        : m.status === 'board'
          ? 'board page (real with the board handles)'
          : m.status === 'part'
            ? 'part (real)'
            : m.status === 'board-part'
              ? 'part (real with the board engine; a stub on a bare port)'
              : 'stub'
  out.push(`| \`${m.path}\` | ${m.owner} | ${today} |`)
}
const count = (s: string) => LOBBY_CANVAS_MEMBERS.filter((m) => m.status === s).length
out.push(
  `\n${LOBBY_CANVAS_MEMBERS.length} members: ${count('core')} C0 port, ${count('composed')} composed, ${count('board')} board page, ${count('part')} landed parts, ${count('board-part')} landed board-engine parts, ${count('stub')} stubs${count('stub') ? ' (' : ''}${Object.entries(
    LOBBY_CANVAS_MEMBERS.filter((m) => m.status === 'stub').reduce<Record<string, number>>((a, m) => {
      a[m.owner] = (a[m.owner] ?? 0) + 1
      return a
    }, {}),
  )
    .map(([o, n]) => `${o} ${n}`)
    .join(', ')}${count('stub') ? ')' : ''}.\n`,
)

out.push('### 6.1 `editor.*` members → replacement (generated)\n')
out.push('| `editor.` member | Uses (files) | Replacement | Implemented by | Note |')
out.push('|---|---|---|---|---|')
const members = Object.keys(EDITOR_MEMBERS).sort((a, b) => (uses.get(b)?.count ?? 0) - (uses.get(a)?.count ?? 0) || a.localeCompare(b))
for (const name of members) {
  const m = EDITOR_MEMBERS[name] as { to: readonly string[]; note?: string }
  const u = uses.get(name)
  const owners = [...new Set(m.to.map(memberOwner))].join(', ')
  out.push(
    `| \`${name}\` | ${u?.count ?? 0} (${u?.files.size ?? 0}) | ${m.to.map((t) => `\`${t}\``).join(', ')} | ${owners} | ${esc(m.note ?? '')} |`,
  )
}
out.push(`\n${members.length} members mapped; ${[...uses.keys()].length} in use today.\n`)

out.push('### 6.2 Imported tldraw symbols → replacement (generated)\n')
out.push('| Group | Owner | Symbols | Replacement | Note |')
out.push('|---|---|---|---|---|')
for (const g of TLDRAW_SYMBOLS) {
  out.push(
    `| ${g.id} | ${g.owner} | ${g.symbols.map((s) => `\`${s}\``).join(', ')} | ${g.to.map((t) => `\`${t}\``).join(', ')} | ${esc(g.note)} |`,
  )
}
out.push(`\n${TLDRAW_SYMBOLS.reduce((n, g) => n + g.symbols.length, 0)} symbols in ${TLDRAW_SYMBOLS.length} groups.\n`)

out.push('### 7.1 Files that use tldraw → porting owner (generated)\n')
const byOwner = new Map<string, typeof fileRows>()
for (const r of fileRows) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r])
out.push('| Owner | Files (tests) | Files |')
out.push('|---|---|---|')
for (const o of Object.keys(OWNERS)) {
  const rows = byOwner.get(o)
  if (!rows) continue
  out.push(
    `| ${o} | ${rows.length} (${rows.filter((r) => r.test).length}) | ${rows
      .map((r) => `\`${r.file}\``)
      .sort()
      .join(', ')} |`,
  )
}
out.push(
  `\n${fileRows.length} files (${fileRows.filter((r) => r.test).length} tests); ${fileRows.filter((r) => r.owner === '?').length} without an owner.\n`,
)
console.log(out.join('\n'))
