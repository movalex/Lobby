// Worker protocol (docs/M3-STORAGE-CONTRACTS.md §4): request bodies, limits and timings of the
// /api/worker/* routes. Workers are semi-trusted (they hold DRAFTROOM_WORKER_TOKEN) but every value
// they send is still validated: it ends up in rows the browser reads. Unknown body keys are ignored
// (stripped), so a newer worker can send extra fields without breaking an older api.

import { LIMITS, type ProbeFacts } from '@draftroom/dev-assets'
import { z } from 'zod'

/** Lease length handed out by claim and extended by each heartbeat (workers beat every ≤ 30 s). */
export const LEASE_MS = 120_000
/** Presigned / fs-mode blob URLs live this long (contract maximum 900 s). */
export const BLOB_URL_TTL_SEC = 900
/** Reservations per job attempt: eager PDF pages + cover thumb + display/poster, with headroom. */
export const MAX_DERIVATIVES_PER_JOB = 32
/** One preview image (2048 px WebP/PNG is a few MB; this is a sanity cap, not a quality target). */
export const MAX_DERIVATIVE_BYTES = 32 * 1024 * 1024
export const MAX_DERIVATIVE_EDGE = 16_384

export const MAX_ATTEMPTS: number = LIMITS.maxAttempts

/**
 * Delay before a transiently failed job may be claimed again: 15 s, 60 s, 4 min, … capped at 15 min.
 * `attempt` is the attempt that just failed (1-based).
 */
export function backoffMs(attempt: number): number {
  return Math.min(15_000 * 4 ** Math.max(0, attempt - 1), 15 * 60_000)
}

// Hostnames, container ids, "nas-1:slot-2": no spaces or control characters.
export const WorkerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/, 'invalid workerId')

/**
 * Optional on every lease-bound call: the `attempt` the claim returned. Two slots of ONE worker share
 * a workerId; the attempt tells a stale slot (whose lease expired and was reclaimed by a sibling) from
 * the current one.
 */
const Attempt = z.number().int().min(1).max(1_000).optional()

export const ClaimInput = z.object({ workerId: WorkerId })

export const HeartbeatInput = z.object({ workerId: WorkerId, attempt: Attempt })

const Dimension = z.number().int().min(1).max(MAX_DERIVATIVE_EDGE)

export const ReserveInput = z
  .object({
    workerId: WorkerId,
    attempt: Attempt,
    role: z.enum(['thumb', 'display', 'page', 'poster']),
    page: z.number().int().min(1).max(LIMITS.maxPdfPages).nullable().optional(),
    mimeType: z.enum(['image/webp', 'image/png']),
    width: Dimension,
    height: Dimension,
    bytes: z.number().int().min(1).max(MAX_DERIVATIVE_BYTES),
  })
  .refine((v) => v.role !== 'page' || typeof v.page === 'number', {
    message: 'page is required for role page',
    path: ['page'],
  })

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/

export const CompleteInput = z
  .object({
    workerId: WorkerId,
    attempt: Attempt,
    status: z.enum(['ready', 'failed']),
    /** Type confirmed by content (magic bytes); null/absent keeps the upload-time type. */
    mimeType: z.string().regex(MIME_RE).nullable().optional(),
    /** ProbeFacts (see sanitizeProbe). */
    probe: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Reserved derivative ids to publish, in display order (ignored when status is 'failed'). */
    derivatives: z
      .array(z.string().regex(/^drv_[0-9A-Za-z]{10,40}$/))
      .max(MAX_DERIVATIVES_PER_JOB)
      .default([]),
    /** The worker's failure code; its own message is never shown (see userFailure). */
    error: z
      .object({ code: z.string().max(64), message: z.string().max(2_000).optional() })
      .nullable()
      .optional(),
  })
  .refine((v) => new Set(v.derivatives).size === v.derivatives.length, {
    message: 'derivatives must be distinct',
    path: ['derivatives'],
  })

export const RetryInput = z.object({
  workerId: WorkerId,
  attempt: Attempt,
  /** Operator detail for preview_jobs.last_error (never shown to users, never logged). */
  error: z
    .union([
      z.string().max(2_000),
      z.object({ code: z.string().max(64).optional(), message: z.string().max(2_000).optional() }),
    ])
    .nullable()
    .optional(),
  /**
   * Extension for graceful shutdown (§5 "finish or release"): hand the job back right away without
   * counting the attempt or waiting for a backoff.
   */
  release: z.boolean().optional(),
})

export type ClaimInput = z.infer<typeof ClaimInput>
export type HeartbeatInput = z.infer<typeof HeartbeatInput>
export type ReserveInput = z.infer<typeof ReserveInput>
export type CompleteInput = z.infer<typeof CompleteInput>
export type RetryInput = z.infer<typeof RetryInput>

/**
 * ProbeFacts as stored: exactly the six known keys. Lenient on purpose (a probe value must never be the
 * reason a finished job cannot complete): unknown keys are dropped, numbers rounded, anything malformed
 * becomes null.
 */
export function sanitizeProbe(raw: unknown): ProbeFacts {
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
      ? Math.round(v)
      : null
  const codec = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null)
  return {
    width: count(src.width),
    height: count(src.height),
    pageCount: count(src.pageCount),
    durationMs: count(src.durationMs),
    videoCodec: codec(src.videoCodec),
    audioCodec: codec(src.audioCodec),
  }
}

/** The fixed, user-safe messages (same wording as apps/worker/src/errors.ts). */
export const FAILURE_MESSAGES: Record<string, string> = {
  IMAGE_TOO_LARGE: 'This image is too large to preview. You can still download it.',
  IMAGE_INVALID: 'This image could not be previewed. It may be damaged or in an unsupported format.',
  TYPE_MISMATCH: "The file's contents do not match its file type, so no preview was made.",
  PDF_ENCRYPTED: 'This PDF is password-protected. Download it to view it.',
  PDF_INVALID: 'This PDF could not be read. It may be damaged or incomplete.',
  PDF_TOO_MANY_PAGES: 'This PDF has too many pages to preview. You can still download it.',
  UNSUPPORTED_CODEC: 'This video format cannot be played here yet. You can still download it.',
  VIDEO_INVALID: 'This video could not be read. It may be damaged or incomplete.',
  VIDEO_TOO_LONG: 'This video is too long to preview. You can still download it.',
  FILE_TOO_LARGE: 'This file is larger than the preview limit. You can still download it.',
  FILE_MISSING: 'The uploaded file is missing. Try uploading it again.',
  TIMEOUT: 'Making the preview took too long. You can still download the file.',
  INTERNAL: 'The preview could not be made. Try uploading the file again.',
}

/** A worker-reported failure as the { code, message } users see: unknown codes become INTERNAL. */
export function userFailure(code: string | null | undefined): { code: string; message: string } {
  const known = code && Object.hasOwn(FAILURE_MESSAGES, code) ? code : 'INTERNAL'
  return { code: known, message: FAILURE_MESSAGES[known] as string }
}
