// OWNER: WS3 (wave Q). The Elements panel's tiles: one option of the panel's listbox each, with its drawing (loaded once
// it scrolls into view), its name, and a star for a favourite. A click, Enter or a tap inserts it; dragging it onto the
// board drops it at the pointer (text/plain `lobby-element:<source>:<id>`); a right-click, the context-menu key or
// Shift+F10 opens its actions. The star is a mouse shortcut of the "Add to favourites" action (hidden from screen
// readers, who get the action and the option's own "favourite" in its name).
import { FILE_ID_PATTERN, pdfPageOf, versionIdOf } from '@draftroom/canvas-schema/limits'
import { libraryThumbPath } from '@draftroom/contracts'
import { type MouseEvent, memo, type ReactNode, useRef } from 'react'
import type { Previews } from '../pieces/PiecesPanel.tsx'
import { PiecePreview } from '../pieces/Preview.tsx'
import { type IconsState, useIconGeometry, useItemElements, useSeen } from './hooks.ts'
import { type Tile, tileDrag, tileKey } from './model.ts'
import { IconGlyph, ItemPreview } from './Previews.tsx'

export const tileDomId = (base: string, section: string, t: Tile) =>
  `${base}-${section}-${tileKey(t).replace(/[^A-Za-z0-9_-]/g, '_')}`

function IconArt({
  tile,
  icons,
  color,
}: {
  tile: Tile & { source: 'icon' }
  icons: IconsState
  color: string | null
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useSeen(ref)
  const geometry = useIconGeometry(icons, tile.set, tile.name, seen)
  return (
    <span ref={ref} className="dr-el-tile__art dr-el-tile__art--icon" data-icon-preview={tile.id}>
      <IconGlyph geometry={geometry} color={color} />
    </span>
  )
}

/**
 * Where an item tile loads the image of `fileId`: its version's thumb, or for a placed PDF page (`ver_….p<n>`) that
 * page's rendering; null (the placeholder) for anything that is not a Lobby file id.
 */
export const itemThumb =
  (workspaceId: string, itemId: string) =>
  (fileId: string): string | null => {
    if (!FILE_ID_PATTERN.test(fileId)) return null
    return libraryThumbPath(workspaceId, itemId, versionIdOf(fileId), pdfPageOf(fileId) ?? undefined)
  }

function ItemArt({ tile, workspaceId }: { tile: Tile & { source: 'item' }; workspaceId: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useSeen(ref)
  const elements = useItemElements(workspaceId, tile.item, seen)
  return (
    <span ref={ref} className="dr-el-tile__art">
      <ItemPreview
        id={tile.id}
        elements={elements}
        width={tile.item.width}
        height={tile.item.height}
        thumb={itemThumb(workspaceId, tile.id)}
      />
    </span>
  )
}

export interface TileProps {
  readonly tile: Tile
  readonly domId: string
  readonly active: boolean
  readonly disabled: boolean
  readonly favourite: boolean | null
  readonly icons: IconsState
  readonly previews: Previews | undefined
  readonly workspaceId: string
  /** the chosen colour's ink, for icon drawings (null: the theme's) */
  readonly iconInk: string | null
  /** a library item in "Recently deleted": a click restores it */
  readonly deleted?: boolean
  onPick(t: Tile): void
  onPoint(): void
  onStar(t: Tile, on: boolean): void
  onActions(t: Tile, at: { x: number; y: number }): void
}

export const TileView = memo(function TileView(p: TileProps) {
  const { tile } = p
  let art: ReactNode
  if (tile.source === 'icon') art = <IconArt tile={tile} icons={p.icons} color={p.iconInk} />
  else if (tile.source === 'piece')
    art = (
      <span className="dr-el-tile__art">
        <PiecePreview info={tile.info} elements={p.previews?.get(tile.info.id)} />
      </span>
    )
  else art = <ItemArt tile={tile} workspaceId={p.workspaceId} />
  const name = p.deleted ? `Restore ${tile.label}` : tile.label
  const star = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    p.onStar(tile, !p.favourite)
  }
  return (
    <div
      id={p.domId}
      role="option"
      tabIndex={-1}
      aria-selected={p.active}
      aria-disabled={p.disabled || undefined}
      aria-label={p.favourite ? `${name}, favourite` : name}
      title={tile.label}
      className={`dr-el-tile dr-el-tile--${tile.source}`}
      data-testid="element-tile"
      data-source={tile.source}
      data-tile-id={tile.id}
      data-active={p.active || undefined}
      draggable={!p.disabled && !p.deleted}
      onClick={() => !p.disabled && p.onPick(tile)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        if (!p.disabled) p.onPick(tile)
      }}
      onMouseMove={() => !p.active && p.onPoint()}
      onContextMenu={(e) => {
        e.preventDefault()
        p.onActions(tile, { x: e.clientX, y: e.clientY })
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', tileDrag(tile))
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      {art}
      <span className="dr-el-tile__name">{tile.label}</span>
      {p.favourite !== null && !p.deleted && (
        <span
          className="dr-el-tile__star"
          aria-hidden="true"
          data-on={p.favourite || undefined}
          data-testid="element-star"
          onClick={star}
          onKeyDown={() => undefined}
        >
          <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true" focusable="false">
            <path d="M12 3.2l2.7 5.5 6 .9-4.4 4.3 1 6-5.3-2.9-5.3 2.9 1-6-4.4-4.3 6-.9z" />
          </svg>
        </span>
      )}
    </div>
  )
})
