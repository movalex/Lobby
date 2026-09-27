import { createContext, useContext } from 'react'
import type { AssetMetaStore } from '../assets/meta-store.ts'
import type { BoardRole } from '../lib/permissions.ts'

export type NoticeTone = 'info' | 'error'
export interface NoticeInput {
  /** Notices with the same key replace each other (e.g. repeated lease denials for one shape). */
  key: string
  text: string
  tone?: NoticeTone
  testId?: string
  /** null = stays until dismissed or replaced. */
  timeoutMs?: number | null
}

export interface BoardContextValue {
  boardId: string
  userId: string
  /** The caller's role from the latest sync ticket (UI hints only; the servers enforce). */
  role: BoardRole
  metaStore: AssetMetaStore
  notify(n: NoticeInput): void
  dismiss(key: string): void
}

export const BoardContext = createContext<BoardContextValue | null>(null)

/**
 * Null outside a mounted board (e.g. shapes rendered for an SVG export in a separate root): callers
 * must then render from shape props alone and make no network requests.
 */
export const useBoard = () => useContext(BoardContext)
