// Worker-local knobs. Product limits shared with apps/sync and apps/web live in
// @draftroom/dev-assets LIMITS; these are rendering choices and tool budgets.

export const PREVIEW = {
  thumbEdge: 512,
  displayEdge: 2048,
  pdfPageWidth: 1024,
  /** Longest canvas edge for a PDF page. Canvas memory is native (not covered by --max-old-space-size); an unclamped 14400 pt page reached 926 MB RSS in research. */
  pdfMaxEdge: 4096,
  posterMaxEdge: 1280,
  thumbQuality: 80,
  displayQuality: 82,
  pageQuality: 82,
  sharpTimeoutSeconds: 20,
  /** Default V8 heap cap of the PDF child (--max-old-space-size); WORKER_PDF_HEAP_MB overrides it. */
  pdfChildHeapMb: 384,
  /**
   * Default resident-memory cap of the PDF child (previews and render-pages), WORKER_PDF_RSS_MB overrides it. The heap
   * flag bounds only V8: pdf.js keeps decompressed streams outside it (a 1.5 MB PDF reached 3.3 GB). Enforced on Linux
   * only (run.ts): a child over it is killed and the file fails for good. The same 768 MB as the pdf-text child's
   * FILE_TEXT_LIMITS.childRssMb.
   */
  pdfChildRssMb: 768,
  pdfEmbeddedImagePixels: 100_000_000,
  probeTimeoutMs: 15_000,
  posterTimeoutMs: 30_000,
  maxProbeStdoutBytes: 1024 * 1024,
  maxPosterStdoutBytes: 32 * 1024 * 1024,
  maxVideoWidth: 3840,
  maxVideoHeight: 2160,
} as const

export const WORKER = {
  /** Idle poll (docs/M3-STORAGE-CONTRACTS.md §5): doubles while idle, with jitter, up to pollMaxMs. */
  pollMs: 2_000,
  pollMaxMs: 15_000,
  concurrency: 1,
  /** Remote lease heartbeat: every leaseMs/4, never more than 30 s apart (contract: ≤ 30 s). */
  heartbeatMaxMs: 30_000,
  heartbeatMinMs: 250,
  /** Touch of the job's claim file inside its temporary local layout (processJob.ts). */
  localTouchMs: 2_000,
  shutdownGraceMs: 10_000,
  /** One /api/worker/* JSON call (claim, heartbeat, reserve, complete, retry). */
  requestTimeoutMs: 15_000,
  /** Download of the original: no bytes for this long aborts it... */
  downloadStallMs: 30_000,
  /** ...and the whole transfer may take 60 s plus 1 s per MB (500 MB video: about 9 minutes). */
  downloadBaseMs: 60_000,
  downloadMsPerMb: 1_000,
  /** One derivative PUT (derivatives are a few MB at most). */
  uploadTimeoutMs: 60_000,
  /** Leftover job directories (a crashed process) older than this are removed at startup. */
  tmpSweepAgeMs: 60 * 60_000,
} as const
