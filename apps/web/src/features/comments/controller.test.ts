import type { Editor } from 'tldraw'
import { describe, expect, it, vi } from 'vitest'
import { focusBoard } from './controller.ts'

describe('focusBoard', () => {
  it('focuses the editor container itself, even while the editor already counts as focused', () => {
    // tldraw's editor.focus() returns early when getIsFocused() is true (the usual state when a
    // comment popover closes), so DOM focus has to be moved explicitly for Esc/shortcuts to work.
    const container = { focus: vi.fn() }
    const editor = { focus: vi.fn(), getContainer: () => container }
    focusBoard(editor as unknown as Editor)
    expect(editor.focus).toHaveBeenCalledTimes(1)
    expect(container.focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})
