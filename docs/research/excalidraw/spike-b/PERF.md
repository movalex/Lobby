# §8.4 client, render and bundle numbers, and the §8.5 gates they feed (O3)

Status: **NOT RUN.** The specs and the run script are written. They need M1 (the board page, the room),
and `perf-fps` also needs M2 for its drag-preview row. The numbers are timing-gated, so they are
measured only in a quiet window the lead posts.

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
before, between and after the runs. Evidence goes to `e2e/test-results/spike-b-7887/o3/perf-*/run-<n>-*.json`
and spike A's `test-results/spike-7898-a14/`.

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

None yet.
