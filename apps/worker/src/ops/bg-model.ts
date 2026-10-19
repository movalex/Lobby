// Wave W (docs/WAVE-W-CONTRACTS.md §4.2): the background-removal model file. OWNER: the wave W lead.
//
// The model is NEVER downloaded by Lobby, at build or at run time. The owner places the file once (a separately
// approved download) and points DRAFTROOM_BG_MODEL_PATH at it; the worker checks it against the pinned sha256 below
// before it reports the remove-bg capability. Missing, unreadable, too large, unpinned or a different hash: the
// capability is not reported, so the api never offers or hands out background removal (features/formats/offer.ts).
// Tests use a tiny synthetic model (test/tiny-onnx.ts) with its own hash passed in, never the real file.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** The one model wave W runs: U²-Net small (Apache-2.0, xuebinqin/U-2-Net), 320 × 320 input. */
export const BG_MODEL = {
  id: 'u2netp',
  file: 'u2netp.onnx',
  licence: 'Apache-2.0',
  inputSize: 320,
  /** the published file is about 4.6 MB; anything far larger is not it */
  maxBytes: 16 * 1024 * 1024,
  /**
   * TODO(owner, wave W WS2): the sha256 of the approved u2netp.onnx, filled in when the owner has downloaded and
   * checked the file (docs/WAVE-W-CONTRACTS.md §11, open decision 1). While it is null no file passes the check, so the
   * remove-bg capability is never reported: background removal stays off whatever DRAFTROOM_REMOVE_BACKGROUND says.
   */
  sha256: null as string | null,
} as const

export type BgModelCheck =
  | { ok: true; path: string; sha256: string; bytes: number }
  | { ok: false; reason: 'unset' | 'not-absolute' | 'missing' | 'too-large' | 'unpinned' | 'hash-mismatch' }

/**
 * Checks the configured model file. `expectedSha256` defaults to the pin above (tests pass the tiny model's). Reads
 * the file once (it is small); the bytes are returned by `loadBgModel` to the child process only.
 */
export function checkBgModel(
  path: string | null | undefined,
  expectedSha256: string | null = BG_MODEL.sha256,
): BgModelCheck {
  if (!path) return { ok: false, reason: 'unset' }
  if (!isAbsolute(path)) return { ok: false, reason: 'not-absolute' }
  let bytes: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return { ok: false, reason: 'missing' }
    bytes = st.size
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (bytes > BG_MODEL.maxBytes) return { ok: false, reason: 'too-large' }
  if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) return { ok: false, reason: 'unpinned' }
  let sha: string
  try {
    sha = createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (sha !== expectedSha256) return { ok: false, reason: 'hash-mismatch' }
  return { ok: true, path, sha256: sha, bytes }
}

/** The model's bytes, re-checked (the file could have changed since start-up). Child process only. */
export function loadBgModel(path: string, expectedSha256: string | null = BG_MODEL.sha256): Uint8Array {
  const check = checkBgModel(path, expectedSha256)
  if (!check.ok) throw new Error(`background model unusable: ${check.reason}`)
  const buf = readFileSync(path)
  if (createHash('sha256').update(buf).digest('hex') !== check.sha256)
    throw new Error('background model changed')
  return new Uint8Array(buf)
}
