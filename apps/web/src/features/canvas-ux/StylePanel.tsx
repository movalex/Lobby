// COL-06: when the selection is all sticky notes (or the note tool is active), the colour picker shows
// Draftroom's note palette as the notes will actually look (fill + text), instead of tldraw's
// solid-colour swatches, and includes "Paper" (white), which tldraw's picker hides. One pick recolours
// every selected note in one undo step (StylePanelContext marks history, then sets the style in one run).
// Everything else is tldraw 5.4.2's default style panel content.

import {
  DefaultColorStyle,
  DefaultStylePanel,
  StylePanelArrowheadPicker,
  StylePanelArrowKindPicker,
  StylePanelColorPicker,
  StylePanelDashPicker,
  StylePanelFillPicker,
  StylePanelFontPicker,
  StylePanelGeoShapePicker,
  StylePanelLabelAlignPicker,
  StylePanelOpacityPicker,
  StylePanelSection,
  StylePanelSizePicker,
  StylePanelSplinePicker,
  StylePanelTextAlignPicker,
  type TLUiStylePanelProps,
  useEditor,
  useStylePanelContext,
  useValue,
} from 'tldraw'
import { NOTE_PALETTE } from './palette.ts'

function isNoteContext(editor: ReturnType<typeof useEditor>): boolean {
  if (editor.isIn('select')) {
    const selected = editor.getSelectedShapes()
    return selected.length > 0 && selected.every((s) => s.type === 'note')
  }
  return editor.getCurrentToolId() === 'note'
}

export function NoteColorPicker() {
  const editor = useEditor()
  const { styles, onHistoryMark, onValueChange } = useStylePanelContext()
  const mode = useValue('dr-color-mode', () => editor.getColorMode(), [editor])
  const color = styles.get(DefaultColorStyle)
  if (color === undefined) return null
  const current = color.type === 'shared' ? color.value : null
  return (
    <fieldset className="dr-note-palette" data-testid="note-palette">
      <legend className="dr-note-palette__legend">Note colour{current === null ? ' (mixed)' : ''}</legend>
      <div className="dr-note-palette__grid">
        {NOTE_PALETTE.map((s) => (
          <button
            key={s.name}
            type="button"
            className="dr-note-palette__swatch"
            data-testid="note-color"
            data-color={s.name}
            aria-pressed={current === s.name}
            aria-label={`${s.label}${current === s.name ? ' (selected)' : ''}`}
            title={s.label}
            style={{ background: s[mode].fill, color: s[mode].text }}
            onClick={() => {
              if (current === s.name) return
              onHistoryMark('note colour')
              onValueChange(DefaultColorStyle, s.name)
            }}
          >
            <span aria-hidden="true">Aa</span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function ColorPicker() {
  const editor = useEditor()
  const notes = useValue('dr-note-context', () => isNoteContext(editor), [editor])
  return notes ? <NoteColorPicker /> : <StylePanelColorPicker />
}

export function DraftroomStylePanel(props: TLUiStylePanelProps) {
  return (
    <DefaultStylePanel {...props}>
      <StylePanelSection>
        <ColorPicker />
        <StylePanelOpacityPicker />
      </StylePanelSection>
      <StylePanelSection>
        <StylePanelFillPicker />
        <StylePanelDashPicker />
        <StylePanelSizePicker />
      </StylePanelSection>
      <StylePanelSection>
        <StylePanelFontPicker />
        <StylePanelTextAlignPicker />
        <StylePanelLabelAlignPicker />
      </StylePanelSection>
      <StylePanelSection>
        <StylePanelGeoShapePicker />
        <StylePanelArrowKindPicker />
        <StylePanelArrowheadPicker />
        <StylePanelSplinePicker />
      </StylePanelSection>
    </DefaultStylePanel>
  )
}
