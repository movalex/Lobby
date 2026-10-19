// scripts/licence-check.mjs, the model rule (wave W, docs/WAVE-W-CONTRACTS.md §4.2): every model a Lobby process may
// load is in apps/worker/models/MODELS.json with a permissive licence, an https source and a pinned (or not yet
// pinned) sha256; any weights file in the repository must be one of them, byte for byte. The real manifest passes,
// and the repository holds no weights file.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BG_MODEL } from '../apps/worker/src/ops/bg-model.ts'
import { findModelFiles, MODEL_EXT, MODELS_MANIFEST, modelFindings } from './licence-check.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL(`../${MODELS_MANIFEST}`, import.meta.url), 'utf8'))
const SHA = 'a'.repeat(64)

describe('the model rule', () => {
  it('the real manifest names u2netp (Apache-2.0, pinned as the worker pins it) and the repository has no weights file', () => {
    expect(manifest.models.map((m: { id: string }) => m.id)).toEqual(['u2netp'])
    // pinned since the owner approved the file (1da6816f); the manifest and BG_MODEL stay in step
    expect(manifest.models[0]).toMatchObject({ licence: 'Apache-2.0', sha256: BG_MODEL.sha256 })
    expect(manifest.models[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(findModelFiles(ROOT)).toEqual([])
    expect(modelFindings([], manifest)).toEqual([])
  })

  it('knows the usual weights extensions', () => {
    for (const f of ['m.onnx', 'm.ORT', 'm.pth', 'm.pt', 'm.safetensors', 'm.tflite', 'm.gguf'])
      expect(MODEL_EXT.test(f), f).toBe(true)
    for (const f of ['m.json', 'm.ts', 'onnx.md']) expect(MODEL_EXT.test(f), f).toBe(false)
  })

  it('refuses a non-permissive or missing licence, a missing source, a malformed hash, and no manifest', () => {
    const one = (m: Record<string, unknown>) =>
      modelFindings([], { models: [{ id: 'x', source: 'https://x', sha256: null, ...m }] })
    expect(one({ licence: 'CC-BY-NC-4.0' })[0]?.why).toMatch(/not permissive/)
    expect(one({ licence: 'AGPL-3.0' })[0]?.why).toMatch(/not permissive/)
    expect(one({})[0]?.why).toMatch(/not permissive/)
    expect(one({ licence: 'MIT', source: 'http://x' })[0]?.why).toMatch(/no https source/)
    expect(one({ licence: 'MIT', sha256: 'abc' })[0]?.why).toMatch(/neither null/)
    expect(one({ licence: 'MIT' })).toEqual([])
    expect(modelFindings([], null)[0]?.why).toMatch(/missing/)
  })

  it('a weights file in the repository must be in the manifest with its exact hash', () => {
    const m = {
      models: [
        { id: 'x', licence: 'MIT', source: 'https://x', sha256: SHA, path: 'apps/worker/models/x.onnx' },
      ],
    }
    expect(modelFindings([{ path: 'apps/worker/models/x.onnx', sha256: SHA }], m)).toEqual([])
    expect(modelFindings([{ path: 'apps/worker/models/x.onnx', sha256: 'b'.repeat(64) }], m)[0]?.why).toMatch(
      /not the manifest/,
    )
    expect(modelFindings([{ path: 'stray/y.onnx', sha256: SHA }], m)[0]?.why).toMatch(
      /not in the models manifest/,
    )
  })
})
