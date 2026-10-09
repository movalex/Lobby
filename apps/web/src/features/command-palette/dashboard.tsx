// OWNER: W3 (wave L, L3-2). The command palette on the dashboard (Ctrl/Cmd+K there too): this workspace's
// boards, the dashboard's lists and the other workspaces, "New board from template" for creators (the
// "Start something" row's own path: the same templates, the same create, the api's creator rule either way),
// and the workspace search (the server's, permission-filtered). A lazy chunk: the dashboard fetches it the
// first time someone presses Ctrl/Cmd+K, and the board list it shows is fetched then too.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client.ts'
import { dashboardApi } from '../../dashboard/dashboard-api.ts'
import type { StartTile } from '../../dashboard/start-row-model.ts'
import { boardPath, type DashboardSection, navigate, workspacePath } from '../../lib/routing.ts'
import { type PaletteEntry, pushRecent, readRecents } from './model.ts'
import { Palette } from './Palette.tsx'
import { workspaceSearch } from './workspace-search.ts'

const dash = dashboardApi(api)

export interface DashboardPaletteProps {
  readonly workspaceId: string
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  /** the signed-in person (recents are theirs, in this browser) */
  readonly viewer: string
  /** creators who may make boards here (the api decides again) */
  readonly canCreate: boolean
  /** a name-only guest: no lists beyond their boards, no other workspace */
  readonly guest: boolean
  /** the "Start something" tiles (blank and the templates) */
  readonly tiles: readonly StartTile[]
  /** the row's own path: makes the board and opens it */
  onStart(tile: StartTile): void
  /** the full template picker (New board) */
  onBrowseTemplates(): void
  onClose(): void
}

const SECTIONS: readonly {
  readonly section: DashboardSection
  readonly label: string
  readonly keywords: string[]
}[] = [
  { section: { kind: 'recent' }, label: 'Recent boards', keywords: ['home', 'dashboard'] },
  { section: { kind: 'all' }, label: 'All boards', keywords: ['every board'] },
  { section: { kind: 'archived' }, label: 'Archived boards', keywords: ['archive'] },
  { section: { kind: 'trash' }, label: 'Trash', keywords: ['deleted', 'bin'] },
]

export default function DashboardPalette(props: DashboardPaletteProps) {
  const { workspaceId, viewer } = props
  const [boards, setBoards] = useState<readonly { id: string; title: string }[]>([])
  useEffect(() => {
    const ctl = new AbortController()
    dash.listBoards(workspaceId, { status: 'active' }, ctl.signal).then(
      (list) => setBoards(list.map((b) => ({ id: b.id, title: b.title }))),
      () => {
        // the list stays empty; the workspace search still finds boards by their words
      },
    )
    return () => ctl.abort()
  }, [workspaceId])

  const entries = useMemo((): PaletteEntry[] => {
    const out: PaletteEntry[] = boards.map((b) => ({
      id: `board:${b.id}`,
      label: b.title || 'Untitled board',
      group: 'Boards',
      keywords: ['board', 'open'],
      recentKey: `board:${b.id}`,
      run: () => navigate(boardPath(b.id)),
    }))
    if (!props.guest) {
      for (const s of SECTIONS)
        out.push({
          id: `section:${s.section.kind}`,
          label: s.label,
          group: 'Go to',
          keywords: s.keywords,
          run: () => navigate(workspacePath(workspaceId, s.section)),
        })
      for (const w of props.workspaces) {
        if (w.id === workspaceId) continue
        out.push({
          id: `workspace:${w.id}`,
          label: `Workspace: ${w.name}`,
          group: 'Go to',
          keywords: ['workspace', 'switch'],
          recentKey: `workspace:${w.id}`,
          run: () => navigate(workspacePath(w.id)),
        })
      }
    }
    if (props.canCreate) {
      for (const t of props.tiles)
        out.push({
          id: `new:${t.choice}`,
          label: t.choice === 'blank' ? 'New blank board' : `New board from template: ${t.name}`,
          group: 'New board',
          keywords: ['new', 'create', 'template', t.name],
          recentKey: `new:${t.choice}`,
          run: () => props.onStart(t),
        })
      out.push({
        id: 'new:browse',
        label: 'New board: browse all templates…',
        group: 'New board',
        keywords: ['new', 'create', 'template', 'picker'],
        run: () => props.onBrowseTemplates(),
      })
    }
    return out
  }, [boards, props, workspaceId])
  const recents = useMemo(() => readRecents(viewer), [viewer])
  const searches = useMemo(() => [workspaceSearch(api, workspaceId, null)], [workspaceId])

  return (
    <Palette
      label="Command palette"
      placeholder="Find a board, a list, or words inside boards…"
      entries={entries}
      searches={searches}
      recents={recents}
      onChoose={(entry) => {
        if (entry.recentKey) pushRecent(viewer, entry.recentKey)
        props.onClose()
        setTimeout(() => entry.run(), 0)
      }}
      onClose={props.onClose}
    />
  )
}
