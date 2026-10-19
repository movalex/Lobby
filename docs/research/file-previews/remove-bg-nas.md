# Background removal on the NAS: the ORT binary, memory and time, the image size (wave W, WS2)

Measured 2026-10-19 on the UGREEN NAS (Intel i5-1235U, 12 threads, AVX2 and no AVX-512, 7.6 GB, Docker 29.6.2) by WS2,
in throwaway `draftroom-load-ws2-ws2a1-*` containers and images, LAN-only, removed afterwards (folder, containers and
both images; the BuildKit layer cache of the two builds stays, as for every build there). Commit ce769d05.
Nothing of `draftroom-worker`, `draftroom-office` or any other project was touched.

**The model is a stand-in, not u2netp.** Nobody has downloaded the real file (its pin, `BG_MODEL.sha256`, is null). The
memory and time below are for `apps/worker/test/standin-u2netp.ts`: a generated model with u2netp's input
(1 × 3 × 320 × 320) and output (1 × 1 × 320 × 320, a Sigmoid), 1,054,497 parameters (u2netp: about 1.13 M), a 4.2 MB
file (u2netp: about 4.6 MB) and about 18 G multiply-accumulates, an estimate of u2netp's dominant layers made from
its architecture, not a measurement of the real model. Random weights: it removes no background. The real model's
time may differ from this; its memory should be close (the weights and the 320² activations are the same order).

## 1. The linux onnxruntime-node binary, install script blocked

- A frozen `pnpm install` in the pinned worker base image (`node:24.19.0-trixie-slim@sha256:ab3eebe…`) with
  `allowBuilds: {onnxruntime-node: false}`: `onnxruntime-node@1.30.0` has `bin/napi-v6/linux/x64/{libonnxruntime.so.1,
  onnxruntime_binding.node}` and no CUDA or TensorRT file: its install script did not run and nothing was downloaded.
- `ldd onnxruntime_binding.node`: every library resolves (its `libonnxruntime.so.1`, libstdc++, libm, libgcc_s, libc,
  libdl, librt, libpthread) on Debian glibc 2.41.
- The real child (`apps/worker/src/ops/bg-child.ts`, spawned as the runner does) ran the tiny model and the stand-in on
  the NAS CPU with no network (`--network none`).
- In the same container (1.5 GB, no swap, 3 CPUs, no network) the worker suites `remove-bg.test.ts` and `ort-cpu.test.ts`
  passed (39 passed); `ops.test.ts`'s preview-loop suite did not run there: its fixtures need ffmpeg, which the bare
  Node image lacks (it passes on the PC).

## 2. Memory and time (the NAS worker's caps: 1.5 GB, no swap, 3 CPUs; 2 intra-op threads; the 256 MB child heap)

`node apps/worker/test/remove-bg-bench.ts 3`: the real child, three runs per picture, its peak RSS read from
`/proc/<pid>/status` VmHWM while it ran.

| Picture | Output | Wall time per op (max of 3) | Model only (max of 3) | Child peak RSS (max of 3) |
|---|---|---|---|---|
| 4096 × 4096 JPEG | 4096 × 4096 PNG RGBA | 2.3 s (dev install) / 2.8 s (trimmed image) | 0.41 s / 0.52 s | 300 MB / 307 MB |
| 7300 × 5450 JPEG (39.8 MP, the input limit) | 4096 × 3058 | 2.5 s / 2.4 s | 0.56 s / 0.54 s | 308 MB / 315 MB |

- The container's cgroup `memory.peak` was 514 to 584 MB, but that includes the bench's own process, which builds the
  39.8 MP picture in memory; the child itself stayed near 300 MB, as the scout expected.
- Headroom: about 315 MB of the worker's 1.5 GB at concurrency 1, and well inside the 45 s timeout. Most of the time is
  the decode, the resize and the PNG encode of a 4096 px picture, not the model.
- The real u2netp is the open measurement: rerun the bench with `DRAFTROOM_BG_MODEL_PATH` once the owner's file exists
  (the bench takes the stand-in today).

## 3. The worker image: keep only its own ORT binary

`docker/worker.Dockerfile` (this branch) deletes `onnxruntime-node`'s darwin and win32 binaries and the other linux
arch right after the install, and fails the build if the binary of its own arch is missing.

| Image | Size (`docker image inspect .Size`) | `onnxruntime-node` in it |
|---|---|---|
| the foundation's Dockerfile (d7bd0271) | 1,518,101,031 bytes (1.52 GB) | 288 MB |
| this branch's | 1,263,311,159 bytes (1.26 GB) | 45 MB (`bin/napi-v6/linux/x64` only) |

255 MB less. The trimmed image ran the bench above (its numbers are the second ones in §2), so its ORT loads and works.
