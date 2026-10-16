# Wave S contracts: Client review

Wave S lets a client review a board's deliverables: **review status** (Approve / Request changes / Awaiting review,
rounds, history; WS1), **versions of a deliverable** and **compare** (WS2), **time-coded, page and spot comments** on
video, PDF and images (WS3), and the **client review page** with a **summary PDF** (WS4). The foundation (branch
`wave-s/foundation`) lands the shared contracts, migration `0037_client_review`, the file collector's chain and
comment-pin rules, the permission predicates and guard rows, `LOBBY_CLIENT_REV` 3, the client stubs and the review
viewer's shell. Nothing changes for a user until the workstreams land:

- every new route is **pending** (`apps/api/src/features/pending-routes.ts`): not registered, so it answers 404
  `NOT_FOUND` exactly like an unknown route, for every caller;
- the web clients answer empty without a request, and every write rejects `'unavailable'`;
- the wave S switches (`apps/web/src/features/review/flags.ts` `REVIEW_FLAGS`: `status`, `versions`, `mediaComments`,
  `reviewPage`) are off: no panel, badge, chip, menu entry, viewer or review page; "My notifications" offers no
  review kind (`offeredChatKinds`);
- the upload **ignores** `X-Lobby-Supersedes` (a fresh asset, as before wave S), and a thread that sends a `spot` is
  refused 400 `INVALID_ANCHOR` (never accepted with the spot dropped);
- the bell and the chat preferences carry `review_status` only to a web build of revision 3 (none exists in storage
  until WS1 writes it).

What does not change: the sync protocol (`CONTRACTS_REV` stays 13), `ELEMENT_SCHEMA_VERSION`, the room's validation.
Status, rounds, versions and spots live in Postgres; the only canvas write of the wave is the one Replace media makes
today (`fileId`, `customData.lobby.file`), and with versions its `assetId` simply stays the same.

Design: the wave S design scout (`scratchpad/wave-s/design.md`), followed except where §9 says why not. Owner decisions
taken as given: clients on a review link (accounts or name-only guests) may set a status, a name-only approval reads
"(guest)"; no recorded walkthroughs; no email (the bell and the wave R Slack/Teams hooks only).

## 1. Workstreams and file ownership

| Workstream | Owns | Reads (does not edit) |
|---|---|---|
| **WS1 Review status** | `apps/api/src/features/review/**` (routes, store, rounds with the named checkpoint, the notification insert and `enqueueChatDeliveries` call, `hooks.ts resetForNewVersion`); its lines in `features/comments/notifications.ts` (`toItem` for `review_status`: `NotificationItem.review`; who may see a row), `features/chat-hooks/{deliver,render,outbox}.ts` (`review_status` in `MANY_RECIPIENT_KINDS`, its `ChatMessage.review`, the label only under `includeSnippets`), the dashboard board list's `review` counts (one grouped query); web `apps/web/src/features/review/**` but `flags.ts` (store, events, badges overlay, popover, the review panel, "Mark for review" entries, "Include review status" through `present-export/ported/badges.ts`, `client.ts` made live), `dashboard/BoardCard.tsx` chip, the bell's words (`dashboard/notifications.ts` and `features/comments/ported/CommentsTopBar.tsx` `KIND_TEXT.review_status`, `DashboardBell.tsx`); the viewer's `header` slot entry `ws1.status`; `e2e/excalidraw/s1-*.spec.ts` | contracts `review.ts`, `review-status.ts`; permissions; migration 0037 |
| **WS2 Versions and compare** | `apps/api/src/files/{upload.ts (the header), versions.ts (the list route)}`; web `file-card/ported/{edit-media.tsx (sends the header), CardLayer.tsx (version chip and list)}`, `features/review-viewer/{compare,versions}/**` (the `compare` slot, the `header` entry `ws2.versions`, `versions/client.ts` made live); `e2e/excalidraw/s2-*.spec.ts` | contracts `asset-versions.ts`; `files/gc.ts` (the rules are the foundation's: change them through the lead); WS1's `resetForNewVersion` |
| **WS3 Media comments** | `apps/api/src/features/comments/{index.ts, store.ts}` (anchor checks, storing and answering `spot`; replaces the foundation's refusal line); web `features/comments/{model.ts, ported/geometry.ts, ported/CommentsOverlay.tsx}` (asset anchors for images, version filtering, "v1" chips), `features/review-viewer/{video,image,pdf,export}/**` (the `body` slot per kind, the `threads` slot, CSV / marker CSV / EDL), the `PdfViewer.tsx` markers; the worker probe's `frameRate` (`apps/worker/src/video.ts`, ffprobe's `avg_frame_rate`; `ProbeFacts.frameRate` is declared); `e2e/excalidraw/s3-*.spec.ts` | contracts `comments.ts` (`CommentSpot`), `asset-versions.ts` `MEDIA_COMMENT_RULES` |
| **WS4 Review page and summary** | `apps/web/src/features/review-page/**` (the `?view=review` overlay, phone layout), `present-export/review-summary/**` and one line in `ported/report.ts`'s kind switch; `invite/InvitePage.tsx` and `board/ShareDialog.tsx` ("Open in review view"); the `landing` lines of `apps/api/src/features/dashboard/review-links.ts`, `routes/invitations.ts` (accept) and `features/guests/join.ts`; `e2e/excalidraw/s4-*.spec.ts` | WS1's `client.ts` and store; contracts `review.ts` (`REVIEW_SUMMARY`, `ReviewSummaryModel`, `reviewLandingPath`) |

**Lead-only** (serialise through the lead): every `packages/contracts/src/**` file (the four new ones, `comments.ts`,
`chat-hooks.ts`, `client-rev.ts`, `dashboard.ts`, `guests.ts`, `index.ts`, `thumbnails.ts`, `fixtures/client-rev2.ts`,
which is frozen), `packages/permissions`, `packages/dev-assets/src/shared.ts`, migration `0037` (shipped: never edited; a
fix is a new migration), `apps/api/src/files/gc.ts`, `apps/api/src/features/{pending-routes.ts, index.ts}`, the guard
lists (`guests/guard.ts`, `domain-access/guard.ts`), `features/chat-hooks/prefs.ts` (the revision rule),
`apps/web/src/features/review/flags.ts`, `apps/web/src/features/review-viewer/{ViewerHost.tsx, viewer-state.ts,
slots.ts, review-viewer.css}`, its mount line in `file-card/ported/index.tsx`, `pnpm-lock.yaml`, `AGENTS.md`,
`docs/PROGRESS.md`. Each workstream removes its own keys from `PENDING_ROUTES` and from `WAVE_S_ROUTES` in
`apps/api/test/features/pending-routes.test.ts` in the change that implements them, and turns its own switch on in
`flags.ts` (one line, through the lead) when its feature is live. WS1 lands its store first (WS2's reset and WS4's
page read it).

Plan items: WS1 S1-1 (items), S1-2 (status and history), S1-3 (rounds); WS2 S2-1 (the version list) and the upload
header; WS3 and WS4 add no route.

## 2. Review status (WS1; contracts `review.ts`, `review-status.ts`)

### 2.1 Model

- A **review item** (`rvi_…`) is one deliverable of one board: a **frame** or a **file** (a file card, or an image
  element with `customData.lobby.file` of kind image; never a placed PDF page), addressed by its element id
  (`REVIEW_ELEMENT_ID_PATTERN` = canvas-schema `ELEMENT_ID_PATTERN`). At most one live item per element
  (`review_items_live_idx`); removing is soft (`removed_at`, history kept) and marking again makes a new live row.
  Duplicating an element does not duplicate its item; a deleted element leaves an orphaned item (the web's fact,
  never stored) that comes back with the element.
- **Statuses** (`REVIEW_STATUSES`, `REVIEW_STATUS_LABELS`): `pending` "Awaiting review", `changes_requested`
  "Changes requested", `approved` "Approved". Any status may follow any other. **Reasons**: `set`, `new_version`
  (WS2's upload; the uploader is the actor), `new_round`.
- A **file** item names its `asset_id`; its status is about `status_version_id`, a version of that asset (0037's
  composite key): the version the card **shows** when the status is set, any version this board serves (after "Make
  current", an undo or a checkpoint restore the card shows an older one; a version the board does not serve is 404).
  So "Approved" always means "approved vN": the badge, panel, popover and review page say "Approved v2 · v3 is newer"
  (or "· this shows v1") when the card shows another version (`apps/web/src/features/review/model.ts fileStanding`).
  `NEWER_VERSION` stays in the contracts for an older api; this one no longer sends it. (Integration fix: requiring
  the newest version locked every status write after "Make current".)
- A card that now shows **another asset** (Replace media's fresh-asset fallback: another board holds the chain, §3.1, or
  a revision-2 tab replaced it) makes its item **stale**: the web shows "File replaced: review again" (icon and counts as
  Awaiting review; never the old "Approved"; the summary PDF lists it as awaiting review), and a status set on it names
  a version of the new asset, which **re-points** the item (`asset_id` and `status_version_id` change together).
- **Rounds** (`rvr_…`, numbered 1..100 per board): optional; at most one open per board (`review_rounds_open_idx`).
  Starting one resets the picked items to pending (default: every live item not approved; `keepApproved` true) and
  takes a **named manual checkpoint** `reviewRoundCheckpointName(title)` ("Review round 2 sent"; no new checkpoint
  reason). Closing freezes it.
- **Events** (`rve_…`, `seq` identity): `status`, `added`, `removed`, `round_opened`, `round_closed`, with the actor as
  it was then (`actor_name`: a guest's typed `guest_name`, an account's name; `actor_kind` read from `users.kind` in
  the write's transaction; `actor_external` from wave J's `knownOutsideSql`). ≤ 1,000 per item.
- Labels: `cleanDisplayText`, 1..120; round titles 1..80. Limits: `REVIEW_LIMITS` (200 live items, 100 rounds per
  board, 30 status changes per person per board per minute → 429 `REVIEW_RATE_LIMITED`).

### 2.2 Who (server-side; `@draftroom/permissions`)

| Rule | Predicate | Who |
|---|---|---|
| `view` | `can(role, 'view', status)` | anyone who may view the board (viewers too); the same answer for every viewer |
| `setStatus` | `canSetReviewStatus(role, status)` = `can(role, 'comment', status)` | owner, editor, commenter on an **active** board: team, workspace guests and **name-only guests on a commenter link**; a viewer link cannot; archived: nobody |
| `manage` | `canManageReview(role, kind, status)` = `kind === 'account' && can(role, 'edit', status)` | edit rights **and** an account: a name-only guest on a workshop link never manages |

`REVIEW_RULES` maps each route to its rule. The actor is always the session's user (`actorOf`); every input is strict
(an `actor` key is refused). `reviewActorLabel` writes an actor everywhere: a guest is its typed name + `" (guest)"`
(never `users.name`, which already carries it), an outside account `"Name · External"`, control/bidi/zero-width
characters removed. The summary PDF adds `REVIEW_GUEST_FOOTNOTE`. No owner switch "clients may approve" in this wave:
a viewer link, revoking the link, or "Internal only" already stops a client.

### 2.3 Routes

| Route | Rule | Body → answer |
|---|---|---|
| `GET /api/boards/:bid/review` | view | → `GetReviewResponse` `{items, rounds, openRoundId, can}` |
| `POST /api/boards/:bid/review/items` | manage | `AddReviewItemInput` → 201 `ReviewItemResponse`; file: the asset must have a version servable here (404 otherwise); 409 `ALREADY_IN_REVIEW`, `REVIEW_FULL` |
| `PATCH /api/boards/:bid/review/items/:rvi` | manage | `PatchReviewItemInput` `{label?, position?}` |
| `DELETE /api/boards/:bid/review/items/:rvi` | manage | 204 (soft) |
| `POST /api/boards/:bid/review/items/:rvi/status` | setStatus | `SetReviewStatusInput` `{status, fromSeq?, versionId?, note?}` → `SetReviewStatusResponse` `{item, event, thread?}`; 409 `STATUS_CHANGED` (`ReviewStatusChangedBody`: the current item) / `NEWER_VERSION` (`ReviewNewerVersionBody`); 400 `VERSION_REQUIRED` |
| `GET /api/boards/:bid/review/items/:rvi/events?before=` | view | → `ListReviewEventsResponse` (50 a page, newest first) |
| `POST /api/boards/:bid/review/rounds` | manage | `StartReviewRoundInput` → 201 `ReviewRoundResponse`; 409 `ROUND_OPEN` |
| `POST /api/boards/:bid/review/rounds/:rvr/close` | manage | → `ReviewRoundResponse`; 409 `ROUND_CLOSED` |

Guard rows: a name-only guest is refused the five `manage` routes (`REVIEW_MANAGE_ROUTE_KEYS`, 403
`GUEST_ACCOUNT_REQUIRED`, `REVIEW_GUESTS_MESSAGE`); the `view` and `setStatus` routes have no guest row (the link's role
decides). **No creator row**: marking for review neither creates a board nor hands out access. Path builders:
`reviewPath`, `reviewItemsPath`, `reviewItemPath`, `reviewStatusPath`, `reviewEventsPath`, `reviewRoundsPath`,
`reviewRoundClosePath`. New queries name `status IN ('active', 'archived')` (the importing-board tripwire).

### 2.4 One write

The board's notification lock first (`lockBoardNotifications`, comments' NC-V3 order), then the item row `FOR UPDATE`; a different `status_seq` than `fromSeq` → 409 (without `fromSeq` the write wins). The
event, the item update, the optional note thread (an `everyone` thread through the comments store: a frame gets a
`shape` anchor at `u=1, v=0`, a file an `asset` anchor on the version; mentions rewritten; ≤ 5,000 characters), the
notifications and the chat outbox rows commit together. Board events `REVIEW_ITEM_EVENT` `{item}` and
`REVIEW_ROUND_EVENT` `{round}` go out after COMMIT, the same payload for every viewer.

### 2.5 The bell and chat (`LOBBY_CLIENT_REV` 3)

- Notification kind `review_status` (0037; `notifications.review_event_id` names its event on the same board,
  `notifications_review_check`). `NotificationItem.review` (`NotificationReview`): `event` `status` (`status`, `reason`,
  `itemId`, `label`) or `round_opened` (`roundTitle`, `itemCount`). Recipients: the board's owners, the person who
  marked the item, earlier status setters who are accounts; never the actor. A round start or a new-version reset is
  ONE notification per recipient. **Flood brakes** (`features/review/store.ts notifyReview`, under
  `lockBoardNotifications`, which the status write, the round start and the upload of a new version take first):
  repeated flips of one item by one actor collapse into one bell row while it is unread and its chat message has not
  gone yet (the row moves to the latest event); within an hour a recipient gets at most 20 rows from one actor on one
  board and 30 from everyone on it, read or not (`REVIEW_NOTIFY_*`; 0037's `notifications_review_window_idx`). Past a
  cap the status still applies; it adds no bell row or chat message. The 30-a-minute write budget stays in front.
- Chat hook kind `review_status` (`CHAT_HOOK_KINDS`; 0037 widens `chat_hook_prefs_kinds_check`); a
  many-recipient kind (one message per hook per event). `ChatMessage.review` (`ChatReview`) and `chatMessageSentence`:
  "Ana (guest) approved an item on Pitch wall"; the item label (or round title) only when the renderer passes it, i.e.
  under the hook's `includeSnippets`, ≤ 60 characters (`CHAT_HOOK_LIMITS.reviewLabelChars`), never from a team-only
  note.
- **Revision 3** (`client-rev.ts`, `knowsRev3`): the api lists `review_status` (and counts it) only for a request that
  declares revision ≥ 3 (`NOTIFICATION_KINDS_SINCE_REV3`); `GET /api/me/chat-prefs` leaves the kind out for an older
  build (`CHAT_HOOK_KINDS_SINCE_REV3`), and an older build's `PUT` keeps each hook's stored `review_status` (also when it
  sends the hook with no kinds, or leaves it out): it cannot know the kind, so it never turns it off. A rev-3 build sets
  and clears it. The rev-2 build's response schemas are frozen in `@draftroom/contracts/fixtures/client-rev2` and the
  api answers are parsed with them (`apps/api/test/features/review/client-rev3.test.ts`).

### 2.6 Dashboard

The board list (`ListBoardsWithThumbnailsResponse`) gains an optional `review: BoardReviewCounts` `{pending, changes,
approved}` (live items; absent when none). A `z.object`: an older web strips it.

## 3. Versions of a deliverable (WS2; contracts `asset-versions.ts`, migration 0037)

### 3.1 The chain

A version of a deliverable is a new `asset_versions` row with the **same `asset_id`** and `supersedes` = the version it
replaces. 0037: `FOREIGN KEY (asset_id, supersedes) REFERENCES asset_versions (asset_id, id) ON DELETE SET NULL
(supersedes)` (a chain stays inside one asset by key), `CHECK (supersedes <> id)`, `UNIQUE (supersedes)` (linear), an
index `(asset_id, created_at)`. The element keeps its id and, across versions, its `customData.lobby.file.assetId`.
"The newest version" has one definition everywhere (the upload, the list, the review store): the `supersedes` walk of
`files/versions.ts chainOnBoard` and `latestServable`, upload order only between unlinked roots, never `created_at`
then id (two versions in one millisecond keep their chain order).

`POST /api/boards/:bid/assets` with **`X-Lobby-Supersedes: ver_…`** (`SUPERSEDES_HEADER` in
`packages/dev-assets/src/shared.ts`), parsed before any body byte is read, after the edit check, like `X-File-Name`.
In the upload's one transaction, after the quota re-check:

- the superseded row is read `FOR SHARE` (the collector then cannot delete it under the new version) and must be
  servable on this board (`files-auth.ts`) → else 404 (no probing); a malformed header → 400 `INVALID_SUPERSEDES`;
- it must be the newest servable version of its asset → else 409 `VERSION_NOT_LATEST` (`VersionNotLatestBody`
  `{latestVersionId}`);
- it must have been **uploaded to this board** (the chain's origin): a version only linked here (a copy shows what
  its canvas showed) → 409 `VERSION_NOT_LATEST` naming that version, "This file’s versions are kept on another board.
  Upload it here as a new file instead." The web's fallback then uploads a fresh asset (its review item reads "File
  replaced: review again", §2.1). Another board never takes a chain over;
- `versionKindsCompatible` (images replace images, the rest the rest; the web's `replaceRefusal`) → else 400
  `VERSION_KIND_MISMATCH`;
- a second concurrent supersede of the same version fails the unique index → 409 `VERSION_NOT_LATEST`;
- WS1's `resetForNewVersion(tx, {workspaceId, boardId, assetId, versionId, actorId})` (`features/review/hooks.ts`)
  resets the asset's live items **on the upload board only** (it locks every live item of the asset there, whatever its
  status, and picks the non-pending ones after the locks: an approval being given at that moment is waited for and
  reset, never left on the old version); after COMMIT the board event `ASSET_VERSION_EVENT`
  `{assetId, versionId}` and the returned items' `REVIEW_ITEM_EVENT`s, on that board. (Integration decision: copies of
  a card share its asset id, but each board's review is its own. A client reviewing board B was shown v1 there, B's
  cards still show v1, and B's "Approved" stays "approved v1" until a version is uploaded on B; the reset never
  reaches a board that did not hear the upload. Tested in `apps/api/test/features/review/review.test.ts`.)

`replaceMedia` sends the header (`versions/client.ts supersedesHeader`) with the element's current `versionId`, then
writes as today. An older web keeps making fresh assets (that card's chain starts again at v1).

### 3.2 The list

`GET /api/boards/:bid/asset-versions/:ast` (view) → `ListAssetVersionsResponse` `{assetId, versions, latestVersionId}`,
oldest first, `n` = 1-based among the versions **servable on this board** (a copy that only links v3 shows it as v1),
`AssetVersionEntry` with uploader (`ReviewActor`), size, status, `pageCount`, `durationMs`, thread counts (as the
caller may see them) and the last review status given to it. Meta and previews keep coming from the existing
`/api/boards/:bid/assets/:ast/:ver` and `/files/…` routes.

### 3.3 Compare

In the viewer's `compare` slot (`mode: 'compare'`, `compareWith`): images side by side (synced zoom/pan), slider
(`clip-path`, letterboxed when the aspect ratios differ, with a note) and onion skin, from the `display` derivatives
("Load full resolution" only when downloads are allowed); PDF and Office previews page N against page N (a page count
mismatch is stated); video A/B on the originals with one transport, B following A's clock (seek when |Δ| > 60 ms,
checked each `requestVideoFrameCallback` or 250 ms), B muted, layouts side by side, wipe and toggle (`A`/`B` inside the
viewer only). A codec the browser cannot play shows the posters and "This browser can't play this file; download it".
Phones: stacked, or the slider with touch.

### 3.4 Storage and the collector (landed by the foundation)

Versions count toward the workspace quota and file count as today. **`apps/api/src/files/gc.ts`** keeps:

- every version a comment thread's `asset` anchor names (resolved threads too; 0037's
  `comment_threads_asset_version_idx`);
- **whole chains**: `keptWithChains` keeps every version of an asset one of whose versions is referenced (on a canvas,
  in "Recently deleted", a checkpoint, a link, a library item, a pinned thread), in flight or on a trashed board, in the
  pass and in the race guard's second read;
- under the version's row lock, deletion also waits for a pinned thread and for **any other version of the chain that
  is not itself marked past the grace period**: a version uploaded since the pass began holds its chain, and a chain
  no board shows any more goes only as a whole.

Tested in `apps/api/test/files/gc-chains.test.ts` (report and delete mode, the lock check; all six fail with the rule
removed). WS3's thread insert reads the anchored version `FOR SHARE` (so a thread and the collector's delete never
cross). Board backup (`.lobby`) keeps only the versions elements show and no review data in this wave (WS2 states it
in the backup's help text).

### 3.5 One asset, many versions (the audit)

Every read of `asset_versions` in `apps/api/src`, `apps/sync/src` and `apps/worker/src` was checked: each is keyed by
the version or by `(asset, version)`, never by the asset alone (`board_asset_links`, `library_item_files`,
`library_place_pending` and the checkpoint refs all key both columns). Two consequences WS2 keeps in mind:
visibility follows the **version** (a board that shows v1 does not see v2 uploaded elsewhere until it is linked), and
`files/usage.ts` counts each version as one file toward `workspaceMaxFiles` and the guest allowance (as the design
says). Deleting a board still cascades the versions uploaded to it (a chain on another board keeps its later versions,
their `supersedes` set to null). `apps/api/test/files/version-chains.test.ts` holds meta, the original, per-version
visibility, A1's file refs and the ignored header.

## 4. Time-coded, page and spot comments (WS3)

- The anchor exists: `asset {shapeId, assetId, versionId, page?, timeMs?}`. New: **`spot`** `{u, v}` in [0, 1]
  (`CommentSpot`), stored in `comment_threads.spot_u / spot_v` (double precision; both or neither; asset anchors only:
  `comment_threads_spot_check`), a **top-level optional `CommentThread.spot`** and `CreateThreadInput.spot`. Top-level
  because `CommentThread` is a `z.object` (an older tab strips it) while `CommentAssetAnchor` is strict (a key inside
  it would break every old tab's thread list).
- Server checks (WS3, `features/comments`; 400 `INVALID_ANCHOR` = `MEDIA_COMMENT_RULES.invalidAnchor`): the version is
  servable on the board and belongs to `assetId`; `page ≤ pageCount`, `timeMs ≤ durationMs + 1 s` when the probe knows
  them; `page` only on `pdf`, `timeMs` only on `video`; `spot` only with `asset`. Until WS3 ships, any `spot` is refused.
- Images get `asset` anchors from the new build; existing image threads stay `shape` anchors ("on every version"). A
  thread keeps its `versionId` forever; the canvas shows the pins of the version a card shows plus version-less
  threads; the panel lists the others with a "v1" chip that opens the viewer on v1.
- The viewer's `body` slot per kind: video (Lobby's transport, ±1 s / ±1 frame at `ProbeFacts.frameRate` or
  `MEDIA_COMMENT_RULES.defaultFrameRate` 25, timecodes, scrubber markers clustered under 6 px, "Comment at 00:12.4"),
  PDF (the `PdfViewer` markers, "Comment on page 3"), image (zoom/pan, spot pins). Keys only inside the viewer.
- Export (a download: the export policy and the e2e download rule apply): CSV, Premiere-style marker CSV and a CMX3600
  EDL (comments cut to 120 characters, no newlines); team-only threads only for the team and by the report's opt-in.

## 5. The review viewer shell (the foundation; `apps/web/src/features/review-viewer`)

- `viewer-state.ts`: `openReviewViewer(registries, {elementId, assetId, versionId, mode?, compareWith?, at?,
  threadId?})`, `closeReviewViewer`, `reviewViewerRequest` (per board page, never synced; a fresh `nonce` per open).
- `slots.ts`: `registerViewerSlot({id, slot, kinds?, order?, Component})`, slots `header` (WS2 `ws2.versions` order
  10, WS1 `ws1.status` order 20), `body` (WS3, per kind), `compare` (WS2), `threads` (WS3). Components get
  `ViewerSlotProps` `{ctx, request, file: {kind, name, mimeType}, close}`.
- `ViewerHost.tsx`: one native modal `<dialog>` (`data-testid="review-viewer"`) portalled to `<body>`, mounted by the
  media feature as a screen overlay; renders nothing while `reviewViewerEnabled()` (the `versions` or `mediaComments`
  switch) is false or nothing asked for it; closes when its element is deleted or shows another asset; keys stop at
  the dialog; Escape and the backdrop close it; on phones the side list is a bottom sheet.

## 6. The client review page and the summary PDF (WS4)

- `/b/:bid?view=review` (`reviewLandingPath(bid, 'review')`, `REVIEW_VIEW_PARAM`): a screen overlay in focus mode over
  the mounted board (like present mode): the same ticket, sync session, access checks and asset loader. The open
  round's items (else every live item) in order; per item the label, a picture (frames through
  `present-export/ported/exporter.ts renderPng` at column width × DPR ≤ 2, lazily, cached by the frame's elements'
  version sum; files their own previews), the pill (`reviewPillText`), the buttons for whoever `can.setStatus`, the
  open threads with reply. Phone first (16 px gutters, 44 px targets, a sticky "3 of 7 approved" from `reviewCounts`).
- **Landing**: `invitations.landing` (`ReviewLanding`: `board` | `review`; 0037 allows `review` only for a board's
  multi-use link: `invitations_landing_scope_check`). `CreateReviewLinkInput.landing` (optional; the api stores
  `board` when absent); `ReviewLinkCreated`, `PendingInvitation`, `InvitationAccepted` and `GuestJoined` carry an
  optional `landing` (absent: the board, as from an older api).
- **Summary PDF** (whoever `downloadsAllowed`): the client pipeline (`pdf-build.ts` in `pdf.worker.ts`), a new report
  kind next to the vote results (`REVIEW_SUMMARY.maxPages` 60): the cover, one or two pages per item
  (`ReviewSummaryModel`: picture, label, status, who and when, `reviewVersionLabel` "v3 of 3", the last 10 events,
  every open thread), and `REVIEW_GUEST_FOOTNOTE` when a guest appears. Searchable text.

## 7. Migration `0037_client_review`

Additive (`packages/db/migrations/0037_client_review.sql`, tested in `packages/db/test/wave-s-0037.test.ts` and the
real-Postgres `apps/api/test/migrations.pg.test.ts`):

- `review_rounds`, `review_items`, `review_events` (CHECKs on ids, kinds, statuses, reasons, labels; the kind decides
  what an event holds; one open round and one live item per element; the status version a version of the item's asset;
  the note thread on the same board; cascades with the board, SET NULL for users, threads, versions, rounds and the
  round's checkpoint);
- `asset_versions.supersedes` (§3.1); `comment_threads.spot_u / spot_v` and the pinned-version index;
  `invitations.landing`; `notifications.review_event_id` and the widened `notifications_kind_check` and
  `notifications_check`, plus `notifications_review_check`; the widened `chat_hook_prefs_kinds_check`.

**Rollback** (the migration's header): before rolling the api back below 0037, `DELETE FROM notifications WHERE kind =
'review_status'` and `UPDATE chat_hook_prefs SET kinds = array_remove(kinds, 'review_status') WHERE 'review_status' =
ANY (kinds)`; and keep `DRAFTROOM_ASSET_GC` at `report` (or `off`) while an older api runs: it does not know the chain
and comment-pin rules, so in delete mode it would remove superseded and comment-pinned versions after 30 days. Report
mode only marks; this build's next pass clears the marks. An older api ignores the review tables, the spot columns
and `landing`; versions sharing an asset id are valid rows to it (§3.5).

## 8. Tests the workstreams inherit

- `apps/api/test/features/pending-routes.test.ts` (`WAVE_S_ROUTES`: delete your keys when you implement them; the guard
  rows hold), the guest refusals matrix (`refusals.test.ts`: the five manage routes), the creation matrix (no wave S
  row).
- `apps/api/test/features/review/client-rev3.test.ts` (the bell and chat preferences for rev 0-3; WS1 extends it with
  real items; WS3 replaces the spot refusal case with its anchor checks).
- `apps/api/test/files/gc-chains.test.ts` and `version-chains.test.ts` (WS2 adds the real-Postgres concurrent
  supersede and the collector against real locks).
- `packages/contracts/src/wave-s.test.ts`, `packages/db/test/wave-s-0037.test.ts`, `apps/web/src/features/review/
  wave-s-stubs.test.ts` (each workstream updates the stub cases it makes live).

## 9. Where the foundation differs from the design

- **Keys instead of code checks.** The chain stays inside one asset by a composite key (`(asset_id, supersedes)` →
  `(asset_id, id)`; the design said "code also checks"), a file item's status version must be a version of its asset
  (composite key), the note thread must be on the item's board (composite key), and a round names its checkpoint by
  key (`board_snapshots`, SET NULL).
- **The chain rule at the row lock.** The design's rule (a version is kept while another version of its asset is
  referenced) cannot be re-checked under the version's lock (canvases are read from sync), so the lock check keeps a
  version while any other version of its chain is not itself marked past the grace period: a version uploaded during
  the pass holds its chain, and a chain goes only as a whole. Comment pins are checked there too, and indexed.
- **An older build's chat-preferences PUT keeps `review_status`.** The design only filtered the GET; without the PUT
  rule a stale tab saving its choices would silently turn a rev-3 choice off.
- **The foundation refuses a `spot`** (400 `INVALID_ANCHOR`) and **ignores `X-Lobby-Supersedes`** rather than
  accepting either and dropping it, so neither can pass for a feature before its workstream stores it.
- **Constraint names**: `invitations.landing`'s column CHECK takes the auto name `invitations_landing_check`, so the
  scope rule (review only on a board's multi-use link: new) is `invitations_landing_scope_check`; 0036's column CHECK
  was confirmed as `chat_hook_prefs_kinds_check`. The spot columns are `double precision` (the design said `real`), so a
  stored spot reads back exactly what JavaScript sent.
- **`landing` in answers is optional**, not defaulted (the design said `z.object`): the api's answer types stay as
  they are until WS4 sets it, and readers treat absent as `board`.
- **The predicates live in `packages/permissions`** (`canSetReviewStatus`, `canManageReview`), lead-only like `can()`;
  `REVIEW_RULES` in contracts names them per route. No creator row for any wave S route (stated and tested).
- **The rev-2 fixtures are a contracts subpath** (`@draftroom/contracts/fixtures/client-rev2`), frozen copies of the
  rev-2 build's bell, thread and chat-preference schemas, so both the contracts and the api tests parse real answers
  with them.
- **The viewer shell is mounted** by the media feature next to the PDF viewer (one overlay line in
  `file-card/ported/index.tsx`) and opens only with the `versions` or `mediaComments` switch; the review status switch
  alone does not need it.
- **`ProbeFacts.frameRate`** is declared (optional) in the foundation so WS3 only fills it in the worker.

## 10. Checks (the foundation's head)

Run on the foundation's head, on the Windows PC (2026-10-16):

| Check | Result |
|---|---|
| `pnpm -r typecheck` | 18 of 19 workspace projects, pass |
| `pnpm lint` (biome) | 0 errors; 4 warnings, all in sync tests this branch does not touch (as on main) |
| vitest `packages` | 70 files, 2,005 tests pass (1 skipped) |
| vitest `canvas-schema`, `dev-assets`, `scripts` | 199, 11 and 26 tests pass |
| vitest `api` (PGlite) | 226 files, 2,191 tests pass (136 skipped: the real-Postgres files) |
| vitest `sync` | 133 files, 854 tests pass (5 skipped) |
| vitest `web` | 471 files, 5,628 tests pass (1 skipped) |
| `pnpm licence:check` | PASS (no new dependency) |
| e2e (chromium, `E2E_PORT_BASE=7720`, once): `comments-*`, `k2-comments`, `media-*` | 75 passed (the preview fixtures generated first with `pnpm fixtures`) |

Not run here: the `*.pg.test.ts` files (they need `DRAFTROOM_TEST_DATABASE_URL`: the lead runs them on the NAS, including
the updated `migrations.pg.test.ts` expectations).
