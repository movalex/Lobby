// COL-06: when the selection is all sticky notes (or the note tool is active), the colour picker shows
// Draftroom's note palette as the notes will actually look (fill + text), instead of tldraw's
// solid-colour swatches, and includes "Paper" (white), which tldraw's picker hides. One pick recolours
// every selected note in one undo step (StylePanelContext marks history, then sets the style in one run).
// Everything else is tldraw 5.4.2's default style panel content.
// RETRO-20/F24a: the panel only shows while something is selected or a creation tool (note, text, shape,
// pen, connector…) is active, instead of always covering the board's top-right corner.

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
  StylePanelSubheading,
  StylePanelTextAlignPicker,
  type TLUiStylePanelProps,
  useEditor,
  useStylePanelContext,
  useValue,
} from 'tldraw'
import { NOTE_PALETTE } from './palette.ts'

/** Tools whose next shape the style panel sets (tldraw 5.4.2 tool ids; every geo shape is 'geo'). */
export const STYLED_TOOLS: ReadonlySet<string> = new Set([
  'note',
  'text',
  'geo',
  'draw',
  'arrow',
  'line',
  'highlight',
])

/**
 * RETRO-20: show the style panel only for a selection or a creation tool. R16: never for a selection
 * of frames only: a frame has no style but opacity, so the panel was a lone, unlabeled slider in the
 * corner for the whole facilitation flow (select a frame to start a brainstorm, a vote, an AI action).
 */
export function showStylePanel(selectedCount: number, toolId: string, framesOnly = false): boolean {
  if (framesOnly) return false
  return selectedCount > 0 || STYLED_TOOLS.has(toolId)
}

/** The selection is one or more frames and nothing else. */
function selectionIsFramesOnly(editor: ReturnType<typeof useEditor>): boolean {
  const ids = editor.getSelectedShapeIds()
  if (!ids.length) return false
  return ids.every((id) => editor.getShape(id)?.type === 'frame')
}

/**
 * R16: the opacity slider with a visible "Opacity" label when it is the panel's only control (an
 * image, a file card…); tldraw only shows that label in its enhanced accessibility mode.
 */
function OpacityPicker() {
  const { styles, enhancedA11yMode } = useStylePanelContext()
  const alone = styles.size === 0
  return (
    <>
      {alone && !enhancedA11yMode && (
        <div className="dr-style-opacity-label" data-testid="style-opacity-label">
          <StylePanelSubheading>Opacity</StylePanelSubheading>
        </div>
      )}
      <StylePanelOpacityPicker />
    </>
  )
}

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
      <legend className="dr-note-palette__legend">Note color{current === null ? ' (mixed)' : ''}</legend>
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
              onHistoryMark('note color')
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
  const editor = useEditor()
  const visible = useValue(
    'dr-style-panel-visible',
    () =>
      showStylePanel(
        editor.getSelectedShapeIds().length,
        editor.getCurrentToolId(),
        selectionIsFramesOnly(editor),
      ),
    [editor],
  )
  // The mobile style menu is opened on purpose from the toolbar: never hide it.
  if (!visible && !props.isMobile) return null
  return (
    <DefaultStylePanel {...props}>
      <StylePanelSection>
        <ColorPicker />
        <OpacityPicker />
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
