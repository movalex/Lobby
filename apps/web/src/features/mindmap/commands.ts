// The mind-map commands behind every entry point (toolbar, context menu, the topic bar, keys): each
// resolves the selection, calls the runtime and hands a new topic to the key queue, so a mouse click
// on "Add child" leaves the keyboard exactly where Tab would.

import type { Editor, TLShapeId } from 'tldraw'
import { downloadBlob } from '../present-export/download.ts'
import { exportFilename } from '../present-export/filename.ts'
import { guardExport } from '../sharing/export-policy.ts'
import { getKeyboard, getMindmapCtx, getRuntime } from './bridge.ts'
import type { EditorMode } from './keyboard.ts'
import { outlineCsv, outlineMarkdown } from './outline.ts'

/** The one selected topic, if exactly one topic is selected. */
export function selectedTopic(editor: Editor): TLShapeId | null {
  const rt = getRuntime(editor)
  const only = editor.getOnlySelectedShape()
  return rt && only && rt.isTopic(only.id) ? only.id : null
}

/** The map (its central topic) of the selection, if every selected topic belongs to one map. */
export function selectedMapRoot(editor: Editor): TLShapeId | null {
  const rt = getRuntime(editor)
  if (!rt) return null
  let root: string | null = null
  for (const id of editor.getSelectedShapeIds()) {
    const r = rt.index.rootOf(id) ?? rt.index.edges.get(id)?.rootId ?? null
    if (!r) continue
    if (root && r !== root) return null
    root = r
  }
  return root as TLShapeId | null
}

/** The single selected shape that "Start a mind map" would turn into a central topic. */
export function startableSelection(editor: Editor): TLShapeId | null {
  const rt = getRuntime(editor)
  const only = editor.getOnlySelectedShape()
  return rt?.canStartFrom(only) ? (only?.id ?? null) : null
}

const expect = (editor: Editor, id: TLShapeId | null, mode: EditorMode = 'fresh') => {
  if (id) getKeyboard(editor)?.expectEditor(id, mode)
  return id
}

/**
 * The toolbar's "Mind map": always a new map, its central topic in the free space nearest the view's
 * centre, ready for typing (the placeholder "Central topic" goes with the first key).
 */
export function newMindmap(editor: Editor): TLShapeId | null {
  const rt = getRuntime(editor)
  if (!rt || editor.getIsReadonly()) return null
  return expect(editor, rt.createMap(), 'placeholder')
}

/**
 * "Start a mind map" (Alt+Shift+M, context menu): the selected note/text/shape becomes the central
 * topic of a new map with a first branch to type in; with nothing (or nothing suitable) selected, a new
 * map as from the toolbar. Returns the topic now being typed in.
 */
export function startMindmap(editor: Editor): TLShapeId | null {
  const rt = getRuntime(editor)
  if (!rt || editor.getIsReadonly()) return null
  const from = startableSelection(editor)
  if (from) return expect(editor, rt.startFrom(from))
  if (selectedMapRoot(editor)) {
    notify(editor, 'This is already part of a mind map: press Tab to add a topic.')
    return null
  }
  return expect(editor, rt.createMap(), 'placeholder')
}

export function addChildTopic(editor: Editor, side?: 'left' | 'right'): TLShapeId | null {
  const rt = getRuntime(editor)
  const id = selectedTopic(editor)
  return rt && id ? expect(editor, rt.addChild(id, { side })) : null
}

export function addSiblingTopic(editor: Editor): TLShapeId | null {
  const rt = getRuntime(editor)
  const id = selectedTopic(editor)
  return rt && id ? expect(editor, rt.addSibling(id)) : null
}

export function promoteTopic(editor: Editor): boolean {
  const rt = getRuntime(editor)
  const id = selectedTopic(editor)
  return !!rt && !!id && rt.promote(id)
}

export function toggleTopicCollapsed(editor: Editor, id?: TLShapeId): boolean {
  const rt = getRuntime(editor)
  const target = id ?? selectedTopic(editor)
  return !!rt && !!target && rt.toggleCollapsed(target)
}

export function tidyMindmap(editor: Editor): boolean {
  const rt = getRuntime(editor)
  const root = selectedMapRoot(editor)
  return !!rt && !!root && rt.tidy(root)
}

// ---- outline export -------------------------------------------------------------------------------

export interface Outline {
  markdown: string
  csv: string
  /** The central topic's text (for file names). */
  title: string
  topics: number
}

export function outlineOf(editor: Editor, anyTopicId?: TLShapeId | null): Outline | null {
  const rt = getRuntime(editor)
  const root = anyTopicId ? rt?.index.rootOf(anyTopicId) : selectedMapRoot(editor)
  const tree = rt && root ? rt.readTree(root) : null
  if (!rt || !tree) return null
  const text = (id: string) => rt.textOf(id)
  return {
    markdown: outlineMarkdown(tree, text),
    csv: outlineCsv(tree, text),
    title: text(tree.rootId).replace(/\s+/g, ' ').trim(),
    topics: tree.nodes.size,
  }
}

function outlineFilename(editor: Editor, title: string, ext: 'md' | 'csv'): string {
  const board = getMindmapCtx(editor)?.board.title ?? ''
  const name = exportFilename(board, 'csv', title || 'Mind map')
  return ext === 'csv' ? name : `${name.slice(0, -'.csv'.length)}.md`
}

function notify(editor: Editor, text: string, tone?: 'error') {
  getMindmapCtx(editor)?.notify({
    key: 'mindmap-outline',
    text,
    tone,
    testId: 'mindmap-outline-notice',
    timeoutMs: 5000,
  })
}

/**
 * Copy the map's outline as Markdown. An export: it follows the board's export policy like Copy as PNG
 * (people it limits only see why). The outline is built from what this person already sees on the
 * canvas, so it discloses nothing new; like Miro's, the policy is not a data-protection feature.
 */
export async function copyOutline(editor: Editor, topicId?: TLShapeId | null): Promise<boolean> {
  if (!guardExport(editor)) return false
  const outline = outlineOf(editor, topicId)
  if (!outline) return false
  try {
    await navigator.clipboard.writeText(outline.markdown)
    notify(
      editor,
      `Outline copied (${outline.topics} ${outline.topics === 1 ? 'topic' : 'topics'}, Markdown).`,
    )
    return true
  } catch {
    notify(editor, 'The browser did not allow copying. Use "Download as Markdown" instead.', 'error')
    return false
  }
}

export function downloadOutline(editor: Editor, format: 'md' | 'csv', topicId?: TLShapeId | null): boolean {
  if (!guardExport(editor)) return false
  const outline = outlineOf(editor, topicId)
  if (!outline) return false
  const blob =
    format === 'csv'
      ? new Blob(['﻿', outline.csv], { type: 'text/csv;charset=utf-8' })
      : new Blob([outline.markdown], { type: 'text/markdown;charset=utf-8' })
  downloadBlob(blob, outlineFilename(editor, outline.title, format))
  return true
}
