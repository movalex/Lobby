// OWNER: WS3 (wave Q). The Elements panel (dock panel 'elements', the Shapes panel's place): one search over the three
// sources, the Icons / Shapes / Library tabs (a name-only guest, a workspace guest and a board-only collaborator get
// Icons and Shapes only), Favourites and Recents, the insert options bar (colour, icon size, keep together, lock), and
// the tiles. It is a combobox: the search box keeps the keyboard and the arrows move the active tile (./model.ts
// gridKey); Enter, a click or a tap inserts at the middle of the view, a drag drops at the pointer (./index.tsx's drop
// handler). Library management (edit, move, delete with Undo, folders, Recently deleted) is in the Library tab, for
// what the caller may change. On a phone (below 600 px) the panel is the host's full-width sheet: smaller tiles, the
// options folded behind one button, and the sheet closes after an insert so the new element shows.
import { lobbyColor } from '@draftroom/board-ops/elements'
import {
  ICON_LICENSES_PATH,
  ICON_SET_IDS,
  ICON_SET_NAMES,
  ICON_SIZES,
  INSERT_COLOR_NAMES,
  type IconSetId,
  type InsertColorName,
  type InsertOptions,
  type LibraryFolder,
  type LibraryItemSummary,
  type LibraryScope,
} from '@draftroom/contracts'
import { PIECE_CATEGORIES, type PieceCategory } from '@draftroom/templates/pieces/catalog'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { countUsage } from '../../lib/usage.ts'
import { usePreviews } from '../pieces/PiecesPanel.tsx'
import { deleteLibraryFolder, deleteLibraryItem, restoreLibraryItem } from './client.ts'
import { type IconsState, useElementsAccess, useFolders, useIcons, useLibraryList } from './hooks.ts'
import { importLibraryFile, LIBRARY_FILE_ACCEPT } from './import.ts'
import { insertFailureText, insertTile } from './insert.ts'
import { FolderDialog, ItemDialog, libraryErrorText } from './LibraryDialogs.tsx'
import { marksOf } from './marks.ts'
import {
  countLabel,
  ELEMENT_TABS,
  type ElementTab,
  gridKey,
  ICON_CREDIT,
  otherMatches,
  searchAll,
  type Tile,
  tileKey,
  tileMarkKey,
  tilesOfMarks,
} from './model.ts'
import { loadInsertOptions, saveInsertOptions } from './options.ts'
import { elementsState } from './state.ts'
import { TileMenu, type TileMenuItem } from './TileMenu.tsx'
import { TileView, tileDomId } from './Tiles.tsx'
import './elements.css'

/** Tiles shown at first, and added by "Show more" (thousands of icons are never drawn at once). */
export const PAGE_SIZE = 120
const TAB_KEY = 'lobby.elements.tab'
const PHONE_QUERY = '(max-width: 599px)'

const readTab = (): ElementTab | null => {
  try {
    const v = globalThis.localStorage?.getItem(TAB_KEY)
    return ELEMENT_TABS.some((t) => t.id === v) ? (v as ElementTab) : null
  } catch {
    return null
  }
}
const writeTab = (tab: ElementTab) => {
  try {
    globalThis.localStorage?.setItem(TAB_KEY, tab)
  } catch {
    // a convenience only
  }
}
const matches = (query: string) => {
  try {
    return globalThis.matchMedia?.(query).matches ?? false
  } catch {
    return false
  }
}
const onPhone = () => matches(PHONE_QUERY)

const HINT =
  'Click or press Enter to add to the middle of the view, or drag onto the board. Right-click for more.'
const TOUCH_HINT = 'Tap to add to the middle of the view. Press and hold for more.'

const COLOR_LABEL = (c: InsertColorName) => {
  const w = c.replace('-', ' ')
  return w.charAt(0).toUpperCase() + w.slice(1)
}

interface Section {
  readonly id: 'favourites' | 'recents' | 'results'
  readonly title: string | null
  readonly tiles: readonly Tile[]
}

export function ElementsPanel({ ctx, close }: { readonly ctx: CanvasFeatureContext; close(): void }) {
  const base = useId().replace(/:/g, '')
  const page = elementsState(ctx.canvas)
  const access = useElementsAccess(ctx)
  const workspaceId = ctx.workspace.id
  const tabs: readonly ElementTab[] = access.library ? ['icons', 'shapes', 'library'] : ['icons', 'shapes']
  const requested = useValue(page.requestedTab)
  const [tab, setTabState] = useState<ElementTab>(() => page.requestedTab.get() ?? readTab() ?? 'icons')
  const shownTab: ElementTab = tabs.includes(tab) ? tab : 'icons'
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [iconSet, setIconSet] = useState<IconSetId | 'all'>('all')
  const [iconCategory, setIconCategory] = useState<string | null>(null)
  const [shapeCategory, setShapeCategory] = useState<PieceCategory | 'all'>('all')
  const [scope, setScope] = useState<LibraryScope>('workspace')
  const [folder, setFolder] = useState('all')
  const [options, setOptionsState] = useState<InsertOptions>(loadInsertOptions)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [colorsOpen, setColorsOpen] = useState(false)
  const [menu, setMenu] = useState<{ tile: Tile; at: { x: number; y: number } } | null>(null)
  const [editing, setEditing] = useState<LibraryItemSummary | null>(null)
  const [folderDialog, setFolderDialog] = useState<{ folder: LibraryFolder | null } | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const readonly = ctx.canvas.readOnly()

  const icons = useIcons()
  const previews = usePreviews()
  const version = useValue(page.libraryVersion)
  const lib = useLibraryList(workspaceId, { scope, folder, enabled: access.library, version })
  const folders = useFolders(workspaceId, scope, access.library, version)
  const marks = useMemo(() => marksOf(workspaceId, () => access.library), [workspaceId, access.library])
  const markState = useValue(marks.state)
  const deletedView = shownTab === 'library' && folder === 'deleted'

  useEffect(() => {
    void marks.load()
  }, [marks])
  useEffect(() => {
    search.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (!requested) return
    setTabState(requested)
    page.requestedTab.set(null)
  }, [requested, page])

  const setTab = (t: ElementTab) => {
    setTabState(t)
    setActive(0)
    setLimit(PAGE_SIZE)
    setMenu(null)
    writeTab(t)
  }
  const setOptions = (o: Partial<InsertOptions>) => {
    const next = { ...options, ...o }
    setOptionsState(next)
    saveInsertOptions(next)
  }
  const bump = () => page.libraryVersion.update((v) => v + 1)

  const results = useMemo(
    () =>
      searchAll({
        query,
        icons: icons.status === 'ready' ? { api: icons.api, index: icons.index } : null,
        iconSet,
        iconCategory,
        shapeCategory,
        items: deletedView ? lib.items : lib.items.filter((i) => !i.deletedAt),
      }),
    [query, icons, iconSet, iconCategory, shapeCategory, lib.items, deletedView],
  )
  // the icon categories of the chosen set (Tabler's; Lucide has none)
  const iconCategories = useMemo(
    () =>
      icons.status === 'ready' ? icons.api.categories(icons.index, iconSet === 'all' ? null : iconSet) : [],
    [icons, iconSet],
  )
  const itemsById = useMemo(() => new Map(lib.items.map((i) => [i.id, i])), [lib.items])
  const iconIndex = icons.status === 'ready' ? icons.index : null
  const lookup = useMemo(
    () => ({ index: iconIndex, items: itemsById, library: access.library }),
    [iconIndex, itemsById, access.library],
  )
  const source = shownTab === 'icons' ? 'icon' : shownTab === 'shapes' ? 'piece' : 'item'
  const ofTab = (list: readonly Tile[]) => list.filter((t) => t.source === source)
  const sections: Section[] = []
  if (!query && !deletedView) {
    const favourites = ofTab(tilesOfMarks(markState.favourites, lookup)).slice(0, 12)
    const recents = ofTab(tilesOfMarks(markState.recents, lookup))
    if (favourites.length) sections.push({ id: 'favourites', title: 'Favourites', tiles: favourites })
    if (recents.length) sections.push({ id: 'recents', title: 'Recent', tiles: recents })
  }
  const all = results[shownTab]
  const shown = all.slice(0, limit)
  sections.push({ id: 'results', title: sections.length ? 'All' : null, tiles: shown })
  const flat = sections.flatMap((s) => s.tiles.map((t) => ({ section: s.id, tile: t })))
  const at = flat.length ? Math.min(active, flat.length - 1) : 0
  const current = flat[at]
  const currentId = current ? tileDomId(base, current.section, current.tile) : undefined

  // the active tile scrolls into view as the arrows move it
  useEffect(() => {
    if (currentId) document.getElementById(currentId)?.scrollIntoView?.({ block: 'nearest' })
  }, [currentId])

  const columns = () => {
    const el = grid.current?.querySelector('.dr-el-grid')
    if (!el) return 1
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
    return Math.max(1, cols)
  }

  const notifyFailure = (text: string) =>
    ctx.notify({ key: 'elements-insert', tone: 'error', text, testId: 'element-insert-failed' })

  const insert = async (t: Tile) => {
    if (readonly) return
    if (t.source === 'item' && t.item.deletedAt) {
      try {
        await restoreLibraryItem(workspaceId, t.id)
        ctx.notify({ key: 'elements-library', text: `Restored “${t.label}”.`, testId: 'element-restored' })
        bump()
      } catch (e) {
        notifyFailure(libraryErrorText(e))
      }
      return
    }
    const r = await insertTile(ctx, { source: t.source, id: t.id }, {
      options,
      icons: icons.status === 'ready' ? icons.api : undefined,
    })
    if (!r.ok) {
      notifyFailure(insertFailureText(r.reason))
      return
    }
    marks.used(r.markKey, t.source !== 'item')
    // on a phone the sheet covers the board: it closes so the new element shows
    if (onPhone()) close()
    else ctx.canvas.focus({ preventScroll: true })
  }

  const importFile = async (file: File) => {
    setImporting(true)
    const folderId = folder === 'all' || folder === 'none' || folder === 'deleted' ? null : folder
    const r = await importLibraryFile(workspaceId, file, { scope, folderId })
    setImporting(false)
    if (!r.ok) {
      ctx.notify({ key: 'elements-library', tone: 'error', text: r.text, testId: 'element-import-failed' })
      return
    }
    ctx.notify({ key: 'elements-library', text: r.text, testId: 'element-imported' })
    bump()
  }

  const star = async (t: Tile, on: boolean) => {
    const ok = await marks.setFavourite(tileMarkKey(t), on)
    if (ok && on) countUsage('elements.favourite')
    if (!ok) notifyFailure('The favourite could not be saved. Try again.')
  }

  const remove = async (item: LibraryItemSummary) => {
    try {
      await deleteLibraryItem(workspaceId, item.id)
      bump()
      ctx.notify({
        key: 'elements-library',
        text: `Deleted “${item.name}”. Copies already on boards stay.`,
        testId: 'element-deleted',
        timeoutMs: 8000,
        action: {
          label: 'Undo',
          testId: 'element-deleted-undo',
          onClick: () => {
            void restoreLibraryItem(workspaceId, item.id).then(bump, (e) =>
              notifyFailure(libraryErrorText(e)),
            )
          },
        },
      })
    } catch (e) {
      notifyFailure(libraryErrorText(e))
    }
  }

  const menuItems = (t: Tile): TileMenuItem[] => {
    const out: TileMenuItem[] = []
    const deleted = t.source === 'item' && !!t.item.deletedAt
    out.push({ id: 'insert', label: deleted ? 'Restore' : 'Add to board', run: () => void insert(t) })
    if (access.library && !deleted) {
      const fav = markState.favourites.includes(tileMarkKey(t))
      out.push({
        id: 'favourite',
        label: fav ? 'Remove from favourites' : 'Add to favourites',
        run: () => void star(t, !fav),
      })
    }
    if (t.source === 'item' && t.item.canEdit && !deleted) {
      out.push({ id: 'edit', label: 'Edit details…', run: () => setEditing(t.item) })
      out.push({ id: 'delete', label: 'Delete', tone: 'danger', run: () => void remove(t.item) })
    }
    return out
  }

  const openActions = (t: Tile, point?: { x: number; y: number }) => {
    let p = point
    if (!p) {
      const el = document.getElementById(tileDomId(base, current?.section ?? 'results', t))
      const r = el?.getBoundingClientRect()
      p = r ? { x: r.left + 8, y: r.bottom + 4 } : { x: 80, y: 120 }
    }
    setMenu({ tile: t, at: p })
  }

  const onKeys = (e: KeyboardEvent, inSearch: boolean) => {
    if (e.nativeEvent.isComposing) return
    const r = gridKey(e.key, {
      active: at,
      sections: sections.map((s) => s.tiles.length),
      columns: columns(),
      query,
      inSearch,
      shift: e.shiftKey,
    })
    if (!r.handled) return
    e.preventDefault()
    e.stopPropagation()
    if (r.close) return close()
    if (r.clear) {
      setQuery('')
      setActive(0)
      return
    }
    setActive(r.active)
    const t = flat[r.active]?.tile
    if (r.insert && t) void insert(t)
    if (r.actions && t) openActions(t)
  }

  const iconInk = options.color ? lobbyColor(options.color).solid : null
  const others = query ? otherMatches(results, shownTab, tabs) : []
  const canManageFolders = scope === 'personal' || access.workspaceSave
  const selectedFolder = folders.find((f) => f.id === folder) ?? null
  const placeholder = access.library ? 'Search icons, shapes and the library' : 'Search icons and shapes'

  return (
    <div className="dr-el" data-testid="elements-panel" data-tab={shownTab}>
      <label className="dr-el__search">
        <span className="dr-sr-only">{placeholder}</span>
        <input
          ref={search}
          type="search"
          className="dr-input"
          placeholder={placeholder}
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={`${base}-grid`}
          aria-autocomplete="list"
          aria-activedescendant={currentId}
          value={query}
          data-testid="element-search"
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            setLimit(PAGE_SIZE)
          }}
          onKeyDown={(e) => onKeys(e, true)}
        />
      </label>

      <div className="dr-el__tabs" role="tablist" aria-label="Element sources">
        {ELEMENT_TABS.filter((t) => tabs.includes(t.id)).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={shownTab === t.id}
            aria-controls={`${base}-grid`}
            tabIndex={shownTab === t.id ? 0 : -1}
            className="dr-el__tab"
            data-testid="element-tab"
            data-tab={t.id}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const list = ELEMENT_TABS.filter((x) => tabs.includes(x.id))
              const i = list.findIndex((x) => x.id === shownTab)
              const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]
              if (!next) return
              setTab(next.id)
              document.getElementById(`${base}-tab-${next.id}`)?.focus()
            }}
          >
            {t.label}
            {query && <span className="dr-el__count">{countLabel(results[t.id].length)}</span>}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="dr-el__options-toggle"
        aria-expanded={optionsOpen}
        aria-controls={`${base}-options`}
        data-testid="element-options-toggle"
        onClick={() => setOptionsOpen((v) => !v)}
      >
        Options
      </button>
      <div
        className="dr-el__options"
        id={`${base}-options`}
        role="group"
        aria-label="Insert options"
        data-open={optionsOpen || undefined}
        data-testid="element-options"
      >
        {shownTab !== 'library' && (
          <div className="dr-el__opt">
            <button
              type="button"
              className="dr-el__swatch-btn"
              aria-expanded={colorsOpen}
              aria-controls={`${base}-colors`}
              data-testid="element-color"
              data-color={options.color ?? 'default'}
              onClick={() => setColorsOpen((v) => !v)}
            >
              <span
                className="dr-el__swatch"
                style={options.color ? { background: lobbyColor(options.color).solid } : undefined}
                data-default={options.color ? undefined : true}
              />
              <span>Colour: {options.color ? COLOR_LABEL(options.color) : 'Default'}</span>
            </button>
          </div>
        )}
        {shownTab === 'icons' && (
          <fieldset className="dr-el__opt dr-el__sizes">
            <legend className="dr-sr-only">Icon size</legend>
            {ICON_SIZES.map((s) => (
              <button
                key={s}
                type="button"
                className="dr-el__size"
                aria-pressed={options.size === s}
                aria-label={`Size ${s === 'S' ? 'small' : s === 'M' ? 'medium' : 'large'}`}
                data-testid="element-size"
                data-size={s}
                onClick={() => setOptions({ size: s })}
              >
                {s}
              </button>
            ))}
          </fieldset>
        )}
        {shownTab === 'library' && (
          <label className="dr-el__check">
            <input
              type="checkbox"
              checked={options.keepTogether}
              data-testid="element-keep-together"
              onChange={(e) => setOptions({ keepTogether: e.target.checked })}
            />
            Keep together
          </label>
        )}
        <label className="dr-el__check">
          <input
            type="checkbox"
            checked={options.lock}
            data-testid="element-lock"
            onChange={(e) => setOptions({ lock: e.target.checked })}
          />
          Lock
        </label>
        {colorsOpen && shownTab !== 'library' && (
          <div className="dr-el__colors" id={`${base}-colors`} role="radiogroup" aria-label="Colour">
            {[null, ...INSERT_COLOR_NAMES].map((c) => (
              <button
                key={c ?? 'default'}
                type="button"
                role="radio"
                aria-checked={options.color === c}
                aria-label={c ? COLOR_LABEL(c) : 'Default colour'}
                title={c ? COLOR_LABEL(c) : 'Default colour'}
                className="dr-el__swatch-pick"
                data-testid="element-color-pick"
                data-color={c ?? 'default'}
                onClick={() => {
                  setOptions({ color: c })
                  setColorsOpen(false)
                }}
              >
                <span
                  className="dr-el__swatch"
                  style={c ? { background: lobbyColor(c).solid } : undefined}
                  data-default={c ? undefined : true}
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {shownTab === 'icons' && icons.status === 'ready' && (
        <fieldset className="dr-el__chips">
          <legend className="dr-sr-only">Icon sets</legend>
          {(['all', ...ICON_SET_IDS] as const).map((s) => (
            <button
              key={s}
              type="button"
              className="dr-el__chip"
              aria-pressed={iconSet === s}
              data-testid="element-chip"
              data-chip={s}
              onClick={() => {
                setIconSet(s)
                setIconCategory(null)
                setActive(0)
                setLimit(PAGE_SIZE)
              }}
            >
              {s === 'all' ? 'All' : ICON_SET_NAMES[s]}
            </button>
          ))}
          {iconCategories.length > 0 && (
            <label className="dr-el__category">
              <span className="dr-sr-only">Icon category</span>
              <select
                className="dr-input dr-select dr-select--compact"
                value={iconCategory ?? ''}
                data-testid="element-icon-category"
                onChange={(e) => {
                  setIconCategory(e.target.value || null)
                  setActive(0)
                  setLimit(PAGE_SIZE)
                }}
              >
                <option value="">All categories</option>
                {iconCategories.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.count})
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
      )}
      {shownTab === 'shapes' && (
        <fieldset className="dr-el__chips">
          <legend className="dr-sr-only">Shape categories</legend>
          {[{ id: 'all' as const, label: 'All' }, ...PIECE_CATEGORIES].map((c) => (
            <button
              key={c.id}
              type="button"
              className="dr-el__chip"
              aria-pressed={shapeCategory === c.id}
              data-testid="element-chip"
              data-chip={c.id}
              onClick={() => {
                setShapeCategory(c.id)
                setActive(0)
              }}
            >
              {c.label}
            </button>
          ))}
        </fieldset>
      )}
      {shownTab === 'library' && (
        <div className="dr-el__libbar">
          <fieldset className="dr-el__scope">
            <legend className="dr-sr-only">Library</legend>
            {(['workspace', 'personal'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className="dr-el__chip"
                aria-pressed={scope === s}
                data-testid="element-scope"
                data-scope={s}
                onClick={() => {
                  setScope(s)
                  setFolder('all')
                  setActive(0)
                }}
              >
                {s === 'workspace' ? 'Workspace' : 'Mine'}
              </button>
            ))}
          </fieldset>
          <label className="dr-el__folder">
            <span className="dr-sr-only">Folder</span>
            <select
              className="dr-input dr-select dr-select--compact"
              value={folder}
              data-testid="element-folder"
              onChange={(e) => {
                setFolder(e.target.value)
                setActive(0)
              }}
            >
              <option value="all">All items</option>
              <option value="none">Not in a folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
              <option value="deleted">Recently deleted</option>
            </select>
          </label>
          {canManageFolders && (
            <input
              ref={importInput}
              type="file"
              accept={LIBRARY_FILE_ACCEPT}
              hidden
              data-testid="element-import-input"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void importFile(file)
              }}
            />
          )}
          {canManageFolders && (
            <FolderActions
              folder={selectedFolder}
              importing={importing}
              onImport={() => importInput.current?.click()}
              onNew={() => setFolderDialog({ folder: null })}
              onRename={(f) => setFolderDialog({ folder: f })}
              onDelete={(f) => {
                void deleteLibraryFolder(workspaceId, f.id).then(
                  () => {
                    setFolder('all')
                    bump()
                    ctx.notify({
                      key: 'elements-library',
                      text: `Deleted the folder “${f.name}”. Its items are still in the library.`,
                      testId: 'element-folder-deleted',
                    })
                  },
                  (e) => notifyFailure(libraryErrorText(e)),
                )
              }}
            />
          )}
        </div>
      )}

      {readonly && <p className="dr-el__note">You can view this board but not add to it.</p>}

      <div ref={grid} className="dr-el__results">
        <div
          className="dr-el__listbox"
          id={`${base}-grid`}
          role="listbox"
          aria-label={ELEMENT_TABS.find((t) => t.id === shownTab)?.label}
          aria-activedescendant={currentId}
          tabIndex={0}
          data-testid="element-grid"
          onKeyDown={(e) => onKeys(e, false)}
        >
          {sections.map((s) =>
            s.tiles.length === 0 ? null : (
              <div key={s.id} role="group" aria-label={s.title ?? 'Results'} className="dr-el__section">
                {s.title && (
                  <div className="dr-el__section-title" aria-hidden="true">
                    {s.title}
                  </div>
                )}
                <div className="dr-el-grid" data-section={s.id} data-testid={`element-section-${s.id}`}>
                  {s.tiles.map((t) => {
                    const domId = tileDomId(base, s.id, t)
                    return (
                      <TileView
                        key={tileKey(t)}
                        tile={t}
                        domId={domId}
                        active={domId === currentId}
                        disabled={readonly}
                        favourite={access.library ? markState.favourites.includes(tileMarkKey(t)) : null}
                        icons={icons}
                        previews={previews}
                        workspaceId={workspaceId}
                        iconInk={iconInk}
                        deleted={t.source === 'item' && !!t.item.deletedAt}
                        onPick={(x) => void insert(x)}
                        onPoint={() => setActive(flat.findIndex((f) => f.section === s.id && f.tile === t))}
                        onStar={(x, on) => void star(x, on)}
                        onActions={(x, p) => openActions(x, p)}
                      />
                    )
                  })}
                </div>
              </div>
            ),
          )}
        </div>
        <EmptyState
          tab={shownTab}
          icons={icons}
          count={all.length}
          query={query}
          loading={shownTab === 'library' && lib.loading}
          deletedView={deletedView}
          others={others}
          onTab={setTab}
        />
        {(all.length > shown.length || (shownTab === 'library' && lib.more)) && (
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-el__more"
            data-testid="element-more"
            onClick={() => {
              if (all.length > shown.length) setLimit((l) => l + PAGE_SIZE)
              else lib.more?.()
            }}
          >
            Show more
          </button>
        )}
      </div>

      <p className="dr-el__hint" aria-live="polite">
        {flat.length ? (matches('(pointer: coarse)') ? TOUCH_HINT : HINT) : ''}
      </p>
      {shownTab === 'icons' && icons.status === 'ready' && (
        <p className="dr-el__credit">
          <a href={ICON_LICENSES_PATH} target="_blank" rel="noopener noreferrer" data-testid="element-credit">
            {ICON_CREDIT}
          </a>
        </p>
      )}

      {menu && (
        <TileMenu
          label={`${menu.tile.label} actions`}
          at={menu.at}
          items={menuItems(menu.tile)}
          onClose={(refocus) => {
            setMenu(null)
            if (refocus) search.current?.focus({ preventScroll: true })
          }}
        />
      )}
      {editing && (
        <ItemDialog
          workspaceId={workspaceId}
          item={editing}
          folders={folders}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            bump()
          }}
        />
      )}
      {folderDialog && (
        <FolderDialog
          workspaceId={workspaceId}
          scope={scope}
          folder={folderDialog.folder}
          onClose={() => setFolderDialog(null)}
          onSaved={(f) => {
            setFolderDialog(null)
            setFolder(f.id)
            bump()
          }}
        />
      )}
    </div>
  )
}

function FolderActions({
  folder,
  importing,
  onImport,
  onNew,
  onRename,
  onDelete,
}: {
  folder: LibraryFolder | null
  importing: boolean
  onImport(): void
  onNew(): void
  onRename(f: LibraryFolder): void
  onDelete(f: LibraryFolder): void
}) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const items: TileMenuItem[] = [{ id: 'new', label: 'New folder…', run: onNew }]
  if (folder?.canEdit) {
    items.push({ id: 'rename', label: 'Rename folder…', run: () => onRename(folder) })
    items.push({ id: 'delete', label: 'Delete folder', tone: 'danger', run: () => onDelete(folder) })
  }
  if (!importing)
    items.push({ id: 'import', label: 'Import a library file (.excalidrawlib)…', run: onImport })
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="dr-el__folder-btn"
        aria-label="Folder and import actions"
        title="Folders and import"
        aria-busy={importing || undefined}
        aria-haspopup="menu"
        aria-expanded={!!open}
        data-testid="element-folder-actions"
        onClick={() => {
          const r = ref.current?.getBoundingClientRect()
          setOpen(open ? null : { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 })
        }}
      >
        <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" focusable="false">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <TileMenu
          label="Folder and import actions"
          at={open}
          items={items}
          onClose={(refocus) => {
            setOpen(null)
            if (refocus) ref.current?.focus()
          }}
        />
      )}
    </>
  )
}

const NOUN: Record<ElementTab, string> = { icons: 'icons', shapes: 'shapes', library: 'library items' }

function EmptyState({
  tab,
  icons,
  count,
  query,
  loading,
  deletedView,
  others,
  onTab,
}: {
  tab: ElementTab
  icons: IconsState
  count: number
  query: string
  loading: boolean
  deletedView: boolean
  others: readonly { tab: ElementTab; count: number }[]
  onTab(t: ElementTab): void
}) {
  if (count > 0) return null
  let text: string
  if (tab === 'icons' && icons.status === 'loading') text = 'Loading icons…'
  else if (tab === 'icons' && icons.status === 'none') text = 'Icons aren’t available on this Lobby yet.'
  else if (loading) text = 'Loading the library…'
  else if (query) text = `No ${NOUN[tab]} match.`
  else if (deletedView) text = 'Nothing was deleted in the last 30 days.'
  else if (tab === 'library')
    text = 'Nothing here yet. Select something on the board and choose Save to library.'
  else text = 'Nothing here.'
  const label = (t: ElementTab) => ELEMENT_TABS.find((x) => x.id === t)?.label.toLowerCase() ?? t
  return (
    <div className="dr-el__empty" data-testid="element-empty">
      <p>{text}</p>
      {others.map((o) => (
        <button
          key={o.tab}
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="element-other-tab"
          data-tab={o.tab}
          onClick={() => onTab(o.tab)}
        >
          Show {countLabel(o.count)} in {label(o.tab)}
        </button>
      ))}
    </div>
  )
}
