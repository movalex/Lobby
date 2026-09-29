# O1 room: the ElementRoom slice (spike B, before integration)

Owner O1 (docs/EXCALIDRAW-MIGRATION.md §8.6.3). Branch `spike/b-room`, based on `spike/excalidraw` 93e3c3e
(C0 975b531 plus B0). Code on `071648d`. Windows 11 workstation, Node 24.19.0, pnpm 10.34.5. Ports: none
bound in O1's range 7860–7869 (every test here uses port 0, as §8.6.5 says for the sync protocol
harness); the listing before and after this phase was empty, and no process of this worktree was left
running.

## What is built

`apps/sync/src/room/**` (except `schema.ts`, `migrate/**`), `apps/sync/src/{file-refs.ts, workshop-state.ts}`,
`packages/canvas-schema/src/invariants.ts`, `packages/canvas-schema/src/engine/binding.ts`.

| File | Plan | What it does |
|---|---|---|
| `room/index.ts` | §2.4, §8.6.3 | the service behind the frozen seam: rooms opened synchronously on the first socket, idle eviction (`IDLE_EVICT_MS`), the routes, `/internal/metrics`, the global outbound budget (64 MiB, largest buffer closed with 4000 first), the snapshot-cache budget (64 MiB), the test hooks (`registerTestHooks`, only with `DRAFTROOM_TEST_HOOKS=1`), the metrics provider installed once |
| `room/element-room.ts` | §2.4.3, §2.4.5 | one board: hello/welcome (catch-up, or a reset with the gzip snapshot, tombstones included, cached 5 s, compressed off the event loop), stage 0 per session (the FIFO of pushes and lease messages; per-op parsing; one file-refs call per push; op and byte budgets), the drain (≤ 64 pushes or ~8 ms, at least 25 ms after this room's previous commit; BEGIN IMMEDIATE, SAVEPOINT per push, one clock per writing push), after COMMIT one `changes` frame serialized once for everyone then acks and lease events in queue order, the COMMIT-failure path, presence and lease ticks, the abuse close, version refusals |
| `room/merge.ts` | §2.4.3 steps 1–12 | the accept algorithm per push: READ_ONLY, GONE, caps, TYPE_CHANGE, lock (a label follows its container), lease (partial accept), customData classes, STALE, the merge (`path` whole, boundElements by id, customData per key, lobbyServer stamped), the conditional fit, rounding (§3.5), the element schema; then invariants, rule 7, index, the ack's `fix`/`fitDropped`/`denied` and `derived` rows, the writes (`lb_elements`, `lb_deleted`, `lb_doc`); the lease-expiry re-fit (rule 6, sticky notes) |
| `room/invariants.ts` | §2.4.4 | rejections (label container, a second label, lease and lock inheritance, frames, group nesting) and repairs (cascades, bindings nulled, boundElements kept symmetric, frameId of a deleted frame) |
| `room/fit.ts` | §2.9.4 rule 7 | re-snap triggers (a bindable element's x, y, width, height or angle, whatever group; an arrow's own `path`, bindings or creation), one re-snap per affected arrow after all ops, `gclock.fit` only, `fix` vs `derived`, the arrow label's derived layout (position only while leased) |
| `room/custom-data.ts` | §3.3 | the five classes' server rules; `file` canonicalized from file-refs, `pdfPage` from `.p<n>` |
| `room/lease.ts` | §2.9.2 | per-session leases, TTL from the last renewal (acquire, presence `editing`, the holder's pushes), the grant hook |
| `room/presence.ts` | §2.7 | 20 Hz in, 10 Hz out, 40 cursors per recipient preferring its view, `sel` dropped during a vote, the drag relay (ids once, deltas, end, drags in welcome; ≤ 500 ids, one active drag, read-only dropped), roster entries |
| `room/outbound.ts`, `rates.ts`, `store.ts`, `index-keys.ts`, `caches.ts`, `metrics.ts`, `http.ts`, `types.ts` | §2.4.5, §2.6, §2.4.6 | ordered queues with promises (the snapshot), 256 KiB / 8 MiB backpressure; token buckets; the `lb_*` store on `room/schema.ts` with compaction at open; the index cache; group-parent map, writer ledger, live counts; Prometheus text; the internal snapshot and workshop-state routes |
| `file-refs.ts`, `workshop-state.ts` | §2.10.2, A1, A2 | the api clients on `sync-internal.ts` (3 s timeout, fail closed), the per-room LRU (10,000; 10 min / 30 s) |
| `canvas-schema/engine/binding.ts` | rule 7 contract | `resnapArrow`, `resnapLinearArrow`, `routeElbowArrow` (Excalidraw's own follow: `updateBoundPoint` for both ends, rounded, then `movePoints`, which on an elbow arrow runs the router and assigns its whole output), `arrowLabelLayout`, and `boundEndsOffEdge` (new, a checker for code that may not import the engine) |
| `canvas-schema/invariants.ts` | §2.4.4 | `checkInvariants` (and `checkInvariantsOf`, `groupParents`) |

## Checks and evidence

| Evidence | Result (3 runs in a row, this tree) |
|---|---|
| **C0 arrow acceptance tests** `pnpm test:arrows` (85 tests, 13 files, against this room in-process) | **85/85, 3/3** (9.5–9.7 s per run; s1-sweep's 2,000 races 7.0 s, r35's 1,000 re-snaps 4.8 s). Per file: r33-freeend-rel 1, r33-label-node 2, r34-elbow-fixed 2, r35-drift 1, s1-freeend 7, s1-sweep 5, s2-midpoint 10, s3-elbow 30, s3-elbow-sweep 1, s4-frame 10, s5-freetext 6, s6-twotargets 8, s7-angle-mix 2. First passing run: `4c0a570` |
| Protocol suites `pnpm exec vitest run --project sync apps/sync/test/element-room` (real server process, raw WebSocket client, fake api) | **78/78, 3/3** (18.3–18.7 s). baseline 2, bound-arrows 10, conflicts 6, convergence 4, durability 3, lifecycle 14, presence 4, readonly 4, security 20, text-lease 11 |
| Unit: `packages/canvas-schema/src/engine/binding.test.ts` (11, incl. the elbow-in-Node and label-node probes), `invariants.test.ts` (16, incl. a 200-board property test) | pass |
| Whole unit suite `pnpm test` | 3,593 passed, 33 skipped, 0 failed (C0: 3,466 / 33) |
| `pnpm lint` | 1,230 files, 0 errors |
| `pnpm -r typecheck` (15 packages) and `tsc -p apps/sync/tsconfig.node-safe.json --noEmit` | pass |
| Specs `e2e/spike-b/tests/b3-l8-*`, `b4-server-*`, `b5-r1-*`, `b5-r4-*`, `b6-*` (21 tests, 6 files) | **written, typecheck, collected (`--list`); NOT RUN**: they need O2's board page and O3's harness, both stubs on this branch |

Per check: `B3-L8.md`, `B4-D3.md`, `B4-D4.md`, `B5-R1.md`, `B5-R4.md`, `B6.md`, and the server half of L6/L10
in `B3-L6-L10-server.md`.

Coverage of §6.2's spike subset by the protocol suites: `baseline`, `auth` (unchanged app.ts path; not
re-tested here), `access` (downgrade 4000, revoke 4099 FORBIDDEN), `validation`, `readonly`, `conflicts`,
`reconnect` (catch-up, epoch, STALE), `durability` (SIGKILL ×3 in group commits, SIGINT, COMMIT failure),
`text-lease` (grant/deny, second tab, renew, expiry, release after a parked push, just-created id, partial
accept, inheritance, L8), "Text lease, container fit" (stale fit, non-holder fit, re-fit, `gclock.fit` only,
a free text's own x as its fit), `attribution`, `presence` (identity refused, roster uncapped, cursor cap,
`sel` during a vote, the drag relay, read-only drag), `schema`, `join-order`, `room-lifecycle`,
`tags-merge`, `internal` (snapshot, workshop-state, metrics, test routes absent without the flag), the
negative security suite, "Prefix invariant" and "Convergence property" (random ops with reconnects and
one SIGKILL, raw clients), "Bound arrows" (subset: derived rows and fix, cases a/b, the barrier race 20×
per order, free text, labels leased and unleased, clocks, locked arrows, deleted targets, no-op writes).
Not covered here: "Epochs" (a restore's new epoch; no restore path in the spike room), "Conversion" (O4),
"Echo" (needs O2's engine-core client), and the bound-arrow cases d1–d3, e and f through the process (they
run in-process in the C0 arrow tests s3, s4, s5).

## Deviations from the plan (for the lead and the verifiers)

1. **The op and byte budgets delay before they refuse** (`rates.ts`). §2.4.5 says an op over budget is
   refused with RATE. The frozen C0 arrow tests burst far above that budget from one session (r35: 3,000
   ops at once; s1-sweep: 4,000 ops in about 1.5 s), so a room that refuses at the budget fails them. The
   room therefore parks a push the bucket cannot pay in the session's stage-0 FIFO (order kept) while the
   ops and bytes waiting there stay within one burst (2,000 ops, 4 MiB), and refuses with RATE and
   `SLOW_DOWN` beyond that; it never closes. A flood still gets RATE (the protocol suite and b6 F14 push
   12 × 500 ops and get ≥ 60 RATE rejects without a close). If the lead prefers the plan's strict rule, it
   is a change request on the frozen tests (pacing their bursts), not on the room's contract.
2. **The lease-hook `delay`/`hold` postpone the grant MESSAGE, not the decision** (`lease.ts`): the lease
   is the requester's in queue order (a competing acquire meanwhile is denied), and a postponed grant whose
   lease was released or taken over is never sent. L12 only needs the client to see a pending request.
3. **A read-only session's `lease.acquire` is denied with a synthetic holder** `{sid: 'read-only', …}` when
   nobody holds the id (`LeaseDeny.holder` is required by the protocol).
4. **Lease TTL**: 10 s (`LEASE_TTL_MS`) unless `TEXT_LEASE_MS` differs from tldraw's default 5,000 (tests
   shorten it that way).
5. **Presence frames**: with 41 sessions or fewer, one frame is serialized for everyone whose own entry is
   not in it (a recipient whose own presence changed gets a copy without itself); above that, per-recipient
   frames with the 40-cursor cap (sticky: a shown peer stays shown until it leaves). Spike B's comparison of
   shared against per-view frames under load is O3's B9.
6. **Order of the label rules**: a label created for (or pointed at) a container leased by another session
   or locked is refused LEASED/LOCKED before the one-label rule (INVALID), as B3 L8 expects.
7. **A create for an existing live id** is INVALID (TYPE_CHANGE when the type differs); a create for a
   tombstone is the undelete of §2.4.3 step 3.
8. **Self-loops are re-snapped to their fixed point** (at most 4 iterations per call), per CONTRACTS.md
   finding 3.
9. **Server ops in `changes`**: one op per element per batch (its state before the batch to its state after),
   a patch when a patch reproduces the stored element exactly (checked by overlaying it), else the full
   element (`c`).
10. **STALE's "someone else"** comes from an in-memory ledger of each clock's author (the push's uid),
    bounded to 200,000 clocks; after a restart, earlier clocks count as someone else's.
11. **The reset snapshot** is cached for 5 s across writes (a joiner gets it plus a catch-up `changes` since
    its clock); `welcome.snapshot.bytes` is the compressed frame's size.

## Not built (not needed by a spike check, or another owner's)

- Internal routes `seed`, `place-notes`, `text`, `asset-refs`, `deleted` (§2.4.6); the tldraw ones are not
  mounted in excalidraw mode (CONTRACTS.md decision 11).
- Epochs on restore; the lazy conversion hook (O4's `room/migrate/**` has no entry point in this room yet:
  a board file with tldraw tables and no `lb_meta` is refused with `BoardNeedsConversion`, sessions closed
  4099 UNKNOWN_ERROR). The integration point is `BoardStore`'s constructor.
- Rule 6 (the lease-expiry re-fit) for rectangles, ellipses and diamonds (sticky notes are done).
- Presence's "always included" peers (followed peer, presenter, summoner): the protocol has no fields for
  them yet.
- `lb_deleted` trim: whole batches beyond 10,000 rows, every 100 deletions (not the tldraw store's
  per-session retention).

## Handover notes

- **O2**: the room sends `changes` before the ack; a reset welcome is followed by the binary frame and, when
  the cached snapshot is older than the room's clock, a `changes` catch-up (full `c` ops). Server patch ops
  carry `vn`. Presence frames may include the recipient's own entry only when it did not change; `drags`
  never include the recipient's own. A push that writes nothing has `ack.clock` = the room's clock.
- **O3**: `boundEndsOffEdge(arrow, elementsById)` in `@draftroom/canvas-schema/engine` measures "on the
  target's edge" without importing the engine; `checkInvariants` is implemented. The test hooks answer for
  a board whose room is not open yet (the hook applies when it opens).
- **O4**: the store refuses a file with tldraw tables and no `lb_meta` (`BoardNeedsConversion`); rule-7
  helpers and `checkInvariants` are ready for step g.
