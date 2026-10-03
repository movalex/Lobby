# §8.4 client, render and bundle numbers, and the §8.5 gates they feed (O3)

Status: **MEASURED on 2026-10-03 (wave C6, G11 HEAVY-PERF).** The runs used Lobby's board page, the page the
cut-over shipped, in a quiet window, with all 200 of the heavy board's images loaded. **Every §8.5 gate
this round measured is met.** The open-time comparison with tldraw was not judged (a different method). The numbers before this round were taken on boards whose images were never drawn
(§"Which earlier numbers had no images"). The spike B harness and its 2026-09-29 smoke runs are kept below
as the record.

## The gates (2026-10-03)

| §8.5 gate | Measured (3 runs each) | Verdict |
|---|---|---|
| Edit visibility p95 ≤ 250 ms at 100% zoom, two browsers, L2 running | **185 / 177 / 208 ms** (B9 workstation half, 30 edits per run, L2 for 5 min) | **met** |
| Heavy board ≥ 30 fps at 0.25 and at 1, sync running | 0.25: **48.7 / 49.5 / 53.0**; 1: **60.0 / 59.3 / 59.3** (navigation-lod-fps, the page's default) | **met** |
| ≥ 24 fps at Lobby's whole-board fit (zoom 0.0455) | **58.7 / 58.3 / 58.0** with the level-of-detail pass (the default); 12.7 / 13.4 / 12.9 with it switched off | **met** (with the pass) |
| Heavy board open no slower than tldraw's (median 3.8 s, A14's method) | live and Saved **2,147 / 2,443 / 2,153 ms**; every image loaded **5,252 / 5,563 / 5,264 ms** after navigation (navigation-lod-fps: a warm server, a fresh page) | **not judged.** This is not A14's method: perf-open's cold opens were not re-run, and tldraw was not re-measured in this window |

**Machine.**
- CPU: AMD Ryzen Threadripper 9970X, 32 cores / 64 threads.
- RAM: 255 GB.
- GPU: NVIDIA GeForce RTX 5090, driver 32.0.16.1664.
- OS: Windows 11 Pro, build 26200.
- Everything ran locally over loopback: api, sync, the preview worker, and `vite preview` of a production
  build with the dev-auth guard.
- Browsers, all headless, all at 1536×864 and DPR 1.25:
  - navigation-lod-fps and B9 used Playwright's headless shell (Chromium 153.0.8010.12) with spike A14's GPU
    flags;
  - the perf harness used branded Chrome 154.0.8037.93 in new headless mode with the same flags;
  - every browser ran on ANGLE D3D11 on the RTX 5090, with 2D canvas and GPU compositing enabled.

**Code.** The app code is `release/held` `99ac6c52`: main `23a36bbd` plus migration 0024 and push receipts
(`CONTRACTS_REV` 11). The harness commits on top of it change `e2e/` only:
- navigation-lod-fps and B9 ran at `f4ceabd2`;
- the perf harness ran at `f4ceabd2` plus the `100-images` view, which it did not use (committed as `9406f2a`).

**Quiet window.** Before and after every run, a process check listed each node, Chrome, Edge, Docker and
ffmpeg process that was not this worktree's. Only idle desktop processes showed up: the Adobe updater, an
idle `server.mjs`, and the editor's `esbuild --ping`.
- Whole-machine CPU during the pans was 2.9-4.5% (navigation-lod-fps) and 4-10% (the perf harness).
- **Two exceptions,** both from another tool on this PC driving After Effects (the `Graphix` project's
  MCP server and scripts; AfterFX then used 1-6 cores in bursts):
  - it started at 17:52:38Z, during the perf harness's third run, whose fps part then ran with the machine at
    8-10% busy;
  - it was running again at the start of the one "zoom 1 over the images" run.

  Both runs' numbers are kept and marked.
- The user's local uvicorn service on port 8001, running since 2026-09-30, takes 1-5 cores in short bursts.
  It was there for every run.
- The NAS agent worked on the NAS throughout, not on this machine.

## Frame rate (navigation-lod-fps, `LOBBY_MEASURE_FPS=1`, E2E_PORT_BASE 7800, 17:05-17:16Z)

The heavy board was seeded through the real protocol for each run: 9,220 elements (20 frames, 4,500 notes
with their labels, 200 uploaded JPEGs with their previews, 40 threads). Each run then opened the board in a
fresh measuring page and took 3 pans of 3 s per view (a 600 px sine), plus one traced pan. Each view was
measured only once the loader had every image in it loaded. Each cell is the median of a run's three pans.

| Mode | fit (zoom 0.0455; 4,720 items and 200 images in view) | 0.25 (282 items, 10 images) | 1 (29 items, no image) |
|---|---|---|---|
| level-of-detail pass on (the default) | **58.7 / 58.3 / 58.0** | 48.7 / 49.5 / 53.0 | 60.0 / 59.3 / 59.3 |
| pass off (`__lobbyLod.setEnabled(false)`) | 12.7 / 13.4 / 12.9 | 47.1 / 49.4 / 51.7 | 59.3 / 59.3 / 59.3 |

- **The main thread is busy for the whole pan, so the frame rate is bounded by main-thread work, not by
  the GPU.** In every traced pan the main thread was 89-100% busy.
- **The pass's bitmaps were ready within the 2.5 s settle.** Rendering the 20 frames took 656 ms in total.
- **With the pass on at fit, 4,700 frame children are left out of the engine's render.** With it off, all
  200 images and 4,500 notes are drawn every frame, and the pan runs at 13 fps.
- **The 1 view has no image in view**, because the image column is at the frame's right. The opt-in
  `LOBBY_FPS_VIEWS=1-images` view (frame 0's image column at 1) was added for that case. Its one run is
  under "Zoom 1 over the images" below: 60 fps.
- Per-run logs: `scratchpad/c6perf/evidence/lodfps-r{1,2,3}.log`. JSON: `evidence/results/lodfps-r*/…/lod-fps.json`.

## Edit visibility under L2 (B9's workstation half, Lobby's page)

There were 3 runs on base 7820 (17:16-17:37Z), with 30 edits per view. The L2 load ran as written in its own
Node process: 30 sessions, 10 one-shot editors at 20 edits/s in total. Both browsers had all 200 images loaded
before the first edit. Every edit was seen, and none was lost in A.

| Run | 100% p50 / p95 / max (ms) | fit (zoom 0.1) p50 / p95 / max |
|---|---|---|
| r1 | 156 / **185** / 190 | 193 / 295 / 307 |
| r2 | 156 / **177** / 192 | 217 / 293 / 308 |
| r3 | 159 / **208** / 213 | 232 / 412 / 437 |

The split at 100% (p50) is about 68 ms on A's side (50 ms of it is the core's coalescing), about 60 ms on the
server path, and about 27 ms for B's apply and paint. The stage tables, the L2 report's targets (all met),
the config (`e2e/perf/b9-lobby.config.ts`) and the evidence paths are in B9.md, §"Workstation half, re-run
on Lobby's board page".

## The perf harness (`node e2e/perf/run.ts`, ported to Lobby's board page; port base 7810, 17:33-17:54Z)

**Setup.**
- Each run starts a fresh stack and a fresh seed of the same heavy board.
- Alice writes and Bob watches, in two tabs of one branded-Chrome process, with no other load.
- The latency part makes 240 edits per view after 40 warm-up edits: half moves of a note with its label, half
  recolours. There are no text edits.
- The open is measured in a fresh tab against a warm server.

**Columns.**
- send: writer edit → the push left the writer's socket.
- wire: socket → socket.
- apply: socket → port.
- render: two frames.

| | r1 | r2 | r3 (fps part: After Effects busy) |
|---|---|---|---|
| visible p50 / p95 / p99 at 100% (ms) | 169 / **192** / 215 | 167 / **190** / 208 | 172 / **198** / 212 |
| split p95 at 100%: send / wire / apply / render | 72 / 60 / 42 / 33 | 72 / 60 / 41 / 33 | 74 / 60 / 47 / 35 |
| visible p50 / p95 / p99 at fit (0.0455) | 174 / 203 / 221 | 178 / 237 / 490 | 184 / 499 / 568 |
| observer long tasks during the fit edits (count, longest) | 9, 69 ms | 37, 122 ms | 92, 167 ms |
| fps while editing, observer / writer, at 100% | 56.3 / 52.0 | 56.7 / 51.6 | 55.4 / 49.2 |
| fps while editing, observer / writer, at fit | 55.4 / 47.8 | 52.9 / 45.4 | 46.2 / 42.4 |
| open: live and Saved / every image loaded (ms) | 2,155 / 5,393 | 2,194 / 5,580 | 2,384 / 5,850 |
| pan fit / fit@60 / 0.25 / 100% (fps, median of 3) | 57.7 / 58.0 / 41.2 / 59.3 | 54.3 / 56.7 / 42.1 / 58.3 | 55.0 / 55.7 / 46.1 / 59.3 |
| machine busy during the measured parts | 4.2-7.7% | 4.0-6.3% | 6.9-9.8% |

The gates the harness prints (p95 ≤ 250 at 100%; ≥ 24 fps at fit; ≥ 30 at 0.25 and at 100%) passed in all
three runs.

**What these numbers show, and what they do not.**
- **The fit latency is a tail, not a gate.** Its p95 ranged from 203 to 499 ms, and each run's observer tab
  had more long tasks than the last (9, 37, 92). This was not profiled here because no target is set at fit.
- **0.25 is slower in branded Chrome 154 (41-46 fps) than in the headless shell 153 (49-53).** The two
  measurements used different browser builds, so they are not compared further.
- **`e2e/perf/budget.json` is re-baselined from these three runs** (`9406f2a`). Each value sits near the
  slowest run, with the file's 15% margin.
- **The package script (`pnpm --filter @draftroom/e2e perf`) against that budget passed:** see "The budget
  run" below.

### The budget run (`pnpm --filter @draftroom/e2e perf`, E2E_PORT_BASE 7810, 18:10-18:15Z, at `9406f2a`)

This was the package script itself, `node perf/run.ts --budget`, against the re-baselined `budget.json`.
**Every value was within budget (exit 0).** The §8.5 gates printed pass: p95 at 100% and all three pan
views. The harness also prints an informational WRK-01 line for the fit view, and that line read FAIL
(276 ms against 250). §8.5 sets the visibility gate at 100% only.

| Number | Measured | Budget (fails beyond 15%) |
|---|---|---|
| latency visible p95, 100% | 184 ms (p50 166, p99 193; split p95 send 70 / wire 59 / apply 38 / render 32) | 200 (fails above 230) |
| latency visible p95, fit | 276 ms (p50 177, p99 428; 36 observer long tasks, the longest 141 ms) | 450 (fails above 517.5) |
| editing tab fps, 100% / fit | 52.6 / 45.6 | 49 / 42 |
| pan median fps: fit / fit@60 / 0.25 / 100% | 57.0 / 58.0 / 44.0 / 58.7 | 54 / 55 / 41 / 58 |
| open: live and Saved / every image loaded | 2,091 / 5,148 ms | (not budgeted) |

Machine busy during the measured parts was 5.1-8.3%. Before the run, the machine was idle for a minute
(under 1 core in use for six 10 s windows). An After Effects render by another tool started at 18:15:36Z,
as the run ended. The user's local uvicorn service on port 8001 has run since 2026-09-30 and takes 1-5 cores
in short bursts; it was there for every run in this file.

## Zoom 1 over the images (navigation-lod-fps `LOBBY_FPS_VIEWS=1,1-images`, 18:17-18:20Z, at `9406f2a`)

This was one run. **It was not fully quiet.** Another tool's After Effects script (`tools/ae/…`, the
`Graphix` project) started as the run began. During the pans the whole machine was 3.9-4.8% busy. The
measuring page went straight to zoom 1, without visiting fit or 0.25 first.

| Mode | 1 (29 items, no image) | 1-images (frame 0's image column: 21 items, 3 images, all loaded) |
|---|---|---|
| pass on (the default) | 60 / 60 / 60 fps | 60 / 60 / 60 fps |
| pass off | 60 / 60 / 60 fps | 60 / 60 / 60 fps |

The open in this run took 2,214 ms to live and Saved, with every image loaded at 5,543 ms.

**Zoom 1 holds 60 fps with images on screen.** One difference from the three gate runs above was not
profiled. Here the traced pans' main thread was **49-51% busy** at zoom 1. In the gate runs, the same view
came after fit and 0.25 in the same page, and there the main thread was **89-96% busy** at an almost
identical frame rate (59.3-60). So something that the earlier views leave behind costs main-thread time at
zoom 1. The 20 bitmaps of the level-of-detail pass stay rendered, and the pass's layer is on (`layer: true`
in its state at 1). That is the obvious suspect, but it is not established. No target is missed, so this is
recorded rather than chased.

**Evidence** (numbers only; C6's session scratchpad `scratchpad/c6perf/evidence/`):
- the per-run logs: `lodfps-*.log`, `b9-r*.log`, `perf-r{1..4}.log`, and `quiet.log` (the process checks);
- the output folders: `results/`, with `lod-fps.json`, B9's evidence and load reports (the job files,
  which hold the runs' expired dev tickets, removed), and the perf harness's `perf-*.json`;
- perf-seed's red check (`red-2.log`) and its green runs.

## Which earlier numbers had no images

**Every browser number of the Excalidraw heavy board before this round was taken on a board whose 200
images were never fetched, decoded or drawn.** The heavy seeds (`e2e/perf/seed.ts`,
`e2e/load/boards.ts`) uploaded the images but wrote no `customData.lobby.file`. The client resolves an
image's bytes through that asset id (`apps/web/src/canvas/files/resolve.ts`), so the loader stayed at
"loading" with no URL. W5-34 has a red check of this, and perf-seed now asserts the images load. The image
elements themselves were present, so per-element costs such as `CanvasPort.bounds` were measured, but image
decoding and drawing were not.

The affected numbers:
- this file's 2026-09-29 smoke runs (perf-open, perf-fps, perf-client; below);
- `wave3/3B-2.md` §3, navigation-lod-fps on `076c38d`: fit 28.2, 0.25 31.5, 1 35.8, pass off 9.8. These
  were also not taken in a quiet window (8-17% busy). SYNTHESIS PERF-3 quotes them;
- B9's workstation diagnosis, diag1-4, and the lead's first B9 run (B9.md);
- `present-export-heavy`'s export numbers. The exporter also resolves images through the asset id
  (`canvas/export/scene.ts`). The spec ran once at `9406f2a` (`LOBBY_MEASURE_EXPORT=1`) as a functional
  check and passed, with the images now in the export. That run had no quiet check, so it is not
  evidence and its numbers are not reported here.

Not affected:
- the NAS half and every L2 or L1 headless number: headless sessions never load images;
- the tldraw-era harness numbers of 2026-09-28 (the old `budget.json`): the tldraw seed gave each image
  asset a `/files/…` src, and tldraw loaded it.

Nothing here isolates what made the newer numbers higher than 3B-2's. That would need A/B runs of the same
machine state. Three things changed together:
- the quiet machine;
- CR 3b-7 and 3b-8 (no per-call element map, no scan on a camera-only change);
- this round's images, which add work.

## Spike B's harness and its smoke runs (2026-09-29; the record)

The section below is O3's harness description and its part-2 smoke runs, as they were. **Their heavy-board
numbers have no image drawn** (§"Which earlier numbers had no images"), and the specs (`perf-open`,
`perf-fps`, `perf-client`, `perf-bundle`) build spike B's board page. They were not re-run in this round:
the gates above were measured on Lobby's page with navigation-lod-fps, B9 and the ported perf harness.

| Number (§8.4) | Spec | How |
|---|---|---|
| Heavy board open through the real stack: ticket, socket, `welcome`, snapshot, apply, first paint | `perf-open.spec.ts` | 3 cold opens, each in a fresh context of spike A's GPU headless shell (1536×864 at DPR 1.25), timed from navigation start to three points: the facade installed with the welcome applied, two animation frames later, and `document.fonts.ready`. The ticket request is timed from resource timing. The board has 200 real uploads (with previews) and 9,220 elements, seeded through the real protocol |
| Typical 2k-object board open | `perf-open.spec.ts` | the same, on 18 frames of 100 notes plus 180 bound arrows (3,798 elements) |
| Pan fps at Lobby's whole-board fit, at 0.25 and at 1, with sync running | `perf-fps.spec.ts` | perf-kit's `measureView`: the pointer at rest, 3 pans of 3 s along a 600 px sine plus one traced pan. The camera moves through CanvasPort's viewport (the facade side channel). Two variants: sync idle, and a remote writer in its own session moving a note in view at 5 Hz |
| Override updates and fps during a 100-note drag preview | `perf-fps.spec.ts` | a peer's raw session relays a presence `drag` of frame 0's first 100 notes (ids once, then deltas at 20 Hz), 3 × 3 s, with the page's rAF frame rate measured at zoom 1. Override updates per second come from O2's `lobby.*` measures when it emits them |
| `updateScene` ms at 5k / 20k, `onChange` diff ms at 20k, the pre-pass on the apply path, with tombstones in the scene (also 20k live + 10,000 deleted) | `perf-client.spec.ts` | O2's adapter timings, read as Performance measures `lobby.updateScene`, `lobby.onChange` and `lobby.prepass`. Without them the spec fails and the numbers are "not measured". O3 also records its own end-to-end apply time: remote push sent, then the page's `changed` event, then the change painted |
| Bundle: gzip JS+CSS of the spike board route | `perf-bundle.spec.ts` | A13's method: every same-origin .js/.css the route loads while it opens and settles, gzip-sized from `apps/web/dist/spike-b-<web port>/`. Reported against A13's 1,086.2 KiB (tldraw board route, not re-measured) and 1,306.9 KiB (engine route) |
| Same-method tldraw baseline | `e2e/spike/tests/render-a14-tldraw.spec.ts` (spike A's, unchanged) | re-run in the same window by `o3-measure.sh`, on `E2E_PORT_BASE=7885` after the Excalidraw stack has stopped, with spike A's web server on 7898 (proxy targets in O3's range) |

**Run:** `bash docs/research/excalidraw/spike-b/scripts/o3-measure.sh 3`. It checks that 7880–7899 is free
before, between and after the runs, runs every measured spec without Playwright's trace (the specs set
`trace: 'off'`; spike A's frozen baseline gets `--trace off`), and copies each run's output folder to
`$O3_LOGDIR/<utc>/<spec>-run<n>.results/` (Playwright wipes `e2e/test-results/spike-b-7887` on every
invocation). Spike A's A14 JSON goes to `e2e/test-results/spike-7898-a14/`.

### The §8.5 gates these feed

| Gate | Source |
|---|---|
| heavy board ≥ 30 fps at 0.25 and at 1 with sync running | `perf-fps`, both variants |
| heavy board open no slower than today's tldraw with the same method (median 3.8 s, re-measured in the same window) | `perf-open` vs `render-a14-tldraw` |
| 24 fps at Lobby's whole-board fit (the level-of-detail prototype's target, wave 3b) | `perf-fps` fit row (reported; the prototype is not in the spike) |
| edit visibility p95 ≤ 250 ms at 100% zoom, two browsers, L2 running | `b9-visibility.spec.ts` (B9.md) |

### A request to O2 (not a frozen file)

`perf-client` reads three Performance measures that only the adapter can emit: `lobby.updateScene`
around the adapter's `updateScene`, `lobby.onChange` around the core's scan and diff in `onChange`, and
`lobby.prepass` around the index pre-pass. A `performance.measure` call costs microseconds, and the
spike build only. Without these measures, the §8.4 client row stays "not measured".

### Readiness: smoke runs (part 2, 2026-09-29, one run each, NOT a quiet window)

Stack 7885, `SPIKE_PERF=1`; perf-bundle, perf-open and perf-fps at `4ad5f34` (17:24–17:33Z), perf-client
again at `017f76d` after the seeding fix below (17:42–17:46Z). GPU: the headless shell on ANGLE D3D11,
NVIDIA RTX 5090 (canvas 2D and GPU compositing enabled). Logs and JSON: O3's scratchpad `o3b/perfsmoke/`.

| Spec | Result | What it measured (informational only) |
|---|---|---|
| perf-bundle | pass (16 s) | spike board route: 37 JS + 3 CSS files, **1,387.8 KiB gzip** (JS 1,348.2, CSS 39.6; 4,781 KiB raw). A13's same-method numbers: tldraw board route 1,086.2 KiB, engine route 1,306.9 KiB. Largest: ExcalidrawHost 494.6, index 489.1, client 62.8, SpikeBoardPage 44.3 KiB |
| perf-open | pass (1.9 min) | heavy board (9,220 elements, 200 images) through the real stack, 3 cold opens: painted 1,141 / 923 / 991 ms (median 991; facade + welcome ready 588 / 516 / 507 ms; ticket 8–9 ms). Typical board (3,798 elements): 697 / 673 / 645 ms (median 673) |
| perf-fps | pass (3.9 min) | **4–7 fps** at every view, main thread 100% busy in the traced pan: idle fit (zoom 0.1) 4.6, 0.25: 6.5, 1: 6.3; with a remote writer at 5 Hz 4.2 / 5.2 / 5.2. The 100-note drag preview (peer relay, zoom 1): 32.9 / 33.1 / 34.5 fps. Spike A measured 53.7 and 60 fps at 0.25 and 1 without sync. Cause: `CanvasPort.bounds` called per image on every viewport change (below) |
| perf-client | first run FAILED at seeding (45 ELEMENT_LIMIT: the seeder's tombstones counted as live items; fixed in `017f76d`), then pass (3.1 min) | see the table below |

perf-client (O2's `lobby.*` measures; 20 remote edits for the apply path, 20 local facade edits for the scan):

| Board (live / deleted) | `updateScene` p50 / p95 (ms) | `onChange` scan p50 / p95 | pre-pass p50 / p95 | remote edit sent → painted p50 / p95 |
|---|---|---|---|---|
| 5k (5,012 / 0) | 3.7 / 5.7 | 0.5 / 1.3 | 0.7 / 1.1 | 26 / 35 |
| 20k (20,045 / 0) | 21.0 / 30.8 | 2.9 / 5.4 | 2.4 / 3.4 | 81 / 105 |
| 20k + 10k deleted (20,045 / 10,000) | 26.8 / 36.1 | 3.8 / 6.7 | 3.0 / 4.4 | 84 / 123 |

**The fps finding** (`e2e/spike-b/tests/perf-probe-pan.spec.ts`, opt-in `SPIKE_B_PROBES=1`, stack 7890): a
9,000-element notes-only board pans at 60 fps with every camera method (CanvasPort's viewport, spike
A's scroll-only `updateScene`, scroll with a zoom object), so the camera hooks are not the cause. The
heavy board (the same plus 200 images) idles at 60 fps and pans at 5.1–6.7 fps. A CPU profile of the
pan: 2,745 ms of about 3.5 s is self time in `bounds` (O2's `CanvasPort.bounds`, `port-impl.ts:184`: a
linear find and a new Map of all 9,220 elements per call), called on every `viewportChanged` by the
overlay layers, the image card layer (O5's `features/viewer.tsx`) once per image; Excalidraw's own code
is 115 ms. Details and the same effect under a remote writer: B9.md, finding 2. Until that is fixed the
§8.5 gate "≥ 30 fps at 0.25 and at 1 with sync running" cannot pass; the quiet-window runs should come
after the fix.

**Changes made for the quiet window (part 2):** the measured specs run without Playwright's trace (it
instruments the harness's own browsers too, with a screencast); o3-measure.sh passes `--trace off` to
spike A's baseline and copies each run's output; seeding deletes each chunk's tombstones right away
(`e2e/load/seed.ts`), so the 20k + 10k-deleted board stays under the room's 20,000-item cap while it
is built.
