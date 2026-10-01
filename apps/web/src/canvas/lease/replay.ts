// Replays keys buffered while a lease was pending into Excalidraw's text editor (§2.3.3, §2.9.2).
//
// document.execCommand('insertText' | 'delete' | 'forwardDelete') on the focused textarea: the browser
// fires beforeinput/input exactly as for typing, so Excalidraw's `oninput` runs its normal path (layout,
// sticky-note fit) and the textarea's native undo stack records the replayed text (Ctrl+Z inside the
// editor stays native, §2.8). execCommand is deprecated but implemented by Chromium, Firefox and Safari
// for textareas; the fallback (setRangeText + an input event) keeps the text right but not native undo.

export interface BufferedKey {
  key: string
  code: string
  shiftKey: boolean
}

export function bufferedKeyOf(e: KeyboardEvent): BufferedKey {
  return { key: e.key, code: e.code, shiftKey: e.shiftKey }
}

function exec(doc: Document, command: string, value?: string): boolean {
  try {
    return doc.execCommand(command, false, value)
  } catch {
    return false
  }
}

function fallbackEdit(ta: HTMLTextAreaElement, key: BufferedKey): void {
  const start = ta.selectionStart
  const end = ta.selectionEnd
  if (key.key === 'Backspace') {
    if (start === end && start > 0) ta.setRangeText('', start - 1, end, 'end')
    else ta.setRangeText('', start, end, 'end')
  } else if (key.key === 'Delete') {
    if (start === end) ta.setRangeText('', start, Math.min(ta.value.length, end + 1), 'end')
    else ta.setRangeText('', start, end, 'end')
  } else {
    ta.setRangeText(key.key === 'Enter' ? '\n' : key.key, start, end, 'end')
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Types `keys` into `ta` at its current caret, in order. Returns how many used the fallback. */
export function replayKeys(ta: HTMLTextAreaElement, keys: readonly BufferedKey[]): number {
  const doc = ta.ownerDocument
  if (doc.activeElement !== ta) ta.focus()
  let fallbacks = 0
  for (const k of keys) {
    const ok =
      k.key === 'Backspace'
        ? exec(doc, 'delete')
        : k.key === 'Delete'
          ? exec(doc, 'forwardDelete')
          : exec(doc, 'insertText', k.key === 'Enter' ? '\n' : k.key)
    if (!ok) {
      fallbacks++
      fallbackEdit(ta, k)
    }
  }
  return fallbacks
}
