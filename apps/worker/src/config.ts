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
  pdfChildHeapMb: 512,
  pdfEmbeddedImagePixels: 100_000_000,
  probeTimeoutMs: 15_000,
  posterTimeoutMs: 30_000,
  maxProbeStdoutBytes: 1024 * 1024,
  maxPosterStdoutBytes: 32 * 1024 * 1024,
  maxVideoWidth: 3840,
  maxVideoHeight: 2160,
} as const

export const WORKER = {
  pollMs: 500,
  requeueEveryMs: 10_000,
  /** Contract: heartbeat at most every 5 s; staleProcessingMs (120 s) is far above this. */
  heartbeatMs: 2_000,
  shutdownGraceMs: 10_000,
} as const
