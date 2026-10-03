// The Export dialog on the Excalidraw page (the port of ../ExportDialog.tsx; same layout, test ids,
// preferences and copy): PNG/SVG of the selection, a frame or the whole board (1×/2×/4×, transparent
// background), copy as PNG, a PDF with one page per frame, and CSV of the board's text.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Bounds, LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { Dialog } from '../../../ui/Dialog.tsx'
import { controllerOf as commentsControllerOf } from '../../comments/ported/controller.ts'
import { exportPolicyOn, exportPolicySentence } from '../../sharing/ported/export-policy.ts'
import { workshopSettingsOf } from '../../workshops/ported/session-settings.ts'
import { downloadBlob } from '../download.ts'
import { frameInView, openingScale } from '../export-defaults.ts'
import { exportFilename } from '../filename.ts'
import {
  exceedsCanvasLimits,
  imagePixelSize,
  isPdfPageFormat,
  PDF_PAGE_FORMATS,
  type PdfPageFormat,
} from '../pdf-layout.ts'
import { pickPdfFrames, slideTitle } from '../slides.ts'
import { exportResults } from './badges.ts'
import type { Controller, ExportRequest } from './controller.ts'
import { boardCsv, csvBlob, csvRowCount } from './csv.ts'
import {
  copyPng,
  ExportCancelled,
  frameTarget,
  IMAGE_SCALES,
  type ImageScale,
  type ImageTarget,
  originalBytes,
  type PdfPageSpec,
  renderPdf,
  renderPng,
  renderSvg,
  reportPdfPages,
  targetElements,
} from './exporter.ts'
import { type ElementFrameEntry, frameOutline, skipCarrier } from './frames.ts'
import {
  commentsBlocks,
  countReportThreads,
  describeAnchor,
  describeElement,
  reportThreads,
  resultRows,
  resultsBlocks,
} from './report.ts'

type Area = 'selection' | 'frame' | 'board'
type BusyKind = 'png' | 'svg' | 'copy' | 'pdf' | 'csv'

interface Prefs {
  scale: ImageScale
  transparent: boolean
  lossless: boolean
  pdfFormat: PdfPageFormat
}

const PREFS_KEY = 'draftroom.export.v1'
// 1×: the frame or selection at the size it has on the board (F14). 2× and 4× stay a click away.
const DEFAULT_PREFS: Prefs = { scale: 1, transparent: false, lossless: false, pdfFormat: 'fit' }

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null
    return {
      scale: IMAGE_SCALES.includes(raw?.scale as ImageScale)
        ? (raw?.scale as ImageScale)
        : DEFAULT_PREFS.scale,
      transparent: raw?.transparent === true,
      lossless: raw?.lossless === true,
      pdfFormat: isPdfPageFormat(raw?.pdfFormat) ? raw.pdfFormat : DEFAULT_PREFS.pdfFormat,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

function writePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // private mode / storage full: preferences are a convenience
  }
}

const fmt = new Intl.NumberFormat()
const plural = (n: number, one: string, many = `${one}s`) => `${fmt.format(n)} ${n === 1 ? one : many}`
const formatBytes = (n: number) =>
  n >= 1024 * 1024
    ? `${fmt.format(Math.round(n / (1024 * 1024)))} MB`
    : `${fmt.format(Math.max(1, Math.round(n / 1024)))} KB`

const rectOf = (b: Bounds | null) => (b ? { w: b.width, h: b.height } : null)

/** A refusal with its own words (the status line shows them; any other failure gets the general text). */
class ExportProblem extends Error {}

function frameName(canvas: LobbyCanvas, id: string): string {
  if (!id) return ''
  const name = (canvas.get(id) as { name?: unknown } | undefined)?.name
  return typeof name === 'string' ? name : ''
}

/** The tag definitions of the board (lb_doc `tagDef:<key>`), for the CSV's tags column. */
function tagDefs(canvas: LobbyCanvas): Map<string, { name: string }> {
  const out = new Map<string, { name: string }>()
  for (const [k, v] of canvas.doc.entries('tagDef:')) {
    const name = v && typeof v === 'object' ? (v as { name?: unknown }).name : undefined
    if (typeof name === 'string') out.set(k.slice('tagDef:'.length), { name })
  }
  return out
}

export function ExportDialog({
  canvas,
  controller,
  request,
  boardTitle,
  onClose,
}: {
  canvas: LobbyCanvas
  controller: Controller
  request: ExportRequest
  boardTitle: string
  onClose(): void
}) {
  const uid = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const pdfButton = useRef<HTMLButtonElement>(null)
  const csvButton = useRef<HTMLButtonElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const boardId = controller.boardId()

  // Live board facts (the dialog is modal, but collaborators keep editing).
  const selectedKey = useValue('lobby-export-selection', () => canvas.selection.join('\n'), [canvas])
  const selectedIds = useMemo(() => (selectedKey ? selectedKey.split('\n') : []), [selectedKey])
  const order = useValue('lobby-export-order', () => controller.presenter.order(), [controller])
  const outline = useValue('lobby-export-outline', () => frameOutline(canvas), [canvas])
  const shapeCount = useValue('lobby-export-count', () => canvas.items().length, [canvas])
  // F9: who may export follows the board's current policy (the owner may just have changed it).
  const policySentence = useValue(
    'lobby-export-policy-sentence',
    () => exportPolicySentence(exportPolicyOn(boardId)),
    [boardId],
  )

  // F14: open on what the person is looking at. A selected frame, else the selection, else the frame
  // that fills the view, else the whole board (export-defaults.ts).
  const [opening] = useState(() => {
    const selectedFrame = selectedIds.find((id) => canvas.get(id)?.type === 'frame')
    const v = canvas.viewport.get()
    const viewed = frameInView({ x: v.x, y: v.y, w: v.width, h: v.height }, outline)
    const area: Area =
      selectedIds.length === 1 && selectedFrame
        ? 'frame'
        : selectedIds.length > 0
          ? 'selection'
          : viewed
            ? 'frame'
            : 'board'
    const frameId = selectedFrame ?? viewed ?? outline[0]?.id ?? ''
    const b =
      area === 'selection'
        ? canvas.boundsOf(selectedIds)
        : area === 'frame' && frameId
          ? canvas.bounds(frameId)
          : canvas.boundsOf()
    return { area, frameId, size: rectOf(b) }
  })
  const [area, setArea] = useState<Area>(opening.area)
  const [frameId, setFrameId] = useState<string>(opening.frameId)
  const [prefs, setPrefs] = useState<Prefs>(readPrefs)
  // The remembered size, stepped down for this opening only when that area would be too large to draw
  // (the stored preference stays what the person chose).
  const [scale, setScale] = useState<ImageScale>(() => openingScale(prefs.scale, IMAGE_SCALES, opening.size))
  const [includeSkipped, setIncludeSkipped] = useState(false)
  // RETRO-05b: the PDF's optional last pages. Never remembered: what goes into a file made for someone else
  // is chosen each time (the team-only threads above all).
  const [withResults, setWithResults] = useState(false)
  const [withComments, setWithComments] = useState(false)
  const [withTeamComments, setWithTeamComments] = useState(false)
  // F15: SVG embeds the board previews unless asked; not remembered, so a huge file is never the default.
  const [svgOriginals, setSvgOriginals] = useState(false)
  const [busy, setBusy] = useState<{ kind: BusyKind; done?: number; total?: number } | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const updatePrefs = (patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      writePrefs(next)
      return next
    })
  }

  // Board shortcuts listen above the dialog: keep keys typed in it (Delete on a focused button…) away.
  useEffect(() => {
    const dialog = rootRef.current?.closest('dialog')
    if (!dialog) return
    const stop = (e: KeyboardEvent) => e.stopPropagation()
    dialog.addEventListener('keydown', stop)
    return () => dialog.removeEventListener('keydown', stop)
  }, [])

  useEffect(() => {
    if (request.focus === 'pdf') pdfButton.current?.focus()
    else if (request.focus === 'csv') csvButton.current?.focus()
  }, [request])

  // Cancel a running PDF when the dialog goes away.
  useEffect(() => () => abortRef.current?.abort(), [])

  // Keep the chosen frame valid if it is deleted meanwhile.
  const frameExists = frameId !== '' && outline.some((f) => f.id === frameId)
  useEffect(() => {
    if (!frameExists && outline[0]) setFrameId(outline[0].id)
  }, [frameExists, outline])

  const hasSelection = selectedIds.length > 0
  const effectiveArea: Area =
    area === 'selection' && !hasSelection ? 'board' : area === 'frame' && !frameExists ? 'board' : area

  // The board's ids are read when an export starts (they change with every collaborator's edit).
  const imageTarget = (): ImageTarget => {
    if (effectiveArea === 'selection') {
      const ids = [...canvas.selection]
      const only = ids.length === 1 ? canvas.get(ids[0] as string) : undefined
      return only?.type === 'frame' ? frameTarget(canvas, only.id) : { ids, qualifier: 'selection' }
    }
    if (effectiveArea === 'frame' && frameId) return frameTarget(canvas, frameId)
    return { ids: [] }
  }

  const areaSize = useValue('lobby-export-bounds', () => {
    const b =
      effectiveArea === 'selection'
        ? canvas.boundsOf(canvas.selection)
        : effectiveArea === 'frame' && frameId
          ? canvas.bounds(frameId)
          : canvas.boundsOf()
    return b ? `${b.width}|${b.height}` : ''
  }, [canvas, effectiveArea, frameId])
  const areaBounds = useMemo(() => {
    if (!areaSize) return null
    const [w, h] = areaSize.split('|').map(Number)
    return { w: w ?? 0, h: h ?? 0 }
  }, [areaSize])

  const sizeHint = useMemo(() => {
    if (!areaBounds) return null
    const want = imagePixelSize(areaBounds.w, areaBounds.h, scale)
    return { want, reduced: exceedsCanvasLimits(want.width, want.height) }
  }, [areaBounds, scale])

  // The originals' total size, for the SVG option (the uploaded images in the chosen area).
  const originalsSize = useValue('lobby-export-originals-bytes', () => {
    const t: ImageTarget =
      effectiveArea === 'selection'
        ? { ids: [...canvas.selection] }
        : effectiveArea === 'frame' && frameId
          ? { ids: [frameId], frameId }
          : { ids: [] }
    return originalBytes(canvas, t)
  }, [canvas, effectiveArea, frameId])

  const imageQualifier =
    effectiveArea === 'selection'
      ? 'selection'
      : effectiveArea === 'frame'
        ? frameName(canvas, frameId) || 'frame'
        : undefined

  const byId = new Map(order.map((e) => [e.id, e]))
  const pdfPick = pickPdfFrames<string, ElementFrameEntry>(
    order,
    outline,
    selectedIds,
    (id) => skipCarrier(byId.get(id)),
    { includeSkipped },
  )
  const pdfPages: PdfPageSpec[] =
    pdfPick.frames.length > 0
      ? pdfPick.frames.map((frame, i) => ({ kind: 'frame', frame, title: slideTitle(frame.name, i) }))
      : shapeCount > 0
        ? [{ kind: 'board', title: boardTitle || 'Board' }]
        : []

  // RETRO-05b: what the optional pages would hold. The results are what this person sees on the board (a
  // revealed vote whose results are shown); the comments are the threads this person's own list holds.
  const commentsStore = commentsControllerOf(canvas)?.store ?? null
  const commentThreads = useValue(
    'lobby-export-comment-threads',
    () => (commentsStore ? Object.values(commentsStore.threads.get()) : []),
    [commentsStore],
  )
  const commentsStatus = useValue(
    'lobby-export-comments-status',
    () => (commentsStore ? commentsStore.status.get() : 'missing'),
    [commentsStore],
  )
  const onTheTeam = useValue('lobby-export-team', () => commentsStore?.privacy.get().teamOnly ?? false, [
    commentsStore,
  ])
  const authorsHidden = useValue(
    'lobby-export-authors-hidden',
    () => workshopSettingsOf(canvas).hideNoteAuthors,
    [canvas],
  )
  const voteResults = exportResults(canvas)
  // the page lists what is still on the board: every item that got votes may have been deleted since the reveal
  const resultRowCount = useValue('lobby-export-result-rows', () => {
    const results = exportResults(canvas)
    return results ? resultRows(results, (id) => describeElement(canvas, id)).rows.length : 0
  }, [canvas])
  const teamIncluded = withTeamComments && onTheTeam
  const commentCounts = countReportThreads(commentThreads, teamIncluded)
  const commentsAvailable = commentsStatus === 'ready' && commentCounts.open + commentCounts.resolved > 0
  const resultsAvailable = resultRowCount > 0
  const addResults = withResults && resultsAvailable
  const addComments = withComments && commentsAvailable
  const extraPages = [addResults ? 'a vote results page' : null, addComments ? 'a comments appendix' : null]
    .filter((x): x is string => x !== null)
    .join(' and ')

  /** The report pages the options ask for, laid out for the chosen page format (read fresh: it is a click). */
  const reportSpecs = (): { specs: PdfPageSpec[]; notShown: number } => {
    const specs: PdfPageSpec[] = []
    let notShown = 0
    if (addResults) {
      const results = exportResults(canvas)
      if (!results)
        throw new ExportProblem(
          'The vote results are not shown on this board any more, so there is no results page to add. Untick it, or show the results again.',
        )
      const { rows, missing } = resultRows(results, (id) => describeElement(canvas, id))
      if (rows.length === 0)
        throw new ExportProblem(
          'The items that got votes are no longer on the board, so there is no results page to add. Untick it.',
        )
      const made = reportPdfPages('Vote results', resultsBlocks(rows, missing), prefs.pdfFormat)
      specs.push(...made.specs)
      notShown += made.notShown
    }
    if (addComments) {
      if (commentsStore?.status.get() !== 'ready')
        throw new ExportProblem('The comments have not finished loading. Try again in a moment.')
      const opts = {
        authorsHidden: workshopSettingsOf(canvas).hideNoteAuthors,
        teamOnlyIncluded: withTeamComments && commentsStore.privacy.get().teamOnly,
      }
      const threads = reportThreads(
        Object.values(commentsStore.threads.get()),
        (anchor) => describeAnchor(canvas, anchor),
        opts,
      )
      const made = reportPdfPages('Comments', commentsBlocks(threads, opts), prefs.pdfFormat)
      specs.push(...made.specs)
      notShown += made.notShown
    }
    return { specs, notShown }
  }

  const run = async (kind: BusyKind, task: () => Promise<string>) => {
    setBusy({ kind })
    setStatus(null)
    try {
      const done = await task()
      setStatus({ tone: 'ok', text: done })
    } catch (e) {
      if (e instanceof ExportCancelled) setStatus({ tone: 'ok', text: 'Export cancelled.' })
      else if (e instanceof ExportProblem) setStatus({ tone: 'error', text: e.message })
      else {
        console.error('export failed', e)
        setStatus({
          tone: 'error',
          text: 'The export failed. Very large areas can exceed what the browser can draw: try a frame or a smaller selection.',
        })
      }
    } finally {
      setBusy(null)
      abortRef.current = null
    }
  }

  const exportImage = (format: 'png' | 'svg') =>
    run(format, async () => {
      const t = imageTarget()
      const blob =
        format === 'png'
          ? await renderPng(canvas, t, { scale, transparent: prefs.transparent })
          : await renderSvg(canvas, t, { transparent: prefs.transparent, originals: svgOriginals })
      const name = exportFilename(boardTitle, format, imageQualifier)
      downloadBlob(blob, name)
      return `Downloaded “${name}”.`
    })

  const copyImage = () => {
    // No await before copyPng: the clipboard write must start inside the click (Safari).
    setBusy({ kind: 'copy' })
    setStatus(null)
    copyPng(canvas, imageTarget(), { transparent: prefs.transparent })
      .then(
        () => setStatus({ tone: 'ok', text: 'Copied as PNG. Paste it into any app.' }),
        () =>
          setStatus({
            tone: 'error',
            text: 'The browser did not allow copying an image here. Download the PNG instead.',
          }),
      )
      .finally(() => setBusy(null))
  }

  const exportPdf = () => {
    const controllerAbort = new AbortController()
    abortRef.current = controllerAbort
    return run('pdf', async () => {
      // the frames' pages, then the optional report pages
      const extra = reportSpecs()
      const all = [...pdfPages, ...extra.specs]
      const blob = await renderPdf(canvas, all, {
        title: boardTitle,
        lossless: prefs.lossless,
        pageFormat: prefs.pdfFormat,
        signal: controllerAbort.signal,
        onProgress: ({ done, total }) => setBusy({ kind: 'pdf', done, total }),
      })
      const name = exportFilename(
        boardTitle,
        'pdf',
        pdfPick.source === 'selection' ? 'selected frames' : undefined,
      )
      downloadBlob(blob, name)
      const cut =
        extra.notShown > 0
          ? ` ${plural(extra.notShown, 'item')} did not fit the page limit of the results and comments pages and ${extra.notShown === 1 ? 'was' : 'were'} left out.`
          : ''
      return `Downloaded “${name}” (${plural(all.length, 'page')}).${cut}`
    })
  }

  const exportCsv = () =>
    run('csv', async () => {
      const ids = hasSelection
        ? new Set<string>(targetElements(canvas, { ids: [...canvas.selection] }).map((e) => e.id))
        : undefined
      // A revealed vote adds its counts (R14), as this person sees them on the board.
      const csv = boardCsv(canvas.items(), ids, { votes: exportResults(canvas), tagDefs: tagDefs(canvas) })
      const name = exportFilename(boardTitle, 'csv', ids ? 'selection' : undefined)
      downloadBlob(csvBlob(csv), name)
      return `Downloaded “${name}” (${plural(csvRowCount(csv), 'row')}).`
    })

  const disabled = busy !== null
  const pdfProgress = busy?.kind === 'pdf' && busy.total ? { done: busy.done ?? 0, total: busy.total } : null
  const nothing = shapeCount === 0

  return (
    <Dialog
      title="Export"
      description={`Download images, a PDF or the board's text. ${policySentence}`.trim()}
      onClose={() => {
        abortRef.current?.abort()
        onClose()
      }}
      testId="export-dialog"
      size="lg"
    >
      <div ref={rootRef} className="dr-pe-export">
        {nothing && (
          <p className="dr-pe-note" role="status">
            This board is empty: add something to export.
          </p>
        )}

        <section className="dr-pe-section" aria-labelledby={`${uid}-img`}>
          <h3 id={`${uid}-img`} className="dr-pe-section__title">
            Image
          </h3>
          <fieldset className="dr-pe-choices" disabled={disabled || nothing}>
            <legend className="dr-pe-legend">What to export</legend>
            <label className="dr-pe-choice">
              <input
                type="radio"
                name={`${uid}-area`}
                value="selection"
                data-testid="export-area-selection"
                checked={effectiveArea === 'selection'}
                disabled={!hasSelection}
                onChange={() => setArea('selection')}
              />
              Selection{hasSelection ? ` (${plural(selectedIds.length, 'object')})` : ' (nothing selected)'}
            </label>
            <label className="dr-pe-choice">
              <input
                type="radio"
                name={`${uid}-area`}
                value="frame"
                data-testid="export-area-frame"
                checked={effectiveArea === 'frame'}
                disabled={outline.length === 0}
                onChange={() => setArea('frame')}
              />
              Frame
              <select
                className="dr-input dr-select dr-select--compact dr-pe-frame-select"
                aria-label="Frame to export"
                data-testid="export-frame"
                value={frameId}
                disabled={outline.length === 0}
                onChange={(e) => {
                  setFrameId(e.target.value)
                  setArea('frame')
                }}
              >
                {outline.length === 0 && <option value="">No frames</option>}
                {outline.map((f, i) => (
                  <option key={f.id} value={f.id}>
                    {slideTitle(f.name, i)}
                  </option>
                ))}
              </select>
            </label>
            <label className="dr-pe-choice">
              <input
                type="radio"
                name={`${uid}-area`}
                value="board"
                data-testid="export-area-board"
                checked={effectiveArea === 'board'}
                onChange={() => setArea('board')}
              />
              Whole board
            </label>
          </fieldset>

          <div className="dr-pe-row">
            <label className="dr-pe-inline">
              Size
              <select
                className="dr-input dr-select dr-select--compact"
                data-testid="export-scale"
                value={scale}
                disabled={disabled}
                onChange={(e) => {
                  const next = Number(e.target.value) as ImageScale
                  setScale(next)
                  updatePrefs({ scale: next })
                }}
              >
                {IMAGE_SCALES.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
            <label className="dr-pe-inline">
              <input
                type="checkbox"
                data-testid="export-transparent"
                checked={prefs.transparent}
                disabled={disabled}
                onChange={(e) => updatePrefs({ transparent: e.target.checked })}
              />
              Transparent background
            </label>
            {sizeHint && (
              <span className="dr-pe-hint" data-testid="export-size-hint">
                PNG ≈ {fmt.format(sizeHint.want.width)} × {fmt.format(sizeHint.want.height)} px
              </span>
            )}
          </div>
          {sizeHint?.reduced && (
            <p className="dr-pe-note dr-pe-note--warn" data-testid="export-size-warning">
              That is larger than browsers can reliably draw (about 16,000 px per side), so the PNG may come
              out smaller. For more detail, choose a smaller size or export frames one at a time.
            </p>
          )}
          <div className="dr-pe-actions">
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm"
              data-testid="export-png"
              disabled={disabled || nothing}
              onClick={() => void exportImage('png')}
            >
              {busy?.kind === 'png' ? 'Preparing PNG…' : 'Download PNG'}
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="export-svg"
              disabled={disabled || nothing}
              onClick={() => void exportImage('svg')}
            >
              {busy?.kind === 'svg' ? 'Preparing SVG…' : 'Download SVG'}
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="export-copy-png"
              disabled={disabled || nothing}
              onClick={copyImage}
              title="Ctrl/Cmd+Shift+C copies the selection as a PNG"
            >
              {busy?.kind === 'copy' ? 'Copying…' : 'Copy as PNG'}
            </button>
          </div>
          <label className="dr-pe-inline">
            <input
              type="checkbox"
              data-testid="export-svg-originals"
              checked={svgOriginals}
              disabled={disabled}
              onChange={(e) => setSvgOriginals(e.target.checked)}
            />
            SVG: embed the original uploads
            {originalsSize > 0 ? ` (large: about ${formatBytes(originalsSize)})` : ' (large file)'}
          </label>
          <p className="dr-pe-hint" data-testid="export-image-source">
            {svgOriginals
              ? 'PNG, Copy and SVG use the original uploads.'
              : 'PNG and Copy use the original uploads. SVG embeds sharp previews, so the file stays small enough to share.'}
          </p>
        </section>

        <section className="dr-pe-section" aria-labelledby={`${uid}-pdf`}>
          <h3 id={`${uid}-pdf`} className="dr-pe-section__title">
            PDF
          </h3>
          <p className="dr-pe-text" data-testid="export-pdf-summary">
            {pdfPick.frames.length === 0
              ? nothing
                ? 'Nothing to export yet.'
                : 'No frames yet: the PDF will be one page with the whole board.'
              : pdfPick.source === 'selection'
                ? `The selected frames, one page each (${plural(pdfPages.length, 'page')}).`
                : `One page per frame, in presentation order (${plural(pdfPages.length, 'page')}).`}
            {extraPages ? ` Then ${extraPages} at the end.` : ''}
          </p>
          {pdfPick.source === 'all' && pdfPick.skippedCount > 0 && (
            <label className="dr-pe-inline">
              <input
                type="checkbox"
                data-testid="export-pdf-include-skipped"
                checked={includeSkipped}
                disabled={disabled}
                onChange={(e) => setIncludeSkipped(e.target.checked)}
              />
              Include {plural(pdfPick.skippedCount, 'frame')} set to skip in presentation
            </label>
          )}
          <label className="dr-pe-inline">
            Page size
            <select
              className="dr-input dr-select dr-select--compact"
              data-testid="export-pdf-page-size"
              value={prefs.pdfFormat}
              disabled={disabled}
              onChange={(e) => {
                if (isPdfPageFormat(e.target.value)) updatePrefs({ pdfFormat: e.target.value })
              }}
            >
              {PDF_PAGE_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="dr-pe-inline">
            <input
              type="checkbox"
              data-testid="export-pdf-lossless"
              checked={prefs.lossless}
              disabled={disabled}
              onChange={(e) => updatePrefs({ lossless: e.target.checked })}
            />
            Lossless images (larger file, slower)
          </label>
          <fieldset className="dr-pe-choices" data-testid="export-pdf-extras" disabled={disabled}>
            <legend className="dr-pe-legend">Add to the end of the PDF</legend>
            <label className="dr-pe-choice">
              <input
                type="checkbox"
                data-testid="export-pdf-results"
                checked={addResults}
                disabled={!resultsAvailable}
                onChange={(e) => setWithResults(e.target.checked)}
              />
              Vote results page
            </label>
            {!resultsAvailable && (
              <p className="dr-pe-hint" data-testid="export-pdf-results-hint">
                {voteResults
                  ? 'The items that got votes are no longer on the board, so there is nothing to list.'
                  : 'Nothing to add yet: reveal a vote and show its results on the board first.'}
              </p>
            )}
            <label className="dr-pe-choice">
              <input
                type="checkbox"
                data-testid="export-pdf-comments"
                checked={addComments}
                disabled={!commentsAvailable}
                onChange={(e) => setWithComments(e.target.checked)}
              />
              Comments appendix
              {commentsAvailable ? ` (${commentCounts.open} open, ${commentCounts.resolved} resolved)` : ''}
            </label>
            {!commentsAvailable && (
              <p className="dr-pe-hint" data-testid="export-pdf-comments-hint">
                {commentsStatus === 'ready'
                  ? 'There are no comments to add.'
                  : commentsStatus === 'loading'
                    ? 'The comments are still loading.'
                    : 'The comments could not be loaded.'}
              </p>
            )}
            {onTheTeam && commentCounts.teamOnly > 0 && (
              <label className="dr-pe-choice">
                <input
                  type="checkbox"
                  data-testid="export-pdf-team-comments"
                  checked={teamIncluded}
                  onChange={(e) => setWithTeamComments(e.target.checked)}
                />
                Include {plural(commentCounts.teamOnly, 'team-only thread')} (internal: leave off for a file
                you send to a client)
              </label>
            )}
            {addComments && authorsHidden && (
              <p className="dr-pe-hint" data-testid="export-pdf-authors-hint">
                This board hides note authors, so the appendix lists the comments without who wrote them.
              </p>
            )}
          </fieldset>
          <p className="dr-pe-hint">
            Every page has a header with its frame’s name (also a PDF bookmark). “Fit each frame” sizes each
            page to its frame; 16:9 and A4 give every page the same landscape size with the frame fitted in.
            Pages are sharp images of your frames (drawn from the original uploads). Text is searchable and
            can be copied, but it is not editable vector text.
          </p>
          <div className="dr-pe-actions">
            <button
              ref={pdfButton}
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm"
              data-testid="export-pdf"
              disabled={disabled || pdfPages.length === 0}
              onClick={() => void exportPdf()}
            >
              {busy?.kind === 'pdf' ? 'Rendering PDF…' : 'Download PDF'}
            </button>
            {busy?.kind === 'pdf' && (
              <button
                type="button"
                className="dr-btn dr-btn--sm"
                data-testid="export-cancel"
                onClick={() => abortRef.current?.abort()}
              >
                Cancel
              </button>
            )}
          </div>
          {pdfProgress && (
            <div className="dr-pe-progress">
              <progress
                data-testid="export-progress"
                max={pdfProgress.total}
                value={pdfProgress.done}
                aria-label="PDF export progress"
              />
              <span>
                {pdfProgress.done < pdfProgress.total
                  ? `Rendering page ${fmt.format(pdfProgress.done + 1)} of ${fmt.format(pdfProgress.total)}…`
                  : 'Saving the file…'}
              </span>
            </div>
          )}
        </section>

        <section className="dr-pe-section" aria-labelledby={`${uid}-csv`}>
          <h3 id={`${uid}-csv`} className="dr-pe-section__title">
            CSV
          </h3>
          <p className="dr-pe-text">
            {hasSelection
              ? `The text of the selection (${plural(selectedIds.length, 'object')} and what they contain): one row per object with its type, frame, color, position and tags.`
              : 'The text of every object on the board: one row per object with its type, frame, color, position and tags.'}
          </p>
          <div className="dr-pe-actions">
            <button
              ref={csvButton}
              type="button"
              className="dr-btn dr-btn--sm"
              data-testid="export-csv"
              disabled={disabled || nothing}
              onClick={() => void exportCsv()}
            >
              Download CSV
            </button>
          </div>
        </section>

        <p
          className={`dr-pe-status${status?.tone === 'error' ? ' dr-pe-status--error' : ''}`}
          data-testid="export-status"
          role={status?.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {status?.text ?? ''}
        </p>
      </div>
    </Dialog>
  )
}
