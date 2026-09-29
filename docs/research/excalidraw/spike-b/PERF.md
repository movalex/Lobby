# §8.4 client, render and bundle numbers, and the §8.5 gates they feed (O3)

Status: **ready for the quiet window; NOT MEASURED.** Each of the four specs ran once on the integrated
tree as a smoke run (part 2, below): all four pass as specs. Their numbers are **not** the §8.4 numbers:
one run, not a quiet window (other owners' stacks and browsers ran on the workstation), and the §8.4
runs are 3 per spec in the lead's window (`o3-measure.sh 3`). The smoke runs found one blocker for the
fps gate, outside the harness: the heavy board pans at 4–7 fps because of `CanvasPort.bounds` in the
overlay layers (B9.md, finding 2).

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

## The §8.5 gates these feed

| Gate | Source |
|---|---|
| heavy board ≥ 30 fps at 0.25 and at 1 with sync running | `perf-fps`, both variants |
| heavy board open no slower than today's tldraw with the same method (median 3.8 s, re-measured in the same window) | `perf-open` vs `render-a14-tldraw` |
| 24 fps at Lobby's whole-board fit (the level-of-detail prototype's target, wave 3b) | `perf-fps` fit row (reported; the prototype is not in the spike) |
| edit visibility p95 ≤ 250 ms at 100% zoom, two browsers, L2 running | `b9-visibility.spec.ts` (B9.md) |

## A request to O2 (not a frozen file)

`perf-client` reads three Performance measures that only the adapter can emit: `lobby.updateScene`
around the adapter's `updateScene`, `lobby.onChange` around the core's scan and diff in `onChange`, and
`lobby.prepass` around the index pre-pass. A `performance.measure` call costs microseconds, and the
spike build only. Without these measures, the §8.4 client row stays "not measured".

## Results

None of the §8.4 numbers yet (quiet window).

## Readiness: smoke runs (part 2, 2026-09-29, one run each, NOT a quiet window)

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
