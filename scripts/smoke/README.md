# Live smoke checks (post-switch, post-rollback)

`scripts/smoke/live-smoke.mjs` checks a live Lobby deployment from the outside: the static site, the api
and the sync, as a signed-out visitor sees them. It is the scripted half of the cut-over runbook's
checks (`docs/EXCALIDRAW-CUTOVER.md` C14 and C15 after the web deploy, B9 after a rollback); the
signed-in half (two people editing a converted board, DEMO.md's flows) stays manual.

```sh
# after the switch (the Excalidraw build is live; runbook C14 onwards)
node scripts/smoke/live-smoke.mjs --base https://draftroom-staging-web.onrender.com --expect excalidraw

# after a rollback to R0 (runbook B9), and on today's staging (R0 is live)
node scripts/smoke/live-smoke.mjs --base https://draftroom-staging-web.onrender.com --expect r0

# keep the result in the cut-over log (never in the repository)
node scripts/smoke/live-smoke.mjs --base ... --expect excalidraw --json "C:\Users\Chase\Documents\Lobby-cutover\<date>\smoke-C14.json"
```

Needs `pnpm install` (it uses the e2e package's Playwright and the Chromium `pnpm e2e:install` puts in
place) and Node 24. No secret, no environment variable, no sign-in. `--api` and `--sync` name the api
and sync origins when they are not `<name>-api` / `<name>-sync` next to a `<name>-web` host.

Every check prints one line, `PASS`, `FAIL`, `WARN` or `INFO`, then a summary; the exit code is 1 when
anything FAILED. A FAIL after the switch is the runbook's **Stop**.

## What it does, and never does

Read-only: GETs of public pages, chunks, fonts and endpoints; one `POST /api/auth/sessions/revoke-all`
with the web origin as `Origin` and no session, which the api must answer 401 before touching anything;
the invite page and `GET /api/invitations/<token>` with a made-up token; one unauthenticated WebSocket
upgrade to the sync, which it must refuse. Headless Chromium opens `/signin` only. It never signs in,
creates or changes data, or calls an `/internal/*` route.

## The checks

| Line | Passes when |
|---|---|
| `web index`, `header …` | `GET /` is 200 HTML with render.yaml's `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`; `/assets/*` carries `Cache-Control: public, max-age=31536000, immutable`. HSTS is reported (Render adds it). |
| `content-security-policy` | `--expect excalidraw`: present (render.cutover.yaml.patch, runbook C13), `script-src` without `'unsafe-eval'` or `'unsafe-inline'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, a `font-src`, `connect-src` naming the sync origin, and `script-src` naming the Clerk frontend-API host decoded from `/api/auth/config`'s publishable key (P5). `--expect r0`: **absent** (R0's web breaks under it; B5 removes it). |
| `index has no inline script` | (excalidraw) index.html has no inline `<script>`: the CSP has no hash for one (C14's grep; G3). |
| `index chunks` | every `<script src>`, `modulepreload` and `stylesheet` in index.html answers 200 **with a JS or CSS content type**. A missing file is not a 404 on this host: the SPA fallback answers 200 `index.html`, so the type is what tells. The dynamic chunks reached from them are fetched too (`bundle closure`), for the scans below. |
| `excalidraw-assets font`, `… missing path` | (excalidraw) a font file the bundle references under `/excalidraw-assets/fonts/…` answers 200 and not HTML; `/excalidraw-assets/fonts/Nunito/not-there.woff2` answers **404** (P6's rewrite, above the SPA fallback). |
| `bundle host …` (INFO), `bundle foreign hosts` | every host of an absolute or protocol-relative URL in the fetched JS and CSS is listed with its class. PASS when none is foreign: allowed are Lobby's own three hosts, Clerk's (`*.clerk.accounts.dev`, `*.clerk.com`, `clerk-telemetry.com`, Clerk's `accounts.dev` suffixes, `challenges.cloudflare.com`), identifiers that are never requested (`www.w3.org`, `json-schema.org`, `*.invalid`) and documentation links in library error messages (`react.dev`, `github.com`, `rolldown.rs`). With `--expect r0`, also the hosts the R0 bundle is known to name (tldraw's embed allowlist and CDN, measured on staging 2026-10-01: the list is in the script). |
| `/api/me signed out` (web and api origin), `POST /api/auth/sessions/revoke-all signed out` | 401 `NOT_AUTHENTICATED`. The POST carries `Origin: <base>`: the api's CSRF rule answers a cross-origin mutation 403 first. |
| `api /healthz`, `sync /healthz` | 200. |
| `/api/auth/config` | 200 with a providers list; the Clerk frontend-API host is decoded from the publishable key for the CSP and browser checks. |
| `invite page`, `invite preview with a bogus token` | `/invite/<made-up>` is the SPA (200 HTML); `GET /api/invitations/<made-up>` is 404 `NOT_FOUND`. |
| `engine markers (…) present / absent` | the markers the integration scripts grep built output for (`docs/research/excalidraw/spike-b/scripts/integration-*.sh`): excalidraw = `excalidraw__canvas`, `EXCALIDRAW_ASSET_PATH`, `Excalifont`, `excalidraw-assets` present and tldraw's editor classes `tl-container`, `tlui-` absent; r0 = `tl-container`, `tlui-`, `@tldraw/` present and the Excalidraw markers (plus `@excalidraw/`) absent. |
| `headless sign-in page …` | Chromium loads `/signin`: the page renders (`[data-testid="signin-page"]` and Clerk's form or the dev provider's heading, not "Can't reach Lobby"), **0** `securitypolicyviolation` events and 0 CSP console lines, **0** console errors and page errors, and every request went to Lobby's hosts or Clerk's (the e2e network rule). |
| `sync socket` | an unauthenticated upgrade to `wss://<sync>/connect/b-live-smoke?sessionId=…` with `Origin: <base>`: 101, then the server's close. FAIL on 403 (`ALLOWED_ORIGINS` does not list the web origin), on any other status, on no close frame (an unauthenticated socket was accepted), or on the reason `MAINTENANCE`. PASS on an auth close (`4099 NOT_AUTHENTICATED`). See the limit below. |

## Limits, read before trusting a line

- **Maintenance cannot be seen from outside on staging.** The sync refuses an unauthenticated socket with
  `4099 NOT_AUTHENTICATED` and a closed board with `4099 MAINTENANCE`, but the ticket check runs first on
  both builds, so a connect without a ticket never sees `MAINTENANCE`; and on staging the edge in front
  of the sync (Cloudflare / Render) answered the probe's 101 with an **empty close frame** (no code, no
  reason) and ended the connection 10 s later, so even the auth reason is hidden (observed 2026-10-01;
  the web's "Lobby is updating" and "ticket refused" screens depend on these reasons reaching the
  browser, which this suggests they may not for an immediate refusal: unverified for an established
  socket). The line is then a `WARN`, not a PASS: what it proves is that the sync accepts upgrades from
  the web origin and refuses the socket. The authoritative maintenance check stays the runbook's
  `int GET /internal/maintenance` in the sync Shell (C16, F9).
- **`bundle foreign hosts` on the cut-over build.** `packages/tldraw-import` keeps `@tldraw/tlschema`, whose
  embed definitions name `codepen.io`, `www.youtube.com`, `www.figma.com` and others. If that chunk is in
  the web bundle after tldraw is removed (G10), this line FAILS and names the chunk as "a chunk naming
  @tldraw/tlschema". Those strings are an allowlist, never requested, but whether to accept them (add them
  to a dated list in the script, as `R0_BUNDLE_HOSTS` is) or to keep them out of the web bundle is the
  owner's call before the cut-over, not this script's.
- **The CSP checks are structural.** They confirm the directives the patch promises, not that the header's
  Clerk origins are right: that is P5 (a real sign-in with the header enforced, at the rehearsal). The
  headless sign-in page under the header is the closest this script gets, and it covers the sign-in page
  only, not the dashboard or a board.
- **Nothing signed in.** Boards, the dashboard, History, "Saved", two-user editing and the phone guest are
  C15 and C17's manual smoke.

## A rehearsal of `--expect excalidraw` before the day

The checks were exercised against a local engine-flag build of this tree (`VITE_LOBBY_ENGINE=excalidraw`,
`VITE_DRAFTROOM_DEV_AUTH=1`) served by a small static server that does what render.yaml plus the patch do
(SPA fallback, 404 under `/excalidraw-assets/`, the headers and the CSP, `/api/*` forwarded read-only to
the staging api) with `--api` and `--sync` pointing at staging. The open items showed as failures, as they
should: the inline theme script and zod's eval probe (G3: 2 CSP violations, 1 console error), tldraw's
markers and hosts still in the bundle (G10), and the 403 on the socket because a local origin is not in
staging's `ALLOWED_ORIGINS`. `e2e/spike/csp/server.ts` is such a server for the e2e stack.
