// The mind-map commands behind every entry point (the toolbar's Mind map, the context menu, the topic
// bar, Alt+Shift+M): each resolves the selection, calls the runtime and hands a new topic to the key
// queue, so a click on "Add child" leaves the keyboard exactly where Tab would. The port of ../commands.ts.

import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import { items } from '../../../canvas/api/index.ts'
import { downloadBlob } from '../../present-export/download.ts'
import { exportFilename } from '../../present-export/filename.ts'
import { cleanTopicText, cutTopic, type OutlineNode, ringOutline } from '../outline-parse.ts'
import type { ExportGate } from './export-gate.ts'
import { type MindmapKeyboard, selectedTopic } from './keyboard.ts'
import { outlineCsv, outlineMarkdown } from './outline.ts'
import type { BuiltTopics, MindmapRuntime, Stamp } from './runtime.ts'

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

// ---- many topics at once (Expand with AI, Paste as mind map, Mind map from a prompt) ------------------

/** Words for a topic from whatever text came in (AI's idea, a pasted line): one line, cut. */
const topicWords = (text: string) => cutTopic(cleanTopicText(text))

/** Whether the board has room for `n` more topics and their lines (a label is not an item). */
function hasRoom(m: Mindmap, n: number): boolean {
  const have = items.contentItems(m.rt.canvas.items()).length
  if (have + 2 * n <= MAX_ITEMS) return true
  m.notify('This board has too many objects to add that many topics.', 'error')
  return false
}

/**
 * Several child topics under topic `topicId` at once (Expand with AI): after its existing children, laid out
 * and tidied with the whole map, their lines bound to it. ONE undo step for all of them (one transact; the
 * second, which binds the lines, joins it). Empty lines and words the topic's children already have are
 * left out. Returns what was made (`children`: the new topics), or null when nothing was added (no topic, a
 * viewer, nothing new).
 */
export function addChildTopics(
  m: Mindmap,
  topicId: string,
  texts: readonly string[],
  opts: { stamp?: Stamp } = {},
): BuiltTopics | null {
  const have = new Set(
    [...(m.rt.index.children.get(topicId) ?? [])].map((id) => topicWords(m.rt.textOf(id)).toLowerCase()),
  )
  const nodes: OutlineNode[] = []
  for (const text of texts) {
    const words = topicWords(text)
    const key = words.toLowerCase()
    if (!words || have.has(key)) continue
    have.add(key)
    nodes.push({ text: words, children: [] })
  }
  if (!nodes.length || !hasRoom(m, nodes.length)) return null
  return m.rt.addChildren(topicId, nodes, opts)
}

/**
 * "Paste as mind map": the outline (parsed by ../outline-parse.ts) as a new map around `center`, in ONE undo
 * step. Returns the central topic, or null.
 */
export function pasteOutlineAsMindmap(
  m: Mindmap,
  outline: { root: OutlineNode; topics: number },
  center?: { x: number; y: number },
): string | null {
  if (!hasRoom(m, outline.topics)) return null
  return m.rt.createMapFromOutline(outline.root, center ? { center } : {})?.rootId ?? null
}

/**
 * "Mind map from a prompt": the prompt is the central topic and the ideas AI drafted for it are its first
 * ring, in ONE undo step. Returns what was made, or null (nothing usable came back).
 */
export function mindmapFromIdeas(
  m: Mindmap,
  prompt: string,
  ideas: readonly string[],
  opts: { stamp?: Stamp; center?: { x: number; y: number } } = {},
): BuiltTopics | null {
  const ring = ringOutline(prompt, ideas)
  if (!ring || !hasRoom(m, ring.topics)) return null
  return m.rt.createMapFromOutline(ring.root, {
    ...(opts.stamp ? { stamp: opts.stamp } : {}),
    ...(opts.center ? { center: opts.center } : {}),
  })
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
