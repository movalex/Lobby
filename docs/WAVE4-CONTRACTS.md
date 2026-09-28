# Wave 4: contracts

Integration owner: main session. Wave 3's shared rules (docs/WAVE3-CONTRACTS.md §1) still bind:
- feature folders;
- events published after commit, with payloads safe for every viewer;
- `requireBoardAction` / `requireWorkspaceRole` for every decision, and 404 so nothing leaks existence;
- `--dr-*` tokens;
- light and dark themes and 390 px;
- "Lobby" in user-visible text;
- no secrets read;
- a deviation list for every file outside your ownership.

The security baseline is docs/SECURITY-REVIEW-2026-09-27.md, plus the wave-3 fixes (name-only guests, the export policy, the user-record and attribution rules in sync). Never reopen them. In particular, **name-only guests** (users.kind = 'guest') are limited everywhere the wave-3 code limits them. Every new route and UI must decide explicitly what a guest can do.

Sources for what is missing: `docs/FEATURES-M2-CONTRACTS.md` §3 rows marked Not built or Partial (the IDs below), `docs/research/miro-ux-checklist.md`, `docs/REVIEW-2026-09-27.md` §4, and the build plan §9 (workshops, exports).

## 1. Shared rules for this wave

- **Base**: `origin/integration/wave3` after round 3, or `origin/main` if it already contains wave 3. Fast-forward before any change.
- **Migrations** (pre-allocated): `0014_checkpoint_policy` (checkpoints), `0015_board_search` (search). Wave 3 round 3 may add `0013_asset_gc`. Add yours to the lists in `packages/db/test/migrate.test.ts`; integration merges the list edits.
- **Registries** (pre-registered stubs; never edit `registry.ts`, `apps/api/src/features/index.ts` or `packages/contracts/src/index.ts`): web features `apps/web/src/features/{mindmap,tags,people}/index.tsx`; api feature `apps/api/src/features/search/index.ts`; contract files `packages/contracts/src/{present-live,mindmap,tags,search}.ts`. Other owners append to their existing contract file.
- **Keyboard**: every new binding goes into `apps/web/src/features/keyboard-map.test.ts`, with no chord bound twice.
- **Tests**: unit and API tests next to the code, plus one browser suite `e2e/tests/<owner>.spec.ts` (3 green runs), and the existing suites that cover what you touched.
- **Performance**: nothing new may run per frame or per store change without a measured reason. Overlays must use tldraw's reactive `useValue` with narrow selectors.

## 2. Owners

### present-live: present to everyone, follow, and the people list (PRS-07, PRS-12, FAC-01, FAC-07..10, WRK-02)
Owns `apps/web/src/features/present-export/**` (the live-presentation part), `apps/web/src/features/workshops/{follow.ts,…}` for the follow helpers, the people list in `apps/web/src/board/TopBar.tsx` (or a new `apps/web/src/features/people/**` it renders), `apps/api/src/features/workshops/**` for any new events, and `e2e/tests/present-live.spec.ts`.
- **Present to everyone** (editors):
  - Present mode gets "Invite everyone". Everyone on the board sees a banner, "Chase is presenting — Join / Not now", and anyone who joins follows the presenter's slides (frames) and camera.
  - Participants can step out ("Stop following") and rejoin from a top-bar chip.
  - The presenter sees "N following". Handing off to another editor makes them the presenter.
  - Ending the presentation releases everyone.
  - Late joiners get the current state (the event plus a GET for state). Viewers, commenters and guests can follow.
- **People list** (the top-bar avatars):
  - a searchable list of who is on the board: name, "(guest)", role, and a follow/unfollow button per person;
  - "Bring to me" per person, for editors, reusing the summon event with a target;
  - a "who follows me" indicator.
- Server authority: presenter state is kept per board in api memory like raised hands. A disconnect ends the presentation after a grace period. Every event payload is safe for all viewers.
- **As built** (present-live):
  - API (`apps/api/src/features/workshops/presentation.ts`, registered from `workshops/index.ts`; contracts `packages/contracts/src/present-live.ts`): `GET /api/boards/:bid/presentation` (view) and `POST …/presentation` (start, claim a tab, `resumeId` after an api restart, `takeOver` once the presenter has been offline 3 s), `…/slide`, `…/stop`, `…/handoff`, `…/follow`. One event, `present.live`, carries the whole state (presenter, presenting tab id, slide, `presenterOnline`, followers up to 200 plus the exact count) and what changed, versioned `{epoch, n}` like the hands queue.
  - Who: GET and follow need `view` (viewers, commenters and name-only guests follow). Start, take over and receiving a hand-off need `edit` and an account (a name-only guest gets 403 `GUEST_ACCOUNT_REQUIRED`, and 409 `GUEST_CANNOT_PRESENT` as a hand-off target). Slides: the presenter's presenting tab only (409 `NOT_PRESENTER` / `OTHER_TAB`). Hand-off: the presenter, from any of their tabs (409 `NOT_PRESENTER`); the target must be able to edit and have an open event stream on the board (409 `CANNOT_PRESENT` / `NOT_ON_BOARD`). End: the presenter, or a board owner (`manage_access`; the api allows it, no UI offers it yet). A `resumeId` is honoured only for a presentation this api process never saw end (an ended id gets a new presentation, so its old followers are not pulled into it).
  - Presence comes from the event streams the hub admitted (`userStreamCount`), swept every second: the presenter is shown as reconnecting after 3 s without a stream, the presentation ends after 15 s (a reload comes back in time), followers without a stream stop counting after 5 s.
  - Limits: slides 30/s per board, follow toggles 12 per 10 s per person, start/stop/hand-over 12 per 10 s per person (429 with Retry-After); only slide requests from the presenting tab count toward the board's slide budget (another editor's refused requests never use it up); follower changes are published at most every 300 ms per board.
  - Web: `present-export/live/` (store, controller, UI) on top of `present-session.ts`, which gained a follower role (the presenter's slide, no slide keys, Esc steps out; the view stays on the slide), `onStop`, and a guard that ends tldraw following while presenting. The presenting tab resumes after a reload (its id is in sessionStorage); a hand-off turns the new presenter's following into presenting and the old presenter into a follower; followers wait 10 s for the presenter's tab after an api restart and follow again (someone who steps out during that wait stays out when it comes back). The people list lives in `features/people/` and replaces the avatars in `TopBar.tsx` (same `presence-list` / `presence-user` test ids); its "In <frame>" detail reads the frames from the store's type index, serialized, so edits to other shapes re-render nothing while the list is open.
  - Test ids: `present-invite`, `present-handoff`, `handoff-list`, `handoff-option[data-user-id]`, `handoff-empty`, `live-top`, `live-presenting[data-count]`, `live-follower-count`, `live-following[data-state=following|waiting|reconnecting]`, `live-stop-following`, `live-take-over`, `live-flash`, `live-invite[data-online]`, `live-join`, `live-not-now`, `live-chip[data-state=rejoin|other-tab]`, `live-rejoin-floating` (phones), `live-ended-toast`; `people`, `people-open`, `people-panel`, `people-search`, `people-row[data-user-id][data-status]`, `people-role[data-role]`, `people-status`, `people-follow`, `people-join` (on the presenter's row), `people-bring`, `people-bring-all`, `people-empty`, `people-followers[data-count]`, `presence-more`, `following-label`.
  - Measured (e2e present-live, loopback, headless Chromium, 3 runs): a follower starts moving to the new slide 6–8 ms after the presenter's key press; both then animate 480 ms, so they arrive together.
  - Also in present-session.ts: after a presentation the board is measured at once (tldraw re-measures its container at most every 200 ms, so clicks right after leaving full screen landed 45/48 px off), and the "re-centre until the person acts" hold ends as soon as anything else moves the camera (a zoom to a frame right after Esc was pulled back). Found by sample-board › "drag the Story theme" failing 4 of 5 runs with the first present-live build; 5 of 5 pass now.
  - DEVIATION (other owners' tests): `e2e/tests/present-export.spec.ts` expects "Invite everyone" in the presentation bar's Tab order; `e2e/tests/shell-sharing-platform.fix.spec.ts` RETRO-19 now waits for the two cards before reading their order (it read an empty grid in 3 of 6 runs with this branch, 0 of 3 on the base).
  - DEVIATION: on phones the Rejoin chip floats on the board under tldraw's page menu instead of sitting in the top bar (the bar has no room: the title's 96 px and Share would be pushed out). FAC-09 (hiding frames from others) and FAC-10's "Close session" are not built; FAC-10's per-person current frame and idle flag are in the people list.
  - Known limits (verifier, not fixed): presence is per person, not per tab, so a presenter who closes the presenting tab but keeps another tab of the board open stays "online" (followers keep the last slide; that tab offers "Present here"; nobody else can take over). A hand-off to someone whose board tab is hidden waits until that tab is shown. A presenter lowered to a read-only role stays the presenter until they end it or leave (the api refuses their slides and hand-offs). After an api restart, another editor could send `resumeId` before the presenter's tab does and take over its followers; editors can already gather everyone ("Bring everyone to me"), so this grants nothing new.

### checkpoints-2: automatic checkpoints and retention (REV-10)
Owns `apps/api/src/features/history/**`, `apps/web/src/features/history/**`, `packages/contracts/src/history.ts` (append), `0014_checkpoint_policy.sql`, `e2e/tests/checkpoints.spec.ts`.
- **Automatic checkpoints** (kind `auto`) of every board that changed:
  - at most one per hour while people edit;
  - one when the last editor leaves after edits;
  - one before any risky operation: restore as new, bulk delete of more than 50 shapes if detectable server-side, import.
  - They come from the sync snapshot, and never block editing.
- **Retention**: keep every manual checkpoint (up to the 500 cap), auto checkpoints hourly for 48 h, daily for 30 days and weekly for 6 months, and prune the rest along with their blobs.
- **Deletion**: owners can delete manual checkpoints, which is audited.
- **UI**: the History panel lists "Automatic" checkpoints under their own disclosure, and the preview and restore actions work for both kinds.
- **Tests**: the retention math, which deletes blobs and never deletes manual checkpoints; the permission matrix, where guests and viewers cannot delete.

### mindmap: mind maps
Owns a new `apps/web/src/features/mindmap/**` (plus its registry line and keyboard map entries) and `e2e/tests/mindmap.spec.ts`. No new shape type: topics are tldraw geo or text shapes, joined by bound arrows, and the tree lives in shape meta (`meta.drMindmap = { rootId, parentId, side, collapsed }`), validated on read.
- **Creating a map**: a "Mind map" tool or template, or selecting any note or text and pressing "Start a mind map".
- **Editing**:
  - Tab adds a child, Enter adds a sibling, Shift+Tab moves up a level;
  - Delete removes a topic and its subtree after a confirmation above N topics;
  - editing a topic keeps focus flow like Miro.
- **Layout**: automatic horizontal tree layout (left or right branches), a "Tidy up" action, and collapse/expand with a count badge. Every layout change is one undo step and is seen live by collaborators.
- **Output**: works in Present mode and in PDF/PNG export. Exports to an outline (Markdown or CSV) through present-export's CSV mechanism, or its own export action.
- **Tests**: layout math as a unit test; e2e with two users building a map by keyboard.

### tags: tags on notes and cards (PRS-13 tags column)
Owns a new `apps/web/src/features/tags/**` and `e2e/tests/tags.spec.ts`. May change: present-export's CSV (add a Tags column) and canvas-ux search (search by tag), minimally.
- **The tags**: up to 10 per note, stored in `meta.drTags` (validated: 1–24 characters, a color from the note palette), with a board-level tag list in document meta (name, color).
- **Adding tags**: a tag picker in the selection toolbar or context menu, creating a tag inline.
- **Display**: tags show as small chips on notes. Chips scale with zoom and hide below a readable zoom.
- **Finding tags**: a filter ("Show only #Research") that dims everything else, and search by tag.
- **Permissions**: viewers see tags but cannot change them.

### office-previews: Office documents (DOCX, PPTX, XLSX, ODT, ODP, ODS, Keynote not required)
Owns `apps/worker/**`, `docker/worker*.Dockerfile`, `deploy/nas/**`, `apps/api/src/files/mime.ts` and the kind or limit tables that name file types, and `e2e/tests/office-previews.spec.ts`.
- **Conversion**: the worker converts Office files to PDF with LibreOffice headless (`soffice --headless --convert-to pdf`) inside the worker image, then reuses the existing PDF page pipeline.
- **Isolation**: a separate process with no network, macros disabled, a per-job profile dir, and a hard timeout, page cap and memory cap. The original stays downloadable; the card says "Preview made from a PDF conversion".
- **Limits**: the size limit for Office files is 100 MB.
- **Tests**: fixtures generated in the repo (DOCX, PPTX, XLSX built by a script, no third-party binaries checked in); the job succeeds, times out, and fails on a corrupt file; the card shows pages.
- **Deploy**: the NAS image grows. Measure it, and record the size and memory in `deploy/nas/README.md`. **Do not deploy to the NAS**; integration deploys.

### search: search across boards (content, not only titles)
Owns a new `apps/api/src/features/search/**`, `0015_board_search.sql`, a new sync internal endpoint `apps/sync/src/http/board-text.ts` (plus one router entry and one `sync-internal.ts` client method), the dashboard search UI (`apps/web/src/dashboard/**`, the search box and results), and `e2e/tests/search.spec.ts`.
- **What gets indexed**: the text of notes, text shapes, geo labels, frame names, arrow labels, file names and comment threads. It goes into Postgres (`tsvector`, English plus simple, with `ts_headline` snippets).
- **Keeping the index current**: re-index a board when it changed since its last index. Changes come from the sync "touch" path or `updated_at`: a background indexer with a bounded batch, plus on-demand refresh for boards the searcher opens.
- **Results**: filtered by permission at query time, so a guest sees only their boards and a viewer only boards they can view. A result names the board, the matching object with a snippet, and opens the board zoomed to the object.
- **Rate limits and caps**: text per board is capped at 1 MB; queries are limited by length and rate.
- **Tests**: permission leaks (the main risk), freshness after an edit, and deletion leaving the index.

### perf: edit latency and big-board frame rate (WRK-01 250 ms p95, PRF-02/03 30 fps)
Owns measurement scripts under `e2e/perf/**` (new) and minimal, justified changes anywhere in `apps/web/src/**`, each listed as a deviation with its before/after number.
- **Reproduce** the measurements in docs/REVIEW-2026-09-27.md §2: browser edit visibility p95 of 283 ms, and the heavy board at 26–32 fps at fit. Use a committed, repeatable script.
- **Profile**: Chrome performance traces with playwright-core CDP. Look for our overlays re-rendering per frame (comment pins, vote badges, workshop overlays, thumbnails capture, tags chips, mind-map layout), unthrottled store listeners, and CSS that forces layout.
- **Fix** the hot spots without changing behavior. Targets: p95 ≤ 250 ms and ≥ 30 fps at fit on the heavy board, on this PC's headless Chromium, stated as such.
- **Report** the numbers before and after, and add a perf budget test that fails on a regression beyond a margin (opt-in if it is too noisy for CI).

## 3. Integration

Merge in this order: checkpoints-2, tags, mindmap, office-previews, search, present-live, then perf last, re-measured after everything else. After merging:
- run the full battery;
- rebuild and deploy the NAS worker image (office previews);
- deploy api → sync → web;
- run live checks.

## 4. Second half (4b): owners added after wave 3 round 3 merged

### ai-assist: AI on the board (OpenAI), with hard cost limits
Owns a new `apps/api/src/features/ai/**` (plus tests), a new `apps/web/src/features/ai/**` (a pre-registered stub), `packages/contracts/src/ai.ts` (a pre-registered stub), the api config for `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_BASE_URL` / `DRAFTROOM_AI_*`, `.env.example` AI lines, `render.yaml` (api `OPENAI_*` as `sync: false`), and `e2e/tests/ai-assist.spec.ts`.
- **Actions**, all on the selection (or the current frame when nothing is selected):
  1. **Summarize**: a short summary inserted as a text block next to the selection. Viewers see it in a panel instead.
  2. **Group into themes**: clusters sticky notes into named themes and rearranges them into labelled groups inside the frame, in one undo step.
  3. **Action items**: a checklist of owners and next steps as new notes.
  4. **Generate ideas**: N sticky notes from a short prompt.
- **Who can use them**:
  - Account users only. Name-only guests never trigger AI, because it costs money.
  - Inserting needs edit; summarize-to-panel needs view.
  - On an export-policy "editors" board, limited viewers get no AI, since AI reads the content out.
- **Server authority**:
  - The api builds the prompt from records it reads itself through the sync snapshot for the requested shape ids. It never trusts client-sent text.
  - It calls OpenAI with a JSON-schema response format and a timeout.
  - It validates the output: lengths, counts, and ids that exist.
  - It returns a plan; the client applies it as normal canvas edits, so undo and sync behave as usual.
- **Cost limits** (the key has NO provider-side cap):
  - input capped at about 12k tokens and output at about 1.5k per call;
  - 20 calls per user per hour;
  - a per-workspace daily token budget (`DRAFTROOM_AI_DAILY_TOKENS`, default 400k), tracked in memory plus Postgres usage rows in a new table in `0016_ai_usage`;
  - a global kill switch `DRAFTROOM_AI=off`.
  
  The UI shows "AI budget used today: N%" to workspace owners.
- **Privacy**: before the first use per user, the UI says "Sends the selected text to OpenAI". Logs hold counts only, never content or prompts. Comments and private-brainstorm drafts are never sent.
- **Tests**: a local fake OpenAI server (`OPENAI_BASE_URL`), for the api and e2e. **Never call the real OpenAI API**; integration verifies it live with a handful of calls. Feature hidden when no key is configured.
