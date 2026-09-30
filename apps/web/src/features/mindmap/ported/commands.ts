// The mind-map commands behind every entry point (the toolbar's Mind map, the context menu, the topic
// bar, Alt+Shift+M): each resolves the selection, calls the runtime and hands a new topic to the key
// queue, so a click on "Add child" leaves the keyboard exactly where Tab would. The port of ../commands.ts.

import { downloadBlob } from '../../present-export/download.ts'
import { exportFilename } from '../../present-export/filename.ts'
import { outlineCsv, outlineMarkdown } from '../outline.ts'
import type { ExportGate } from './export-gate.ts'
import { type MindmapKeyboard, selectedTopic } from './keyboard.ts'
import type { MindmapRuntime } from './runtime.ts'

/** What the commands need: the runtime, its key queue, the export gate and the feature context's notices. */
export interface Mindmap {
  readonly rt: MindmapRuntime
  readonly keys: MindmapKeyboard
  readonly gate: ExportGate
  readonly boardTitle: () => string
  notify(text: string, tone?: 'error'): void
}

export { selectedTopic }

/** The map (its central topic) of the selection, if every selected topic or line belongs to one map. */
export function selectedMapRoot(rt: MindmapRuntime): string | null {
  let root: string | null = null
  for (const id of rt.canvas.selection) {
    const el = rt.canvas.get(id)
    const own = el?.type === 'text' && el.containerId ? el.containerId : id
    const r = rt.index.rootOfAny(own)
    if (!r) continue
    if (root && r !== root) return null
    root = r
  }
  return root
}

/** The single selected element that "Start a mind map" would turn into a central topic. */
export function startableSelection(rt: MindmapRuntime): string | null {
  const sel = rt.canvas.selection
  if (sel.length !== 1) return null
  const el = rt.canvas.get(sel[0] as string)
  const target = el?.type === 'text' && el.containerId ? rt.canvas.get(el.containerId) : el
  return rt.canStartFrom(target) ? (target?.id ?? null) : null
}

/**
 * The toolbar's "Mind map": always a new map, its central topic in the free space nearest the view's
 * centre, ready for typing (the placeholder "Central topic" goes with the first key).
 */
export function newMindmap(m: Mindmap): string | null {
  if (m.rt.canvas.readOnly()) return null
  const id = m.rt.createMap()
  if (id) m.keys.expectEditor(id, 'placeholder')
  return id
}

/**
 * "Start a mind map" (Alt+Shift+M, context menu): the selected note/text/shape becomes the central topic
 * of a new map with a first branch to type in; with nothing (or nothing suitable) selected, a new map as
 * from the toolbar. Returns the topic now being typed in.
 */
export function startMindmap(m: Mindmap): string | null {
  const { rt } = m
  if (rt.canvas.readOnly()) return null
  const from = startableSelection(rt)
  if (from) {
    const made = rt.startFrom(from)
    if (made) m.keys.expectEditor(made, 'fresh')
    return made
  }
  if (selectedMapRoot(rt)) {
    m.notify('This is already part of a mind map: press Tab to add a topic.')
    return null
  }
  return newMindmap(m)
}

export function addChildTopic(m: Mindmap, side?: 'left' | 'right'): string | null {
  const id = selectedTopic(m.rt)
  const made = id ? m.rt.addChild(id, side ? { side } : {}) : null
  if (made) m.keys.expectEditor(made, 'fresh')
  return made
}

export function addSiblingTopic(m: Mindmap): string | null {
  const id = selectedTopic(m.rt)
  const made = id ? m.rt.addSibling(id) : null
  if (made) m.keys.expectEditor(made, 'fresh')
  return made
}

export function promoteTopic(m: Mindmap): boolean {
  const id = selectedTopic(m.rt)
  return !!id && m.rt.promote(id)
}

export function toggleTopicCollapsed(m: Mindmap, id?: string): boolean {
  const target = id ?? selectedTopic(m.rt)
  return !!target && m.rt.toggleCollapsed(target)
}

export function tidyMindmap(m: Mindmap): boolean {
  const root = selectedMapRoot(m.rt)
  return !!root && m.rt.tidy(root)
}

// ---- outline export -------------------------------------------------------------------------------

export interface Outline {
  markdown: string
  csv: string
  /** The central topic's text (for file names). */
  title: string
  topics: number
}

export function outlineOf(rt: MindmapRuntime, anyTopicId?: string | null): Outline | null {
  const root = anyTopicId ? rt.index.rootOfAny(anyTopicId) : selectedMapRoot(rt)
  const tree = root ? rt.readTree(root) : null
  if (!tree) return null
  const text = (id: string) => rt.textOf(id)
  return {
    markdown: outlineMarkdown(tree, text),
    csv: outlineCsv(tree, text),
    title: text(tree.rootId).replace(/\s+/g, ' ').trim(),
    topics: tree.nodes.size,
  }
}

function outlineFilename(board: string, title: string, ext: 'md' | 'csv'): string {
  const name = exportFilename(board, 'csv', title || 'Mind map')
  return ext === 'csv' ? name : `${name.slice(0, -'.csv'.length)}.md`
}

/**
 * Copy the map's outline as Markdown. An export: it follows the board's export policy like Copy as PNG
 * (people it limits only see why). The outline is built from what this person already sees on the
 * canvas, so it discloses nothing new; like Miro's, the policy is not a data-protection feature.
 */
export async function copyOutline(m: Mindmap, topicId?: string | null): Promise<boolean> {
  if (!m.gate.guard()) return false
  const outline = outlineOf(m.rt, topicId)
  if (!outline) return false
  try {
    await navigator.clipboard.writeText(outline.markdown)
    m.notify(`Outline copied (${outline.topics} ${outline.topics === 1 ? 'topic' : 'topics'}, Markdown).`)
    return true
  } catch {
    m.notify('The browser did not allow copying. Use "Download as Markdown" instead.', 'error')
    return false
  }
}

export function downloadOutline(m: Mindmap, format: 'md' | 'csv', topicId?: string | null): boolean {
  if (!m.gate.guard()) return false
  const outline = outlineOf(m.rt, topicId)
  if (!outline) return false
  const blob =
    format === 'csv'
      ? new Blob(['﻿', outline.csv], { type: 'text/csv;charset=utf-8' })
      : new Blob([outline.markdown], { type: 'text/markdown;charset=utf-8' })
  downloadBlob(blob, outlineFilename(m.boardTitle(), outline.title, format))
  return true
}

/** The board's Delete, widened to whole branches (asks above a size); 'not-mindmap' leaves it to the board. */
export function deleteSelection(m: Mindmap): 'not-mindmap' | 'asked' | 'done' | 'nothing' {
  if (m.rt.canvas.readOnly()) return 'not-mindmap'
  return m.rt.requestDelete(m.rt.canvas.selection)
}
