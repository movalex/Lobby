# Lobby demo video

A reproducible pipeline for the leadership demo video: it starts a fresh local Lobby stack, films two
people (and a client on a phone) using the real UI, and cuts the recordings to a narrated 1080p MP4.

```bash
pnpm --filter @draftroom/e2e demo:video -- \
  --narration=<path>/narration.json \
  --license-key-file=<path>/tldraw-license-key.txt
```

Output (gitignored) goes to `e2e/demo/out/`:

| File | What |
|---|---|
| `lobby-demo.mp4` | 1920x1080, 30 fps, H.264 (yuv420p, CRF 20, faststart) + AAC 192k, loudness -16 LUFS |
| `contact-sheet.png` | one frame per scene, for review |
| `timeline.json` | the scene windows (wall clock) and the recordings they cut from |
| `composed.json` | where each scene landed in the video |
| `recordings/`, `segments/`, `graphics/`, `debug/` | intermediate files and end-of-run screenshots |

A full run takes about 4-5 minutes on the dev PC (3 min recording, 1-2 min encoding).

## Inputs

- **Narration** (`--narration` or `DEMO_NARRATION`): a `narration.json` with `scenes[]` of
  `{ id, caption, text, audio, durationSec }`, `audio` relative to the JSON file. The scene ids are the
  ones in `scenes.ts` (`01-intro` ... `11-outro`); `caption` becomes the scene's lower third.
- **tldraw licence key** (optional): `--license-key-file` (or `DEMO_TLDRAW_LICENSE_FILE`), or the key
  itself in `VITE_TLDRAW_LICENSE_KEY`. Without one the canvas shows tldraw's "Get a license for
  production" button, as on any unlicensed localhost build. The key is inlined into the demo build
  only (`apps/web/dist/demo-web-11002/`, gitignored, deleted when the recording ends) and never
  printed.
- **AI** (scene 05): by default the repo's fake OpenAI server (`e2e/tests/support/ai.ts`, port base + 3)
  answers, with the three themes a person would give the tour's Brainstorm notes; nothing leaves the
  machine. With `OPENAI_API_KEY` in the environment (and optionally `OPENAI_MODEL`, `OPENAI_BASE_URL`)
  the real API is used instead: `run.ts` takes those variables out of its own environment and hands
  them, with `DRAFTROOM_AI=on`, to the api process alone (`StackOptions.apiEnv`); the sync server, the
  preview worker and `vite preview` never see them. A real model's wait is cut from the video (the busy
  pill shows for a moment). If the api reports AI as not set up, scene 05 is skipped.

```bash
# the final cut with the real API (the key comes from your shell or secret store; never commit it)
OPENAI_API_KEY=... OPENAI_MODEL=gpt-5.4-mini pnpm --filter @draftroom/e2e demo:video -- \
  --narration=<path>/narration.json --license-key-file=<path>/tldraw-license-key.txt
```

## Options

| Flag | |
|---|---|
| `--until=<scene id>` | stop recording after that scene (quick iterations) |
| `--record-only` | record and write `out/timeline.json`, skip composing |
| `--compose-only` | re-compose from the last `out/timeline.json` and its recordings |
| `--headed` | show the browser windows |

`E2E_PORT_BASE` defaults to 11000 (sync 11000, api 11001, web 11002), so the demo can run next to the
e2e suites and `pnpm dev`.

## How it works

- `run.ts` builds the web app with the local-dev guard (`VITE_DRAFTROOM_DEV_AUTH=1`), starts the real
  api, sync server and preview worker through `tests/support/stack.ts` (fresh temporary data dir, dev
  sign-in), serves the build with `vite preview`, records, composes, and stops everything.
- `scenes.ts` is the script. Everything on the boards is made through the UI: sign-in, the lobby's
  existing boards (New board → template → title, shared with the workspace), the Lobby tour from the
  gallery, sharing with Sam, the review link for the guest. Work between scenes (navigation, framing
  the view, closing notices) is filmed but cut: only the scene windows go into the video. Each scene
  runs at least as long as its narration clip plus 1.6 s of tail; a scene whose feature is not in the
  build (mind maps, AI) is skipped, not faked.
- `human.ts` makes the input look human: eased, slightly curved `page.mouse.move` paths, typing at
  about 11 characters a second, a drawn cursor with a click ripple (headless Chromium paints no
  cursor), keycaps for Tab / Enter / Esc, and touch dots on the phone. Its demo-only stylesheet hides
  the dev sign-in "DEV" tag and fits the board top bar into the 960 px windows.
- `compose.ts` cuts each scene from the recordings (Alex left, Sam right, the phone as an inset over
  Sam's half), adds the divider, name labels and caption, renders the title and outro cards frame by
  frame from HTML (`cards.ts`, Segoe UI), cross-fades the scenes, places each narration clip at its
  scene start and normalises the mix (two-pass loudnorm).

## Scenes

| id | Who | What |
|---|---|---|
| 01-intro | card | DBC Lobby, the tagline |
| 02-dashboard | both | dashboards with thumbnails; Alex creates "Lobby tour" from the gallery |
| 03-collab | both | Sam adds a note on the Brainstorm frame, Alex connects it; live cursors; Saved |
| 04-mindmap | Alex | a mind map built with Tab / Enter; Sam watches it grow |
| 05-ai | both | Alex brushes over the Brainstorm idea notes and shift-clicks his connector out of the selection (only notes are sent) → AI → "Group into themes" (Lobby asks before regrouping notes that sit under theme cards, then the first-use OpenAI notice) → "Grouped … Undo" toast (dismissed before the close-up) → labelled clusters on both screens, zoomed in |
| 06-private | both | a private brainstorm: both write, counts show, Alex reveals |
| 07-vote | both | a dot vote on the revealed notes, then the ranked results |
| 08-guest | both + phone | Alex's Share → "Share with a client" makes and copies the guest link in one click; Jordan joins on a phone with just a name (the page load and "Connecting to board…" are cut), shows as "(guest)", comments; Alex's bell shows it and opens the thread |
| 09-present | both | Present → "Invite everyone"; Sam gets the invite banner and joins; "1 following"; two slides in step; End (for everyone) |
| 10-history | both | Export (frame PNG / PDF) and the "⋯" menu closed, then the History panel: the automatic "Before AI grouped notes into themes" checkpoint, previewed read-only and zoomed in on the Brainstorm frame as it was |
| 11-outro | card | "Lobby — live today" and three facts |

## Known quirks worked around (off camera)

- Present uses the app's in-window mode: the demo reports fullscreen as unavailable, because a
  fullscreen element in headless Chromium takes the virtual screen's size and tears the recording.
- At 800 CSS px the board top bar folds Present and Export into its "⋯" menu once the workshop items
  join it (after the vote); scenes 09 and 10 open them from there, on camera.
- While the Note tool is active its style panel opens on the right: scene 03 frames the Brainstorm
  frame wide enough that Sam's click on the empty Story slot never lands on the panel.
- Participants other than the starter get the private brainstorm's "Add your notes" card (the top-bar
  chip may be folded away); scene 06 uses whichever shows.
- After a reveal, a participant who did not start the private brainstorm can keep a stale
  "Revealing…" chip until a reload (the server state is final). The script reloads Sam's tab off
  camera when it happens and logs it.
