# Spike B: the verifiers' fix round (part 3)

The fixes for the independent verifiers' findings on the part-3 integration `37bdfa9`
(docs/EXCALIDRAW-MIGRATION.md §8.6.8): V1 (room, lease and undo), V2 (security) and V3 (conversion and
rollback). One fixer acted for the owner each defect names, in that owner's worktree (O1
`Draftroom-sb-room`, O2 `Draftroom-sb-engine`; for O4 a worktree of its own, `Draftroom-sb-fix-convert`,
because `Draftroom-sb-convert` was not to be touched), and then merged into `spike/excalidraw` as the lead
does. Every high and medium defect and every WRONG verdict has a fix and a regression test that failed on
`37bdfa9` and passes on the merged tree. Most lows are fixed too. The findings are the verifiers'
(worktrees `Draftroom-spike-v1`, `-v2`, `-v3`); this file says what changed, how it was checked, and what
is still open. **These are the fixer's runs, not the verifiers' re-checks and not a quiet window:** each
verifier still re-checks its own findings (§8.6.8 "the same verifier re-checks"), and V3 confirms the B8
staging rows. It follows `M3-part3.md`.

| | |
|---|---|
| Base | `spike/excalidraw` `37bdfa9` |
| Owner commits | O1 `spike/b-room`: `486a08e`, `46fea60`, `2f34836`, `21c4a4c` (evidence). O2 `spike/b-engine`: `c28c311`, `2ac9a37`, `96f0676`, `7a8156f` (evidence). O4 `spike/b-convert`: `a7747e7`, `66e6a3d` (evidence), on O4's `3390b0c`, `55b8ddc`, `de3dc40` (unmerged until now) |
| Merges (`--no-ff`, no conflict) | `eb2ff73` (b-room), `35073f5` (b-engine), `1f783af` (b-convert), `245268c` (b-room), `8833e45` (b-engine), `38af6d6` (b-room); the owners' evidence: `6f3b9a8` (O1), `b40b4bc` (O2), `b1ad9dc` (O4, `B8.md` phase 4; O4's leak-check count before the merge: 0) |
| Lead's change | `5f9d5b1`: CR rev 6 (`limits.ts`: a signed-URL parameter name percent-encoded) and `CONTRACTS.md` (row 6, the round's decisions) |
| Frozen files | only the lead's CR (`limits.ts`, `CONTRACTS_REV` 6 in `protocol.ts`). No wire message, room schema, `types.ts` or `port.ts` change: the lost-ack replay is decided in the core (CONTRACTS.md, this round's decision 2) |
| Ports | the spare range, as the lead: 7950-7953 (gate: spike A suite, A8), 7960-7969 (spike-b specs; B8 stand-in 7968), 7955-7959 (a second spec runner); O4's 7900-7909 for B8, through O4's own scripts; protocol tests on port 0. Nothing listened in these ranges before or after. `DRAFTROOM_BACKUP_STORE=off` everywhere; `.env.deploy.local` never read; headless Chromium only |
| Not a quiet window | shared with the wave-3 sessions (`Draftroom-engine-w3b-*`, ports 6400-6482; CPU about 7% of 64 threads). Every timing is informational |
| Logs | the fixer's scratchpad `fixer/` (`gate/`, `unit2/`, `node/`, `specs/`, `broad/`, `b8open/`, `b8rows/`); staging outputs only inside `spike-b8/`; never committed |

## What changed, per defect

The table answers every defect and WRONG verdict of the three verifiers. "Regression" is the committed test
that failed on `37bdfa9` and passes here; "Re-run" is the verifier's own repro, 3 runs on the merged tree
(20 repetitions per probe unless said).

### V1 (room, lease and undo)

| Defect | Severity | Fix | Regression | Re-run | Status |
|---|---|---|---|---|---|
| A push whose ack is lost is replayed over another user's later Saved write, and a replayed create revives a deleted element (N3a, N3b, P4) | high, WRONG | O2 `c28c311`: after the welcome each lost group goes again only if the server copy shows it did not land (it holds the value the first lost push was built on, or an earlier lost value); the server holding the last value means it landed; any other value means another user wrote it after, and the server copy stands. A lost create goes again only when the server has no copy (or still the tombstone it undeletes). Behind a reset snapshot the lost pushes are held as in flight until its catch-up (`2ac9a37`'s test) | `sync/core/verifier-fixes.test.ts` (4 cases + 2 controls); `apps/sync/test/verifier-v1/v1-core.test.ts` N3 | N3a 20/20, N3b 20/20, 3/3 runs; browser P4 20/20, 3/3 | FIXED |
| STALE never fires for offline replays older than 10 minutes (N17) | high, WRONG | O2 `c28c311`: a replay goes out on the clock its change was made on (the offline clock, the lost push's base, the queue entry's), in pushes of their own; the entry a create's ack left behind no longer hides a later offline change's `off` | `sync/core/verifier-fixes.test.ts` N17; `verifier-v1/v1-stale.test.ts` | N17 20/20 (STALE, B's 222 kept, `off` 660,05x ms, base the pre-cut clock), 3/3 | FIXED |
| A Saved client holds another versionNonce after an identical remote value overtook a dirty group (N16, N18, D2) | medium | O2 `c28c311`: dirty groups the same remote value overtook are dropped when it lands; a flush that finds nothing to send puts the server copy back | `sync/core/verifier-fixes.test.ts` N18; `verifier-v1/v1-diverge.test.ts` | N18 20/20, N16 (`v1-echo`) 20/20 rounds, 3/3; D2 with 6 rounds 3/3 | FIXED |
| Undo after a retryable reject undoes the step before (N9, N9b, U-b) | medium, WRONG | O2 `c28c311`: `LobbyHistory.onAck` keeps a change answered RATE or UNAVAILABLE for its retry | `history/verifier-fixes.test.ts` U-b; `verifier-v1/v1-undo.test.ts` | N9 20/20, N9b 10/10, U-b, 3/3 | FIXED |
| Board-document writes are not in the offline queue (N8) | medium, WRONG | O2 `c28c311`: pending and unacked doc writes are one queue entry (id `#doc`, which no element can have), adopted into the next push's `doc` | `sync/core/verifier-fixes.test.ts` N8; `verifier-v1/v1-offline.test.ts` | N8 20/20 (tag and tagDef stored, 0 rejects), 3/3 | FIXED |
| An elbow arrow stored at its two unrouted create points (L10 6) | medium | O1 `486a08e`: the room routes an elbow arrow whose points are not an orthogonal route (Excalidraw's normalization), idempotent on a routed one. O2 `c28c311`: an arrow bound to nothing has no derived change, so its route is pushed | `element-room/verifier-fixes.test.ts` (room); `sync/core/verifier-fixes.test.ts` (client) | L10 6 80/80 rows, 3/3 (two runs of L10 6 alone, and the whole `b3-l6-l10-arrows` spec: 7 passed, 580/580 rows) | FIXED |
| Folding a fix drops the path unit's equal fields (U-a) | medium | O2 `c28c311`: the fold keeps an arrow's or a line's path unit whole while any of it changes | `history/verifier-fixes.test.ts` U-a; `verifier-v1/v1-undo-arrow.test.ts` | U-a; N19 20/20 (0 kept), 3/3 | FIXED |
| A release in a batch whose COMMIT fails takes effect (N7) | low, WRONG | O1 `486a08e`: the drain restores the lease table and sends none of the batch's lease replies. O2 `c28c311`: an acquire the socket took unanswered is asked again after the welcome; a lease the server still names this tab for, released meanwhile, is released behind the pushes | `element-room/verifier-fixes.test.ts` N7; `sync/core/verifier-fixes.test.ts` (both client halves) | N7 20/20, 3/3; browser P11 20/20 | FIXED |
| Saved while keys wait in a pending editor (P1) | low, WRONG | O2 `c28c311`: `LobbyEngineCore.holdSaved`, set by the spike page while EditorLease buffers keys | `sync/core/verifier-fixes.test.ts` | P1 20/20 (`saving` while pending, keys landed), 3/3 | FIXED |
| Saved on a reloaded page before the old queue is loaded (N20) | low, WRONG | O2 `c28c311`: no Saved before the previous page's queue is loaded and adopted | `sync/core/verifier-fixes.test.ts`; `verifier-v1/v1-slowload.test.ts` | N20 20/20 (0 Saved before the load), 3/3 | FIXED |
| After typing into a note created empty, its creation can never be undone (P6, wave 2E) | low | O2 `96f0676`: a local create absorbed before its step boundary (a label re-keyed by the index pre-pass before the editor closed) stays unrecorded until the boundary records it as created | `history/verifier-fixes.test.ts` P6 | P6 20/20 (undo 1 removes the label, undo 2 the note), 3/3 | FIXED |

### V2 (security)

| Defect | Severity | Fix | Regression | Re-run | Status |
|---|---|---|---|---|---|
| A non-holder escapes a text lease through the bind group (detach, move into its own note, a leased free text too) | high, WRONG | O1 `486a08e`: step 6 denies `bind` too for a text element under another session's lease; the op's fields keep the stored kind while its detach is denied | `element-room/verifier-fixes.test.ts` (3 tests); `e2e/spike-b/tests/b3-l8-bind-escape.spec.ts` (V2's browser repro, adopted) | P-A1, A2, A3, A6: LEASED 20/20, stored text and container unchanged, 0 violations; P-A7 holder push ok; browser 20/20 A's text kept, Saved, 0 violations; 3/3 | FIXED |
| The container-to-label one-to-one rule against forged `b` patches (b.rm under lease or lock; a second label) | medium, WRONG | O1 `486a08e`: a `b.rm` of a live label naming its container is put back; the label count reads the stored list and the push's; a detached text leaves its old container's list | `element-room/verifier-fixes.test.ts` (2 tests) | P-A4, P-A5 20/20 (list `[n.t]`, 0 violations); P-A8 20/20 (second label INVALID, one label); 3/3 | FIXED |
| Any session stalls the process with `hello` frames | medium | O1 `486a08e`: more than 5 hellos in 10 s close the session 4099 RATE_LIMITED before any work; welcomes are built from one process-wide queue, 20 ms a slice | `element-room/verifier-fixes.test.ts` | P-H1 (3,000 elements, 400 hellos): viewer closed RATE_LIMITED 20/20; the editor's acks p50 3-6 ms, max 167 ms over the 60 repetitions, on the same board and on another (was 8,040-8,952 ms); 3/3 | FIXED |
| A guest can lock by creating (or reviving a tombstone locked) | low | O1 `486a08e`: a guest's create is stored unlocked (`fix: locked`) | `element-room/verifier-fixes.test.ts` | P-B5 storedLockedByGuest false, P-G3 locked false, 20/20, 3/3 | FIXED |
| The guest cap is per session id | low | O1 `486a08e`: counted by the guest's uid, seeded from its live items at open | `element-room/verifier-fixes.test.ts` | P-D4 500/0/0 over 3 tabs, 3/3 | FIXED |
| A percent-encoded signed-URL parameter name passes | low | lead `5f9d5b1` (CR rev 6): decoded up to three times before the check | `limits.test.ts` (4 cases) | P-C1: `X%2DAmz%2DSignature=` INVALID/INVALID, 20/20, 3/3 | FIXED |
| A malformed `customData.lobby.file` on a create is UNAVAILABLE | low | O1 `486a08e`: the value's schema is checked first (INVALID) | `element-room/verifier-fixes.test.ts` | P-C2 fileKeyString INVALID 20/20, 3/3 | FIXED |
| Lease squatting | low | O1 `486a08e`, `2f34836`: a label's id is no lease id; beyond 4 live leases a session's new acquire is denied (every request answered) | `element-room/verifier-fixes.test.ts` | P-L1 20/20, 3/3 (mallory's 52 acquires all answered, 4 granted; alice's acquire and text push granted) | FIXED |
| `serverWrite` skips the invariants and leases | low | O1 `46fea60`: a write that changes a leased text's text, layout, life or bind (or a leased container's life) is 409 `leased`; one that breaks an invariant around what it wrote is a contract error (500), rolled back | `element-room/verifier-fixes.test.ts` | P-E4 500/500/409, holder's next push ok, 0 violations, 20/20, 3/3 | FIXED |
| A relayed drag never expires | low | O1 `486a08e`: a drag with no frame for 15 s ends and leaves `welcome.drags` | `element-room/verifier-fixes.test.ts` | P-D2 20/20 (relay unchanged; ids of another session's private frame are still relayed by design, §2.7) | FIXED |
| B6 F9's browser evidence used a made-up id | low | O1 `46fea60`: V2's real-stack probe adopted as `b6-cross-workspace.spec.ts` | the spec | 20 repetitions: foreign, same-workspace-other-board, re-point INVALID; own ok; api down UNAVAILABLE; after up INVALID; 0 foreign stored | FIXED |

### V3 (conversion and rollback)

| Defect | Severity | Fix | Regression | Re-run | Status |
|---|---|---|---|---|---|
| The roll-forward gives a placed shape a tombstone's z-order key (on `37bdfa9`) | high, WRONG | O4's `3390b0c`, merged now (`1f783af`) | `apps/sync/test/migrate/rollforward.test.ts` (O4's) | `v3-probe-rf` dupWritten 0, 160/160; `v3-probe-lbident` dupKeys 0, 20/20; b8-drill kitchen sink passes; 3/3 | FIXED |
| b8-drill: `waitSaved` read the wrong field; `pickTargets` picked locked shapes | medium | O4's `de3dc40`, merged | the spec | b8-drill 11/11 boards, every check, 3/3 | FIXED |
| b8-staging-drill passes the wrong data dir and picks the copy by bytes | medium, WRONG | O4's `de3dc40`, merged | the spec | b8-staging-drill on `b-7gw2v3e61a` (64 records): 69/69 checks, 3/3 | FIXED |
| `leak-check.ts` finds only verbatim, whole copies; 4-character strings match inside words | medium | O4 `a7747e7`: `leak-match.ts` (outputs also read normalized: JSON and HTML escapes decoded, line breaks collapsed; word windows for partial copies; short strings as whole tokens, counted apart; repo-shared text apart) | `apps/sync/test/migrate/leak-check.test.ts` (synthetic canary board; the 4 escaped/wrapped/partial CLI cases failed on `de3dc40`) | V3's synthetic canary: 9, 9, 9, 2, 9 matches for exact, JSON, HTML, partial, wrapped (the old check: 1, 0, 0, 0, 0); on the staging runs: 0 matches | FIXED |
| No staging re-run on a merged commit (§8.6.8) | medium | O4's staging rows re-run 3 times on the merged tree (below) | none (a process item) | conversion and diff 4/4 boards, restore fixed point, two browsers 4/4, drill 69/69, 3/3; leak check 0 | FIXED (V3's confirmation pending) |
| The drill's untouched check leaves out every arrow | low | O4 `a7747e7`: an arrow is touched only when an end is bound to a touched element | the drill's own check | b8-drill and staging drill pass with the arrows in, 3/3 | FIXED |
| A both-sides recolour of a geo-polygon (cloud, star) lists no conflict | low | not changed | | | NOT FIXED |
| R0 notes: a 0-byte `-wal` next to a refused board; a board born on Excalidraw keeps its `lb_*` schema only in the WAL after a SIGKILL (a copy of the main file alone reads as tldraw) | low | not changed; recorded as an R0 runbook item (checkpoint before any file copy) | | | NOT FIXED |

## The gate

At `1f783af` (the three merges; `scripts/integration-m3-gate.sh` with the fixer's ports) and, for the unit
part, again at `5f9d5b1`:

| Gate | Result |
|---|---|
| lint (`biome check .`) | PASS, 1,449 files |
| typecheck (`pnpm -r typecheck`) + engine-probe tsc + Node-safety tsc | PASS |
| `pnpm test` | PASS: 4,068 passed, 33 skipped at `1f783af`; 4,071 passed, 33 skipped at `5f9d5b1` (part 3: 4,016) |
| `pnpm test:arrows` | PASS 85/85 (both) |
| plugin units; `hash.ts` in Chromium | PASS 9/9; PASS 1/1 |
| spike A suite (`SPIKE_WEB_PORT=7950`), once | PASS: 99 passed, 2 skipped, 20.4 min, fresh build |
| A8 browser probe | PASS |
| normal web build | PASS, 0 engine markers, 0 source maps |
| engine flag without the dev-auth guard | PASS, 0 marker files |

`38af6d6` differs from `5f9d5b1` only in `apps/sync/src/room/{element-room,lease}.ts` (the lease cap) and
its test: lint, typecheck and the element-room suites (118/118) pass there.

## The re-runs (3 each, 20 repetitions per probe)

- **The verifiers' Node probes** (their files, copied untracked into the merged tree), at `38af6d6`, runs
  1-3: every V1 probe (N3, N17, N18, N16, N9, N9b, U-a/U-b, N19, N8, N20, N7) passes 3/3, 20/20 each
  (N9b 10/10); V2's five probe files 3/3 (24 + 4 + 1 + 1 + 1 tests; results as in the table); V3's
  `v3-probe-rf` 160/160, `v3-probe-lbident` 20/20, `v3-probe-arrows` 120/120 (620 untouched arrow rows, 0
  changed). One deviation: V2's P-A7 computed its base as the clock 2 below alice's, which assumed
  mallory's two pushes wrote; they are refused now, so the clock does not move and the base went negative
  (a malformed push, closed 4099). The copy uses `max(0, …)`; the holder's push then lands 20/20.
- **The verifiers' browser probes**: V1 P1, P4, P6 and the L8 bind escape 3/3 at `5f9d5b1` (20/20 each)
  and once more at `b1ad9dc` (the final code, `38af6d6`; 20/20 each); P11 20/20 at both; B6 cross-workspace
  20/20 once; `b4-client-durability` D2 with `SPIKE_B4_D2_ROUNDS=6` (V1's N16 repro) 3/3.
- **B8 as O4**, O4's own scripts (`o4-b8-open.sh`, `o4-b8-rows.sh` with the fixer's copy excluding the
  untracked V3 probes from its unit run), 3 runs each. Generated: converter and migrate units 407/407 (V3's
  re-check: 127 of them were O4's; the other 280 were V3's untracked probes, v3-probe-rf 160 and v3-probe-arrows
  120, because `--exclude` has no effect in this vitest workspace; O4's own count is 127/127), the
  11 boards' conversions, the restore fixed point (0 beyond tolerance), two browsers 11/11 and the drill
  11/11 (runs 1-2 at `5f9d5b1`, run 3 across the merge of `38af6d6`). Staging (inside `spike-b8/`, TEMP
  and TMP there, traces off, at `38af6d6`): conversions 4/4, restore fixed point 158 elements (0 beyond
  tolerance), two browsers 4/4, the drill on `b-7gw2v3e61a` 69/69. Leak check after each: 0 matches (85
  strings and 100 word windows over 204 and 172 files; 0 of the 12 short strings as whole tokens; 0
  repo-shared). Only ids, counts, codes and hashes were printed.
- **Every other spike-b spec once** at `38af6d6` (the broad pass, base 7960): m1-walking-skeleton 1/1,
  b1-concurrent-fields 4/4, b2-undo 12/12, b3-l1-l5-lease 5/5, b3-l6-l10-arrows 7/7 (580/580 rows, 1.3 h),
  b3-l7-offline 1/1, b3-l8-leased-forged 1/1, b3-l8-bind-escape 1/1, b3-l9-l12-guard 4/4, b3-l12-lease-l 9/9,
  b3-l13-chords 2/2, b3-l13-keys-k 5/5, b4-client-durability 6/6, b4-server-d3-sigkill 1/1,
  b4-server-d4-commit 1/1, b5-r1-readonly-forged 3/3, b5-r2-commenter 1/1, b5-r3-keys 1/1, b5-r4-downgrade 1/1,
  b6-forged 15/15, b6-cross-workspace 1/1, b7-files 7/7 (mood board 200 images, 0 lost creates), b10-echo 1/1,
  b11-convergence 1/1 (3 browsers and 50 headless clients), b12-collapse 1/1, b12-guard 4/4, b12-phone 1/1, the
  owners' probes (400 creates 0 lost; 40 edits 0 lost with and without a 50 Hz writer), V1's P2, P3, P5 (5
  repetitions each). b8-restore and b8-screens refuse any port outside O4's and the lead's ranges (their
  own guard); they ran on O4's ports: b8-restore 3/3 inside `o4-b8-rows.sh`, b8-screens 1/1 at base 7905. Not
  run in this round: B9 (the workstation half waits for the performance fix; the NAS half is O3's) and the
  perf-* specs (unchanged code paths; informational).

## Open

- V3: the geo-polygon conflict listing; the R0 runbook's checkpoint before a file copy.
- The verifiers' re-checks of their findings (V1, V2, V3) and V3's confirmation of the staging rows.
- Unchanged from `M3-part3.md`: B9's performance item (O2 with O5), the quiet window, B9's NAS half, the
  per-item offline count, presence's always-included peers, 2E's redo of Ctrl+G.
