// K7-1: "Expand with AI" on a selected mind-map topic. The api sees nothing new: the existing 'ideas' action
// with the topic's words as the prompt (cut to the 200-character cap) and the topic's path from the central
// topic, with the topics already under it, as the context. What comes back becomes new sub-topics under the
// topic, laid out and tidied with the map, in ONE undo step (../../mindmap/ported/commands.ts addChildTopics).
// This file is the pure half: what to ask for. ./actions.ts runs the request and applies the answer.

import { AI_MAX_REQUEST_SHAPES, AI_PROMPT_MAX_CHARS } from '@draftroom/contracts'
import type { MindmapRuntime } from '../../mindmap/ported/runtime.ts'
import { topicLabel } from '../copy.ts'

/** Sub-topics asked for: a ring that stays readable beside the topic. */
export const EXPAND_COUNT = 5
/** Existing children sent as context, so the ideas do not repeat them. */
export const EXPAND_CONTEXT_CHILDREN = 20

/** A topic's words as the ideas prompt: one line, at most AI_PROMPT_MAX_CHARS UTF-16 units, no half character. */
export function promptOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= AI_PROMPT_MAX_CHARS) return one
  let end = AI_PROMPT_MAX_CHARS
  const last = one.charCodeAt(end - 1)
  // never end on the first half of a surrogate pair
  if (last >= 0xd800 && last <= 0xdbff) end--
  return one.slice(0, end).trimEnd()
}

export interface ExpandPlan {
  topicId: string
  /** The topic's words, one line. */
  text: string
  /** What the 'ideas' action is asked: the topic's words, cut to the cap. */
  prompt: string
  /** The path from the central topic to the topic (both included). */
  path: string[]
  /** Element ids sent as context: the path, then the topic's existing children. */
  context: string[]
  /** "the topic “Channels”", for the notice and the pill. */
  label: string
}

export type ExpandProblem = 'gone' | 'empty'

export type ReadsMap = Pick<MindmapRuntime, 'treeOfTopic' | 'textOf'>

/** What to ask for to expand `topicId`, or why it cannot be expanded. */
export function expandPlan(rt: ReadsMap, topicId: string): ExpandPlan | { problem: ExpandProblem } {
  const tree = rt.treeOfTopic(topicId)
  const node = tree?.nodes.get(topicId)
  if (!tree || !node) return { problem: 'gone' }
  const text = rt.textOf(topicId).replace(/\s+/g, ' ').trim()
  if (!text) return { problem: 'empty' }
  // the path up to the central topic (a map is at most MINDMAP_MAX_DEPTH deep; the guard is for loops)
  const path: string[] = [topicId]
  let at = node
  for (let i = 0; at.parentId !== null && i < 80; i++) {
    path.unshift(at.parentId)
    const up = tree.nodes.get(at.parentId)
    if (!up) break
    at = up
  }
  const context = [...path, ...node.children.slice(0, EXPAND_CONTEXT_CHILDREN)].slice(
    0,
    AI_MAX_REQUEST_SHAPES,
  )
  return {
    topicId,
    text,
    prompt: promptOf(text),
    path,
    context,
    label: topicLabel(text),
  }
}
