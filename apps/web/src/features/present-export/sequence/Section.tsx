// OWNER: WS3 (wave T). The Export dialog's "Image sequence" section (its kind slot, ../ported/export-sections.ts id
// `storyboard-sequence`): a ZIP of one PNG per panel with timings.csv and animatic.edl, for an editor to rebuild the
// animatic with its timings. Offered with the storyboard exports' switch on a board holding a storyboard; the dialog
// opens only under the board's export policy, and the file goes through ../download.ts as every export.
import { useId, useState } from 'react'
import { storyboardById } from '../../storyboard-play/model.ts'
import { downloadBlob } from '../download.ts'
import type { ExportSectionProps, ExportSectionSpec } from '../ported/export-sections.ts'
import {
  hasStoryboard,
  plural,
  SectionProgress,
  StoryboardPicker,
  storyboardFileName,
  useSectionTask,
  useStoryboardChoice,
} from '../storyboard-sheet/pick.tsx'
import { makeSequenceZip, SEQUENCE_WIDTHS, type SequenceWidth } from './build.ts'
import { SEQUENCE_FPS, type SequenceFps } from './timings.ts'

function StoryboardSequenceSection({ canvas, selectedIds, disabled, run }: ExportSectionProps) {
  const uid = useId()
  const { list, current, setChosen } = useStoryboardChoice(canvas, selectedIds)
  const [width, setWidth] = useState<SequenceWidth>(1920)
  const [fps, setFps] = useState<SequenceFps | null>(null)
  const [burnIn, setBurnIn] = useState(true)
  const task = useSectionTask()
  const rate: SequenceFps = fps ?? (current ? (storyboardById(canvas, current.id)?.fps ?? 24) : 24)
  const download = () =>
    run(
      task.wrap(async (signal, progress) => {
        const view = current ? storyboardById(canvas, current.id) : null
        if (!view) throw new Error('the storyboard is gone')
        const result = await makeSequenceZip({
          canvas,
          view,
          width,
          fps: rate,
          burnIn,
          signal,
          onProgress: ({ done, total }) =>
            progress(done < total ? `Drawing frame ${done + 1} of ${total}…` : 'Saving the file…'),
        })
        const name = storyboardFileName(view.title, 'image sequence', 'zip')
        downloadBlob(result.blob, name)
        return `Downloaded “${name}” (${plural(result.frames, 'frame')}, timings.csv and animatic.edl at ${rate} fps).`
      }),
    )
  return (
    <section
      className="dr-pe-section"
      aria-labelledby={`${uid}-seq`}
      data-testid="export-sb-sequence-section"
    >
      <h3 id={`${uid}-seq`} className="dr-pe-section__title">
        Image sequence
      </h3>
      <p className="dr-pe-text">
        One picture per panel with a timings spreadsheet and an EDL (CMX3600), in a ZIP: an editing tool
        rebuilds the animatic with its timings.
      </p>
      <StoryboardPicker
        list={list}
        current={current}
        onChange={setChosen}
        disabled={disabled}
        testId="export-sb-sequence-choice"
      />
      <div className="dr-pe-row">
        <label className="dr-pe-inline">
          Width
          <select
            data-testid="export-sb-sequence-width"
            value={String(width)}
            disabled={disabled}
            onChange={(e) => setWidth(Number(e.target.value) as SequenceWidth)}
          >
            {SEQUENCE_WIDTHS.map((w) => (
              <option key={w} value={String(w)}>
                {w} px
              </option>
            ))}
          </select>
        </label>
        <label className="dr-pe-inline">
          Frame rate
          <select
            data-testid="export-sb-sequence-fps"
            value={String(rate)}
            disabled={disabled}
            onChange={(e) => setFps(Number(e.target.value) as SequenceFps)}
          >
            {SEQUENCE_FPS.map((f) => (
              <option key={f} value={String(f)}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="dr-pe-inline">
        <input
          type="checkbox"
          data-testid="export-sb-sequence-burn-in"
          checked={burnIn}
          disabled={disabled}
          onChange={(e) => setBurnIn(e.target.checked)}
        />
        Shot numbers on the pictures
      </label>
      <div className="dr-pe-actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="export-sb-sequence"
          disabled={disabled || !current}
          onClick={() => void download()}
        >
          Download image sequence
        </button>
      </div>
      <SectionProgress task={task} testId="export-sb-sequence" />
    </section>
  )
}

export const STORYBOARD_SEQUENCE_SECTION: ExportSectionSpec = {
  id: 'storyboard-sequence',
  order: 20,
  offered: hasStoryboard,
  Section: StoryboardSequenceSection,
}
