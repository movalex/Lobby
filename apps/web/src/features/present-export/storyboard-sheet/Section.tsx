// OWNER: WS3 (wave T). The Export dialog's "Storyboard sheet (PDF)" section (its kind slot, ../ported/export-sections.ts
// id `storyboard-sheet`): a storyboard's panels on landscape pages, 2, 3 or 6 to a page, with their pictures, numbers,
// durations and fields as searchable text. Offered while the storyboard exports' switch is on and the board holds a
// storyboard with a panel; the dialog itself opens only under the board's export policy.
import { useId, useState } from 'react'
import { storyboardById } from '../../storyboard-play/model.ts'
import { downloadBlob } from '../download.ts'
import type { ExportSectionProps, ExportSectionSpec } from '../ported/export-sections.ts'
import { canvasMeasure } from '../review-summary/raster.ts'
import { makeStoryboardSheet } from './build.ts'
import { SHEET_PER_PAGE, type SheetPerPage } from './layout.ts'
import {
  hasStoryboard,
  plural,
  SectionProgress,
  StoryboardPicker,
  sheetDate,
  storyboardFileName,
  useSectionTask,
  useStoryboardChoice,
} from './pick.tsx'

const PER_PAGE_WORDS: Readonly<Record<SheetPerPage, string>> = {
  2: '2 large panels, every field',
  3: '3 panels, every field',
  6: '6 panels, camera and dialogue',
}

function StoryboardSheetSection({ canvas, boardTitle, selectedIds, disabled, run }: ExportSectionProps) {
  const uid = useId()
  const { list, current, setChosen } = useStoryboardChoice(canvas, selectedIds)
  const [perPage, setPerPage] = useState<SheetPerPage>(3)
  const task = useSectionTask()
  const download = () =>
    run(
      task.wrap(async (signal, progress) => {
        const view = current ? storyboardById(canvas, current.id) : null
        if (!view) throw new Error('the storyboard is gone')
        const result = await makeStoryboardSheet({
          canvas,
          view,
          perPage,
          boardTitle,
          date: sheetDate(),
          measure: canvasMeasure(),
          signal,
          onProgress: ({ done, total }) =>
            progress(done < total ? `Drawing page ${done + 1} of ${total}…` : 'Saving the file…'),
        })
        const name = storyboardFileName(view.title, 'storyboard', 'pdf')
        downloadBlob(result.blob, name)
        const cut = result.notShown
          ? ` ${plural(result.notShown, 'panel')} did not fit in the page limit.`
          : ''
        const images = result.imagePages.length
          ? ` ${plural(result.imagePages.length, 'page')} drawn as images (their text is still searchable).`
          : ''
        return `Downloaded “${name}” (${plural(result.pageCount, 'page')}).${cut}${images}`
      }),
    )
  return (
    <section className="dr-pe-section" aria-labelledby={`${uid}-sheet`} data-testid="export-sb-sheet-section">
      <h3 id={`${uid}-sheet`} className="dr-pe-section__title">
        Storyboard sheet (PDF)
      </h3>
      <p className="dr-pe-text">
        {current
          ? `“${current.title}”: ${plural(current.panels, 'panel')} in order, with their pictures, shot numbers, durations and fields.`
          : 'A storyboard’s panels in order, with their pictures, shot numbers, durations and fields.'}
      </p>
      <StoryboardPicker
        list={list}
        current={current}
        onChange={setChosen}
        disabled={disabled}
        testId="export-sb-sheet-choice"
      />
      <fieldset className="dr-pe-choices dr-pe-choices--stack" disabled={disabled}>
        <legend className="dr-pe-legend">Panels per page</legend>
        {SHEET_PER_PAGE.map((n) => (
          <label key={n} className="dr-pe-choice">
            <input
              type="radio"
              name={`${uid}-per-page`}
              data-testid={`export-sb-sheet-${n}`}
              checked={perPage === n}
              onChange={() => setPerPage(n)}
            />
            {PER_PAGE_WORDS[n]}
          </label>
        ))}
      </fieldset>
      <div className="dr-pe-actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="export-sb-sheet"
          disabled={disabled || !current}
          onClick={() => void download()}
        >
          Download storyboard PDF
        </button>
      </div>
      <SectionProgress task={task} testId="export-sb-sheet" />
    </section>
  )
}

export const STORYBOARD_SHEET_SECTION: ExportSectionSpec = {
  id: 'storyboard-sheet',
  order: 10,
  offered: hasStoryboard,
  Section: StoryboardSheetSection,
}
