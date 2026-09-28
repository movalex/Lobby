// "Tags…" in the canvas context menu (canvas-ux renders this group), for a selection that holds notes or
// file cards. It opens the same picker as the selection bar's button. People who cannot edit get "Show
// tags" while the selection carries tags.

import { TldrawUiMenuGroup, TldrawUiMenuItem, useEditor, useValue } from 'tldraw'
import { isTaggable, shapeTags } from './model.ts'
import { selectedTaggable } from './runtime.ts'
import { openTagPicker } from './TagPicker.tsx'

export function TagsContextMenuGroup() {
  const editor = useEditor()
  const item = useValue('dr-context-tags', () => {
    const shapes = editor.getSelectedShapes().filter(isTaggable)
    if (!shapes.length) return null
    if (!editor.getIsReadonly()) return selectedTaggable(editor).length ? 'edit' : null
    return shapes.some((s) => shapeTags(s.meta).length > 0) ? 'view' : null
  }, [editor])
  if (!item) return null
  return (
    <TldrawUiMenuGroup id="dr-tags">
      <TldrawUiMenuItem
        id="dr-tags-open"
        label={item === 'edit' ? 'context-menu.dr-tags' : 'context-menu.dr-tags-view'}
        readonlyOk
        // After the menu has closed and handed the focus back, so the picker keeps it.
        onSelect={() => {
          editor.timers.setTimeout(() => openTagPicker(editor), 0)
        }}
      />
    </TldrawUiMenuGroup>
  )
}

export const TAGS_TRANSLATIONS = {
  'context-menu.dr-tags': 'Tags…',
  'context-menu.dr-tags-view': 'Show tags',
} as const
