# Wave V contracts: Live sessions+

Wave V makes a workshop a live session: **polls, scales and word clouds** (live activities: WS1 api, WS2 web), a
**QR and short-code join** for a room of people (WS3), **breakouts** into groups with their own frames (WS4) and a
**session summary** (WS5, who also owns the stale-tab proof against the deployed 711dd04 web and the gate). The
foundation (branch `wave-v/foundation`) lands the shared contracts, migration `0038_live_sessions`, the three api kill
switches, every wave V route pending behind its switch with its guard rows, the web switches, the Facilitate menu's
registry, the top-centre `breakout` slot, the recap's source registry, the Export section id, the `/j/:code` route and
the QR library. Nothing changes for a user until the workstreams land:

- every new route is **pending** (`apps/api/src/features/pending-routes.ts`): not registered, so it answers 404
  `NOT_FOUND` exactly like an unknown route, for every caller; once its owner lands it, its **kill switch** gates it the
  same way while off (§1.2);
- the api switches are off (`render.yaml`: `"off"`; unset is off) and `GET /api/auth/config` says so (`live`);
- every web switch is off (`apps/web/src/features/live/flags.ts` `LIVE_FLAGS`), the three wave V features are
  registered empty, no Facilitate entry, pill part, recap section, Export section or page is registered, and `/j/...`
  is the unknown-address screen;
- the wave V palette ids are pending (`PENDING_PALETTE_COMMAND_IDS`).

What does not change: the sync protocol (`CONTRACTS_REV` stays **14**: §7), `ELEMENT_SCHEMA_VERSION` (1),
`LOBBY_CLIENT_REV` (3: no bell kind, no existing response enum gains a value), every `customData` key, the sync-internal
`WorkshopStateBody` (strict: a new field would make the deployed sync refuse the push), the sync and the worker (neither
is deployed in wave V). Design: the wave V design scout (`scratchpad/wave-v/SCOUT.md`), followed except where §11 says
why not. Owner decisions taken as given: Q&A, super lock, per-group timers, fencing edits to a group's frame and wave
V4 (planning poker, spinner, music) are out of this wave.

## 1. The switches

### 1.1 The api (`apps/api/src/config.ts` `parseOnOff`, `parseLiveSwitches`)

| Variable | Feature | Values |
|---|---|---|
| `DRAFTROOM_LIVE_ACTIVITIES` | polls, scales, word clouds (WS1) | `on`; `off`, empty or unset = off; anything else (any case, trimmed) refuses to start: `… must be on or off` |
| `DRAFTROOM_JOIN_CODES` | join codes (WS3) | as above |
| `DRAFTROOM_BREAKOUTS` | breakouts (WS4) | as above |

Read once at boot (`ApiConfig.live`, contracts `LiveSwitches`); a change is a restart. `parseDesignPreviews` now uses the
same `parseOnOff` (its message is unchanged). Told to the web in `GET /api/auth/config` as `live: {activities,
joinCodes, breakouts}` (contracts `AuthConfig.live`, optional: an api before wave V sends none, read as all off).
`render.yaml` sets all three to `"off"` on the api only (`scripts/smoke/render-yaml.test.mjs`); the e2e stack
(`e2e/tests/support/stack.ts`) sets all three `on` (a spec may set one `off` through `apiEnv`).

### 1.2 What "off" means (`apps/api/src/features/live/switch.ts`)

Every route of the feature answers **exactly like an unknown route** (the root 404 `{"error":{"code":"NOT_FOUND",
"message":"Not found."}}`) for every caller: anonymous, a guest, an owner, the internal secret. The gate is the route's
own `onRequest` hook (`liveRoute`), which runs before the body is parsed and before the root `preHandler` guards, so
neither a guest refusal (403) nor the creator rule tells anyone the feature exists, and nothing is read or written. No
event of the feature is published (nothing runs), and its open-state part is null (its loader calls `requireLive`).
Data in Postgres stays as it is: an open activity or a running breakout simply stops answering and comes back as it was
when the switch is on again (WS1 and WS4 close what ended meanwhile by its `ends_at` on the next read). A placed chart
or cloud is a plain element and stays. The QR of the full invite URL keeps working without join codes.

Every wave V route registers through `liveRoute(app, ctx, switch, method, url, handler)` and nothing else; until its
owner implements it, its handler is `liveStub` (501 `NOT_IMPLEMENTED`, reachable only with the route off the pending
list and its switch on). Test: `apps/api/test/features/live/switch.test.ts`.

### 1.3 The web (`apps/web/src/features/live/flags.ts`)

`LIVE_FLAGS` `{activities, joinCodes, breakouts, summary}`, all `false`; a dev-auth page may set `LIVE_FLAG_KEYS[name]`
(`lobby.liveActivities`, `lobby.liveJoinCodes`, `lobby.liveBreakouts`, `lobby.liveSummary`) to `'1'`/`'0'` in
localStorage (read in try/catch; a production bundle ignores it). `liveEnabled(flag)`: the web switch AND the api switch
it needs (`LIVE_FLAG_SERVER`; the summary needs none), asked when the offer is drawn; `liveSwitches` is a signal the
session sets from `AuthConfig.live` (`setLiveSwitches`; anything not exactly `true` is off), so an offer drawn before the
config arrived redraws. Each workstream turns its own `LIVE_FLAGS` line on (through the lead) in the change that makes
its feature live; the api still decides every request.

## 2. Live activities (V1: WS1 api, WS2 web; contracts `live-activities.ts`)

### 2.1 Model

Three kinds (`ACTIVITY_KINDS`), one open activity per board (a dot vote may run beside it):

| Kind | Setup (`config`, strict) | Answer (strict, `kind`-tagged) | Results (aggregates) |
|---|---|---|---|
| `poll` | `options`: 2-12 distinct (by `normalizeWord`) one-line texts of 1-80 code points; `maxChoices` 1..options (default 1) | `choices`: option indexes, each once, 1..`maxChoices` | `counts` per option in order (zeros kept), `answered`; `rankActivityResults` gives competition ranks |
| `scale` | `min`/`max` one of 1-5, 1-7, 0-10 (`SCALE_RANGES`); `minLabel`/`maxLabel` ≤ 40 code points or null | `value` in `min..max` | `counts` per value, `mean` and `median` (2 decimals; the median of an even count is the mean of the middle two), `answered` |
| `words` | `maxWords` 1-5 (default 3) | `words`: 1..`maxWords` entries of 1-30 code points, distinct by `normalizeWord` | the top 100 words `{text, count}` (highest first, ties by code-point order of the text), `distinct`, `hidden` (count), `answered` |

- **Text rules** (prompt ≤ 200, options, labels, words; `ActivityPrompt`, `PollOptionText`, `ScaleLabel`, `WordText`):
  one line (whitespace runs, newlines and tabs collapse to one space; trimmed); lengths in **code points** (an emoji or
  a CJK character is one, as Postgres `char_length`); C0/C1 controls, DEL, bidi controls (U+061C, U+200E/F,
  U+202A-E, U+2066-9), zero-width characters (U+200B, U+2060, U+FEFF) and line/paragraph separators refused. ZWNJ and
  ZWJ (U+200C, U+200D) are taken where they join two characters (an emoji sequence such as a woman and a laptop or the
  rainbow flag, a Persian or Indic word: `outside.ts joinerJoins`, the rule of display names) and refused anywhere else
  (next to ASCII, a space, an end, another invisible character); the emoji variation selectors are ordinary characters
  (fix wave, review m7). Breakout group names and broadcasts use the same rule (`hasForbiddenActivityChar`), and a group
  name taken from a frame is cleaned first (`groupNameOf` through `cleanDisplayText`, again after the 40-character cut),
  so "Use the selected frames" never fails on a frame's name.
- **Words** group by `normalizeWord`: NFKC (fullwidth forms and ligatures fold), whitespace collapsed, lower-cased
  (locale-free). One person's same word counts once. A word is shown in its most frequent original spelling (ties:
  code-point order), so `tallyWords` is deterministic whatever order answers arrive in. Pure: `tallyPoll`, `tallyScale`,
  `tallyWords`, `answerProblem` (an answer against its activity) are the api's and the web's.
- **Status** (`ActivityStatus`): `open` → `closed` → `revealed`; `open|closed` → `cancelled`. An open activity past
  `endsAt` is reported `closed` (the effective status, as votes). At most one open per board (0038's partial index): a
  start while one is open is 409 `ACTIVITY_OPEN` (WS1 first closes one that ended by its time, under the lock).
- **One answer per person** (`live_answers` PK), replaced on change (an upsert under the activity's row `FOR UPDATE`,
  with a tally mark taken under the lock, as `castInLockedSession`), until it closes; not withdrawn. 30 answers a person a
  minute per activity (`ACTIVITY_LIMITS.answersPerMinute`, 429), 10 starts a board a minute.
- **Moderation** (word clouds): `POST …/hide {word, hidden}` stores the normalized word in `live_activities.hidden` (≤
  200); a hidden word leaves every result, event and placement (`results.hidden` counts them; a manager's state lists
  them in `hiddenWords`).
- **Reveal** freezes the aggregate into `live_activities.results` in the same transaction; GET results reads it.
- **Starter left**: the starter, a board owner, or any account editor once the starter left manages it (`canManage`,
  `starterLeft`). The starter left when they can no longer edit the board (as a private brainstorm) or, since the fix
  wave (review m6), when they have no open event stream on the board (`EventHub.hasStream`: they closed every tab of
  it), so a co-facilitator is never stuck behind them; back on the board, it is theirs again. Owners as before.

### 2.2 Anonymity (the wire rule; WS1's anonymous wire test, WS2's placement test)

1. `anonymous` defaults to true. An anonymous activity's answers never leave the api tied to a person: no response,
   event, export, log line or board element carries a user id, name or per-person grouping of one. Bodies hold
   aggregates only, plus the CALLER's own answer (`ActivityState.myAnswer`); the only account id in any body is the
   starter's (`createdBy`, a facilitator, never a participant). `wave-v.test.ts` pins that the result and event schemas
   have no key that could name a person.
2. **Timing**: counts anyone is shown while it is open (the event, GET, the answer response's `answered`, live results)
   are the counts at the last wall-clock boundary of the tally window: `activityTallyWindowMs` = 1 s only for a named
   activity whose results are not live, else 5 s (`ACTIVITY_TALLY_WINDOW_MS`), one event per window that changed
   something (the dot vote's RT-03 design). WS1 writes its own `features/live-activities/tally.ts` (a copy adapted to
   per-option and per-word counts; `workshops/vote-tally.ts` is not touched). The caller's own answer comes back at once.
3. **Words** are shown to participants only after the reveal, or live when the facilitator turned `resultsLive` on
   (then windowed), and never with their author. The facilitator sees windowed live results while it is open (that is
   why anonymous is 5 s).
4. **Retention** (widened in the fix wave, review m2): whenever an anonymous activity stops taking answers the api
   freezes its aggregate into `live_activities.results` and deletes its `live_answers` rows in the same transaction
   (`store.ts settleActivity`): at the close, its end time passing (the first read after it, or the settle sweep
   `sweep.ts` every minute for boards nobody reads, while the switch is on), a new start superseding it, the reveal,
   a cancel (no aggregate is kept: a cancelled one has no results), and its board being archived or trashed (in the
   transaction that changes the board's status, whatever the switch says). Afterwards no row ties a person to an
   answer (`myAnswer` is then null); the reveal of a closed one shows the aggregate frozen at its close (a word hidden
   after it still leaves it; one hidden before it cannot come back). A named activity keeps its answers (with the
   board) for `GET …/answers`. Tests: `live-activities/retention.test.ts` (one per path, and the invariant).
5. **Named** (`anonymous: false`) is opt-in and labelled in the setup dialog ("Answers show who gave them to you after
   the reveal"); the facilitator (manage) sees who answered what after the reveal only; other participants never see
   names. The setup dialog also says that a rare word can identify its author by its content (R2).
6. **Placement**: the placed elements are written by the facilitator's client; `customData.lobbyServer.createdBy` is
   the facilitator; no answer's author reaches the board (WS2's e2e checks every placed element).

### 2.3 Routes (`ACTIVITY_ROUTE_KEYS`, `ACTIVITY_RULES`; path builders `activityPath`, `activitiesPath`, `activityActionPath`)

| Route | Rule (§6) | Body → answer |
|---|---|---|
| `GET /api/boards/:bid/activity` | view | → `ActivityState` (the open activity, else the most recent closed or revealed one; cancelled ones are not shown) |
| `GET /api/boards/:bid/activities` | view | → `ListActivitiesResponse` (≤ 50, newest first; `ActivitySummary`: results only once revealed) |
| `POST /api/boards/:bid/activities` | facilitate | `StartActivityInput` → 201 `ActivityState`; 409 `ACTIVITY_OPEN` |
| `POST /api/activities/:aid/answer` | participate | `AnswerActivityInput` → `ActivityState`; 409 `ACTIVITY_NOT_OPEN`; 400 `ACTIVITY_BAD_ANSWER` (`answerProblem`) |
| `POST /api/activities/:aid/close` | manage | → `ActivityState` (an anonymous one: freezes `results`, deletes its answers) |
| `POST /api/activities/:aid/reveal` | manage | → `ActivityState` (from open or closed; freezes `results`, or keeps the one frozen at the close; deletes an anonymous one's answers) |
| `POST /api/activities/:aid/extend` | manage | `ExtendActivityInput` `{addMs ≤ 30 min}` → `ActivityState`; 409 `ACTIVITY_NOT_OPEN` |
| `POST /api/activities/:aid/cancel` | manage | → `ActivityState` (deletes an anonymous one's answers) |
| `POST /api/activities/:aid/hide` | manage | `HideWordInput` (word clouds only, else 400) → `ActivityState` |
| `POST /api/activities/:aid/placed` | manage | → `ActivityState` (revealed only, idempotent: `placed_at` once; no element id is kept) |
| `GET /api/activities/:aid/results` | view (revealed) / manage (open, closed) | → `ActivityResultsResponse`; 404 otherwise |
| `GET /api/activities/:aid/answers` | manage | → `NamedAnswersResponse`; 404 for an anonymous activity, 409 `ACTIVITY_NOT_REVEALED` before the reveal |

`ACTIVITY_NOT_YOURS` (403) for a manage route by an editor who is not the starter while the starter can still edit. Every
new query names `status IN ('active', 'archived')` (the importing-board tripwire); `participate` needs an active board.

### 2.4 Events (after COMMIT, the same body for every viewer)

`workshop.activity` (`WORKSHOP_EVENTS.activity`, `LIVE_ACTIVITY_EVENTS.activity`): `WorkshopActivityEvent` `{activity,
answered, results}` after a start, a window's new count, close, extend, reveal, cancel, placed or a hidden word;
`results` only with `resultsLive` or once revealed. `workshop.activity.results`: `WorkshopActivityResultsEvent`
`{activityId, results}`, once, at the reveal. Each client refetches its own answer. An older web has no listener.

### 2.5 To the board (WS2)

The facilitator's client places revealed results in ONE `canvas.transact` (one undo step), copying the pattern of
`features/workshops/ported/vote-board.ts` (read, never edited): a poll or scale → a frame of rectangle bars and texts,
`customData.lobby.kind` `'poll-chart'` (`LIVE_ELEMENT_KINDS.pollChart`); words → a frame `'word-cloud'` of free texts,
font size 16..96 by `sqrt(count)` rank buckets, at most `ACTIVITY_LIMITS.cloudWordsMax` (60) words, laid out by a pure,
deterministic spiral packer (`features/live-activities/word-cloud-layout.ts`: sorted by count then text, seeded angle
steps) over `canvas.measure` (the server's metrics), Lobby palette colours only; or "As sticky notes" (one note per word
with its count). Then `POST …/placed`. Ordinary elements: the sync validates every op as usual, no server re-layout,
and a client that only receives pushes nothing ("a receiving client pushes nothing" test). Never a `data:`/`blob:` URL.

### 2.6 Load (WS1; the acceptance)

`e2e/load/activities.ts`: 200 virtual participants with guest sessions answering a poll and a word cloud in 10 s bursts,
on the NAS in `draftroom-load-*` throwaway containers with a throwaway Postgres (AGENTS.md NAS rules: no image built, no
published port, LAN-only, cleaned after). Pass: answer ack p95 < 1 s; at most one `workshop.activity` event per window
per activity; the report goes into the gate.

## 3. Join codes and the QR card (V2: WS3; contracts `join-codes.ts`)

### 3.1 The code

- 8 Crockford base-32 characters (`JOIN_CODE_ALPHABET`: no I, L, O, U), 40 bits, shown `ABCD-2345` (`formatJoinCode`);
  read case- and dash-insensitively with I and L as 1, O as 0 (`normalizeJoinCode`; anything else is null).
- Derived, so it can be shown again: `HMAC(HMAC(ticketSecret, JOIN_CODE_HMAC_LABEL), "<invitationId>:<n>")`, the first
  5 bytes through `joinCodeFromBytes`. Stored only as `sha256(code)` in `invitations.join_code_hash` (globally unique);
  `join_code_n` (0-15) is bumped when the insert meets the unique index (≈2^-40 per pair of links). Rotating the ticket
  secret changes every code (as it does every link token).
- Only a **workshop link** gets one: a board's multi-use `editor` link (0038 `invitations_join_code_scope_check`),
  whether it lets people join with a name or not. Made on first ask by `POST …/review-links/:id/code` (idempotent) or
  with the link; shown in the Share dialog's workshop links and on the join card to people who may manage access
  (`ReviewLinkCreated.joinCode`, `PendingInvitation.joinCode`, optional: an older api and other links send none).
- It is a bearer secret like the link's token: whoever has it joins while the link is open. Never on the board (a link
  expires within 24 h, a board outlives it), never logged (the api logs route patterns only).

### 3.2 Routes (`JOIN_CODE_ROUTE_KEYS`, `JOIN_CODE_RULES`)

| Route | Rule | Body → answer |
|---|---|---|
| `POST /api/boards/:bid/review-links/:id/code` | creator (manage access on the board, a creator: guard rows §6) | none → `JoinCodeResponse` `{joinCode: {code, display, joinUrl, expiresAt}}`; 404 for an unknown, expired, revoked or non-workshop link |
| `GET /api/join/:code` | anyone (no session) | → `ResolvedJoinCode` `{token}` of an OPEN link; the same 404 `NOT_FOUND` for unknown, malformed, expired, revoked (and switch off): no oracle. A MISS is 429 past `JOIN_CODE_LOOKUPS_PER_ADDRESS` (120 misses / 10 min per address, an IPv6 client by its /64) or `JOIN_CODE_LOOKUPS_GLOBAL` (600 misses / min); a code that resolves is never refused |

`joinUrl` = `<PUBLIC_ORIGIN>/j/<code>` (`joinCodeWebPath`). A guess succeeds with probability (open codes)/2^40 per try;
at the global cap and 50 open codes that is about 4·10^-5 a day.

**The limits** (fix wave, review M1 and m3). They count and refuse **misses only**:

- A code that resolves to an open link is answered whatever either window holds, so neither a guesser nor a crowd of
  them can keep a room with a good code (or its QR) out; a full window only slows guessing.
- A miss under both limits answers the same 404 as before; past either it is 429 with `Retry-After`. The 429 says
  nothing the 404 would not (that this code is not open), only "slow down".
- Each lookup reserves its slot in the window BEFORE the database is asked (no await between the check and the count,
  `rate-limit.ts` `reserve`) and gives it back on a hit, so 300 simultaneous misses from one address get exactly 120
  404s and 180 429s (`join-codes.test.ts`). The address's window is reserved first: a guesser at its limit uses none
  of the api's window.
- 120 per address (not 30) so a 200-person room behind one office NAT can mistype, retry and scan an old QR without
  being locked out.
- Why this is still safe: a code is 40 bits. At the api-wide 600 misses a minute (864,000 a day) and 50 open codes, a
  guesser finds one with probability about 4·10^-5 a day, the same as before, since a hit was never what the windows
  bounded.

### 3.3 The web (WS3)

- `apps/web/src/features/join/qr.ts` wraps **`qrcode-generator` 2.0.4** (`qrMatrix(text, ec)` → `boolean[][]`; replaceable,
  unit-tested with golden matrices of fixed inputs at EC level M) and `QrCard.tsx` draws it as an inline `<svg>`: dark
  modules on a white quiet zone of 4, whatever the theme; never `createDataURL`, `createImgTag`, a canvas, a `data:` or
  `blob:` URL or an external reference. The QR encodes `joinUrl` when the link has a code (a version 2-3 QR), else the
  full invite URL.
- The join card ("Show join code" in the Facilitate menu, §6.2; "Show QR" in the Share dialog's `WorkshopLinksSection`):
  full screen and presentable, the QR, the code in large type, the host name, "Expires 14:30". The Facilitate entry,
  the palette command and the card's "Make a workshop link" are offered only to someone known to be a creator
  (`me.access.creator === true`); anyone else who opens the card is told whom to ask (`joinCardStart`; review n2). An
  archived board gets no code: `POST …/code` is 409 `BOARD_ARCHIVED` and a new workshop link on it comes without one
  (review n1). The e2e follows the
  `data-join-url` the QR was made from (no small MIT decoder is in the tree).
- `/j/:code` (`lib/routing.ts` route `join`; `App.tsx` loads `features/join/JoinPage.tsx` lazily, outside the session,
  only while `LIVE_FLAGS.joinCodes` is on) resolves the code and continues at `/invite/:token`, whose name-only join is
  unchanged; a code that does not resolve says so with a field to type another. A "Have a code?" field on the sign-in
  page (`auth/SignInPage.tsx`, one insertion) does the same. No request leaves Lobby's origins.

### 3.4 The join-cap fix (R1, required for "a room of people joins"; WS3, security-reviewed)

Today a 200-person QR session stalls at 60 joins per 10 minutes, per link and per office address. Constants (contracts
`guests.ts`); WS3 applies them in `features/guests/join.ts` and `features/guests/limits.ts`:

| Window | Workshop link (multi-use editor) | Any other link |
|---|---|---|
| per link | `GUEST_JOINS_PER_WORKSHOP_LINK` 200 / 10 min (the database count, as today) | `GUEST_JOINS_PER_LINK` 60 / 10 min (unchanged) |
| per client address | `GUEST_JOINS_PER_ADDRESS_PER_WORKSHOP_LINK` 200 / 10 min keyed by address + link, and `GUEST_JOINS_PER_ADDRESS_ON_WORKSHOP_LINKS` 400 / 10 min per address over every workshop link together | `GUEST_JOINS_PER_ADDRESS` 60 / 10 min (unchanged) |
| total | `GUESTS_PER_LINK` 200 (unchanged) | the same |

Workshop joins never consume the 60-per-address window of the other links, and other links' joins never consume the
workshop windows. These windows have **no switch** of their own (review n3, decided: none is added): they apply whatever
`DRAFTROOM_JOIN_CODES` says (the full invite URL's QR needs them too), and rolling them back is an api deploy of the
previous build (DEPLOY.md, wave V rollback). Still bounding abuse: a link lets in at most 200 guests ever; only creators make workshop links; the
board's guest item budget and the per-link stream (`GUEST_LINK_STREAMS` 400), reaction and summon caps hold. Tests
(WS3, `apps/api/test/features/guests/join-burst.test.ts`): 200 joins from one address on one workshop link within 2
min succeed, the 201st is `GUEST_LIMIT`; a review link from the same address still meets its 60; a second workshop link
from that address gets its own 200 but the address's 400 caps the two together.

## 4. Breakouts (V3: WS4; contracts `breakouts.ts`)

### 4.1 Model

- A session (`brk_…`) has 2-20 groups (`BREAKOUT_LIMITS`), ids `g1`..`g20` in the order given (`breakoutGroupId`),
  each a name (1-40 code points, one line) and its own frame (`frameId`, an api ref `shape:<element id>` as votes and
  spotlights use). Groups come from selected frames, or "Make N frames" (the facilitator's client creates them first in
  one transact, so everyone's camera finds them on start; optional `kind: 'breakout-frame'`, harmless if absent; names
  `breakoutGroupDefaultName`). A refused or failed start removes them again in the same undo step (`frames.ts`
  `startWithNewFrames`, `joinPrevious`; review m4), so no frame is left behind and a retry never piles them up.
- Modes: `auto` (the api deals out everyone with an open event stream on the board, `hub.streams()`, facilitators left
  out, round robin over a shuffled list; a late joiner is placed in the smallest group at their first GET, under the
  session's row lock), `manual` (the facilitator moves people), `choose` (people `POST …/join {groupId}`, up to an
  optional `groupCap` 1-200; 409 `BREAKOUT_GROUP_FULL`).
- One running session per board (0038's partial index; 409 `BREAKOUTS_RUNNING`). One session-wide `endsAt` (the chip
  draws it); the board timer stays independent. `rev` grows with every change of the session or its members;
  `isNewerBreakoutState` orders states arriving by different paths. An ended session stays the board's `session` for
  `BREAKOUT_RECENT_MS` (12 h) for the chip's "Breakouts ended" and the summary.
- Membership is not secret (names are on the board already); presence stays ephemeral and untouched.
- Starting during a live presentation or a spotlight: 409 `PRESENTING` / `SPOTLIGHT`. A deleted group frame keeps the
  group (the chip says "Frame removed"; the facilitator picks another).
- Editing is NOT fenced to a group's frame (a guide, not a fence: fencing would be a sync merge rule per uid; the UI
  copy says so).

### 4.2 Routes (`BREAKOUT_ROUTE_KEYS`, `BREAKOUT_RULES`; `breakoutsPath`, `breakoutActionPath`)

| Route | Rule | Body → answer |
|---|---|---|
| `GET /api/boards/:bid/breakouts` | view | → `BreakoutState` `{session, members, myGroupId, canManage, serverNow}` |
| `POST /api/boards/:bid/breakouts` | facilitate | `StartBreakoutsInput` → 201 `BreakoutState` |
| `POST /api/breakouts/:brk/assign` | manage | `AssignBreakoutInput` `{moves: [{userId, groupId \| null}] ≤ 200}` |
| `POST /api/breakouts/:brk/shuffle` | manage | none (deals everyone out again) |
| `POST /api/breakouts/:brk/join` | participate | `JoinBreakoutInput` (choose mode; 409 `BREAKOUT_NOT_CHOOSE`) |
| `POST /api/breakouts/:brk/extend` | manage | `ExtendBreakoutInput` `{addMs ≤ 60 min}`; 400 on an untimed session (it stays untimed: review m5; the panel offers no "+5 min" there) |
| `POST /api/breakouts/:brk/broadcast` | manage | `BreakoutBroadcastInput` `{text ≤ 200, groupId \| null}` → 204; never stored; one per 3 s per session |
| `POST /api/breakouts/:brk/summon` | manage | `BreakoutSummonInput` `{groupId, screen?}` → 204; one per 3 s |
| `POST /api/breakouts/:brk/end` | manage | → `BreakoutState`; "Return everyone" is the existing Gather everyone |

### 4.3 Events and the leak rule

- `workshop.breakout` (`WorkshopBreakoutEvent` `{session, members}`) to everyone on the board after every change.
- `workshop.breakout.broadcast` and `workshop.breakout.summon` of ONE group are delivered with
  `hub.publish(bid, ev, {to: uid => members.has(uid)})` ONLY, so a stream outside the group never receives them (the
  server half of "follow never leaks across groups"); `groupId: null` broadcasts go to everyone. The web obeys a summon
  only when `breakoutSummonApplies(ev, {userId, sessionId, groupId})` (pure, contracts; the web half): its own group of
  the same session, never its own summon. Tests (WS4): a hub-level leak test with three users in two groups, the pure
  rule, and e2e v3 (a group summon moves only that group's cameras).

### 4.4 The web (WS4)

A top-centre chip in the new slot `breakout` (`canvas/overlay/top-centre.ts`, right under the session timer): "Group 2
· 8:30 left · Go to my frame"; camera fit to the frame on start, on Go to my frame and after a group summon (follow
the summoner, `features/workshops/follow.ts` `followSidOf`, `ported/camera.ts`: import only). The facilitator panel:
groups × people (drag or picker), the broadcast box, per-group "Join group", "+5 min", End. An optional local "Only my
group's cursors" dimming (client-side; presence unchanged). Risk R6 (the 40-cursor cap is the room's choice, not by
group) stays; the sync-side preference is a follow-up (a new internal route and a sync deploy).

## 5. The session summary (WS5) and the open-state parts

- Wrap up's non-AI sections (`features/ai/recap/**`, WS5) gain the registered sources (`ai/recap/sources.ts`, §6.5):
  activities run (kind, prompt, answered, top results; anonymous ones aggregate-only), word clouds (top 10 words),
  breakouts (groups, member counts, duration), next to the votes and the run of show that exist. No new storage: built
  from `GET /api/boards/:bid/activities` and the breakout state.
- "Session summary" export: the Recap frame (exists, `apply.ts`) plus a formula-safe CSV of every activity's results,
  the Export dialog section `session-csv` (`present-export/session-csv/**`; a download: the export policy and the e2e
  download rule apply).
- Open-state (`contracts board-open.ts`): `OpenState.activity` (`ActivityState`) and `.breakouts` (`BreakoutState`) are
  declared, optional, and pending (`OPEN_STATE_PENDING_PARTS`). WS1 and WS4 each provide the loader
  (`provideOpenStatePart`, null while its switch is off) and move their name to `OPEN_STATE_PARTS` (one line, through the
  lead) in the change that implements the route; `open-state.test.ts` already maps both to their routes. A web before
  that, or an api without them, makes the separate GET only while the feature is on.

## 6. Who may do what

### 6.1 The rules (contracts `live.ts` `LiveRule`, checked server-side by each route)

`view`: `can(role, 'view', status)` (an archived board's readers too). `participate`: may view an ACTIVE board.
`facilitate`: may edit AND has an account (`workshops/facilitators.ts` `requireFacilitatorAccount`). `manage`: on one
running activity or session: its starter, a board owner, or any account editor once the starter left: can no longer
edit, or has no open event stream on the board (`starterLeft`; review m6); always an account. `creator`: manage access on the board and a creator (`identity.requireCreator`).
`anyone`: no session.

### 6.2 The matrix

| Action | Owner / editor (account) | Commenter | Viewer | Name-only guest, workshop (editor) link | Name-only guest, review link | Client (account on a review link) | No access | Archived board |
|---|---|---|---|---|---|---|---|---|
| See the activity, past list, revealed results, breakouts | yes | yes | yes | yes | yes | yes (its role) | 404 | yes (read) |
| Answer an activity, choose a breakout group | yes | yes | yes | yes | yes | yes | 404 | no (409) |
| Start an activity or breakouts | yes | 403 | 403 | 403 `GUEST_ACCOUNT_REQUIRED` (guard) | 403 (guard) | 403 | 404 / 403 guard | no |
| Close, reveal, extend, cancel, hide a word, mark placed; assign, shuffle, extend, broadcast, summon, end | the starter, an owner, or any account editor once the starter left | 403 | 403 | 403 (guard) | 403 (guard) | 403 | 404 / 403 guard | no |
| Named answers after the reveal | managers (as above) | 403 | 403 | 403 (guard) | 403 (guard) | 403 | 404 | yes (read) |
| Make or show a join code | creators who manage access | 403 | 403 | 403 (guard) | 403 (guard) | 403 | 404 / 403 guard | no |
| Resolve a join code | anyone with the code, signed in or not | | | | | | | the link's own rules |

The guard rows (`apps/api/src/features/guests/guard.ts`): a name-only guest is refused the 15 facilitate/manage routes
(`ACTIVITY_FACILITATOR_ROUTE_KEYS`, `BREAKOUT_FACILITATOR_ROUTE_KEYS`; 403 `GUEST_ACCOUNT_REQUIRED`,
`LIVE_FACILITATE_GUESTS_MESSAGE`) and the join code (the INVITE message), before any board check, whatever role the
guest was given. `domain-access/guard.ts`: the join code route needs a creator (`share`, `always`): it hands out the
link's access, like extending it. Live activities and breakouts create nothing and hand out nothing: no creator row.
The rows are tested by `refusals.test.ts`, `creation-matrix.test.ts` and `pending-routes.test.ts` (a pending row answers
as an unknown route; a landed one is held to its row).

## 7. Compatibility: no CONTRACTS_REV bump

- **Board elements**: the only canvas writes of the wave are ordinary creates by the facilitator's client carrying the
  existing create-only `customData.lobby.kind` with new values (`poll-chart`, `word-cloud`, `breakout-frame`). `kind` is
  `^[a-z][a-z0-9-]{0,31}$` in every reader since rev 11 and any writer may set it on create (`apps/sync/src/room/
  custom-data.ts`). Proven by `packages/canvas-schema/src/wave-v-kinds.test.ts`: `checkElement` and the strict
  `ServerMessage` of the frozen rev 11 (437b4e7), rev 12 (3c83611) and rev 13 (6769e07) schemas and of this package
  (rev 14; `git diff 711dd04 -- packages/canvas-schema` is empty, so it is the deployed web's AND sync's) accept a frame,
  a rectangle, a free text and a note with each kind in a `changes` frame, and `kind` is create-only in all four; a value
  outside the rule is still refused. So `CONTRACTS_REV` stays 14, and the deployed sync (711dd04) takes the placements.
- **The api's answers**: every new field is additive on a non-strict `z.object` (`AuthConfig.live`, `OpenState.activity`
  / `.breakouts`, `ReviewLinkCreated.joinCode`, `PendingInvitation.joinCode`): a 711dd04 tab strips them. No existing
  enum gains a value (no bell kind, no chat kind, no notification): `LOBBY_CLIENT_REV` stays 3.
- **Events**: new names only (`workshop.activity`, `.activity.results`, `.breakout`, `.breakout.broadcast`,
  `.breakout.summon`); an old web has no listener for them (`features/events.ts`).
- **Usage**: the deployed api refuses a usage batch naming an unknown palette id (400, the web drops the batch): the api
  deploys before the web (§9).
- **The stale proof (WS5)**: `e2e/excalidraw/v-compat-711dd04.spec.ts` with the real 711dd04 web (`E2E_OLD_WEB_DIST`,
  the build steps of `e2e/excalidraw/l-compat-kit.ts`): on a board where a new-web facilitator runs a poll, a word cloud
  and breakouts and places results, the old tab keeps its board live, drops no frame, pushes nothing while it only
  receives, renders the placed charts, and its Facilitate menu (timer, votes, hands) keeps working.

## 8. Migration `0038_live_sessions`

Additive (`packages/db/migrations/0038_live_sessions.sql`; tested in `packages/db/test/wave-v-0038.test.ts` and the
real-Postgres `apps/api/test/migrations.pg.test.ts`):

| Table / column | Holds | Keys and CHECKs |
|---|---|---|
| `live_activities` | `id` (`act_`), `workspace_id`, `board_id`, `kind`, `prompt` (1-200), `config` (an object ≤ 4 KiB), `anonymous` (default true), `results_live` (default false), `status`, `hidden text[]` (≤ 200, words only), `results` (the frozen aggregate, ≤ 16 KiB: at the reveal, or at the close of an anonymous one), `created_by` (SET NULL), `created_at`, `ends_at`, `closed_at`, `revealed_at`, `placed_at` | `(status = 'open') = (closed_at IS NULL)`; `(status = 'revealed') = (revealed_at IS NOT NULL)`; revealed needs `results`, and `results` only on a closed or revealed one (edited in the fix wave before 0038 shipped); `placed_at` only when revealed; one open per board (`live_activities_open_idx`); `(board_id, created_at DESC)`; cascades with the board |
| `live_answers` | `workspace_id`, `activity_id`, `user_id`, `answer` (an object ≤ 2 KiB), `created_at`, `updated_at` | PK `(activity_id, user_id)`; `(workspace_id, activity_id)` → `live_activities` CASCADE; the user CASCADE |
| `breakout_sessions` | `id` (`brk_`), `workspace_id`, `board_id`, `mode`, `groups` (a 2-20 array ≤ 16 KiB), `group_cap` (1-200, choose only), `status` (`running`/`ended`), `rev`, `created_by` (SET NULL), `created_at`, `ends_at`, `ended_at` | `(status = 'ended') = (ended_at IS NOT NULL)`; one running per board (`breakout_sessions_running_idx`); cascades with the board |
| `breakout_members` | `workspace_id`, `session_id`, `user_id`, `group_id` (`g1`..`g20`), `assigned_by` (`auto`/`facilitator`/`self`), `assigned_at` | PK `(session_id, user_id)`; `(session_id, group_id)`; cascades with the session and the user |
| `invitations.join_code_hash`, `.join_code_n` | sha256 of the code (nullable), the bump (0-15, default 0) | `invitations_join_code_scope_check` (only a board's multi-use editor link); unique `invitations_join_code_idx` |

db ids: `act`, `brk`. **Rollback** of the api below 0038 (with `DRAFTROOM_ALLOW_NEWER_SCHEMA=1`): nothing to undo; that
build ignores the tables and columns (the migration's header).

## 9. Deploy order and rollback

1. **api** with 0038 and the routes (switches off): nothing answers yet; the usage list knows the wave V palette ids.
2. **web** (the switches the integration turned on): it offers nothing until the api says on (`AuthConfig.live`).
3. **the switches on** (`DRAFTROOM_LIVE_ACTIVITIES`, `DRAFTROOM_JOIN_CODES`, `DRAFTROOM_BREAKOUTS` = `on` through the
   Render API and a restart; render.yaml follows in the same change).

Sync and worker are not deployed. **Rollback**: a switch off (instant, a restart: the feature 404s, Postgres keeps its
rows); the web below wave V is safe (it never calls the routes); the api below wave V is safe (0038 is additive; an
older api ignores the tables and the new invitation columns; the join codes stop resolving, the full invite URL
works). Placed charts and clouds stay as plain elements. WS5 writes the wave V section of `docs/DEPLOY.md`.

## 10. Workstreams and file ownership

| Workstream | Owns | Reads (does not edit) |
|---|---|---|
| **WS1 Activities api** | `apps/api/src/features/live-activities/**` (routes, store, `tally.ts`, starter-left, hide, results, past list, named answers, the open-state part loader); `apps/api/test/features/live-activities/**` (incl. `*.pg.test.ts` races: 20 parallel upserts of one person, reveal against answer, close against extend); `e2e/load/activities*.ts` and the NAS load run and its report | contracts `live-activities.ts`, `live.ts`; 0038; `features/live/switch.ts`; `features/workshops/{facilitators.ts, vote-tally.ts}` (import / read) |
| **WS2 Activities web** | `apps/web/src/features/live-activities/**` (setup dialog with the three kinds, the answer sheet incl. the phone sheet, the live and revealed results panel, moderation, Results to board, `word-cloud-layout.ts`, its Facilitate entry `activities` and pill part, its recap sources `activities` and `word-clouds`); `e2e/excalidraw/v1-*.spec.ts` and a kit beside them | `features/live/**`, `features/workshops/ported/vote-board.ts`, `features/workshops/{results-plan.ts, results-card.ts}` (copy patterns), `facilitate-entries.ts`, `ai/recap/sources.ts` |
| **WS3 QR and codes** | `apps/api/src/features/join-codes/**`; the `joinCode` lines of `apps/api/src/features/dashboard/review-links.ts`; the R1 lines of `apps/api/src/features/guests/{join.ts, limits.ts}`; `apps/api/test/features/join-codes/**`, `apps/api/test/features/guests/join-burst.test.ts`; `apps/web/src/features/join/**` (`qr.ts`, `QrCard.tsx`, `JoinPage.tsx`, its Facilitate entry `join-code`); the "Show QR" row in `apps/web/src/board/ShareDialog.tsx` `WorkshopLinksSection` (that function only); the "Have a code?" field in `apps/web/src/auth/SignInPage.tsx` (one insertion); `e2e/excalidraw/v2-*.spec.ts` | contracts `join-codes.ts`, `guests.ts`, `dashboard.ts`; 0038 |
| **WS4 Breakouts** | `apps/api/src/features/breakouts/**`; `apps/api/test/features/breakouts/**` (incl. `breakouts.pg.test.ts`: concurrent assign and join, late joiner); `apps/web/src/features/breakouts/**` (the facilitator panel, the chip in slot `breakout`, camera, broadcast toast, cursor dimming, its Facilitate entry `breakouts` and pill part, its recap source `breakouts`); `e2e/excalidraw/v3-*.spec.ts` | contracts `breakouts.ts`; `features/workshops/{follow.ts, ported/camera.ts, presentation.ts, spotlight.ts}` (import only); `events/hub.ts` |
| **WS5 Summary, compat, gate** | `apps/web/src/features/ai/recap/**` except `sources.ts` (drawing the registered sections in the panel, the Markdown and the Recap frame); `apps/web/src/features/present-export/session-csv/**` (the `session-csv` section, formula-safe); `e2e/excalidraw/v-compat-711dd04.spec.ts`, `v4-session-summary.spec.ts`; the no-outside-request assertions of the new pages; the `docs/DEPLOY.md` wave V section; the gate (§12) | everything (read) |

**Lead-only** (serialise through the lead): `packages/contracts/**` (incl. `board-open.ts`, `usage.ts`, `guests.ts`),
`packages/db/**` (0038 is shipped once merged: a fix is a new migration), `packages/canvas-schema/**` (unchanged),
`pnpm-lock.yaml` and `pnpm-workspace.yaml`, `apps/api/src/config.ts`, `apps/api/src/routes/auth.ts`,
`apps/api/src/features/{index.ts, live/**, guests/guard.ts, domain-access/guard.ts}`, `apps/web/src/features/live/**`,
`apps/web/src/features/workshops/ported/{facilitate-entries.ts, WorkshopBar.tsx, guest-chrome.ts}`,
`apps/web/src/features/ai/recap/sources.ts`, `apps/web/src/features/present-export/ported/export-sections.ts`,
`apps/web/src/canvas/overlay/top-centre.ts`, `apps/web/src/{App.tsx, lib/routing.ts, auth/session.tsx}`,
`apps/web/src/features/canvas-registry.ts`, `e2e/tests/support/stack.ts`, `render.yaml`, `AGENTS.md`, `docs/PROGRESS.md`.

Shared lines each workstream edits itself (its own lines only; the lead resolves adjacent-line conflicts at
integration): its keys in `apps/api/src/features/pending-routes.ts` and its spread in `WAVE_V_ROUTES` of
`apps/api/test/features/pending-routes.test.ts` (deleted in the change that implements the routes); its rows in the
`refusedCalls` probes of `refusals.test.ts` and the join code's probe in `creation-matrix.test.ts` (made to reach a
workshop link). Through the lead: its `LIVE_FLAGS` line on, its palette ids out of `PENDING_PALETTE_COMMAND_IDS`, its
open-state part into `OPEN_STATE_PARTS`, and any new `FacilitateExtraId` / `RecapSourceId` value. **Order**: WS1 merges
before WS2's e2e (WS2 unit-tests against a fake api); WS3 and WS4 are independent; WS5 last.

## 11. Where the foundation differs from the design, and why

1. **A switch off makes the whole feature an unknown route** (the scout kept reads answering so a placement could
   finish): one state to test and to explain; nothing is lost (Postgres keeps it; placed elements are plain); a kill
   switch that half-works is the one that surprises.
2. **The gate is the route's `onRequest` hook**, before the body and the guards: with a preHandler guard first, a guest
   (403) or a non-creator would learn the feature exists while it is off.
3. **The web learns the switches from `GET /api/auth/config`** (`AuthConfig.live`; the scout: `WorkshopState.live`): the
   `/j/` page and the sign-in page's "Have a code?" have no board; one read at page load serves every page.
4. **The tally window is not extracted from `vote-tally.ts`**: it is wave J's privacy-critical code with timing tests,
   and the activity's aggregate (per option, per word) and its window (1 s / 5 s) differ; WS1 writes its own copy in its
   folder with its own fake-clock tests, and the vote stays exactly as it is.
5. **The six built-in Facilitate entries stay code**; the registry is for added entries, after them (the scout made the
   built-ins registrations too): their order, test ids and K3 behaviour cannot move, and no workstream edits
   `WorkshopBar.tsx` either way.
6. **An anonymous activity's answers are deleted as soon as it stops taking answers** (the foundation said at its
   reveal or cancel; the fix wave widened it to every way it stops, §2.2 rule 4), and the aggregate is frozen in
   `live_activities.results` (the scout kept `user_id` only to enforce one answer): afterwards nothing ties a person to
   an answer, and the summary stays stable after guests are swept.
7. **Hidden words are a `hidden text[]` column**, not `config.hidden`: the setup stays immutable and checkable.
8. **The join code hash is unique over all links**, not "open links" (an index predicate cannot name `now()`), and its
   scope (a board's multi-use editor link) is a CHECK; a code is never reused while its row exists.
9. **The join-cap fix is three windows** (per workshop link 200; per address and link 200; per address over workshop
   links 400; other links untouched): the scout's "address + link up to 200" alone multiplied by the links one holds.
10. **The open-state parts are declared but pending** (`OPEN_STATE_PENDING_PARTS`): wave M's test pins that every
    declared part is answered; a stub part would have broken the parity tests for every role.
11. **`GET /api/activities/:aid/answers`** is added: the scout's named activity ("the facilitator sees who answered what
    after the reveal") needed a route.
12. **Breakout groups are `g1`..`g20` with `shape:` frame refs and a stored `rev`** (the scout: versioned like
    `HandsVersion`): the state is in Postgres, so a per-row counter orders it across restarts with no epoch.
13. **A landed-but-unimplemented route is 501 `NOT_IMPLEMENTED`**, never a 200 that looks finished; every wave V route
    is also pending, so no deployment reaches a stub.
14. **The palette ids** are four, pending: `activities.start`, `join.show-code`, `breakouts.start`,
    `session-summary.csv`.

## 12. Checks of the foundation, and what each workstream inherits

Pinned by: `packages/contracts/src/{wave-v.test.ts, wave-m.test.ts}`, `packages/canvas-schema/src/wave-v-kinds.test.ts`,
`packages/db/test/wave-v-0038.test.ts` (and the migration lists of the older ones), `apps/api/test/{config.test.ts,
auth.test.ts, open-signin.test.ts, migrations.pg.test.ts}`, `apps/api/test/features/{live/switch.test.ts,
pending-routes.test.ts, guests/refusals.test.ts, domain-access/creation-matrix.test.ts, board-open/open-state.test.ts}`,
`apps/web/src/features/wave-v-stubs.test.ts`, `apps/web/src/{lib/routing.test.ts, canvas/overlay/top-centre.test.ts}`,
`scripts/smoke/render-yaml.test.mjs`, `pnpm licence:check`.

Run on the foundation (the Windows PC and the NAS, 2026-10-18/19; tests on c01b57e7, the same code as the head):

| Check | Result |
|---|---|
| `pnpm -r typecheck` | 18 of 18 workspace projects, pass |
| `biome check .` (local) | 0 errors; the 4 older warnings in sync tests this branch does not touch (as on main) |
| vitest `packages`, `dev-assets`, `scripts` | 79 files, 2,088 passed (1 skipped) |
| vitest contracts / canvas-schema / db (PGlite) | 23 files / 216; 16 / 247; 17 / 123: all pass |
| vitest `sync` | 140 files, 883 passed (9 skipped) |
| vitest `web` (root config) | 501 files, 5,895 passed, 1 failed: `timeline.test.ts` "draws an svg over the frame", which fails on main too (date-dependent fixture) |
| vitest `api` (PGlite) | 2,212 passed and 65 timed out on a loaded machine (5 s test / 10 s hook limits); the 57 files rerun with 4 workers: 622 / 622 pass |
| real Postgres 18 on the NAS (`nas-pg-api.sh --only db`, `--only api`) | db 17 files / 123 passed; api 265 files / 2,436 passed (1 skipped), `migrations.pg` included |
| `node --test scripts/smoke/render-yaml.test.mjs` | 10 / 10 |
| `pnpm licence:check` | PASS (FAIL 0; the web's tree 302 packages, qrcode-generator MIT) |

Not run by the foundation: e2e (nothing user-visible changed: every switch is off and every route pending),
`probe:browser`, `test:arrows` (no engine or sync change).

The gate (WS5, at integration): `pnpm lint`, `pnpm typecheck`, `pnpm test`, the real-Postgres api and db suites on the
NAS (`bash scripts/nas-pg-api.sh <sha> --only api|db`), `probe:browser`, `test:arrows`, the whole e2e on chromium twice
(normally and with `E2E_DIRECT_EVENTS=1`), the stale pair with the real 711dd04 web, the NAS load report, and
`pnpm licence:check`.
