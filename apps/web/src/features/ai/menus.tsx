// The two ways into AI (docs/WAVE4-CONTRACTS.md §4 ai-assist), both rendered by canvas-ux:
//  - "AI" in the selection bar: opens the AI menu for the selection;
//  - "AI ›" in the canvas context menu: the four actions for the selection, or, with nothing selected,
//    for the frame under the pointer ("Generate ideas…" works anywhere).
// Both stay hidden unless the api reports AI on for this person on this board (AiStatus), and read-only
// people only get "Summarize" (into a panel).

import { memo, useRef, useState } from 'react'
import {
  type Editor,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  useEditor,
  useValue,
} from 'tldraw'
import { openAiMenu, runAi } from './actions.ts'
import { SparkIcon, Spinner } from './icons.tsx'
import { type AiMenuState, aiJob, aiMenu, aiStatus } from './runtime.ts'
import { selectionTarget, targetAt } from './target.ts'

/** A point in the editor container (px) as the popover's anchor. */
function anchorAtPoint(editor: Editor, page: { x: number; y: number }): AiMenuState['at'] {
  const v = editor.pageToViewport(page)
  return { x: v.x, top: v.y, bottom: v.y }
}

function anchorAtElement(editor: Editor, el: HTMLElement): AiMenuState['at'] {
  const c = editor.getContainer().getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2 - c.left, top: r.top - c.top, bottom: r.bottom - c.top }
}

/** The selection bar's "AI" button (canvas-ux renders it). */
export const AiBarButton = memo(function AiBarButton() {
  const editor = useEditor()
  const enabled = useValue('dr-ai-enabled', () => aiStatus(editor).get()?.enabled === true, [editor])
  const busy = useValue('dr-ai-busy', () => aiJob(editor).get() !== null, [editor])
  const open = useValue('dr-ai-menu-open', () => aiMenu(editor).get() !== null, [editor])
  const ref = useRef<HTMLButtonElement>(null)
  if (!enabled) return null
  return (
    <span className="dr-ai-barslot">
      <span className="dr-cux-selbar__sep" aria-hidden="true" />
      <button
        ref={ref}
        type="button"
        className="dr-cux-selbar__btn dr-ai-barbtn"
        aria-label={busy ? 'AI is working' : 'AI'}
        title="AI: summarize, group into themes, action items, ideas"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy}
        disabled={busy}
        data-testid="selection-ai"
        onClick={() => {
          if (open) {
            aiMenu(editor).set(null)
            return
          }
          const target = selectionTarget(editor)
          if (target && ref.current) openAiMenu(editor, anchorAtElement(editor, ref.current), target)
        }}
      >
        {busy ? <Spinner /> : <SparkIcon />}
        <span className="dr-ai-barbtn__label">AI</span>
      </button>
    </span>
  )
})

/** "AI ›" in the canvas context menu (rendered while the menu is open). */
export function AiContextMenuGroup() {
  const editor = useEditor()
  const status = useValue('dr-ai-context-status', () => aiStatus(editor).get(), [editor])
  const busy = useValue('dr-ai-context-busy', () => aiJob(editor).get() !== null, [editor])
  // Where the menu was opened, and on what: fixed while it is open.
  const [point] = useState(() => editor.inputs.getCurrentPagePoint().clone())
  const [target] = useState(() => targetAt(editor, point))
  if (!status?.enabled) return null
  const at = anchorAtPoint(editor, point)
  const later = (fn: () => void) => {
    editor.timers.setTimeout(fn, 0)
  }
  const run = (action: 'summarize' | 'themes' | 'actions') =>
    later(() => void runAi(editor, { action }, target, { at }))
  const insert = status.canInsert && !editor.getIsReadonly()
  return (
    <TldrawUiMenuGroup id="dr-ai">
      <TldrawUiMenuSubmenu id="dr-ai-sub" label="context-menu.dr-ai" disabled={busy}>
        <TldrawUiMenuGroup id="dr-ai-items">
          <TldrawUiMenuItem
            id="dr-ai-summarize"
            label="context-menu.dr-ai-summarize"
            readonlyOk
            disabled={target.texts === 0}
            onSelect={() => run('summarize')}
          />
          {insert && (
            <TldrawUiMenuItem
              id="dr-ai-themes"
              label="context-menu.dr-ai-themes"
              disabled={target.notes < 2}
              onSelect={() => run('themes')}
            />
          )}
          {insert && (
            <TldrawUiMenuItem
              id="dr-ai-actions"
              label="context-menu.dr-ai-actions"
              disabled={target.texts === 0}
              onSelect={() => run('actions')}
            />
          )}
          {insert && (
            <TldrawUiMenuItem
              id="dr-ai-ideas"
              label="context-menu.dr-ai-ideas"
              onSelect={() => later(() => openAiMenu(editor, at, target, 'ideas'))}
            />
          )}
        </TldrawUiMenuGroup>
      </TldrawUiMenuSubmenu>
    </TldrawUiMenuGroup>
  )
}

export const AI_TRANSLATIONS = {
  'context-menu.dr-ai': 'AI',
  'context-menu.dr-ai-summarize': 'Summarize',
  'context-menu.dr-ai-themes': 'Group into themes',
  'context-menu.dr-ai-actions': 'Action items',
  'context-menu.dr-ai-ideas': 'Generate ideas…',
} as const
