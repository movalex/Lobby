# tldraw 5.x licensing for Draftroom

Researched 2026-09-26 against **tldraw 5.4.2** (npm `latest`). Draftroom context: an internal creative-team collaboration app with invited external reviewers. It is not a public SaaS at first, and it is planned to run on Render.

Confidence labels used below:
- **[src]**: read in the published 5.4.2 tarball source/dist.
- **[probe]**: run empirically against 5.4.2 code.
- **[docs]**: tldraw.dev page as fetched on 2026-09-26.
- **UNVERIFIED**: could not be confirmed.

This is engineering research, not legal advice. Contract terms override everything here.

---

## 1. Answers at a glance

| Question | Answer | Basis |
|---|---|---|
| Allowed in development / localhost? | Yes, free, no key. The license permits use "in Development Environments". | LICENSE.md [src], SDK checks [src][probe] |
| Key required for production? | **Yes.** The license's conditions include "Not to use the Software in Production Environments" unless you hold a trial or commercial license (or a hobby license, per the docs). | LICENSE.md [src], /community/license [docs] |
| Does Draftroom's internal pilot count as production? | **Yes.** The "Production Environment" definition includes serving "end users". Only internal dev/test/staging that is "not accessible to end users" is exempt. The creative team and external reviewers are end users. | LICENSE.md definitions [src] |
| What happens in production without a key? | Red console errors. The editor renders for **5 s**, then the whole editor subtree is replaced by a hidden `<div data-testid="tl-license-expired">`, which leaves a blank canvas. There is no watermark in this state. A tracking ping goes to `cdn.tldraw.com`. | `LicenseProvider.tsx`, `LicenseManager.ts` [src][probe] |
| Wrong domain / expired key? | Same as no key: blank after 5 s. | [src][probe] |
| Trial key? | Free **100-day** trial with no credit card. The key is emailed at once. One trial per business unit. It has **no grace period**: the editor goes blank the day after expiry. All premium features (including commenting) are enabled during the trial. The trial pings tldraw with the page URL. | /pricing, /community/license, /sdk-features/license-key [docs], LICENSE.md, `getEnabledFeatures` [src][probe] |
| Hobby key? | Free and discretionary, for "ideas that aren't a business yet". It **must show the "made with tldraw" watermark** and pings tldraw. Draftroom (a business tool) should not assume it qualifies. | /get-a-license/hobby [docs] |
| Are sync packages covered by the same license? | Yes. `@tldraw/sync` and `@tldraw/sync-core` ship the identical tldraw-license `LICENSE.md` and are marked `premium:false` (part of the core SDK). The pricing page says "Multiplayer sync included". There is **no** runtime key check in the sync packages; the key is checked only in the browser editor. | tarballs [src], /pricing [docs] |
| Does commenting need a separate license? | **Yes, if you use tldraw's commenting packages.** `@tldraw/commenting`, `@tldraw/mentions`, `@tldraw/sync-collaboration` and `@tldraw/collaboration` are `premium:true`, and the key must carry `FEAT_COMMENTING` or `FEAT_COLLABORATION`. Without that flag, the components render nothing in production. Draftroom's own Postgres comment system doesn't use these packages (see section 7). | package.json `tldraw_product` [src], `LicenseManager.ts` [src][probe], /docs/commenting [docs] |
| Is pricing published? | **No. Quote only** ("Value-based pricing"). There is a startup discount by application. The trial is free. The price of premium modules (commenting) isn't published. | /pricing [docs] |
| Alternatives | `@excalidraw/excalidraw` 0.18.1 is **MIT**. `yjs` is MIT. The `@liveblocks/*` client libraries are Apache-2.0, but the Liveblocks service is paid (UNVERIFIED pricing), and tldraw + Liveblocks still needs a tldraw license. | npm registry [src] |

---

## 2. Package license matrix (5.4.2)

I checked with `npm pack <pkg>@5.4.2` and `npm view <pkg>@5.4.2 license tldraw_product`. All "tldraw license" `LICENSE.md` files are byte-identical (md5 `802e49f9…`). Each is a one-line pointer to https://github.com/tldraw/tldraw/blob/main/LICENSE.md, whose content is identical at tag `v5.4.2` (4609 bytes, `cmp` equal).

| Package | `license` field | `tldraw_product` (stableId / premium / licenseFlag) |
|---|---|---|
| `tldraw` | SEE LICENSE IN LICENSE.md | `tldraw:sdk-core` / false |
| `@tldraw/editor` | SEE LICENSE IN LICENSE.md | `tldraw:sdk-core` / false |
| `@tldraw/assets` | SEE LICENSE IN LICENSE.md | `tldraw:sdk-core` / false |
| `@tldraw/driver` | SEE LICENSE IN LICENSE.md | `tldraw:driver` / false |
| `@tldraw/sync` | SEE LICENSE IN LICENSE.md | `tldraw:sync` (parent sdk-core) / false |
| `@tldraw/sync-core` | SEE LICENSE IN LICENSE.md | `tldraw:sync` (parent sdk-core) / false |
| `@tldraw/tlschema` | **MIT** | `tldraw:sdk-core` / false |
| `@tldraw/state`, `@tldraw/state-react`, `@tldraw/store`, `@tldraw/utils`, `@tldraw/validate` | **MIT** | `tldraw:sdk-core` / false |
| `@tldraw/commenting` | SEE LICENSE IN LICENSE.md | `tldraw:commenting` / **true** / `FEAT_COMMENTING` |
| `@tldraw/mentions` | SEE LICENSE IN LICENSE.md | `tldraw:commenting` / **true** / `FEAT_COMMENTING` |
| `@tldraw/sync-collaboration` | SEE LICENSE IN LICENSE.md | `tldraw:commenting` / **true** / `FEAT_COMMENTING` |
| `@tldraw/collaboration` | SEE LICENSE IN LICENSE.md | `tldraw:collaboration` / **true** / `FEAT_COLLABORATION` |

The official templates in the repo at tag `v5.4.2` are MIT for their own code: `simple-server-example`, `socketio-server-example`, `sync-cloudflare`, `vite`, `nextjs` and others. They depend on the tldraw-licensed packages above.

The v5.3.0 release notes (`tldraw/RELEASE_NOTES.md`) call commenting the first piece of "a separately licensed section of the SDK".

---

## 3. What the license text says (github.com/tldraw/tldraw/blob/v5.4.2/LICENSE.md)

- **Production Environment**: any production deployment "used to provide functionality to end users". It "excludes internal development".
- **Development Environment**: internal dev/test/staging that is "not accessible to end users, customers, or the public".
- **Permissions**: use in Development Environments; modify; bundle with your own projects; submit modifications.
- **Conditions** (abridged):
  - no production use without a license;
  - "Not to disable, change, or interfere with" License Key enforcement;
  - keep notices;
  - no standalone redistribution;
  - "include a verbatim copy of this License in any distribution";
  - follow the trademark policy.
- **Trial**: production use is allowed "for the specified period" from key issuance. It is limited to one trial per business unit unless tldraw approves in writing.
- **Commercial**: production use is allowed for the period of the separate agreement.
- **Technical enforcement**: the code verifies keys, detects environments, enforces the watermark, and "may collect and transmit usage data".
- **Other**: Delaware law. Termination is automatic on breach or if you bring an IP claim against tldraw. tldraw may assign the license without your consent.
- **Hobby**: the hobby license isn't mentioned in LICENSE.md itself. It appears only on tldraw.dev pages.

---

## 4. Runtime enforcement (source: `@tldraw/editor/src/lib/license/*`, 5.4.2)

### 4.1 Public API surface (from the published `.d.ts`)

```ts
// @tldraw/editor dist-esm/index.d.mts
export declare interface TldrawEditorBaseProps { /* … */ licenseKey?: string; /* line 8083 */ }
export declare interface TLEditorOptions       { /* … */ licenseKey?: string; /* line 8477 */ }
// tldraw dist-esm/index.d.mts
export declare interface TldrawBaseProps extends TldrawUiProps, TldrawEditorBaseProps, TLExternalContentProps {} // line 4222
export declare interface TldrawImageProps extends TLImageExportOptions { /* … */ licenseKey?: string; /* line 4331 */ }
// @tldraw/commenting dist-esm/index.d.mts (public)
export declare function useCommentingEnabled(): boolean; // line 1368
```

`LicenseManager`, `LicenseState`, `useLicenseFeatureFlag`, `useMaybeLicenseManager` and `LICENSE_TIMEOUT` are exported at runtime but are `@internal`, so they are excluded from the public types. Don't build on them.

### 4.2 Key format and verification [src]

- The format is `tldraw-<prefix>/<base64(JSON [id, hosts[], flags, expiryDate])>.<base64 ECDSA P-256/SHA-256 signature>`.
- The key is verified **offline in the browser** with `crypto.subtle` against an embedded public key. No license server is called to validate it.
- Zero-width characters and newlines are stripped before parsing.

Flags (`LicenseManager.ts` `FLAGS`):

```ts
ANNUAL_LICENSE: 1, PERPETUAL_LICENSE: 1<<1, INTERNAL_LICENSE: 1<<2, WITH_WATERMARK: 1<<3,
EVALUATION_LICENSE: 1<<4, NATIVE_LICENSE: 1<<5, FEAT_COLLABORATION: 1<<6, FEAT_COMMENTING: 1<<7
```

`INTERNAL_LICENSE` is parsed into `isInternalLicense`, but nothing in 5.4.2 gates on it. That suggests an "internal use" license SKU exists. **Ask sales** (section 10).

### 4.3 Development detection (`LicenseManager.getIsDevelopment`) [src][probe]

```ts
if (hostname.toLowerCase().endsWith('.localhost')) return process.env.NODE_ENV !== 'production'
return protocol === 'http:' || (protocol === 'https:' && isLoopbackHost(hostname)) || process.env.NODE_ENV !== 'production'
// isLoopbackHost: localhost | ::1 | 127.x.x.x
```

In development, all features are enabled, including commenting, and no key is needed.

Gotchas:
- A production build served on **`https://app.localhost`** is treated as production (probe case 6).
- A production build on **plain `http://` on any host** is treated as development (probe case 3). This is **not** a licensing loophole: LICENSE.md still forbids production use, and it forbids interfering with enforcement.
- `process.env.NODE_ENV` is resolved by *your bundler*. I verified that Vite 8.3.1 `vite build` inlines it as `false` for the `!== 'production'` check (see section 5).

### 4.4 State machine (`getLicenseState`) and user-visible effect [src][probe]

I ran a Node probe that loads the real `LicenseManager.mjs` from `@tldraw/editor@5.4.2`, uses a mocked `window.location`, and mints test keys signed with my own key pair via the constructor's `testPublicKey` argument. Scratch: `…/scratchpad/research/license/probe/probe.mjs`.

| Scenario (URL, NODE_ENV) | State | Features (collab/comment) | Visible result | Ping to cdn.tldraw.com |
|---|---|---|---|---|
| `https://draftroom.example.com`, prod, **no key** | `unlicensed-production` | off/off | Console errors; editor blank after 5 s | yes, `license_type=unlicensed` |
| Same, garbage key | `unlicensed-production` | off/off | "Invalid tldraw license key / Reason: Invalid signature"; blank after 5 s | yes |
| Valid annual key, host listed | `licensed` | off/off | Normal, no watermark | no |
| Annual + `FEAT_COMMENTING` | `licensed` | off/**on** | Normal | no |
| Annual + `FEAT_COLLABORATION` | `licensed` | on/on (umbrella) | Normal | no |
| Evaluation (trial), unexpired | `licensed` | **on/on** | Normal, no watermark | yes, `license_type=evaluation&license_id=…` |
| Evaluation, expired yesterday | `expired` | off/off | "evaluation license has expired"; blank after 5 s | yes |
| Annual + `WITH_WATERMARK` (hobby-like) | `licensed-with-watermark` | off/off | "made with tldraw" watermark | yes, `license_type=with_watermark` |
| Key hosts don't include `draftroom-staging.onrender.com` | `unlicensed-production` | off/off | "License key is not valid for this domain."; blank after 5 s | yes |
| `www.` variant of a listed host | `licensed` | per flags | Normal | no |
| `*.example.com` key on `staging.example.com` | `licensed` | per flags | Normal | no |
| Annual, expired 10 days | `licensed` (grace) | per flags | Console "License expired 9 days ago." | no |
| Annual, expired 40 days | `expired` | off/off | Blank after 5 s | no |
| `http://localhost:5173`, dev, no key | `unlicensed` | on/on | Watermark button "Get a license for production" | no |
| `http://localhost:5173`, dev, valid key | `licensed` | on/on | No watermark | no |

Other details:
- **Pending state:** in production, features are *fail-closed* until async validation finishes. For example, `CanvasComments` stays hidden.
- **Blanking:** `LICENSE_TIMEOUT = 5000`. `LicenseProvider` swaps its children for `<LicenseGate/>` (a `display:none` div with `data-testid="tl-license-expired"`).
- **Watermark:** it renders only in `unlicensed` (dev) and `licensed-with-watermark`. It is positioned bottom-right. On viewports under 700px it shrinks to an 8px tab.
- **Watermark identifiers:**
  - class `tl-watermark_SEE-LICENSE`;
  - test ids `tl-watermark-unlicensed` and `tl-watermark-licensed`;
  - z-index `--tl-layer-watermark: 248`.
- **Don't hide the watermark.** The embedded CSS comment says you agree to keep it "visible, unobscured, and available to user-interaction". Draftroom overlays (comment pins in `InFrontOfTheCanvas`) must not cover it.
- **Expiry timing:** it is computed in UTC. The named expiry day is fully usable. The grace period is `GRACE_PERIOD_DAYS = 30` for annual and perpetual keys and 0 for evaluation keys.
- **Perpetual keys:** they gate on the `publishDates` of the installed version (5.4.2: major `2026-05-06`, minor `2026-09-02`). /sdk-features/license-key says perpetual licenses are no longer sold.

### 4.5 Data collection [src][probe] versus the docs

`maybeTrack` fetches `https://cdn.tldraw.com/<version>/watermarks/watermark-track.svg` with these query parameters:
- `version`, `license_type`, `license_id`, `sku`;
- **`url=window.location.href`** (the full URL, including path, query and hash);
- `environment=NODE_ENV`.

When it fires:
- For `unlicensed-production`, evaluation (trial) and `licensed-with-watermark` states.
- Never in development.
- Never for a plain commercial key.
- The CDN URL is hard-coded, so self-hosting the assets does **not** suppress this ping.

The docs disagree with each other and with the code:
- /sdk-features/license-key matches the code: trial and hobby send license ID, type, version and page URL.
- /community/license (page footer says "Last edited on Sep 13, 2023") is stale. It says trial sends "a hash of the license key" and that hobby sends nothing.

**Draftroom impact:** during a trial, board IDs **and any review-link token in the URL** would be sent to tldraw. Before mounting `<Tldraw>`, exchange the review token for a session cookie and remove it from the URL with `history.replaceState`. Also keep secrets out of the path and hash.

The FAQ (/faq) adds that default static assets (fonts, icons) load from tldraw's CDN unless self-hosted. It says that self-hosting all assets on a normal license means "no external requests are made."

---

## 5. Supplying the key (Vite / Render Static Site)

These are the supported mechanisms [docs][src]:
- the `licenseKey` prop on `Tldraw`, `TldrawEditor` or `TldrawImage`;
- automatic detection of `TLDRAW_LICENSE_KEY` or `{NEXT_PUBLIC_,REACT_APP_,GATSBY_,VITE_,PUBLIC_}TLDRAW_LICENSE_KEY` via `process.env` or `import.meta.env` (`LicenseProvider.getLicenseKeyFromEnv`).

Keys are public by design ("They can be public"), so shipping one in the frontend bundle is expected.

**Verified [probe]:** tldraw 5.4.2 with Vite 8.3.1, `@vitejs/plugin-react` 6.1.1 and `.env.production` containing `VITE_TLDRAW_LICENSE_KEY=…`. `vite build` inlined the key string into tldraw's `getLicenseKeyFromEnv`, and `NODE_ENV` checks were compiled to `false`.

**Consequence:** the key is fixed **at build time**. Renewing the license (every key embeds an expiry date) requires a **rebuild and redeploy of the web app**, within 30 days after expiry. Adding a domain also requires a rebuild.

Recommended explicit wiring. This is not verified in a browser. It is standard Vite behavior plus the verified prop:

```tsx
// apps/web/src/canvas/tldrawLicense.ts
export const TLDRAW_LICENSE_KEY: string | undefined =
  import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined

// usage
<Tldraw licenseKey={TLDRAW_LICENSE_KEY} /* store / tools / components … */ />
```

Suggested guardrails (Draftroom code, not tldraw API):
- **CI:** fail a production-mode build when `VITE_TLDRAW_LICENSE_KEY` is empty for a deploy target that is reachable by end users.
- **Post-deploy smoke test (Playwright):** load a board on the deployed hostname and wait for more than 6 s. Assert that `[data-testid="tl-license-expired"]` and `[data-testid="tl-watermark-unlicensed"]` are both absent. Assert that no console line contains `tldraw license`.
- **Calendar reminder:** set one for the key's expiry date. It is readable from the key payload (`JSON.parse(atob(key.split('.')[0].split('/')[1]))[3]`).

---

## 6. Sync (`@tldraw/sync`, `@tldraw/sync-core`)

- **License:** the same tldraw license as the SDK, marked as a non-premium core feature [src]. The pricing page states "Multiplayer sync included" in the SDK License [docs].
- **No server-side enforcement:** there are no `license`/`watermark` strings in `src/` or `dist-*` of `@tldraw/sync`, `@tldraw/sync-core` or `@tldraw/sync-collaboration` [src]. The `collaboration` feature flag exists, but nothing in 5.4.2 gates on it except as the umbrella that grants commenting [src].
- **Licensing still applies to the server:** the license defines Production Environment to include "servers". So running `@tldraw/sync-core` on Render for end users is licensed production use, even though the code doesn't check a key.
- **Demo server:** tldraw's hosted demo sync is for prototyping only. Data is deleted after about a day and rooms are public [docs /docs/collaboration]. Draftroom self-hosts, as planned.
- **Object-store lane:** the generic object-store lane added to `@tldraw/sync-core` in 5.3.0 lives in a non-premium package.

---

## 7. Commenting and Draftroom's own comment system

tldraw commenting:
- It requires a key with `FEAT_COMMENTING` or `FEAT_COLLABORATION` in production.
- "every commenting component renders nothing in production" without it (/sdk-features/commenting [docs]).
- The gate is in `@tldraw/commenting/src/canvas/license.ts` and `tldraw/src/lib/ui/hooks/useCommentingEnabled.ts`. Without the flag, the comment toolbar item, Quick Action and `C` shortcut are also hidden [src].
- Trial keys enable it [src][probe]. So commenting will appear to work during a trial and then disappear under a base commercial key that lacks the flag.

Draftroom's plan (Postgres threads, custom anchors and UI) doesn't need these packages. Rules to keep it that way:
- Do **not** add `@tldraw/commenting`, `@tldraw/mentions`, `@tldraw/sync-collaboration` or `@tldraw/collaboration` as dependencies unless the quote includes commenting. Add a dependency-lint rule.
- `@tldraw/mentions` is premium. Build @-mentions in Draftroom's own UI.
- `commentSchemaRecords` / `TLComment*` types live in MIT `@tldraw/tlschema`. Draftroom stores comments in Postgres, so it doesn't need them in the tldraw store.
- UNVERIFIED and to confirm with sales: whether building a custom comment feature on the base SDK is fully within base-license scope. LICENSE.md has no per-feature terms, and the docs merely *suggest* gating custom comment UI on `useCommentingEnabled`.

---

## 8. Pricing and license types (tldraw.dev, fetched 2026-09-26)

- **SDK License (commercial):**
  - "Value-based pricing"; "Host anywhere"; "Support available";
  - "Multiplayer sync included";
  - the pricing page shows no price, and "Talk to sales" leads to /get-a-license/plans. That form asks for company size, website and **Domains**.
- **Trial:** "Start with a 100-day free trial." "No credit card required." The trial form asks only for name, work email, company website and intended use. It asks for **no domain field**, so the hosts in a trial key are UNVERIFIED.
- **Startup:** "Discounted pricing is available for new companies", by application (/get-a-license/startup).
- **Hobby:** "for personal projects and early experiments". It shows the watermark and is reviewed case by case.
- **Premium modules:** described on the pricing page as "in development". Commenting has shipped (5.3.0), but no price is listed.
- **Domains:** FAQ says "We map all relevant domains you plan to host the SDK on to a single license."

---

## 9. Draftroom environment mapping

| Environment | License status | Technical behavior | Action |
|---|---|---|---|
| Local dev (`http://localhost`, `127.0.0.1`) | Permitted, no key | Dev mode; "Get a license for production" watermark; all features on | None |
| CI / Playwright on localhost | Permitted (testing) | Dev mode | None |
| Staging on Render (HTTPS, `*.onrender.com` or custom domain), team-only | Permitted *legally* only if "not accessible to end users" | **SDK treats it as production**, so it goes blank after 5 s without a key whose hosts include the staging hostname | Ask sales for staging hosts on the key. Don't rely on non-production builds to dodge the check. |
| Render PR/preview URLs | Same as staging | Dynamic hostnames won't match an exact host | Ask for a wildcard on a custom domain (for example `*.draftroom.<company>.com`) |
| Internal pilot (creative team) | **Production**: needs a trial or commercial key | A trial works for 100 days, then goes blank with no grace | Request the trial only when the pilot deploy is ready (the clock starts at issuance) |
| External reviewers | Production | Same key; the license is per domain, not per user (per the public text) | Confirm the pricing basis with sales |
| Preview/thumbnail worker, if it renders tldraw in headless Chromium | Probably production (server use for end users) | On `http://localhost` inside the worker it runs in dev mode | Ask sales. Don't treat localhost dev mode as a license. |

---

## 10. Open questions to resolve with tldraw sales before production

1. **Price.** What is the annual quote for Draftroom's exact use, and what is it based on (seats, MAU, boards, domains, company size)? What does renewal cost, and are there price caps?
2. **Internal-use SKU.** Does an internal-use license apply (the `INTERNAL_LICENSE` flag exists in the key format)? Do invited **external reviewers** break "internal" eligibility?
3. **Sync included.** Is self-hosted `@tldraw/sync` + `@tldraw/sync-core` on Render (Node, SQLite) covered by the base SDK license with no per-server or per-room fees? Is a future move to Cloudflare Durable Objects covered?
4. **Commenting and collaboration module.**
   - What is the price of `FEAT_COMMENTING` / `FEAT_COLLABORATION`?
   - Confirm in writing that a custom Postgres comment system that doesn't use `@tldraw/commenting`, `@tldraw/mentions`, `@tldraw/sync-collaboration` or `@tldraw/collaboration` is within base-license scope.
   - If Draftroom later adopts the module, how does it migrate?
5. **Domains.**
   - Which production custom domain(s) go on the key?
   - Can staging hostnames be included? Is `*.onrender.com` possible, or is a wildcard on our own domain required?
   - Are dynamic preview URLs possible?
   - How fast is key re-issuance when domains change?
6. **Staging and dev keys.** The license allows staging, but the SDK blanks on HTTPS production builds. Do they issue a staging key, or do they expect staging hosts on the production key?
7. **Trial mechanics.**
   - Which hosts does a trial key cover, given the form asks for none?
   - Can it be extended?
   - How do we convert to a commercial key without downtime, given evaluation keys have no grace period?
   - The trial is one per business unit, so how is our "business unit" defined?
8. **Version coverage.** Does an annual license cover all 5.x/6.x releases during the term? After non-renewal, does the deployed version stop working? The code blanks it after the 30-day grace, so confirm there are no contractual carve-outs.
9. **Telemetry.** Confirm in the contract that a commercial key sends no data. Is it acceptable that trial pings include the full page URL? This bears on reviewer confidentiality.
10. **Server-side and headless rendering.** Is rendering boards to thumbnails or exports in a worker (headless browser or `TldrawImage`) covered?
11. **Notice obligations.** How do we satisfy "include a verbatim copy of this License in any distribution" for a browser-delivered bundle? A third-party-notices page is suggested.
12. **Discounts.** Are startup or nonprofit discounts available, and what are the eligibility criteria? Is there a multi-year option?
13. **Support.** Is an SLA or support channel included? What is the response time for a production-blocking license issue, for example a key expiring or a domain mismatch?
14. **Legal review.** Delaware governing law, automatic termination on any breach or IP claim, and tldraw's unilateral assignment right all need review.
15. **Future native/tablet wrapper.** If the plan later ships a wrapper, will it need a native key (`NATIVE_LICENSE`)?

---

## 11. Alternatives in the plan (licenses verified via npm)

| Option | License | Notes |
|---|---|---|
| `@excalidraw/excalidraw` 0.18.1 | MIT (npm + repo LICENSE, "Copyright (c) 2020 Excalidraw") | Editor only. Collaboration, storage and hosted features must be built. |
| `yjs` 13.6.33 | MIT | A sync layer if Excalidraw is chosen. Don't combine it with native tldraw sync. |
| `@liveblocks/client`, `@liveblocks/react`, `@liveblocks/node` 3.24.2 | Apache-2.0 | The service is paid SaaS (pricing UNVERIFIED). tldraw + Liveblocks still needs a tldraw license. |

---

## 12. Unverified items

- The actual commercial price, and whether it is based on seats, MAU or domains.
- Which hosts are in a trial key.
- Whether the hobby license is ever granted to internal business tools (the public wording suggests it isn't).
- Whether a custom comment feature on the base SDK is fully within base-license scope. This is legal interpretation for sales to confirm.
- The browser runtime of `import.meta.env.VITE_TLDRAW_LICENSE_KEY` pickup. The bundle inlining was verified, but I didn't load it in a real browser.
- Liveblocks service pricing and terms.

## Sources

- Tarballs: `tldraw@5.4.2`, `@tldraw/editor@5.4.2`, `@tldraw/sync@5.4.2`, `@tldraw/sync-core@5.4.2`, `@tldraw/tlschema@5.4.2`, `@tldraw/commenting@5.4.2`, `@tldraw/sync-collaboration@5.4.2`. Key files:
  - `@tldraw/editor/src/lib/license/{LicenseManager.ts,LicenseProvider.tsx,Watermark.tsx,useLicenseManagerState.ts}`
  - `@tldraw/commenting/src/canvas/license.ts`
  - `tldraw/src/lib/ui/hooks/useCommentingEnabled.ts`
  - `tldraw/RELEASE_NOTES.md` (v4.0.0 Licensing, v5.3.0 Commenting)
- https://github.com/tldraw/tldraw/blob/v5.4.2/LICENSE.md
- https://tldraw.dev/pricing
- https://tldraw.dev/community/license
- https://tldraw.dev/sdk-features/license-key
- https://tldraw.dev/sdk-features/commenting (same content as /docs/commenting)
- https://tldraw.dev/docs/collaboration
- https://tldraw.dev/faq
- https://tldraw.dev/get-a-license/trial, /hobby, /startup, /plans
- https://tldraw.dev/legal/trademark-guidelines. It forbids using the tldraw marks or a "tl" prefix in product names. "Draftroom" is fine.
- Probes (scratch, not repo):
  - `C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/research/license/probe/probe.mjs`
  - `…/viteprobe/`
