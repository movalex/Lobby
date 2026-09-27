// The Export dialog: PNG/SVG of the selection, a frame or the whole board (1×/2×/4×, transparent
// background), copy as PNG, a PDF with one page per frame, and CSV of the board's text.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { type Editor, type TLShape, type TLShapeId, useValue } from 'tldraw'
import { Dialog } from '../../ui/Dialog.tsx'
import { type FrameEntry, frameOutline } from './board-ops.ts'
import type { Controller, ExportRequest } from './controller.ts'
import { boardCsv, csvBlob, csvRowCount } from './csv-export.ts'
import { downloadBlob } from './download.ts'
import {
  copyPng,
  ExportCancelled,
  IMAGE_SCALES,
  type ImageScale,
  type PdfPageSpec,
  renderPdf,
  renderPng,
  renderSvg,
} from './export-render.ts'
import { exportFilename } from './filename.ts'
import {
  exceedsCanvasLimits,
  imagePixelSize,
  isPdfPageFormat,
  PDF_PAGE_FORMATS,
  type PdfPageFormat,
} from './pdf-layout.ts'
import { frameRecords } from './present-session.ts'
import { pickPdfFrames, slideTitle } from './slides.ts'

type Area = 'selection' | 'frame' | 'board'
type BusyKind = 'png' | 'svg' | 'copy' | 'pdf' | 'csv'

interface Prefs {
  scale: ImageScale
  transparent: boolean
  lossless: boolean
  pdfFormat: PdfPageFormat
}

const PREFS_KEY = 'draftroom.export.v1'
const DEFAULT_PREFS: Prefs = { scale: 2, transparent: false, lossless: false, pdfFormat: 'fit' }

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

function frameName(editor: Editor, id: TLShapeId | ''): string {
  if (!id) return ''
  const shape = editor.getShape(id) as TLShape | undefined
  const name = (shape?.props as { name?: unknown } | undefined)?.name
  return typeof name === 'string' ? name : ''
}

export function ExportDialog({
  editor,
  controller,
  request,
  boardTitle,
  onClose,
}: {
  editor: Editor
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

  // Live board facts (the dialog is modal, but collaborators keep editing).
  const selectedIds = useValue('dr-export-selection', () => editor.getSelectedShapeIds(), [editor])
  const order = useValue('dr-export-order', () => controller.presenter.order(), [controller])
  const outline = useValue(
    'dr-export-outline',
    () => frameOutline(frameRecords(editor), editor.getCurrentPageId()),
    [editor],
  )
  const shapeCount = useValue('dr-export-count', () => editor.getCurrentPageShapeIds().size, [editor])

  const [area, setArea] = useState<Area>(() => {
    if (selectedIds.length === 1 && editor.getShape(selectedIds[0] as TLShapeId)?.type === 'frame')
      return 'frame'
    return selectedIds.length > 0 ? 'selection' : 'board'
  })
  const [frameId, setFrameId] = useState<TLShapeId | ''>(() => {
    const selectedFrame = selectedIds.find((id) => editor.getShape(id)?.type === 'frame')
    return selectedFrame ?? outline[0]?.id ?? ''
  })
  const [prefs, setPrefs] = useState<Prefs>(readPrefs)
  const [includeSkipped, setIncludeSkipped] = useState(false)
  const [busy, setBusy] = useState<{ kind: BusyKind; done?: number; total?: number } | null>(null)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const updatePrefs = (patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      writePrefs(next)
      return next
    })
  }

  // Board shortcuts listen on <body>: keep keys typed in the dialog (Delete on a focused button…) away.
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
  const imageIds = (): TLShapeId[] => {
    if (effectiveArea === 'selection') return [...editor.getSelectedShapeIds()]
    if (effectiveArea === 'frame' && frameId) return [frameId]
    return [...editor.getCurrentPageShapeIds()]
  }

  const areaBounds = useValue('dr-export-bounds', () => {
    const b =
      effectiveArea === 'selection'
        ? editor.getSelectionPageBounds()
        : effectiveArea === 'frame' && frameId
          ? editor.getShapePageBounds(frameId)
          : editor.getCurrentPageBounds()
    return b ? { w: b.w, h: b.h } : null
  }, [editor, effectiveArea, frameId])

  const sizeHint = useMemo(() => {
    if (!areaBounds) return null
    const want = imagePixelSize(areaBounds.w, areaBounds.h, prefs.scale)
    return { want, reduced: exceedsCanvasLimits(want.width, want.height) }
  }, [areaBounds, prefs.scale])

  const imageQualifier =
    effectiveArea === 'selection'
      ? 'selection'
      : effectiveArea === 'frame'
        ? frameName(editor, frameId) || 'frame'
        : undefined

  const shapeOf = (id: TLShapeId) => editor.getShape(id) as TLShape | undefined
  const pdfPick = pickPdfFrames(order, outline, selectedIds, shapeOf, { includeSkipped })
  const pdfPages: PdfPageSpec[] =
    pdfPick.frames.length > 0
      ? pdfPick.frames.map((frame: FrameEntry, i) => ({
          kind: 'frame',
          frame,
          title: slideTitle(frame.name, i),
        }))
      : shapeCount > 0
        ? [{ kind: 'board', title: boardTitle || 'Board' }]
        : []

  const run = async (kind: BusyKind, task: () => Promise<string>) => {
    setBusy({ kind })
    setStatus(null)
    try {
      const done = await task()
      setStatus({ tone: 'ok', text: done })
    } catch (e) {
      if (e instanceof ExportCancelled) setStatus({ tone: 'ok', text: 'Export cancelled.' })
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
      const blob =
        format === 'png'
          ? await renderPng(editor, imageIds(), { scale: prefs.scale, transparent: prefs.transparent })
          : await renderSvg(editor, imageIds(), { transparent: prefs.transparent })
      const name = exportFilename(boardTitle, format, imageQualifier)
      downloadBlob(blob, name)
      return `Downloaded “${name}”.`
    })

  const copyImage = () => {
    // No await before copyPng: the clipboard write must start inside the click (Safari).
    setBusy({ kind: 'copy' })
    setStatus(null)
    copyPng(editor, imageIds(), { transparent: prefs.transparent })
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
      const blob = await renderPdf(editor, pdfPages, {
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
      return `Downloaded “${name}” (${plural(pdfPages.length, 'page')}).`
    })
  }

  const exportCsv = () =>
    run('csv', async () => {
      const ids = hasSelection
        ? new Set<string>(editor.getShapeAndDescendantIds(editor.getSelectedShapeIds()))
        : undefined
      const csv = boardCsv(editor.store.allRecords(), ids)
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
      description="Download images, a PDF or the board's text. Everyone who can view the board can export it."
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
                  setFrameId(e.target.value as TLShapeId)
                  setArea('frame')
                }}
              >
                {outline.length === 0 && <option value="">No frames</option>}
                {outline.map((f, i) => (
                  <option key={f.id} value={f.id}>
                    {`${' '.repeat(Math.min(f.depth, 4))}${slideTitle(f.name, i)}`}
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
                value={prefs.scale}
                disabled={disabled}
                onChange={(e) => updatePrefs({ scale: Number(e.target.value) as ImageScale })}
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
          <p className="dr-pe-hint">
            Images use the original uploads, not the smaller previews shown on the board.
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
              ? `The text of the selection (${plural(selectedIds.length, 'object')} and what they contain): one row per object with its type, frame, colour and position.`
              : 'The text of every object on the board: one row per object with its type, frame, colour and position.'}
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
