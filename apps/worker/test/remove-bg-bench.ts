// Wave W, WS2 (docs/WAVE-W-CONTRACTS.md §4.5): the NAS measurement of background removal, run by hand in a throwaway
// container (never part of `pnpm test`: no .test.ts suffix). `node apps/worker/test/remove-bg-bench.ts [runs]`.
//
// It runs the REAL child (src/ops/bg-child.ts, spawned exactly as src/ops/remove-bg.ts does: the 256 MB V8 heap, the
// minimal environment, the request on stdin) with a STAND-IN model shaped like u2netp (test/standin-u2netp.ts: the same
// input and output, about the same parameter count and file size; NOT the real model, which nobody has downloaded),
// on synthetic pictures: 4096 × 4096 (the output edge), and 7300 × 5450 (39.8 MP, the input limit, scaled to 4096).
// For each run: the wall time, the child's own timings (decode to mask, the model), its peak RSS (VmHWM, read from
// /proc while it runs) and, in a container, the cgroup's memory.peak. Prints one JSON line per run and a summary.
// Linux only for the RSS (Windows reports the time alone).

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { REMOVE_BG_LIMITS } from '@draftroom/contracts'
import sharp from 'sharp'
import { BG_CHILD, type BgChildRequest, type BgChildResponse } from '../src/ops/remove-bg.ts'
import { childEnv } from '../src/run.ts'
import { standinU2netp } from './standin-u2netp.ts'
import { tinyMaskModel } from './tiny-onnx.ts'

const runs = Number(process.argv[2] ?? 3)
const dir = mkdtempSync(join(tmpdir(), 'drw-bgbench-'))
const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v)}\n`)

const readNum = (path: string): number | null => {
  try {
    const v = readFileSync(path, 'utf8').trim()
    return /^\d+$/.test(v) ? Number(v) : null
  } catch {
    return null
  }
}
const hwmKb = (pid: number): number | null => {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

async function picture(width: number, height: number): Promise<Buffer> {
  // a noisy background with a bright disc, drawn from raw pixels: realistic entropy for the decoder and the PNG encoder
  const raw = Buffer.alloc(width * height * 3)
  let s = 12345
  const cx = width / 2
  const cy = height / 2
  const r2 = (Math.min(width, height) / 3) ** 2
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      s = (s * 1103515245 + 12345) >>> 0
      const i = (y * width + x) * 3
      const inside = (x - cx) ** 2 + (y - cy) ** 2 < r2
      const base = inside ? 220 : 40
      raw[i] = base + ((s >>> 8) & 31)
      raw[i + 1] = base - 10 + ((s >>> 13) & 31)
      raw[i + 2] = base - 20 + ((s >>> 18) & 31)
    }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer()
}

function runChild(
  req: BgChildRequest,
): Promise<{ res: BgChildResponse | null; ms: number; hwmMb: number | null }> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${REMOVE_BG_LIMITS.childHeapMb}`, BG_CHILD],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(),
      },
    )
    let hwm: number | null = null
    const poll = setInterval(() => {
      const v = child.pid ? hwmKb(child.pid) : null
      if (v !== null) hwm = Math.max(hwm ?? 0, v)
    }, 20)
    const chunks: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => chunks.push(b))
    child.stderr.on('data', () => {})
    const kill = setTimeout(() => child.kill('SIGKILL'), REMOVE_BG_LIMITS.childTimeoutMs)
    child.on('close', () => {
      clearInterval(poll)
      clearTimeout(kill)
      let res: BgChildResponse | null = null
      try {
        res = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BgChildResponse
      } catch {}
      resolve({
        res,
        ms: Math.round(performance.now() - t0),
        hwmMb: hwm === null ? null : Math.round(hwm / 1024),
      })
    })
    child.stdin.end(JSON.stringify(req))
  })
}

const { model, facts } = standinU2netp(REMOVE_BG_LIMITS.modelSize)
const modelPath = join(dir, 'standin-u2netp.onnx')
writeFileSync(modelPath, model)
const sha = createHash('sha256').update(model).digest('hex')
out({
  host: {
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    cpu: cpus()[0]?.model,
    memMb: Math.round(totalmem() / 2 ** 20),
    node: process.version,
  },
  cgroup: {
    max: readNum('/sys/fs/cgroup/memory.max'),
    cpuMax: (() => {
      try {
        return readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim()
      } catch {
        return null
      }
    })(),
  },
  standin: { ...facts, note: 'NOT u2netp: a generated stand-in of its shape and size, random weights' },
})

// the tiny model first: ORT's CPU binary loads and computes in this image at all
{
  const tiny = tinyMaskModel(8)
  const tinyPath = join(dir, 'tiny.onnx')
  writeFileSync(tinyPath, tiny)
  const pic = join(dir, 'tiny.jpg')
  writeFileSync(pic, await picture(64, 48))
  const r = await runChild({
    input: pic,
    output: join(dir, 'tiny-out.png'),
    modelPath: tinyPath,
    modelSha256: createHash('sha256').update(tiny).digest('hex'),
    size: 8,
    maxInputPixels: REMOVE_BG_LIMITS.maxInputPixels,
    maxInputEdge: REMOVE_BG_LIMITS.maxInputEdge,
    maxOutputEdge: REMOVE_BG_LIMITS.maxOutputEdge,
    sharpTimeoutSeconds: 20,
  })
  out({ check: 'tiny model through the real child', ok: r.res?.ok === true, res: r.res })
}

const cases: [string, number, number][] = [
  ['4096x4096', 4096, 4096],
  ['7300x5450 (39.8 MP)', 7300, 5450],
]
const summary: Record<string, unknown>[] = []
for (const [label, w, h] of cases) {
  const pic = join(dir, `in-${w}x${h}.jpg`)
  writeFileSync(pic, await picture(w, h))
  const results: { ms: number; hwmMb: number | null; model: number | null; total: number | null }[] = []
  for (let i = 0; i < runs; i++) {
    const before = readNum('/sys/fs/cgroup/memory.peak')
    const r = await runChild({
      input: pic,
      output: join(dir, `out-${w}x${h}.png`),
      modelPath,
      modelSha256: sha,
      size: REMOVE_BG_LIMITS.modelSize,
      maxInputPixels: REMOVE_BG_LIMITS.maxInputPixels,
      maxInputEdge: REMOVE_BG_LIMITS.maxInputEdge,
      maxOutputEdge: REMOVE_BG_LIMITS.maxOutputEdge,
      sharpTimeoutSeconds: 20,
    })
    const peak = readNum('/sys/fs/cgroup/memory.peak')
    const ok = r.res?.ok === true
    const row = {
      label,
      run: i + 1,
      ok,
      wallMs: r.ms,
      childMs: ok && r.res?.ok ? r.res.ms : null,
      output: ok && r.res?.ok ? `${r.res.width}x${r.res.height}` : r.res,
      childPeakRssMb: r.hwmMb,
      cgroupPeakMb: peak === null ? null : Math.round(peak / 2 ** 20),
      cgroupPeakBeforeMb: before === null ? null : Math.round(before / 2 ** 20),
    }
    out(row)
    results.push({
      ms: r.ms,
      hwmMb: r.hwmMb,
      model: ok && r.res?.ok ? r.res.ms.model : null,
      total: ok && r.res?.ok ? r.res.ms.total : null,
    })
  }
  const max = (xs: (number | null)[]) => Math.max(...xs.filter((x): x is number => x !== null))
  summary.push({
    label,
    runs,
    wallMsMax: max(results.map((r) => r.ms)),
    modelMsMax: max(results.map((r) => r.model)),
    childPeakRssMbMax: max(results.map((r) => r.hwmMb)),
  })
}
out({
  summary,
  cgroupPeakMb: (() => {
    const p = readNum('/sys/fs/cgroup/memory.peak')
    return p === null ? null : Math.round(p / 2 ** 20)
  })(),
})
rmSync(dir, { recursive: true, force: true })
