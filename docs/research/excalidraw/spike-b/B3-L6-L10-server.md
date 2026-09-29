# B3 L6 and L10: the server half (O1)

L6 and L10's specs and evidence are O2's (§8.6.3). O1 owns the server half: the conditional container fit
(§2.9.4 rules 1–5), the free text's own fit (3.5), the lease-expiry re-fit (rule 6) and the server-derived
bound arrows (rule 7), with their unit and protocol tests. This file is that half's evidence, on `c54d6ab`.

| Server behaviour L6/L10 rely on | Where it is tested | Result (3 runs) |
|---|---|---|
| a holder's fit applied last, only if no `pos`/`shape` write to the container came after its base; dropped otherwise (`fitDropped`); a holder's re-fit on the newer base applied | text-lease.test.ts "a stale fit is dropped…"; arrows s4-frame (drag then fit, fit then drag) | pass |
| a non-holder's fit dropped silently; fit writes advance only `gclock.fit` (an 11-minute-old replay of a resize based before the fit is not STALE) | text-lease.test.ts | pass |
| a leased free text's own `x`/`y` as its fit: dropped after B's move of the text (kept), re-applied on B's position | text-lease.test.ts; arrows s5-freetext (left and centred) | pass |
| rule 6: the holder vanished after a resize; on expiry the server re-fits the note's label for the new size (sticky notes) | text-lease.test.ts "lease expiry" | pass |
| rule 7: a target's move, resize, rotation, fit or free-text layout re-snaps its bound arrows in the same clock; the resizer and the typist push 0 arrow ops (their follows are derived); `derived` rows in their acks; `fix` on an arrow the push wrote | arrows s1, s2, s3, s5, s6, r34, r35; bound-arrows.test.ts | pass |
| C's free end, midpoint or fixed segment kept in both commit orders (the whole `path` unit), on the target's final edge within 0.5 px; the barrier race 20× per order | arrows s1 (plain and rotated 0.6), s2, s3 (move, resize, 60°, 90°, replay), s7; bound-arrows.test.ts race (40 boards, every client's hash equal to the snapshot) | pass |
| a frame drag: the translated arrow is the dragger's write (not derived), free end and bend moved with the frame, bound end on N's grown edge, both op orders and both orders of the drag and the fit | arrows s4-frame (8 cases) | pass |
| arrow labels: unleased → derived `layout` (re-wrapped, repositioned); leased → position only | bound-arrows.test.ts; arrows r33-label-node | pass |
| a locked arrow follows its target; a deleted target nulls the binding and leaves the end in place; a no-op target write re-snaps nothing | bound-arrows.test.ts | pass |

Commands: `pnpm test:arrows` (85/85, 3/3) and `pnpm exec vitest run --project sync
apps/sync/test/element-room` (82/82, 3/3); the unit tests of the helpers in
`packages/canvas-schema/src/engine/binding.test.ts`.
