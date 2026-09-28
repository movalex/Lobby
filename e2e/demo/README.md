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
- **AI** (scene 05): with `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, `OPENAI_BASE_URL`) in the
  environment, those variables go to the api process only (the stack's other processes never see
  them). Without a key, the repo's fake OpenAI server is used when the ai-assist feature ships one at
  `e2e/tests/support/fake-openai.ts` (an exported `start…()` returning `{ url | baseUrl, close | stop }`).
  Without either, or while `apps/web/src/features/ai` is still the stub, scene 05 is skipped.

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
| 05-ai | Alex | select the brainstorm notes → AI "Group into themes" (skipped until ai-assist ships) |
| 06-private | both | a private brainstorm: both write, counts show, Alex reveals |
| 07-vote | both | a dot vote on the revealed notes, then the ranked results |
| 08-guest | phone | Jordan joins from the review link with just a name, shows as "(guest)", comments |
| 09-present | both | Alex gathers everyone and presents the tour; Sam follows (no "present to everyone" yet) |
| 10-history | both | Export (frame PNG / PDF) and the History panel's automatic checkpoint, previewed |
| 11-outro | card | "Lobby — live today" and three facts |

## Known quirks worked around (off camera)

- Present uses the app's in-window mode: the demo reports fullscreen as unavailable, because a
  fullscreen element in headless Chromium takes the virtual screen's size and tears the recording.
- After a reveal, a participant who did not start the private brainstorm can keep a stale
  "Revealing…" chip until a reload (the server state is final). The script reloads Sam's tab off
  camera when it happens and logs it.
