# Domain access: contracts

Status: contracts committed (step A, §12), 2026-09-29, on branch `next` (base a571636: 19 backlog fixes, not deployed). Revised after the security and regression reviews: every blocking item is resolved, and §16 (Review log) says what was accepted, rejected or deferred. **API steps B1 and B2 are built** on branch `da/api` (§17, As built), **the web (step C) on `da/web`**, and both are **merged into `next`** (step D, §18: the gate is recorded there and in docs/PROGRESS.md). **Verifier findings, fixer round 1** (§19): fixed on `next`, with the contract changes marked "fixer round 1" in §3.3, §3.4, §4.2, §6.1, §7, §9, §14 and §15. **Fixer round 2** (§20): four web findings, fixed on `next`, with the §9 changes marked "fixer round 2". Still to do: the opt-in real-Postgres run, the independent security review (§14) and the deploy (§13).

Owner decisions: 2026-09-29, final (restated in §0). Two builders work in parallel: an **API owner** and a **WEB owner** (§12). This file is the only coordination channel between them. Contract changes go through the API owner and are recorded here.

The shared rules from docs/WAVE3-CONTRACTS.md §1 and docs/WAVE4-CONTRACTS.md §1 still apply:
- 404 whenever something must not reveal that it exists;
- no secrets read;
- "Lobby" in user-visible text;
- `--dr-*` tokens, light and dark themes, 390 px;
- every name-only-guest limit is kept.

This work adds no dependency, does not touch the lockfile and does not change `render.yaml` (§13).

## 0. The rule

| Who | How we know | May sign in | Gets on first sign-in | May create workspaces, projects, boards | May invite, create links or raise access |
|---|---|---|---|---|---|
| **Creator** | a verified email whose domain is exactly `darkburn.com` or `trailerparkgroup.com`, or an address on the exceptions list. Never a Clerk test-mode address (`+clerk_test`). | yes | a personal workspace (plus Dev Studio, dev only) | yes, where their workspace role allows it (owner/admin/member) | yes, where their board or workspace role allows it |
| **Outside account** | any other signed-in account | yes | nothing | never, anywhere | never. They may still lower or remove access and revoke links |
| **Name-only guest** (wave 3) | `users.kind = 'guest'` | through guest links | n/a | never (unchanged) | never (unchanged) |

Owner decisions, restated:
1. Creators are as defined above. Only creators create, in any form: new board, duplicate, template, sample board, import, restore as a new board, a new project, a workspace. Only creators get a personal workspace.
2. Outside people get only what they are invited to, with the role they were given.
3. An invitation to an email address works only for an account that has that verified address. Name-only guest links stay exactly as they are.
4. Existing accounts keep every membership, grant and ownership they have today. Nothing is removed. The owner's personal account keeps creator rights through the exceptions list.
5. Rollout: branch `next` → full gate → independent security review → staging deploy (the lead deploys).

## 1. Decisions this document makes

The owner decisions leave these points open. The lead can reverse each one with a small, local change.

- **D1. Any verified address counts, primary or secondary, for both the creator rule and the invite lock, except Clerk test-mode addresses.** Verifying an address in Clerk normally requires control of that mailbox, and Clerk keeps each address unique per instance (UserApi.d.ts:190). A primary-only rule would lock out Dark Burn people whose primary address is personal, and it would be no stronger.
  The exception: Clerk **test mode**, on by default on every development instance (staging uses one), verifies any address with the `+clerk_test` subaddress with the fixed code 424242 and sends no email. So `anyone+clerk_test@darkburn.com` proves nothing. Lobby never stores, matches or invites such an address, in any environment (§2), and the lead turns test mode off on the staging instance (§13).
  The Clerk verification strategy (`from_oauth_google`, `email_code`, …) is stored with each address, for a later per-strategy rule (§15). It is not enforced now.
- **D2. Every new single-use invitation must name an email address.** There are no more unbound "whoever opens it first" links, for boards or for workspaces. We rejected the alternative, "unbound links, but only creators may accept them": a forwarded link could still be taken by any Dark Burn person instead of the invitee, it adds a second rule to audit, and the Share dialog already asks for an address.
- **D3. Open unbound single-use links are revoked by migration 0021.** Their address was never stored (email-invites.ts logged only a hash), so they cannot be locked after the fact. Holders get the existing 410 page, which says to ask the inviter for a new link. The new code also treats any unbound single-use link as gone (for links an older build creates during a rollback).
- **D4. Everything that hands out access is creator-only:**
  - creating invitations of any kind: board, workspace, email;
  - review, workshop and client guest links;
  - extending a link;
  - approving an access request;
  - raising someone's board role or a board's visibility;
  - transferring board ownership (the caller must be a creator, and so must the target, D5).

  Anything that reduces access stays open to whoever holds the role today: revoke, remove, lower, deny. That includes lowering or removing a creator's grant (a board owner can already trash the board, and decision 4 keeps their role). The last-owner rule is unchanged.
  Non-creator managers still see the pending list, but multi-use link URLs come back as `url: null` for them, so they cannot hand out a link that already exists.

  Why: an outsider who can mint links can bring in anyone without a Dark Burn person deciding, and that defeats decision 2. The only outsiders who hold `manage_access` are pre-existing accounts (decision 4), and they keep every ability to reduce exposure. Board settings that are not access (the export policy, AI settings) stay role-based (§15).
- **D5. Outsiders can never be given board `owner` or workspace `admin`/`owner` from now on.** This covers PUT members, transfer of ownership, workspace invitations and "Duplicate, keep sharing" (copied owner grants of non-creators become editor). Existing outsider owners and admins keep their roles (decision 4). Outsiders may be given editor, commenter or viewer on a board, and member or guest in a workspace.
- **D6. `PATCH /api/projects/:pid` (rename, archive, unarchive) is creator-only.** The guest guard already treats it as a creation route. Outsiders are there to work on boards, not to reorganise Dark Burn's project lobbies. Moving a board between projects (`PATCH /api/boards/:bid {projectId}`) stays role-based: it creates nothing and hands out nothing.
- **D7. Multi-use review and workshop links behave as today.** Any signed-in account holding the link may accept it (by design: the links are time-limited and role-capped, and a creator made them for that purpose). Only their creation and extension become creator-only (D4). Residual risk, §15.
- **D8. Dev sign-in without an email is a creator.** The account gets the synthetic address `<handle>@dev.invalid`, and `dev.invalid` counts as a creator domain only while the api runs the dev provider. Every existing api, e2e, perf and demo login stays a creator with a personal workspace and Dev Studio. Invitation tests address a handle-only dev user as `<handle>@dev.invalid`. `.invalid` is reserved (RFC 2606), so it can never be a real, Clerk-verified address.
- **D9. A first Clerk sign-in whose profile fetch fails is refused (503).** The alternative, provisioning the person as an outsider, would turn a Clerk blip into a Dark Burn employee with no personal workspace. A later sign-in with the profile unavailable still succeeds on the stored emails.
- **D10. Personal workspaces are marked (`workspaces.personal_of`), and "ensure a personal workspace" runs for every creator.** It runs at sign-in, at an identity refresh and at GET /api/me. Case: an existing outsider whom an exception or a new company address makes a creator gets one. Existing personal workspaces of non-creators stay (decision 4).
- **D11. The web's fallback is permissive.** When `/api/me` carries no `access` (an api from before this feature, for example during an api-only rollback), the web parses `ME_ACCESS_LEGACY` (`creator: true, reason: 'legacy'`) and behaves exactly as today. That api gates nothing, so hiding controls would only break the UI; the server is authoritative either way. The domain-access api never sends `'legacy'`.
- **D12. Identity freshness is "confirm when unknown, refresh in the background when merely stale".** Stored addresses are confirmed with Clerk before they are trusted for the first time (every staging user after the deploy), and again when they are older than 24 h. Between 1 h and 24 h, /api/me answers at once and refreshes in the background. Accepting a locked invitation always uses addresses at most 5 min old. Details in §3.4.
- **D13. "Invite people" with an email address makes a locked link, and sends no email.** It calls `POST /api/boards/:bid/invitations` with `{ role, email }`, as today minus the lock. The separate "Invite by email" section keeps using the email route (Clerk sends it). This keeps the field's "Lobby does not send email" hint true and changes the fewest flows.

## 2. Config

The policy lives in `apps/api/src/auth/creators.ts` (pure, no I/O). config.ts parses the policy into `ApiConfig.creators`.

```ts
export interface CreatorPolicy {
  /** Exact, ASCII, lowercase domains. */
  domains: readonly string[]
  /** Exact, ASCII, lowercase addresses (the exceptions list). */
  emails: readonly string[]
}
export const DEFAULT_CREATOR_DOMAINS = ['darkburn.com', 'trailerparkgroup.com'] as const
/** Counts as a creator domain only while the api RUNS the dev provider (D8). Never configurable. */
export const DEV_CREATOR_DOMAIN = 'dev.invalid'
```

The dev domain and the `user_emails.source` filter are keyed on the provider instance the api actually runs (`provider.id`; app.ts:92 lets `deps.authProvider` differ from `config.authProvider`), never on the `AUTH_PROVIDER` variable.

| Variable | Unset or blank (config.ts `read` treats blank as unset) | Set |
|---|---|---|
| `DRAFTROOM_CREATOR_DOMAINS` | `DEFAULT_CREATOR_DOMAINS`, in every environment (production included) | Comma-separated. Replaces the default. It must hold at least one valid domain. |
| `DRAFTROOM_CREATOR_EMAILS` | no exceptions | Comma-separated addresses, at most 50. |

**Fail closed.** No setting turns the policy off.
- An unset domain list means the two built-in domains, never "everyone".
- An unset exception list means no exceptions, so the owner's personal account is an outsider until the variable is set.
- An invalid value stops the api at startup.

Neither variable is required in production, so `config.test.ts` prodSecrets needs no change.

**Parsing**, for both variables:
- split on `,`, trim each entry, ignore empty entries (a trailing comma is fine), remove duplicates;
- lowercase **ASCII letters only** (`asciiLowercase` from contracts), never `toLowerCase()` on the whole string. Unicode lowercasing turns `K` (U+212A, the Kelvin sign) into `k` and `İ` into `i̇`, and that would let a look-alike domain match.

A domain entry must match:

```
^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
```

That means ASCII LDH labels, at least two labels, and no `*`, `@`, leading dot, trailing dot or port. Also refused: any `*.invalid` domain.
- An internationalised domain must be written in punycode (`xn--…`). The code never converts between Unicode and punycode.
- Subdomains are separate entries: `mail.darkburn.com` does not match `darkburn.com`. List it explicitly if it is ever needed.

An exception entry must pass `normalizeEmail` (below), and its domain must match the domain rule. A `+clerk_test` entry is refused.

Errors name the variable and the 1-based entry number, never the value. For example: `DRAFTROOM_CREATOR_EMAILS entry 2 is not a valid email address`, `DRAFTROOM_CREATOR_DOMAINS entry 1 is not an ASCII domain (write internationalised domains in punycode, xn--…)`, `DRAFTROOM_CREATOR_DOMAINS lists no domain`.

The startup log shows `{ creators: { domains: [...], exceptions: <count> } }` only. It never shows an address.

**Matching** (the pure functions in creators.ts; tests in §11):
- `normalizeEmail(raw): string | null`: trim, then refuse (null) anything that:
  - contains a character outside `!`..`~` (0x21 to 0x7e), which rules out non-ASCII, spaces and U+FF20 `＠`;
  - is longer than 254 characters;
  - has no `@`, or has an empty local part or domain;
  - contains `+clerk_test` in any ASCII case (`isClerkTestAddress` from contracts).
  Otherwise lowercase ASCII letters and return the result. Every source goes through it: Clerk profiles, dev logins, invitations (after `AccountEmail`), config.
- `emailDomain(email)`: the text after the **last** `@`. So `"a@darkburn.com"@evil.test` → `evil.test`.
- `isCreatorEmail(email, policy, devDomain)`: `domains.includes(domain) || emails.includes(email) || domain === devDomain`, where `devDomain` is `DEV_CREATOR_DOMAIN` under the dev provider, else null. Exact string equality only: no `endsWith`, no subdomains, no suffix matching. `evil-darkburn.com`, `darkburn.com.evil.test`, `darkburn.co` and `darkburn.com.` (trailing dot) all fail. Exceptions compare the whole address. Gmail dots and `+tags` are **not** normalised, so the owner lists the exact address Clerk verified.
- `creatorReason(emails, policy, devDomain)`: `'domain' | 'exception' | 'dev' | null`, in that order of precedence.

**Deploy config.** `render.yaml` is not changed (a Blueprint sync on a push to `main` could otherwise redeploy the api early, §13). The lead sets `DRAFTROOM_CREATOR_EMAILS` on `draftroom-staging-api` in the Render Dashboard; the domain default needs no variable. DEPLOY.md documents both variables.

**.env.example** gets both keys, commented, with an `@example.test` placeholder. No real address may appear in the repo, in tests, in fixtures, in logs or in error messages. Tests use `owner@personal.example.test`, `@client.example.test`, `@dev.invalid`. For the real domains they use fake local parts prefixed `lobby-test-`.

## 3. Identity: which emails count, and where they live

### 3.1 Which Clerk addresses count

Names checked in the installed @clerk/backend 3.20.1 and @clerk/shared 4.36.0 types:
- User.d.ts: `emailAddresses: EmailAddress[]` (includes the primary), `primaryEmailAddressId: string | null`, `banned: boolean`, `locked: boolean`;
- EmailAddress.d.ts: `id`, `emailAddress`, `verification: Verification | null`;
- Verification.d.ts: `status: VerificationStatus` (`'unverified' | 'verified' | 'transferable' | 'failed' | 'expired'`), `strategy: string`;
- UserApi.d.ts:377: `getUser(userId)`;
- errors/clerkApiResponseError.d.ts: `ClerkAPIResponseError` has `status: number` and `errors: ClerkAPIError[]` (`code: string`, `message: string`); `isClerkAPIResponseError(e)`.

An address counts only when `a.verification?.status === 'verified'` **and** `normalizeEmail(a.emailAddress) !== null` (so never a `+clerk_test` one). `'transferable'`, `null` and non-ASCII addresses never count.
- Normalise and dedupe. Put the primary first: `isPrimary = a.id === u.primaryEmailAddressId`. Store at most 20 addresses per user.
- Keep `verification.strategy` when it matches `^[a-z0-9_:.-]{1,100}$`, else store null.
- Also switch the verified check in `features/dashboard/clerk-directory.ts` (~:53) from `toLowerCase()` to `normalizeEmail`, so the email-invite "granted" lookup gets the same rule.

`ClerkProfile` (clerk.ts:36-39) becomes:

```ts
export interface ProfileEmail { email: string; isPrimary: boolean; strategy: string | null }
export interface ClerkProfile {
  name: string
  avatarUrl: string | null
  /** Verified, normalised (normalizeEmail), deduplicated, primary first. Required. */
  emails: readonly ProfileEmail[]
  banned?: boolean // default false
  locked?: boolean // default false
}
```

`ClerkDeps.profile(sub)` rejects with the Clerk error. The user counts as **gone** only when `isClerkAPIResponseError(e) && e.status === 404 && e.errors.some((x) => x.code === 'resource_not_found')`. Every other failure (timeouts, 5xx, 401 from a wrong key, a 404 without that code) is "unavailable". The call uses the same 10 s timeout as clerk-directory.ts. Test fakes supply `emails`.

Every Clerk call in the exchange and the refresh is caught inside the auth code and turned into `IDENTITY_UNAVAILABLE` (or 'gone'/'banned'). None reaches the global 5xx handler, which logs `err.message` (app.ts:171-183), and Clerk messages can quote the address (clerk-directory.ts:78). The failure log is `{ evt: 'identity.refresh_failed', userId, status, code }`: Clerk's HTTP status and first error code only.

### 3.2 Migration `packages/db/migrations/0021_domain_access.sql` (committed in step A)

This is the only schema change for the whole feature, and only the API owner edits it. It is unreleased until the deploy, so it may still change; anyone who applied an earlier version to a local database resets that database (the checksum guard refuses an edited migration). Every new column on an existing table is nullable (older builds' INSERTs keep working; migrations.pg.test.ts:593-601). The file as committed:

- `user_emails (user_id, email, domain, is_primary, source, verification_strategy, seen_at)`, primary key `(user_id, email)`:
  - `email` CHECK: lowercase, printable ASCII only, 3 to 254 characters, `^[^@].*@[^@]+$`, and no `+clerk_test`;
  - `domain` is `GENERATED ALWAYS AS (substring(email from '@([^@]+)$')) STORED`, the text after the last `@`;
  - `source IN ('clerk', 'dev')`; `verification_strategy` is 1 to 100 characters or null;
  - indexes: `user_emails_email_idx (email)`; one primary per user and source (`user_emails_one_primary_idx (user_id, source) WHERE is_primary`).
- `users.identity_checked_at timestamptz` (NULL = never checked: every user who existed before 0021).
- `workspaces.personal_of text REFERENCES users (id)`, unique where not null. Backfill: each user's earliest workspace other than Dev Studio (`wsp_DevStudio00000000000`). Before 0021 only two code paths created workspaces: the personal one (auth/users.ts) and Dev Studio (auth/dev.ts).
- `invitations.invited_email text` with the same CHECK as `user_emails.email`, plus `invitations_invited_email_single_use CHECK (invited_email IS NULL OR NOT multi_use)`.
- D3: `UPDATE invitations SET revoked_at = now() WHERE NOT multi_use AND invited_email IS NULL AND redeemed_by IS NULL AND revoked_at IS NULL AND expires_at > now()`.

The table stores **verified addresses only**, and nothing ever logs them. The migration deletes no membership, grant or workspace.

### 3.3 Writing emails

`replaceUserEmails(tx, userId, source, emails, fetchedAt)`, where `fetchedAt` is `ctx.now()` read **before** the provider call started:
1. `UPDATE users SET identity_checked_at = $fetchedAt WHERE id = $userId AND (identity_checked_at IS NULL OR identity_checked_at < $fetchedAt)`. When it updates no row, a newer snapshot is already stored: stop, write nothing (two sign-ins, or a sign-in and a refresh, racing).
   (Fixer round 1, §19: `<=` as built (§12 item 1); a stored `identity_checked_at` more than `CLOCK_SKEW_TOLERANCE_MS` (60 s) **ahead of this process's clock** never blocks a write, since a process whose clock ran ahead wrote it (a deploy overlap) and its snapshot is not known to be newer; and the **dev login writes unconditionally**, since its address is not a remote snapshot but the one it was just given.)
2. Delete that user's rows for `source`, then insert `emails` with `ON CONFLICT (user_id, email) DO UPDATE` setting `is_primary`, `source`, `verification_strategy` and `seen_at`.

The function is idempotent: the sign-in transaction is retried once on a unique violation (app.ts:259-266).

Writers:
- **Clerk exchange** (clerk.ts:123-168):
  1. `profile.banned || profile.locked` → 403 `ACCOUNT_DISABLED`, before `signIn`, and no session is created. When `banned` and an `identities` row exists for `sub`, every existing session of that account is revoked too (`sessions.revokeAll`, as a refresh that finds 'banned' does; fixer round 1, §19). A `locked` account (a temporary lockout, which anyone's failed sign-in attempts can cause) keeps its sessions.
  2. Profile unavailable on a **first** sign-in (no `identities` row for `sub`) → 503 `IDENTITY_UNAVAILABLE`, and no user is created (D9).
  3. Profile unavailable on a later sign-in → the sign-in succeeds, the stored emails are kept, and `identity_checked_at` is not bumped.
  4. Otherwise `findOrCreateUser` gets `emails` and writes them in the sign-in transaction. A profile whose only addresses are `+clerk_test` ones signs in as an outsider with no stored address.
- **Dev login** (dev.ts): `DevLoginInput.email` (optional, §7) is trusted as verified. Only this dev-guarded route accepts it: DRAFTROOM_DEV_AUTH=1, never NODE_ENV=production (config.ts:295-310, app.ts:94).
  - With an email: the dev emails become `[{ email, isPrimary: true, strategy: null }]`.
  - Without one: `[{ email: '<handle>@dev.invalid', isPrimary: true, strategy: null }]` (D8).
  - Every login replaces the previous dev emails and stamps `identity_checked_at`.
- **Identity refresh** (§3.4).

### 3.4 Creator status and freshness

**Per request.** Creator status is **computed per request** from the stored emails plus the **current** config, so removing an exception or a domain takes effect at the next api restart without anyone signing in again. One SQL helper, used by the session lookup (session.ts:91-101), by every SELECT that feeds `toSessionUser` (users.ts:51-58, 65-68) and by `requireCreator`:

```sql
u.kind, u.identity_checked_at,
(u.kind = 'account' AND u.identity_checked_at >= $cutoff AND EXISTS (
   SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.source = $source
      AND (e.domain = ANY($domains::text[]) OR e.email = ANY($emails::text[])))) AS creator
```

- `$source` is the running provider's name (dev rows never count under Clerk, and the reverse);
- `$domains` is `policy.domains`, plus `dev.invalid` only under the dev provider; `$emails` is `policy.emails`;
- `$cutoff` is `now() - IDENTITY_GRACE_MS` from `ctx.now` (test clocks apply).

So a creator whose addresses are unconfirmed (never checked, or older than 24 h) is **not** a creator until a refresh confirms them.

`SessionUser` gains `kind`, `creator: boolean` and `identityCheckedAt: Date | null`. `sessionUserToUser` (serialize.ts:45) was `({ ...u })`, which would have copied these into `me.user`; **step A already rewrote it** to list the five `User` fields explicitly.

`identity.status(user) → MeAccess` (§7):
- `'guest'` for name-only guests (creator false, email null);
- `'unconfirmed'` (creator false) for an account whose `identityCheckedAt` is NULL or older than `IDENTITY_GRACE_MS`;
- otherwise the reason from §2, or `'outside'` when no stored address qualifies;
- `email` = the primary stored address of the running provider's source, else the first one, else null.

**Refresh.** A new `apps/api/src/auth/identity.ts` exposes `ctx.identity: IdentityService` (added to AppContext). It is backed by a new optional provider method (the same pattern as `revokeProviderSessions`, provider.ts:46):

```ts
// AuthProvider
refreshIdentity?(db: Queryable, userId: string, fetchedAt: Date): Promise<'ok' | 'none' | 'gone' | 'banned' | 'unavailable'>
```

- **Clerk.** For each `identities` row with provider 'clerk' of the user, call `deps.profile(sub)`, then `replaceUserEmails(source 'clerk')`. 404 with `resource_not_found` → `'gone'`. `banned` → `'banned'` (a `locked` account only fails at the exchange). Any other failure → `'unavailable'`. No clerk identity → `'none'`, which stamps `identity_checked_at` (nothing to find).
- **Dev.** Always `'ok'`, never a network call. A user with a dev identity and no dev `user_emails` rows (a local database from before 0021) gets `<handle>@dev.invalid`. It **always** stamps `identity_checked_at`, so dev users never turn 'unconfirmed' under `clock.advance`.

`identity.freshen(req, user, mode)` returns the user to use for the rest of the request:

| mode, caller | Awaits a refresh when the stored data is | If that refresh fails | Starts a background refresh when older than |
|---|---|---|---|
| `'me'`: GET /api/me, GET /api/auth/me, and (fixer round 1) the Share dialog's reads GET /api/boards/:bid/invitations and GET /api/boards/:bid/sharing/members, after their own permission check | never checked, or older than 24 h | keeps the stored data (status says `'unconfirmed'`), still 200 | 1 h |
| `'confirm'`: the creator guard, every guarded route | never checked, or older than 24 h | 503 `IDENTITY_UNAVAILABLE` on `refuse: 'always'` routes; keeps the stored data on `'in-route'` routes | 1 h |
| `'accept'`: accepting a locked invitation | older than 5 min, or never checked | 503 `IDENTITY_UNAVAILABLE`, nothing redeemed | n/a |

- It is a no-op for name-only guests and when the provider has no `refreshIdentity`.
- A stored `identity_checked_at` more than 60 s ahead of this process's clock (a deploy overlap on a host whose clock ran ahead) has an unknown real age: it counts as stale but not unconfirmed (a background refresh; `'accept'` awaits one), and that refresh's write replaces it (§3.3). Fixer round 1, §19.
- One in-flight refresh per user (awaited and background share it). After a failure, no new call for `REFRESH_FAILURE_BACKOFF_MS` (60 s): during that window an awaited refresh counts as failed at once (strict callers answer 503), and a background one is skipped.
- `'gone'` / `'banned'` from the caller's **own** refresh → `sessions.revokeAll(userId)` plus announce. An awaited refresh then throws 401 `NOT_AUTHENTICATED`; a background one simply ends, and the next request is 401. Stored emails are left as they are.
- After an awaited refresh, `freshen` returns `await sessions.reload(req)`: a new SessionStore method that re-runs the lookup and **replaces the per-request cache entry** (session.ts:84-144 caches the user in a WeakMap). `status`, `ensurePersonalWorkspace` and the guard's decision all use the reloaded user. A backfilled creator's first /api/me therefore says `'domain'`, not `'unconfirmed'`.
- After an `'ok'` refresh that finds a creator → `ensurePersonalWorkspace` (§5).
- Background refreshes catch every error, are tracked (`identity.settled()` resolves when none is running; tests await it), and the api's `onClose` waits for them.
- A creator-status change is logged at info level: `{ evt: 'identity.creator_changed', userId, creator, emailDomains }`, with the distinct domains only (at most 5).
- The network call is never made inside a database transaction or while a board or invitation lock is held.

**Target refresh.** `identity.refreshTarget(userId)` is used only where the target's creator status decides the answer (PUT `role: 'owner'`, transfer of ownership, §4.2). It runs **after** the route's own permission pre-check, and only when the target's `identity_checked_at` is NULL or older than 24 h. It never throws, never revokes anything, and ignores every outcome except `'ok'`/`'none'` (which write as usual). The route then decides from stored data: an unconfirmed target counts as not a creator.

| Constant (identity.ts) | Value |
|---|---|
| `IDENTITY_RECHECK_MS` | 1 h |
| `IDENTITY_GRACE_MS` | 24 h |
| `ACCEPT_IDENTITY_MAX_AGE_MS` | 5 min |
| `REFRESH_FAILURE_BACKOFF_MS` | 60 s, per user, in process |

Existing staging users start with `identity_checked_at` NULL. Their first page load after the deploy confirms them (one `getUser` each, awaited once), and they never need to sign in again. Clerk webhooks (`user.updated`, `user.deleted`) remain future work (routes/auth.ts:13-17).

## 4. The creator check

### 4.1 One function

It lives in `apps/api/src/auth/identity.ts`, next to the refresh (creators.ts stays pure), exposed as `ctx.identity.requireCreator`:

```ts
export type CreatorPurpose = 'create' | 'share'
/** Stored status only; no network. Safe inside a transaction. Reads the database, never the request cache. */
requireCreator(q: Queryable, userId: string, purpose: CreatorPurpose, log: { route: string; by: 'guard' | 'route' }): Promise<void>
```

- One query (the §3.4 fragment).
- `kind = 'guest'` → 403 `GUEST_ACCOUNT_REQUIRED` with guard.ts's messages: `CREATE` for 'create', `INVITE` for 'share'. Guests keep their code everywhere.
- Unconfirmed (`identity_checked_at` NULL or older than 24 h) → 503 `IDENTITY_UNAVAILABLE`.
- Not a creator → 403 `CREATOR_REQUIRED` with the purpose's message (§4.3). It logs `{ evt: 'creator.refused', userId, route, by, purpose, reason, emailDomains }`, where `route` is `req.routeOptions.url` (the pattern, never `req.url`: the accept path carries the invitation token). The log carries the user id and domains only, never an address.
- Helpers on the same read: `isCreatorUser(q, userId)` and `creatorsAmong(q, userIds): Set<string>`. Both treat unconfirmed as not a creator.

`packages/permissions` gained (step A) `canCreateContent(creator, role) = creator && canCreateInWorkspace(role)` and `canHandOutAccess(creator, role, status) = creator && can(role, 'manage_access', status)`.

**`canCreateInWorkspace` itself does not change.** It also gates reads: members, the project list, storage and checkpoint preview (workspaces.ts:23,41; storage-routes.ts:57; checkpoint-routes.ts:86-89).

### 4.2 Where it is called

**Root guard.** Add `apps/api/src/features/domain-access/{index.ts,guard.ts}` and register it in `features/index.ts` directly **after** `registerGuests`: root preHandler hooks run in registration order, so guests are refused by the guest guard first. `CREATOR_ROUTES` uses the guest guard's key format (`METHOD pattern`, with HEAD read as GET).
- `refuse: 'always'`: `identity.freshen(req, caller, 'confirm')`, then `requireCreator(db, caller.id, purpose, { by: 'guard' })`.
  - The answer depends only on the caller, never on the id in the URL, so it reveals nothing. Creators still get the routes' own 404 for foreign ids, so tenancy tests are unchanged.
- `refuse: 'in-route'`: the guard only freshens the caller (`'confirm'`, lenient on failure). It never touches the target: target refreshes happen in the route, after its own permission check (§3.4).
- The guard does nothing for unauthenticated requests: the route answers 401.
- A root hook does not reach routes in child scopes created before it (Fastify 5 copies hooks at scope creation: the files plugin, thumbnails, the worker). None of those creates anything today. The in-route checks below are the real control, and the creation-matrix test proves both layers (§11.1).

**In-route checks.** They stay even with the guard, so a renamed route cannot slip past (the reasoning in guard.ts:12-13). They always come after the route's own 404/403 membership checks, and use `by: 'route'`.

| Route (`CREATOR_ROUTES` key) | purpose | guard | In-route check (stored status, inside the existing transaction where there is one) |
|---|---|---|---|
| `POST /api/workspaces/:wid/boards` (new board, every template, sample board, quick "Untitled") | create | always | routes/boards.ts, after `canCreateInWorkspace` (~:89), before `assertBoardRoom` |
| `POST /api/workspaces/:wid/projects` | create | always | routes/workspaces.ts, after ~:54, before the INSERT |
| `PATCH /api/projects/:pid` (D6) | create | always | routes/workspaces.ts at ~:77 |
| `POST /api/workspaces/:wid/boards/import` | create | always | features/history/index.ts: the local `requireCreator` (:85-89) is renamed `requireBoardCreator` and gains `requireCreator(db, user.id, 'create', …)` after the role check. It stays the first check, before the archive is parsed. |
| `POST /api/boards/:bid/duplicate` | create | always | same helper (~:225), before the sync snapshot |
| `POST /api/snapshots/:sid/restore-as-new` | create | always | same helper (~:182), before `captureQuietly` |
| (createBoardFrom's transaction) | create | n/a | features/history/new-board.ts:110-111 re-check (the seed can take a while). "Keep sharing" (:145-154) copies grants of non-creators (`creatorsAmong`) as at most `editor` (D5). |
| (sign-in provisioning) | create | n/a | `findOrCreateUser` creates the personal workspace only for creators (§5) |
| `POST /api/workspaces/:wid/invitations` | share | always | `createInvitation` (routes/invitations.ts), next to the guest check. `role: 'admin'` for an address where `!isCreatorEmail` → 409 `ROLE_REQUIRES_CREATOR` (D5) |
| `POST /api/boards/:bid/invitations` | share | always | `createInvitation` |
| `POST /api/boards/:bid/invitations/email` | share | always | email-invites.ts, after `requireBoardAction(manage_access)`, before the limiter; `createInvitation`; the `grant` transaction |
| `POST /api/boards/:bid/review-links` (review, workshop, client guest links) | share | always | review-links.ts, after the guest check (~:258) |
| `POST /api/boards/:bid/review-links/:id/extend` | share | always | review-links.ts, after `requireBoardAction` |
| `POST /api/access-requests/:id/approve` | share | always | access-requests.ts, approve branch only (deny unchanged) |
| `POST /api/boards/:bid/transfer-ownership` | share | always | sharing.ts: 1) unlocked pre-check: `requireBoardAction(db, …, 'manage_access')` and the target is a workspace member (today's 404s); 2) `refreshTarget`; 3) the transaction as today, plus: a non-creator target → 409 `ROLE_REQUIRES_CREATOR` |
| `PUT /api/boards/:bid/members/:uid` | share | in-route | members.ts. With `role: 'owner'`: the same unlocked pre-check, then `refreshTarget`. In the transaction, after `loadTarget`: `role: 'owner'` for a non-creator target → 409 `ROLE_REQUIRES_CREATOR`, whoever the caller is. A **lowering** (`target.board_grant !== null` and the new role ranks below it) is open to every manager, and so is an unchanged role (a no-op). Anything else (adding a grant, raising, owner) needs a creator caller: unconfirmed → 503, outside → 403 `CREATOR_REQUIRED`. |
| `PATCH /api/boards/:bid` (only when the body has `visibility`) | share | in-route | routes/boards.ts, after the `change_visibility` check: lowering (`workspace_edit` > `workspace_view` > `private`) is open; raising needs a creator caller (503 / 403 as above). |
| `GET /api/boards/:bid/invitations` | n/a | none | review-links.ts (~:227-231): for a caller who is not a creator (stored status), multi-use links come back with `url: null`. Everything else unchanged. Fixer round 1 (§19): after `requireBoardAction(manage_access)` the route calls `identity.freshen(req, user, 'me')`, as does `GET /api/boards/:bid/sharing/members`, so a manager who never loads /api/me is confirmed when unconfirmed and refreshed in the background after 1 h; the decision reads the database, so an awaited refresh counts at once. |

These stay open to non-creators with the role they already have:
- `DELETE /api/invitations/:id`, `POST …/review-links/:id/revoke`;
- `GET /api/boards/:bid/invitations` (with `url: null`, above), `GET …/sharing/members`, `GET …/access-requests`, `POST /api/access-requests/:id/deny`;
- `DELETE …/members/:uid` (a creator's grant included; the last-owner rule applies);
- `POST /api/boards/:bid/access-requests` (outsiders asking in);
- archive, trash and restore; `PATCH` title or projectId; "Recently deleted" restore; checkpoints (`POST /api/boards/:bid/snapshots` saves a checkpoint; it creates no board);
- `PUT /api/boards/:bid/export-policy`, board and workspace AI settings (board settings, not access; §15);
- AI, comments, workshops and presentations.

The sync server needs no change: its only creation-like route, `/internal/boards/:bid/seed`, writes canvas storage and never a `boards` row, and its only caller is `createBoardFrom`.

### 4.3 Error codes and messages

The codes and messages are exported from contracts (`DOMAIN_ACCESS_CODES`, `DOMAIN_ACCESS_MESSAGES`, `invitationEmailMismatchMessage`, §7), so the api sends exactly these and the web can switch on the codes. The web shows the server's message as it is.

| Code | Status | Message |
|---|---|---|
| `CREATOR_REQUIRED` (create) | 403 | Only people at Dark Burn Creative or Trailer Park Group can create workspaces, projects and boards in Lobby. If you work there, sign in with your work email. Otherwise, ask the person who invited you. |
| `CREATOR_REQUIRED` (share) | 403 | Only people at Dark Burn Creative or Trailer Park Group can invite people, create links or give more access in Lobby. You can still lower or remove access. |
| `ROLE_REQUIRES_CREATOR` | 409 | Only people at Dark Burn Creative or Trailer Park Group can own boards or be workspace admins in Lobby. Choose a different role for this person. |
| `INVITATION_EMAIL_MISMATCH` | 403 | This invitation is for {hint}. Sign in with that email address to accept it. (body §7) |
| `IDENTITY_UNAVAILABLE` | 503 | Lobby couldn’t confirm your email address with the sign-in service. Try again in a minute. |
| `ACCOUNT_DISABLED` | 403 | This account can’t sign in to Lobby. Contact the person who runs Lobby at Dark Burn Creative. |
| (validation, 400) | 400 | `AccountEmail` messages; a `+clerk_test` address: "Lobby doesn’t accept Clerk test addresses (+clerk_test)." |

### 4.4 Audit and logs

- Refusals are **logged, not audited**. `audit_events` needs a workspace and is written in the transaction of the change it describes, and a refusal changes nothing. Log fields: `userId`, `route` (the pattern), `by`, `purpose`, `reason`, `emailDomains`.
- `invitation.create` detail gains `emailLocked: true` and `emailDomain`. `invitation.accept` gains `emailLocked: true`. Never the address; for correlation use the keyed `emailRef` from email-invites.ts:53-58.
- A mismatch at accept is logged: `{ evt: 'invitation.email_mismatch', userId, invitationId, invitedDomain, callerDomains }`.
- No new `AuditAction`.
- Nothing logs: addresses, the exceptions list, the masked hint, Clerk payloads or Clerk error messages, `req.url` of the accept route.

## 5. Personal workspace and Dev Studio

- `findOrCreateUser` (users.ts:40-89):
  - `IdentityInput` gains `emails: readonly ProfileEmail[]`, `source` and `fetchedAt`.
  - Writes the emails (§3.3), then computes creator from them and `ctx.config.creators`.
  - Runs `ensurePersonalWorkspace` only when the user is a creator.
  - Lines 77-87 move into `ensurePersonalWorkspace(tx, userId, name, now)`. It inserts the workspace with `personal_of = userId` (`ON CONFLICT (personal_of) WHERE personal_of IS NOT NULL DO NOTHING`) plus the owner membership. It is a no-op when one already exists.
- `ensurePersonalWorkspace` also runs:
  - at every sign-in of a creator;
  - after an `'ok'` refresh that finds a creator;
  - in GET /api/me and GET /api/auth/me for a creator (a single indexed EXISTS when the workspace is already there).
  An account made a creator by an exception or a new company address therefore gets its workspace on its next page load (D10).
- A non-creator never gets a personal workspace. **An existing personal workspace of a non-creator is kept, with its owner membership** (decision 4). Losing creator status never removes a membership, a grant or ownership.
- Dev Studio (dev.ts:15-29, 51): `joinDevStudio` runs only when the new dev user is a creator. That covers every handle-only login and dev emails at creator domains. Outside dev users do not join, not even as guests.
- The api test helper still finds the personal workspace by name suffix (helpers.ts:113). It may switch to `personal_of`, but does not have to.

## 6. Invitations and sharing

### 6.1 The lock

- **Creating.** `createInvitation(tx, ctx, { …, email })` requires `email`, already passed through `AccountEmail` (§7). It is stored in `invitations.invited_email`, and `INVITATION_COLUMNS` / `InvitationRow` gain it.
  - All three single-use routes pass it: board, workspace, and the email route's `newInvitation`.
  - The email route's `emailed`, `existing_account`, `email_not_configured`, `invalid_email`, `rate_limited` and `provider_error` links are therefore all locked to the address.
  - The `granted` path (an existing Lobby user whose Clerk address is verified) is unchanged apart from the creator check.
- **Workspace invitations**: `role: 'admin'` for an address where `!isCreatorEmail` → 409 `ROLE_REQUIRES_CREATOR` (D5). `member` and `guest` are allowed for anyone.
- **State.** `stateFor` (invitations.ts:80-84), after the `redeemed_by` branch: `!inv.multi_use && inv.invited_email === null` → `'gone'` (D3). The preview therefore also answers 410 through `sendGone`. Guest join checks `multi_use` before `stateFor` (features/guests/join.ts:84-87), so guests never reach this branch.
- **Accept** (`POST /api/invitations/:token/accept`, invitations.ts:308-340):
  1. `requireUser`, `perUser.take`, token check (unchanged).
  2. **Before any transaction**, an unlocked read: `SELECT invited_email FROM invitations WHERE token_hash = $1`. When it is set, `identity.freshen(req, user, 'accept')` (503 `IDENTITY_UNAVAILABLE` with nothing redeemed). Then load the caller's stored addresses (running provider's source) into a Set. No network call ever happens while the board or invitation lock is held (the lock order in access.ts and `lockInvitation`).
  3. Inside the transaction:
     - `lockInvitation` → the existing guest check (name-only guests get `GUEST_ACCOUNT_REQUIRED`, as today);
     - `state === 'gone'` → 410 (no hint);
     - `'redeemed_by_caller'` → no-op;
     - `'usable'`: if `inv.invited_email !== null` and the Set does not contain it → mismatch. The transaction returns a marker, and the route answers `reply.code(403).send(InvitationEmailMismatchBody)`, the way `sendGone` answers. Nothing is redeemed, and the link stays usable for the invitee.
     - A workspace invitation with `role` admin/owner while the caller is not a creator → 409 `ROLE_REQUIRES_CREATOR` (the exceptions may have changed since it was created).
     - Then `redeemInvitation` (unchanged).
  4. Mismatched tries count against `acceptPerUser` (30 a minute), as today.
- **Matching** is exact equality on the normalised address (case-insensitive through ASCII lowercasing). Any verified address of the caller counts (D1). A Clerk invitation sign-up verifies the invited address, so the invitee's new account matches right after the exchange.
- **Preview** (`GET /api/invitations/:token`) adds:
  - `emailLocked`;
  - `invitedEmailHint`, the masked address, for usable locked links only;
  - `matchesYou`: true or false for a signed-in account, from its stored addresses (no Clerk call here: accept re-checks with fresh data); null when signed out, for guests and for unlocked links;
  - `sentByYou` (fixer round 1, §19): true when the signed-in caller created this locked invitation (an inviter opening their own link to check it), else false. The page then says whom the link is for instead of "ask {inviter} to invite {you}".

  The mask is the first character of the local part, then `•••@`, then the domain: `jane.doe@client.com` → `j•••@client.com`. `maskEmail` lives in the api only. The full address is returned to others in exactly one response, the manager-only `GET /api/boards/:bid/invitations` (`PendingInvitation.email`); besides that, `POST /api/boards/:bid/invitations/email` echoes it back (`EmailInviteResult.email`) only to the creator who just typed it (wording corrected in fixer round 1, §19).

### 6.2 Existing links

- Unbound single-use links that are still open are revoked by 0021 (D3). Their holders see the existing 410 "ask {inviter} for a new link", and inviters send a new one.
- Multi-use review, workshop and name-only guest links are untouched (the new CHECK keeps `invited_email` NULL on them). Links an outsider created before the deploy stay valid until they expire (at most 30 days) or are revoked; §13 has an optional check for them.
- Redeemed links, and the memberships they created, stay.

### 6.3 Non-creators and role limits

This restates D4/D5 as enforced in §4.2:
- non-creators create no invitation, review, workshop or guest link, and transfer no ownership;
- they extend nothing, approve nothing, and raise no role or visibility;
- they may revoke, remove, lower and deny, a creator's grant included;
- they get `url: null` for existing multi-use links;
- nobody makes a non-creator a board owner or workspace admin, and a duplicate never copies one in as owner;
- existing outsider owners and admins keep their roles (the last-owner rule is unchanged).

## 7. Shared contracts (step A, committed)

New file **`packages/contracts/src/domain-access.ts`**. It imports only `zod`, so `index.ts` and `dashboard.ts` can import it without an import cycle. It exports:
- `ACCOUNT_EMAIL_MAX_LENGTH` (254), `CLERK_TEST_SUBADDRESS` (`'+clerk_test'`), `asciiLowercase`, `isClerkTestAddress`, `CLERK_TEST_ADDRESS_MESSAGE`;
- `AccountEmail`: trim → `min(1)` "Enter an email address." → `max(254)` "That email address is too long." → printable ASCII only "Enter a valid email address." → no `+clerk_test` → ASCII-lowercase → `z.email('Enter a valid email address.')`;
- `CreatorReason = z.enum(['domain', 'exception', 'dev', 'outside', 'guest', 'unconfirmed', 'legacy'])`;
- `MeAccess = { creator: boolean, reason: CreatorReason, email: string | null }` (`email`: the caller's own primary verified address, else their first verified one, else null);
- `ME_ACCESS_LEGACY = { creator: true, reason: 'legacy', email: null }` (D11);
- `DOMAIN_ACCESS_CODES`, `DomainAccessCode`, `DOMAIN_ACCESS_MESSAGES`, `invitationEmailMismatchMessage(hint)` (§4.3);
- `InvitationEmailLock = { emailLocked: default false, invitedEmailHint: string | null default null, matchesYou: boolean | null default null, sentByYou: boolean default false }` (`sentByYou` added in fixer round 1, §19);
- `InvitationEmailMismatchBody = { error: { code: 'INVITATION_EMAIL_MISMATCH', message }, mismatch: { invitedEmailHint: string, invitedBy: { name } | null } }`.

Edits to **`packages/contracts/src/index.ts`** (it also `export * from './domain-access.ts'`):
- `DevLoginInput` gains `email: AccountEmail.optional()`;
- `Me` gains `access: MeAccess.default(ME_ACCESS_LEGACY)`. The inferred output type makes `access` required, so typecheck forces every api place that builds a `Me` to set it;
- `CreateWorkspaceInvitationInput` and `CreateBoardInvitationInput` gain `email: AccountEmail.optional()`. **Step B2 makes it required** (with the api fixture updates, §11.3); the web always sends it;
- `User` does **not** change.

Edits to **`packages/contracts/src/dashboard.ts`**:
- `InviteEmail = AccountEmail` (same messages; now ASCII-only and without `+clerk_test`). `INVITE_EMAIL_MAX_LENGTH` stays and equals 254.
- `PendingInvitation` gains `email: z.string().nullable().default(null)`: the full invited address, for `kind: 'invite'` only, and only from the manager-only list.
- `ShareMember` gains `canOwn: z.boolean().default(true)`: false when that member is confirmed not a creator. An older api keeps offering owner, and its server allows it.

**Step-A placeholders in apps/api** (typecheck needs them; each is replaced by B1/B2 and none may remain afterwards, §14):
- routes/auth.ts (both /api/me routes) and app.ts (the signIn response) send `access: ME_ACCESS_LEGACY`: this build enforces no creator rule yet, which is exactly what 'legacy' means;
- review-links.ts sends `PendingInvitation.email: null`; sharing.ts sends `ShareMember.canOwn: true`.

Step A also added `canCreateContent` / `canHandOutAccess` to `packages/permissions` and `access` to the web's `makeMe()` fixture (apps/web/src/api/test-fixtures.ts), so the web compiles and its tests pass against the contracts as committed.

Tests committed in step A: `packages/contracts/src/domain-access.test.ts` (AccountEmail: case, trim, U+212A, U+FF20, Cyrillic, `İ`, `+clerk_test` in any case, 255 characters; `DevLoginInput.email`; the invitation inputs; the `Me.access` default; the `InvitationEmailLock` defaults; the mismatch body; `PendingInvitation.email` and `ShareMember.canOwn` defaults) and the permissions predicates.

Once B2 makes `email` required, the old web (which sends `{ role }`) gets 400 on its "one-time invite link" button until the new web is deployed. The deploy order (api, then sync, then web) keeps that gap to minutes.

### 7.1 HTTP changes at a glance

| Route | Change |
|---|---|
| `POST /api/auth/dev/login` | body gains optional `email` |
| `POST /api/auth/clerk/session` | new 403 `ACCOUNT_DISABLED`; 503 `IDENTITY_UNAVAILABLE` (first sign-in only); response `Me.access` |
| `GET /api/me`, `GET /api/auth/me`, sign-in responses | `access: MeAccess`; refresh per §3.4; ensure personal workspace |
| every `CREATOR_ROUTES` `always` route | 403 `CREATOR_REQUIRED` (guests keep `GUEST_ACCOUNT_REQUIRED`); 503 `IDENTITY_UNAVAILABLE` when unconfirmed |
| `POST /api/boards/:bid/invitations`, `POST /api/workspaces/:wid/invitations` | `email` (required from B2); workspace `admin` for an outside address → 409 |
| any body with an address | 400 for non-ASCII and `+clerk_test` addresses |
| `GET /api/invitations/:token` | + `InvitationEmailLock`; unbound single-use → 410 |
| `POST /api/invitations/:token/accept` | 403 `INVITATION_EMAIL_MISMATCH` (body above); 503; 409 |
| `GET /api/boards/:bid/invitations` | `PendingInvitation.email`; `url: null` for non-creator callers |
| `GET /api/boards/:bid/sharing/members` | `ShareMember.canOwn` (`creatorsAmong`, one query; true while a member was never checked, since the server decides at PUT) |
| `PUT …/members/:uid` | 409 `ROLE_REQUIRES_CREATOR`; a non-creator may only lower |
| `POST …/transfer-ownership` | creator callers only (403); 409 `ROLE_REQUIRES_CREATOR` for a non-creator target |
| `PATCH /api/boards/:bid` `visibility` | a non-creator may only lower it |
| `POST /api/boards/:bid/duplicate` with "keep sharing" | non-creators' copied grants are at most editor |

## 8. API: what /api/me says

- `/api/me` and `/api/auth/me` (routes/auth.ts:37-51): `user = await identity.freshen(req, user, 'me')`, then `ensurePersonalWorkspace` when that user is a creator, then `{ user, workspaces, kind, access: await identity.status(user) }`. An awaited refresh that finds the account gone or banned answers 401, and the web shows sign-in.
- The signIn response (app.ts:270) sets `access` from inside the sign-in transaction. It uses stored data only, which the provisioning step has just written.
- `/api/me` never fails because Clerk is down, and awaits Clerk only when the stored data is unconfirmed (at most once a day per user in normal use).

## 9. Web (WEB owner)

Everything reads `useMe().access`. The server stays authoritative, so the UI only hides or disables what the server refuses. The web copies of the predicates come from `apps/web/src/lib/permissions.ts` (add `canCreateContent`, `canHandOutAccess` to its re-exports). `reason: 'legacy'` (an older api) behaves exactly as today.

**Dashboard** (`dashboard/DashboardPage.tsx`, `dashboard/model.ts`, `Sidebar.tsx`)
- Split the one flag (:102) in two:
  - `canCreate = canCreateContent(me.access.creator, role)`;
  - `inWorkspace = canCreateInWorkspace(role)`.
- `canCreate` drives:
  - `showCreate` (Import, Templates, New board, :561-611);
  - quick new board (:330-350) and `onImportFile`;
  - `emptyState.offerCreate` (Create a board, `SampleBoardButton`);
  - `CreateBoardDialog`;
  - the card menu's "Duplicate…" (`menu.canCreate`).
- `inWorkspace` keeps driving:
  - the project list load (:147);
  - "Move to project…" (`menu.canMove`);
  - the sidebar's project list and `StorageLine`.
- `Sidebar` gets three props instead of `canManageProjects`:
  - `canSeeProjects` (the list and the storage line);
  - `canCreateProjects` ("New project lobby" `create-project`, `NewProjectForm`);
  - `canRenameProjects` (D6), which equals `canCreate`.
- `emptyState` (model.ts:168-210) gets an outside-member variant: "Boards shared with you appear here. Only people at Dark Burn Creative or Trailer Park Group can create boards. Work there? Sign in with your work email." The guest copy is unchanged.
- `reason: 'unconfirmed'` with workspaces: a notice (`access-unconfirmed`): "Lobby couldn't confirm your account, so creating and sharing are paused." plus a Reload button.
- (Fixer round 1, §19) `reason: 'outside'` in a workspace whose role would let it create (owner, admin, member; `showOutsideNotice`), outside Trash and Archived: a notice (`access-outside`): "Only people at Dark Burn Creative or Trailer Park Group can create boards, projects and links in Lobby." / "You can open and work on the boards shared with you. Work there? Sign in with your work email." Without it, an existing account that lost creator status (the owner's personal account while `DRAFTROOM_CREATOR_EMAILS` is unset included) saw New board, Import, Templates and "New project lobby" vanish from its own workspace with no reason. While the notice shows, the outside empty state says only "Boards shared with you appear here." (no repeat). Workspace guests keep the empty-state copy above.

**Landing with nothing shared** (`App.tsx` RootRedirect, `no-workspace`). Add `data-reason`:
- `outside`: title "Nothing has been shared with you yet". Body: "You're signed in as {access.email}." (without an address: "You're signed in with an account that has no confirmed email address.") "When someone at Dark Burn Creative or Trailer Park Group invites this address, open the invite link they send you. Work there? Sign in with your work email." (Fixer round 1: was "open the link in their email", but under D13 "Invite people" and "Link for one person" send no email.) Action: "Sign in with a different account" (`signOut`).
- `unconfirmed`: "We couldn't confirm your account" plus a Reload button.
- `none` (a creator with no workspace, which should not happen): today's copy.

**Board page History** (`features/history/model.ts` `historyPermissions`, `HistoryPanel.tsx`)
- `historyPermissions` takes the creator flag through an options object. The one production caller passes `me.access.creator`.
- `canCreateBoards` requires it, so for non-creators "Duplicate board" and "Restore as new board" are `hidden`.
- The checkpoint preview gate (checkpoints-model.ts:96-98) stays role-based.
- (Fixer round 1, §19) The line under "Checkpoints" (`checkpoints-hint`, `checkpointsHint`) promises "Restoring one makes a new board…" only when "Restore as new board" is offered (or shown turned off). Otherwise: "A checkpoint keeps this board as it is now.", plus "Only people at Dark Burn Creative or Trailer Park Group can restore one as a new board." for `outside`, or "Restoring one as a new board is paused until Lobby can confirm your account." for `unconfirmed`.

**Share dialog** (`board/ShareDialog.tsx`, `board/share-model.ts`, `features/sharing/api.ts`, `api/client.ts`)
- `canShare = canHandOutAccess(me.access.creator, role, status)`.
- For a non-creator manager (`canManage && !canShare`):
  - hide `InvitePeople` (with `AddMember`), `EmailInvite`, `InviteLinkSection`, the transfer-ownership control, and the create controls of `MoreWaysToShare` / `ClientLinkSection` / `WorkshopLinksSection` / `WorkshopShortcut` / `GuestsOption`;
  - hide `ReviewLinkRow`'s Extend and copy-link (the url is null; keep Revoke) and `AccessRequestRow`'s Approve (keep Deny);
  - `VisibilitySection`: options above the current one are disabled;
  - `MemberRow`'s role menu offers only roles below the current direct grant, plus Remove;
  - show a note (`share-creator-note`) with `DOMAIN_ACCESS_MESSAGES.creatorRequiredShare`. (Fixer round 1, §19: for `reason: 'unconfirmed'` the note, `data-reason="unconfirmed"`, says instead "Lobby couldn't confirm your account, so inviting people, creating links and giving more access are paused. You can still lower or remove access. Reload in a minute to try again.", so a Dark Burn person Lobby could not confirm is never told they are not at Dark Burn; `data-reason="outside"` otherwise.)
  - the Export and download section leaves out "Creating a client link turns this off…" (`clientLinkWillLimit` takes `canCreateLinks`), since this manager cannot create client links (fixer round 1).
- For creators:
  - `api.createBoardInvitation(boardId, { role, email })` replaces `(boardId, role)` (client.ts:252), at both callers.
  - `InvitePeople` with an email target makes a locked link through it (:487, D13), not through the email route. Its result copy: "Only {email} can use this link, once, until {date}. Anyone else who opens it is turned away."
  - An unknown name (neither an email nor a known @handle) asks "Enter their email address to invite them" instead of making a link (:575).
  - `InviteLinkSection` becomes "Link for one person": a required email field (`one-person-link-email`) plus a role, with the same copy.
  - Pending rows (:1366-1392) read "For {email} · {role} · expires …" (no email: today's row).
  - The owner option (and the transfer-ownership target) is disabled for members with `canOwn === false`. Its tooltip: "Only people at Dark Burn Creative or Trailer Park Group can own boards". (Fixer round 1, §19: a disabled option in a native select popup shows no tooltip and a disabled button takes no focus, so the reason is also shown as text, `member-owner-note`, tied to the select and the transfer button with `aria-describedby`.) (Fixer round 2, §20: the note is shown **once**, under "People with access", when any row the caller can edit has Owner off for this reason (`listShowsOwnerNote`); it reads "Only people at Dark Burn Creative or Trailer Park Group can own boards, so Owner is turned off for everyone else here." The select and transfer button of each such row (`rowNeedsOwnerNote`) point to it with `aria-describedby`; a creator's row does not. On every row it repeated down a list of client reviewers, and at 390 px grew each of their rows from 47 to about 209 px.)
  - (Fixer round 1) "Or pick someone from the workspace…" (`AddMember`) offers Can edit, Can comment and Can view, never Owner, like "Invite people": `WorkspaceMember` carries no `canOwn`, so Owner would be offered to outsiders and refused with 409 after Add. Ownership is set on the person's row, which knows `canOwn`.
- Update the copy helpers `emailInviteHint`, `linkForEmailHint` and `emailInviteOutcome` to say the link works only for that address.
- `CREATOR_REQUIRED` and `ROLE_REQUIRES_CREATOR` errors show the server's message.

**Invite page** (`invite/InvitePage.tsx`, `invite/model.ts`, `invite/guest.tsx`, `auth/SignInPage.tsx` + `auth/model.ts` `signInHeading`)
- The preview schema becomes `InvitationPreview.extend(InvitationGuestAccess.shape).extend(InvitationEmailLock.shape)`. It is defined in `invite/guest.tsx` (`GuestAwarePreview`); that one line may change (§10).
- The web's `ApiError` keeps no response body (api/client.ts:37-50), so every hint comes from the preview, never from the 403 body. On a 403 `INVITATION_EMAIL_MISMATCH` the page shows the mismatch state with the preview it already has.
- States (testids in brackets):
  1. Signed out, `emailLocked`: the facts list adds "For {hint}" (`invite-locked-hint`). The primary action reads "Sign in or create an account with {hint}", and the sign-in page heading repeats the hint.
  2. Signed in, `matchesYou === true`: today's Accept, including the PRI-16 auto-accept after sign-in.
  3. Signed in, `matchesYou === false`, or accept answers 403 `INVITATION_EMAIL_MISMATCH` (`invite-email-mismatch`):
     - it says "This invitation was sent to {hint}. You're signed in as {access.email}. Sign in with the invited address, or ask {invitedBy} to invite {access.email}." Fallbacks: without `access.email`, "You're signed in with a different account" and "ask {invitedBy} for a new invitation"; without `invitedBy`, "the person who invited you";
     - one action: "Sign in with a different account" (`invite-mismatch-switch`: `rememberAcceptIntent` plus `signOut({ returnTo })`, as at :160-179). There is no "Check again": Lobby has no account-management UI, so nothing the person does in Lobby can change the answer;
     - **No auto-accept on this state.** The intent is consumed once (`takeAcceptIntent`), so it can never loop. The full address is never shown.
     - (Fixer round 1, §19) When the preview says `sentByYou` (the inviter opening their own link to check it): "This is the invitation you sent" / "Only {hint} can use this link. It won't let you in as {access.email}. Send it to them: they sign in with that address to join." (without `access.email` the middle sentence is left out). It never says "ask {invitedBy} to invite {you}".
     - (Fixer round 2, §20) On that `sentByYou` state the whole page is about the inviter's own invitation, and nothing on it signs them out:
       - the eyebrow reads "Your invitation to a board" (or "… to a workspace"), never "{invitedBy} invited you…"; the title is the board title in quotes (or the workspace name), without "Join"; "Invited by" shows "{name} (you)"; the role fact is headed "Their role";
       - the block is `role="status"` (not `alert`) with `data-sent-by-you`, in the accent colours rather than the warning ones;
       - its one action is a link back to what was shared (`invite-own-back`): "Back to the board" (`/b/{board.id}`) or "Go to the workspace" (`/w/{workspace.id}`). There is no `invite-mismatch-switch` and no accept intent is stored. An inviter who really wants to use another account signs out from Lobby as usual.
     - (Fixer round 2, §20) When accept answers 403 `INVITATION_EMAIL_MISMATCH`, the page re-reads the session (`refresh()`, GET /api/auth/me) before it shows this state: accept checked the account with the sign-in service and the api stored the addresses it found, so the session's `access.email` (which the preview matched, possibly the invited address itself) is out of date.
  4. Accept answers 503 `IDENTITY_UNAVAILABLE`: "Couldn't confirm your email right now", with a retry.
  5. Accept answers 409 `ROLE_REQUIRES_CREATOR`: the server message.
  6. Gone (410) and guest links (`allowGuests`): unchanged.

**Sign-in**
- `ClerkSignIn.tsx` maps `ACCOUNT_DISABLED` and `IDENTITY_UNAVAILABLE` from the exchange to their messages, with a retry for the 503. (Fixer round 2, §20: the markup after Clerk's form lives in `auth/ExchangeStatus.tsx`, free of Clerk hooks, so a unit test renders it.)
- The dev form (`SignInPage.tsx` ~:213-260, dev builds only) gains an optional "Email (dev only)" field (`dev-login-email`), sent only when it is filled in.

## 10. Name-only guest links: unchanged

Must not change (behaviour or code, apart from what is listed as allowed below):
- `apps/api/src/features/guests/**`: `join.ts`, `limits.ts`, `link-caps.ts`, `sweep.ts`, revocation, and `guard.ts`'s `GUEST_REFUSED_ROUTES`, messages and `checkGuestTarget`;
- the multi-use branch of `redeemInvitation`, and `assertGuestRoomOnLink`;
- the `allowGuests` logic in review-links.ts;
- guest session lifetimes;
- `InvitationGuestAccess`, `MeKind`, `GuestJoined`;
- on the web, `joinAsGuest`, the `kind` fetch, `GuestJoinForm`, `GuestEndedScreen`, `GuestNoAccessScreen`, and `ClientLinkSection`'s guest options for creators.

The only guest-adjacent changes allowed:
- a `requireCreator` call placed after the guest check in review-links create;
- `requireCreator` answering guests with `GUEST_ACCOUNT_REQUIRED`;
- `InvitationEmailLock` defaults (false/null) on guest-link previews;
- in `apps/web/src/invite/guest.tsx`, only the `GuestAwarePreview` schema line (it adds `.extend(InvitationEmailLock.shape)`);
- in guest api tests, only the **fixture bodies** of single-use invitations, which gain an `email` (§11.3). No guest expectation changes.

Proof: with only those fixture edits, these pass:
- api: `features/guests/{join,hardening,followups,revocation}.test.ts` and `refusals.test.ts`;
- e2e, unmodified: `guests.spec.ts`, `guests-2.spec.ts`, `client-defaults.spec.ts`, `workshop-copy.spec.ts`, `present-live.spec.ts`, `notify-comments.spec.ts`.

## 11. Tests

The policy is always on. Tests exercise it by:
- giving dev logins an outside email: `api.login(handle, name?, { email? })`, and `signInWith(…, { email })` in e2e;
- setting `DRAFTROOM_CREATOR_EMAILS` / `DRAFTROOM_CREATOR_DOMAINS` through `createTestApi({ env })`, or `test.use({ apiEnv })` in e2e (the stack strips the shell's DRAFTROOM_*, stack.ts:177-201);
- using the Clerk fakes (`deps` on the Clerk provider), whose errors mimic `ClerkAPIResponseError` (`status`, `errors[].code`).

Invitation tests address handle-only users as `<handle>@dev.invalid`. Export a `devEmail(handle)` helper from `apps/api/test/helpers.ts`.

### 11.1 New api tests (API owner): `apps/api/test/features/domain-access/`

- **`policy.test.ts`**, pure and table-driven:
  - exact matches for `darkburn.com` and `trailerparkgroup.com`;
  - upper case and surrounding spaces normalise;
  - refused: `sub.darkburn.com`, `evil-darkburn.com`, `darkburn.com.evil.test`, `darkburn.co`, `darkburn.com.`, `"x@darkburn.com"@evil.test`, `a@b@evil.test`;
  - refused look-alikes: Kelvin sign `darKburn.com`, Cyrillic `а`, fullwidth `＠`, `İ`, a punycode look-alike `xn--…`;
  - refused: `anyone+clerk_test@darkburn.com`, `Anyone+CLERK_TEST@darkburn.com`, and a `+clerk_test` exception entry;
  - exceptions are exact: `owner+x@…` ≠ `owner@…`;
  - the dev domain only counts under the dev provider;
  - `parseCreatorPolicy` errors name the variable and the entry index, and never contain the value.
- **`config.test.ts`** additions:
  - defaults;
  - the override;
  - blank means the default;
  - an empty list after parsing is an error;
  - `*.invalid` refused;
  - more than 50 exceptions refused;
  - production without the variables still starts.
- **`sign-in.test.ts`**:
  - dev without an email → creator ('dev'), a personal workspace and Dev Studio;
  - dev `@client.example.test` → outsider: no workspace, no Dev Studio, `me.workspaces == []`, `access.reason 'outside'`;
  - dev `lobby-test-a@darkburn.com` and `@trailerparkgroup.com` → 'domain';
  - dev `x+clerk_test@darkburn.com` → 400;
  - an exception via env → 'exception';
  - the api never sends `reason: 'legacy'`;
  - Clerk fakes:
    - a verified secondary address counts;
    - unverified, `transferable` and `null` verification never count;
    - a verified `anyone+clerk_test@darkburn.com` never counts (outsider, `access.email` null);
    - banned or locked → 403 `ACCOUNT_DISABLED` with no session;
    - a first sign-in whose profile rejects → 503 with no users row;
    - a later sign-in whose profile rejects keeps the stored status and leaves `identity_checked_at` unchanged;
    - the stored `verification_strategy`;
  - a concurrent first sign-in by a creator → exactly one personal workspace.
- **`refresh.test.ts`** (Clerk fakes with call counts, `clock.advance`, `identity.settled()`):
  - NULL `identity_checked_at` → one awaited call on /api/me, and that response already says `'domain'` (the reloaded user, not the cached one);
  - within 1 h → no call;
  - between 1 h and 24 h → /api/me answers from stored data, then exactly one background call;
  - after 24 h → an awaited call;
  - single flight: parallel /api/me calls make one fake call;
  - 404 with `resource_not_found` → every session revoked and the next request 401; a 404 with another code, a 401 or a timeout → no revocation ('unavailable');
  - banned → revoked;
  - unavailable while confirmed (under 24 h) → stored status;
  - unavailable while unconfirmed → /api/me 200 with `'unconfirmed'`, create routes 503; within the 60 s backoff the 503 comes without a fake call;
  - an older snapshot never overwrites a newer one (two refreshes resolving out of order);
  - a failing Clerk call logs no error message and no address;
  - an exception added (env) for an existing outsider → creator plus a personal workspace on the next /api/me;
  - an exception removed → outsider after the api is re-created, with every membership kept;
  - the dev provider: after `clock.advance` of 25 h, dev users are still creators (the dev refresh stamps).
- **`creation-matrix.test.ts`**:
  - for every `CREATOR_ROUTES` entry with `refuse: 'always'`, an outsider who is a workspace **member** (and a board owner via a direct DB grant) gets 403 `CREATOR_REQUIRED`, and the refusal log says `by: 'guard'` (the hook reaches every route);
  - the same run with the guard switched off (`createTestApi({ domainAccessGuard: false })`, a test-only seam) still gets 403 on every entry, with `by: 'route'` (the in-route checks alone hold);
  - nothing is created: row counts of boards, projects, workspaces, invitations and snapshots, `board.create` audit rows, and no sync seed or snapshot call on the fake;
  - the same 403 comes back for a nonexistent id (uniform);
  - a creator gets 201/200 on the same calls;
  - tenancy is unchanged: a creator gets 404 on foreign ids;
  - name-only guests still get `GUEST_ACCOUNT_REQUIRED`;
  - completeness: every key in `CREATOR_ROUTES` is a registered route (`app.hasRoute`);
  - **source tripwire** over `apps/api/src/**`, with a regex that tolerates newlines, `AS` aliases, double-quoted and schema-qualified names (`public.boards`, `"boards"`):
    - `INSERT INTO` `workspaces|projects|boards|invitations|board_members|workspace_members`;
    - `UPDATE invitations … SET … role|expires_at`, `UPDATE boards … SET … visibility`, `UPDATE board_members|workspace_members … SET … role`.
    Each pattern has an allowed-file list, built from a grep at the start of B2 and reviewed entry by entry (each is gated, is a lowering path, or is sign-in provisioning). A new site fails this test until it is gated and listed.
- **`sharing-rules.test.ts`**:
  - a non-creator's PUT lowering a grant → 200 (a creator's grant included); raising a grant or adding one → 403;
  - `owner` for an outsider target → 409, even from a creator;
  - transfer to an outsider → 409, to a creator → 200; transfer by a non-creator owner → 403;
  - PUT `owner` for a never-checked target refreshes it once; a failing or 404 target refresh neither revokes the target nor signs the caller out (the caller gets the 409 from stored data);
  - a non-creator lowering visibility → 200, raising it → 403;
  - revoke → 204, extend → 403, approve → 403, deny → 200;
  - `GET …/invitations`: `url` null for a non-creator manager, set for a creator;
  - "Duplicate, keep sharing" from a board an outsider owns → the outsider is editor on the copy; creators keep their roles;
  - `ShareMember.canOwn` (false for a confirmed outsider, true for a creator and for a never-checked member).
- **`existing-accounts.test.ts`** (decision 4):
  - an account with a personal workspace, Dev Studio membership, board grants and one board it owns is given an outside email (a dev re-login with that email);
  - `me.workspaces` is unchanged, `GET /api/boards/:bid` returns the same role, and `POST /api/boards/:bid/ticket` works;
  - every create route answers 403;
  - the exception address keeps full rights and never gets a second personal workspace.
- **`invite-lock.test.ts`**:
  - create without `email` → 400 (after the B2 flip);
  - a `+clerk_test` address → 400;
  - the address is stored normalised (`Pat@Client.Example.Test` → lowercase);
  - preview: `emailLocked`, a masked hint, `matchesYou` true/false/null;
  - a wrong account → 403 mismatch with a masked body; the link is not redeemed and stays usable;
  - the right account accepts, including through a Clerk-verified secondary address;
  - an unverified or `+clerk_test` address does not match;
  - stale identity → refresh at accept (fake count);
  - Clerk down at accept → 503 with nothing redeemed;
  - an unbound single-use row (direct INSERT) → 410;
  - workspace `admin` to an outside address → 409 at create, and at accept after an exception was removed;
  - review, workshop and guest links are unchanged;
  - the email route's `emailed`, `existing_account` and `email_not_configured` links are all locked, and `granted` is unchanged.
- **`no-leak.test.ts`**:
  - capture the api log stream and read `audit_events.detail`, every error body and every `User`-shaped JSON;
  - none contains a test address, the exception address, the unmasked invited address, or an accept token (the access log uses the route pattern);
  - `me.user` has exactly the five `User` keys.

### 11.2 Migration tests

Done in step A:
- `packages/db/test/migrate.test.ts`: `0021_domain_access` in the three name lists and `user_emails` in the table list; the milestone-1 upgrade test asserts the unbound single-use link is revoked, the workspace gets `personal_of`, `identity_checked_at` is NULL and `user_emails` is empty.
- `packages/db/test/core-schema.test.ts` (`0021_domain_access`): the `user_emails` and `invited_email` CHECKs (upper case, non-ASCII, space, empty parts, `+clerk_test`, multi-use), the generated `domain` (after the last `@`), the source CHECK, one primary per user and source, `personal_of` unique.

For the API owner (B2):
- `apps/api/test/migrations.pg.test.ts` (opt-in real Postgres): the count at :564 **stays 29** (it counts the tables before the upgrade). Add assertions that the seeded open single-use invitations (`INV.single`, `INV.board`) are revoked after the upgrade, the redeemed and multi-use ones are untouched, `personal_of` is backfilled with Dev Studio excluded, and membership counts are unchanged (the existing count check already covers them).
- `schema-rollback.test.ts` needs no change (it uses a synthetic 9999 migration).

### 11.3 Existing api tests that change (API owner)

- `auth.test.ts`:
  - the Clerk fake profile at ~:265 returns `emails: [{ email: 'lobby-test-alice@darkburn.com', isPrimary: true, strategy: 'email_code' }]`;
  - :282-298 keeps expecting a personal workspace for that creator;
  - add an outsider case.
- `auth-limits.security.test.ts` (~:157) and `sessions.security.test.ts` (~:102): the fakes add `emails: []`. Only status codes are asserted.
- `features/dashboard/email-invites.test.ts`:
  - `clerkWorld` people get verified emails: `alice` a creator domain, clients `@client.example.test`;
  - :238-311 and :450-486 are rewritten: a different account now gets 403 `INVITATION_EMAIL_MISMATCH` and the link stays usable, then the invitee with that address accepts, then the 410 for a third account stays;
  - the fake `@clerk/backend` gains `users.getUser` wherever the refresh reaches it.
- Fixture bodies gain `email` when B2 makes it required (no expectation changes except where noted):
  - `features/dashboard/setup.ts` `singleUseInvite(c, boardId, role, email)` (email required) and its callers;
  - `invitations.test.ts`, `tenancy.test.ts` (:30-33, :51-52 keep expecting 404: add `email` so the 400 for a missing field does not mask it);
  - `features/guests/join.test.ts` (:144, :296, :303) and `refusals.test.ts` (~:59-60, ~:139, ~:153, ~:158): fixture bodies only; every refusal expectation stays (§10);
  - `auth-limits.security.test.ts`, `event-streams.security.test.ts`, `members.test.ts`, `boards.test.ts`;
  - `features/history/{duplicate,checkpoints,archive}.test.ts`;
  - `lock-order.pg.test.ts` and `migrations.pg.test.ts` where they call the create route.
  The accepting user is the handle-only `<handle>@dev.invalid` or a login with that email.
- `contracts.test.ts`: `CreateBoardInvitationInput.safeParse({ role: 'commenter' })` becomes a failure; `domain-access.test.ts`'s "optional until step B2" case changes with it.
- `apps/api/test/helpers.ts`: `login(handle, name?, opts?: { email?: string })` and `devEmail(handle)`. Handle-only callers are unchanged.
- Opt-in real Postgres (`DRAFTROOM_TEST_DATABASE_URL`): `concurrency.pg.test.ts` and `lock-order.pg.test.ts`. Accept's pre-transaction read must add no lock outside the access.ts order. Add the concurrent creator first-sign-in race and a concurrent `ensurePersonalWorkspace`.

### 11.4 Web unit tests (WEB owner)

- `dashboard/model.test.ts`: the menu and `emptyState` for a workspace member who is not a creator; `landingWorkspace([])`; `legacy` behaves as a creator.
- `features/history/model.test.ts`: `historyPermissions` with `creator: false`.
- `invite/model.test.ts`: the locked and signed-out copy, the mismatch state and its fallbacks (null email, null inviter), no auto-accept on a mismatch, the 503 copy.
- `board/share-model.test.ts` (:95-123): an email target makes a locked link through `createBoardInvitation`, the unknown-name prompt, the locked-link copy, the pending row with `email`; `checkInviteEmail` refuses `+clerk_test`.
- `api/client.test.ts`: `createBoardInvitation` sends `{ role, email }`.
- A no-workspace screen model for `outside` (with and without an address), `unconfirmed` and `none`.

### 11.5 e2e (WEB owner)

**Support changes**:
- `e2e/tests/support/api.ts` (`signInWith`, `Api.signIn`, `signInContext`), `support/board.ts` (`signInThroughUi` fills `dev-login-email`) and `support/dashboard-share.ts` (`signedInContext`) take an optional `email`;
- outsider helpers skip `users.get` / `personalWorkspace()`, which throw without a personal workspace (users.ts:37-38);
- in the shared default stack, outsider dev logins always use `freshHandle()`, never alice/bob/carol: `createUsers` caches sessions, and every dev login replaces the dev emails, so reusing a shared handle with an outside email would make that user an outsider for the rest of the run.

**New spec `e2e/tests/domain-access.spec.ts`**, with `test.use({ apiEnv: { DRAFTROOM_CREATOR_EMAILS: 'owner@personal.example.test' } })`. Three green runs. Flows 2 to 5 need B2.
1. An outsider (`client@client.example.test`) lands on `no-workspace[data-reason=outside]`, which shows their address. `Api.fetch` gets 403 `CREATOR_REQUIRED` on every create route.
2. The email lock:
   - alice (handle-only) invites `pat@client.example.test` through "Invite people" (a locked link);
   - `sam@client.example.test` opens it and sees `invite-email-mismatch` with `p•••@client.example.test`, "signed in as sam@…", and no auto-accept;
   - "Sign in with a different account" → pat signs in → auto-accept → the board at the given role;
   - pat's dashboard has no New board, Templates, Import or sample, the card menu has no Duplicate, the History panel has neither copy action, and the empty state shows the outside copy.
3. Domain creators: `lobby-test-dbc@darkburn.com` and `lobby-test-tpg@trailerparkgroup.com` get a personal workspace and New board works. `lobby-test@sub.darkburn.com` is an outsider.
4. The exception `owner@personal.example.test` is a creator.
5. A non-creator board owner: the Share dialog shows `share-creator-note`, no invite or link sections, no transfer, no copy-link on existing links, and lowering and removing work.
6. A name-only guest joins a creator's client link, unchanged.

**Specs that change**:
- `invite-email.spec.ts`: the email hint (~:40) and the result copy (~:69-73) say the link works only for that address; :96-118: sam signs in with `sam@client.example.test`; add the wrong-account step.
- `dashboard-share.spec.ts` (:844-917): an email target still shows the invite result, with the locked copy.
- `permissions.spec.ts` (:221-340): the plain invite link becomes a one-person link for `carol@dev.invalid`.
- `history.spec.ts` (:715), `theme.spec.ts` (:207), `sharing-polish.spec.ts`, `security-web.fix.spec.ts`, `shell-sharing-platform.fix.spec.ts`: one-time invite flows gain an address.

**Must stay green unmodified**:
- `dashboard.spec.ts`, `sample-board.spec.ts`, `storage-2.spec.ts`, `search.spec.ts`, `shell-2.fix.spec.ts`;
- the guest specs in §10;
- the demo (`pnpm --filter @draftroom/e2e demo:video`) and perf, whose handle-only logins stay creators. Run them as a manual smoke check.

**Gate**: `pnpm verify` (lint, typecheck, test, e2e) green, plus the opt-in real-Postgres run, all recorded in docs/PROGRESS.md with counts. State after step A: 3,143 unit tests passing (33 opt-in skipped); the last browser run of `next` was 327/327 (before step A, not re-run for it).

## 12. File ownership and order

| Owner | Owns |
|---|---|
| **API owner** | `apps/api/**`, `packages/db/**`, `packages/contracts/**`, `packages/permissions/**`, `.env.example`, `docs/DOMAIN-ACCESS-CONTRACTS.md` (contract changes, the "As built" section), `docs/DEPLOY.md`, `docs/PROGRESS.md` |
| **WEB owner** | `apps/web/**`, `e2e/**` (support helpers, the new spec, spec updates) |
| **Lead** | `render.yaml` (not changed by this work), the Render and Clerk dashboards, the deploy |

Nobody edits the other owner's files. If the web needs a contract change, the WEB owner writes a request under "Contract change requests" below, and the API owner makes it. There are no dependency or lockfile changes. Migration 0021 is the only migration.

**Order**
- **A. Done (this commit).** §7 contracts, the permissions predicates, migration 0021 and its db tests, the step-A placeholders in apps/api (§7), `sessionUserToUser` listing its fields, and `access` in the web's `makeMe()`. Lint, typecheck and the unit suite are green. The WEB owner starts §9 now: against this api, `access` is `'legacy'` and the UI behaves as today.
- **B1. API owner, early**: the dev login `email`; `user_emails` writes (dev and Clerk exchange, with the `+clerk_test` drop and the strategy); `identity_checked_at` stamping; `Me.access` from `identity.status` in all three places (no `ME_ACCESS_LEGACY` left in apps/api/src); `ensurePersonalWorkspace` with `personal_of`, personal workspace and Dev Studio for creators only. Push early: the WEB owner can then run the outsider landing, the dashboard and History gating, and e2e flows 1, 3 and 4 against a real dev api.
- **B2. API owner**: the rest of §3 to §6 and §8 (refresh, guard, lock, D4/D5, `url: null`, duplicate capping, canOwn, pending `email`); flip invitation `email` to required with the fixture updates (§11.3); the tests in §11.1 to §11.3; `.env.example`; DEPLOY.md (env vars, Clerk test mode, rollback, offboarding). E2e flows 2 and 5 need B2.
- **C. WEB owner**: §9, §11.4 and §11.5.
- **D. Integration** (API owner or the lead): merge; the full `pnpm verify` and the real-Postgres run; three green runs of `domain-access.spec.ts`; an independent security review against §14; then the lead deploys (§13).

**Contract change requests**: none from the WEB owner. Two readings of §9 the WEB owner asked to confirm, accepted at integration (step D) because they match D4 and need no api change:
- For a non-creator manager, `InviteLinkSection` hides its create form but keeps the pending one-time invitations ("Unused invitations", Revoke only), as D4 says ("non-creator managers still see the pending list"). Open review and workshop links are listed the same way, with Revoke only.
- `invite/guest.tsx`: besides the `GuestAwarePreview` line (§10), its import list gains `InvitationEmailLock`, which that line needs to compile.

Changes the API owner made while building B1/B2 (each small and local; the reasons are in §17):
1. `replaceUserEmails` writes when the stored `identity_checked_at` is NULL or **at or before** `fetchedAt` (`<=`, not `<`), so two dev logins within one millisecond both write; an older snapshot still never overwrites a newer one.
2. `AuthProvider.refreshIdentity` takes a `Db` (not a `Queryable`): the provider writes each snapshot in one transaction, after its network calls.
3. §2: the running provider is `provider.id` (the `AuthProvider` field), not `provider.name`.
4. `ShareMember.canOwn` is also false for name-only guests (they can never own a board; the guest guard answers 409 `GUEST_ONLY_THROUGH_LINKS`).
5. `PUT …/members/:uid`: an unchanged role is a no-op (200) before the D5 check, so putting `owner` again on a pre-existing outsider owner does not answer 409. The target refresh for `role: 'owner'` runs only when the caller is a creator (stored status), and transfer of ownership checks the caller's creator status in its unlocked pre-check, before `refreshTarget`: a non-creator can never make Lobby call Clerk about someone else.
6. `identity.status(user, q?)` takes an optional `Queryable` (the sign-in response computes it inside the sign-in transaction, §8).

## 13. Rollout, rollback, offboarding

**Before the deploy (the lead)**
1. Clerk Dashboard, the staging instance → **Instance Settings** → turn **Test mode off**, and record it in DEPLOY.md. (Lobby ignores `+clerk_test` addresses anyway; this also stops the fixed code 424242 from verifying anything.) Confirm which sign-in methods are enabled and record them: company addresses should sign in through email code or Google; do not enable a Microsoft/Entra connection (§15).
2. Do **not** switch Clerk instances (development → production) as part of this deploy. A switch changes every Clerk user id: sign-in would create new Lobby users with none of their memberships, and the refresh would treat the old ids as gone and revoke their sessions. Any instance switch needs its own plan that remaps `identities` first.
3. Set `DRAFTROOM_CREATOR_EMAILS` on `draftroom-staging-api` in the Render Dashboard or through the Render API, never in git. The env edit redeploys the current build, which ignores it. If this is forgotten, nothing is lost: the owner's personal account stays an outsider (it keeps everything and cannot create or share) until the value is set.

**Deploy (the lead)**
1. Deploy the api. Migration 0021 runs and revokes the open unbound one-time links (tell the team to send new ones). Then deploy sync (no change) and web.
2. Verify with `GET /api/me` → `access.reason`:
   - the owner's personal account → `exception`;
   - a Dark Burn account → `domain`;
   - an outside test account → `outside` (it can open what it was invited to, and New board is hidden and refused);
   - a name-only guest link works as before.
3. Optional, a day later (once most people have loaded a page): list open multi-use links whose creator is now an outsider, and revoke any the team did not expect (SQL in DEPLOY.md, joining `invitations.created_by` to `user_emails`).

**Rollback** (`DRAFTROOM_ALLOW_NEWER_SCHEMA=1`, docs/DEPLOY.md). The older build enforces no creator gate and ignores `invited_email`. For the whole rollback window, every outsider can again create boards, projects, invitations and links, new outsiders get a personal workspace, and any account could redeem an email-locked link. Keep the window short. Before starting the older build, run:

```sql
UPDATE invitations SET revoked_at = now()
 WHERE invited_email IS NOT NULL AND redeemed_by IS NULL AND revoked_at IS NULL;
```

- The web need not be rolled back: against the older api, `access` is missing and the web falls back to `'legacy'` (D11), which behaves as before.
- Before starting the new build again, mark the personal workspaces the older build created, so their owners do not get a second one:

```sql
UPDATE workspaces w SET personal_of = w.created_by
  FROM (SELECT DISTINCT ON (created_by) id FROM workspaces
         WHERE id <> 'wsp_DevStudio00000000000'
           AND created_by NOT IN (SELECT personal_of FROM workspaces WHERE personal_of IS NOT NULL)
         ORDER BY created_by, created_at, id) pick
 WHERE w.id = pick.id;
```

- Unbound links that the older build creates are treated as gone once the new build returns (§6.1). Users the older build provisions have no stored emails; they are confirmed on their next request and keep what they have (decision 4).

Add all of this to DEPLOY.md.

**Offboarding a leaver.**
- A Clerk address stays "verified" after the mailbox is gone, so ban or delete the user in Clerk. Their sessions are revoked by the refresh: within about 1 h of their next page load, or at their next gated action once the stored data is older than 24 h.
- For an immediate stop, use "sign out everywhere" on their behalf. This matters for an idle open board tab, which keeps its sync session until then.
- Remove their memberships by hand: losing creator status removes nothing (decision 4).
- Clerk webhooks remain the complete fix (future work).

## 14. Security review checklist (independent reviewer)

1. Every `INSERT INTO workspaces|projects|boards|invitations|board_members|workspace_members`, and every UPDATE that raises a role, a visibility or a link's lifetime, is reachable only behind `requireCreator` or is a lowering path (the tripwire test, plus reading the code), including the seed-before-row order in `createBoardFrom` (no orphan canvas for a refused caller).
2. Domain and exception matching is exact ASCII: the last `@`, no `endsWith`, no Unicode case folding, and non-ASCII addresses dropped at every entry point (Clerk profile, dev login, invitations, config).
3. `+clerk_test` addresses are refused or dropped at every entry point (`AccountEmail`, `normalizeEmail` for every source, both DB CHECKs), and DEPLOY.md records that Clerk test mode is off on the staging instance.
4. Only `verification.status === 'verified'` addresses are stored or compared, only rows of the running provider's source count, and a dev email is accepted only on the dev-guarded route.
5. `creator` and addresses never appear in `User` JSON, logs or audit rows. The full invited address is returned to others only in the manager-only pending list (the email route echoes it back only to the creator who typed it, §6.1). The hint is masked. No Clerk error message and no accept token reaches a log.
6. No network call happens inside a transaction or while holding a board or invitation lock. The accept path fails closed (503) and leaves a mismatched link usable. A refresh reloads the request's cached user before it is used. An older Clerk snapshot never overwrites a newer one.
7. Target refreshes run only after the route's own permission check, and never revoke or throw. Only a 404 with `resource_not_found` or `banned` revokes, and only from the user's own refresh.
8. Guests keep `GUEST_ACCOUNT_REQUIRED` on every route, and §10's code is unchanged.
9. Tenancy: creators still get 404 for foreign ids; the outsiders' uniform 403/503 reveals nothing about ids.
10. Unbound single-use links are dead (migration plus `stateFor`), and the rollback notes exist.
11. There is no outsider path to board `owner` or workspace `admin` (PUT, transfer, workspace invitations and accept, duplicate), and no non-creator path to minting access (including reading an existing link's URL). "Non-creator" means the stored status, which follows Clerk within the freshness rules of §3.4 (D12): up to about 1 h after the person's next request to /api/me, the Share dialog's lists or a gated route, and at most 24 h without one.
12. Config errors never echo values, and the startup log shows only the exceptions count.
13. `ME_ACCESS_LEGACY` no longer appears in apps/api/src, and the api never sends `reason: 'legacy'`; `PendingInvitation.email` and `ShareMember.canOwn` are computed, not the step-A constants.

## 15. Residual risks (accepted, documented)

- **A verified address does not prove the person still controls the mailbox** (leavers, and shared or helpdesk-routed addresses such as info@ or a group, whose verification codes other people can read).
  - Mitigation (owner actions in the Clerk dashboard, not code): allow company-domain sign-in only through email code or Google, never route company verification mail to shared inboxes, and ban or delete leavers.
  - Later hardening, prepared: `user_emails.verification_strategy` is stored, so a per-strategy rule for creator domains (for example Google only) needs no migration.
- **Microsoft/Entra ("nOAuth")**: some identity providers' email claims are not proof of mailbox control. If a Microsoft/Entra connection is ever enabled in Clerk, creator domains must not rely on it.
- **Anyone who receives a forwarded Clerk sign-up email before the invitee acts can create the account that owns the address**, and so passes the lock. This is inherent to email as proof.
- **Staleness.** A Clerk-side change reaches Lobby within about 1 h of the person's next page load, or at the next sign-in. More exactly (fixer round 1): after 1 h, the next request that freshens the caller starts a background refresh: GET /api/me or /api/auth/me (every page load), the Share dialog's GET …/invitations and GET …/sharing/members, and every guarded create or share route. The request that starts it still answers from the stored data, so one guarded call can succeed on stale data before the refresh lands (D12, accepted). Stored emails are trusted for up to 24 h while Clerk is unreachable; after that the person is `'unconfirmed'` (no creating or sharing) until Clerk answers. A ban seen at a sign-in exchange ends the account's sessions at once (§3.3).
- **Signed-in outsiders holding a multi-use review or workshop link get its role** (D7, by design: creators make those links for exactly that). Links an outsider created before the deploy stay valid until they expire (at most 30 days) unless revoked (§13 optional check).
- **Outsider workspace members still see workspace-visible boards, projects, the member list and storage** (the role they were given, decision 2).
- **Pre-existing outsider board owners keep board settings that are not access**: the export policy (downloads for viewers) and AI settings. They are the board's owners (decision 4); the lead can extend D4 to these later.
- **Clerk development instances are capped at 100 users** (per the regression review; the lead confirms against the Clerk plan). Outsiders now sign in too, and count toward the cap on staging.

## 16. Review log

Reviews of the first draft (security and regression, both at a571636). Every blocking item is resolved:

| Item | Resolution |
|---|---|
| Clerk test mode lets anyone become a creator (both reviews) | D1, §2 `normalizeEmail`, `AccountEmail`, both DB CHECKs (committed); §13 turns test mode off; §14 item 3; tests in §7, §11.1, §11.2. |
| `sessionUserToUser` is `({ ...u })` | Rewritten in step A to list the five fields; §3.4 corrected. |
| Step A breaks the web | Step A includes `access` in `makeMe()`; the `'legacy'` default (D11) keeps `parse(me)` stable; typecheck and the unit suite are green. |
| Refreshing the target signs out the caller | §3.4 target refresh: after the route's permission check, never throws, never revokes; the route decides from stored data. |
| D5 gap: duplicate "keep sharing" copies owner grants | Non-creators' copied grants are capped at editor (§4.2, §11.1). |
| §10 "must not change" contradicts §9/§11 | §10 now allows the `GuestAwarePreview` line and fixture-only edits of guest tests. |

Non-blocking items accepted: storing the verification strategy (enforcement deferred); `resource_not_found`-only "gone" and the instance-switch warning; reloading the cached user after a refresh; the grace rule inside `requireCreator` and in-route decisions; 503 during the failure backoff; transfer of ownership is creator-only for the caller; `url: null` for non-creator managers; target refreshes only after the permission pre-check; filtering by the running provider's source and keying the dev domain on the running provider; the widened tripwire; proving both the guard and the in-route layer; the full rollback note; the fetch-time write rule; Clerk errors never logged and the route logged as its pattern; "Invite people" makes a locked link through the existing route (D13); the work-email line in outside copy; dropping "Check again"; fallbacks for a null address or inviter; the unconfirmed dashboard notice; `canOwn` true while a member was never checked; "Sign in or create an account"; no `render.yaml` change; the `personal_of` re-backfill after a rollback; the permissive web fallback instead of rolling the web back; the 100-user cap, the dev-refresh wording, the web build notes, the e2e details and the nOAuth warning.

Rejected, with reasons:
- **Stop non-creators from lowering or removing creators' grants**: a pre-existing outsider owner can already trash the board, and decision 4 keeps their role; blocking lowering would add a rule without reducing exposure. Stated in D4.
- **Extend D4 to the export policy and AI settings**: they are board settings, not access, and belong to the board's existing owners (decision 4). Recorded in §15 for the lead.
- **Ship D4/D5 later**: kept. With them, only Dark Burn and Trailer Park Group people let anyone in, which is the point of decision 2. For creators every sharing flow is unchanged, so their regression risk is confined to the non-creator variant, which only pre-existing outsider owners can see.
- **Drop session revocation from the refresh**: kept for offboarding, but only on unambiguous signals (404 `resource_not_found`, banned) and only from the user's own refresh. The hourly re-check is now in the background, and /api/me awaits Clerk only when the data is unconfirmed.
- **Let unbound links expire instead of revoking them (D3)**: rejected, to fail closed. They live at most 7 days, so little is lost, and the team is told to send new ones.
- **Make the company names in the copy configurable**: Lobby is Dark Burn Creative's tool, and the domain variable exists for exceptions and tests, not rebranding. Clients see the names of the companies that invited them.

Deferred: the access-request requester's email domain in the approval row (a follow-up; approval is already creator-only); enforcing the verification strategy; Clerk webhooks.

Corrections to the first draft: `migrations.pg.test.ts:564` counts the tables before the upgrade, so it stays 29; the "B1 is everything the e2e flows need" claim was wrong (flows 2 and 5 need B2).

## 17. As built (API owner, steps B1 and B2)

Branch `da/api` (B1 1af29c4; B2 on top). Everything in §2 to §8 and §11.1 to §11.3 is built; the contract changes above are the only divergences.

**Where things are**
- Policy (pure): `apps/api/src/auth/creators.ts` (`normalizeEmail`, `emailDomain`, `creatorMatch`, `isCreatorEmail`, `creatorReason`, `distinctDomains`, `parseCreatorPolicy`), parsed into `ApiConfig.creators` (config.ts). The startup log line is `'domain access policy'` with `{ creators: { domains, exceptions } }`.
- The one SQL fragment and the freshness constants: `apps/api/src/auth/creator-sql.ts` (a leaf module, so session.ts, users.ts and identity.ts share it without an import cycle; identity.ts re-exports the constants). `SessionUser` has `kind`, `creator`, `identityCheckedAt`; `SessionStore.reload(req)` replaces the per-request cache entry.
- Addresses: `users.ts` `cleanProfileEmails` (normalise, dedupe, one primary first, at most 20, strategy `^[a-z0-9_:.-]{1,100}$` else null), `replaceUserEmails`, `stampIdentityChecked`, `ensurePersonalWorkspace`, `findOrCreateUser` (D9: a first sign-in without a profile throws 503 inside the sign-in transaction, so no user is created). `clerk.ts` `verifiedProfileEmails` and `classifyProfileFailure` (`isClerkAPIResponseError`, loaded lazily from `@clerk/backend/errors`, plus 404 and `resource_not_found`); the profile call has the 10 s timeout of clerk-directory.ts. `dev.ts` `devEmail(handle)`.
- `apps/api/src/auth/identity.ts`: `createIdentityService` → `ctx.identity` (`status`, `freshen(req, user, mode, { strict })`, `refreshTarget`, `requireCreator`, `isCreatorUser`, `creatorsAmong`, `canOwnAmong`, `ensurePersonalWorkspace`, `settled`, `lookup`). `ApiServer.identity` exposes it (tests call `settled()`); the api's `onClose` waits for it.
- The guard: `apps/api/src/features/domain-access/{index.ts,guard.ts}` (`CREATOR_ROUTES`), registered right after `registerGuests`. Test-only seam: `ApiDeps.domainAccessGuard: false` / `createTestApi({ domainAccessGuard: false })`.
- In-route checks, all after the route's own 404/403: routes/boards.ts (create; PATCH visibility raise), routes/workspaces.ts (create project; PATCH project), routes/invitations.ts (`createInvitation`: guest check, then `requireCreator`, then D5 for workspace `admin`/`owner`; accept: the lock; preview: `InvitationEmailLock`), routes/members.ts (PUT), features/history/index.ts (`requireBoardCreator` for import, duplicate, restore as new), features/history/new-board.ts (the re-check in the transaction; keep-sharing caps non-creators' owner grants at editor via `creatorsAmong`), features/dashboard/{email-invites,review-links,access-requests,sharing}.ts.
- Refusal logs: `creator.refused` (`userId`, `route` pattern, `by`, `purpose`, `reason` `outside` or `unconfirmed`, `emailDomains`); `invitation.email_mismatch`; `identity.refresh_failed` (`userId` null at the exchange; `status`, `code`); `identity.creator_changed`; `identity.sessions_revoked`.

**Creation paths.** A fresh grep of `apps/api/src` found no creation or hand-out path beyond §4.2. Every `INSERT INTO workspaces|projects|boards|invitations|board_members|workspace_members` (22 sites) and every raising `UPDATE` (4 sites) is listed, with the reason it is allowed, in the tripwire of `apps/api/test/features/domain-access/creation-matrix.test.ts`. The sync server's seed route is unchanged (§4.2).

**Tests** (`apps/api/test/features/domain-access/`): `policy`, `sign-in`, `refresh`, `creation-matrix` (the guard, the in-route layer alone, uniform ids, creators, tenancy, guests, route completeness, the source tripwire), `sharing-rules`, `existing-accounts`, `invite-lock`, `no-leak`; a fake Clerk Backend API in `clerk-fake.ts` (the real adapter code runs against it). Also `config.test.ts` (domain access), `auth.test.ts` (an outsider case), the §11.3 fixture updates, and `createTestApi({ db })` to re-create an api over the same database (a policy change applied at restart). Deviations in the test setup: the creation matrix's outsider is a workspace **admin** (the strongest role a pre-existing outsider can hold), so that the in-route layer is reached on the workspace-invitation route too; the guard run repeats every entry for a plain member. In `email-invites.test.ts`, dave is a creator (`lobby-test-dave@darkburn.com`), so "a person outside the board gets 404" still holds, and an outsider's 403 `CREATOR_REQUIRED` is added. In `features/guests/refusals.test.ts`, the unused single-use invitation is locked to `erin@dev.invalid`, because the test lets erin use it (a fixture body; no expectation changed).

**Opt-in real Postgres** (`DRAFTROOM_TEST_DATABASE_URL`): `migrations.pg.test.ts` asserts 0021 (open unbound single-use links revoked, the others untouched, `personal_of` with Dev Studio excluded: the seed gained a Dev Studio row, nobody confirmed, no address stored); `concurrency.pg.test.ts` adds the creator first-sign-in race and the concurrent `ensurePersonalWorkspace`; `lock-order.pg.test.ts` adds "accepting a locked invitation takes the board row before the invitation". **Not run for B2**: no Postgres was available to this builder; they typecheck and are skipped without the variable. Run them in step D.

**For the WEB owner**: `/api/me`, `/api/auth/me` and the sign-in responses carry `access` (never `legacy`); single-use invitation bodies must carry `email` (400 without it); the preview carries `InvitationEmailLock`; accept can answer 403 `INVITATION_EMAIL_MISMATCH` (body `InvitationEmailMismatchBody`), 409 `ROLE_REQUIRES_CREATOR` and 503 `IDENTITY_UNAVAILABLE`; `PendingInvitation.email` and `ShareMember.canOwn` are computed; `url` is null for non-creator managers. `/api/auth/me` answers 401 (not 204) when an awaited refresh finds the account gone or banned, as §8 says. Dev logins accept `email` (`DevLoginInput`).

## 18. Integration (step D)

`next` merged `origin/da/api` (db73946, B1 + B2) and then `origin/da/web` (9ec92a8, step C, which already contained both api commits), each with a merge commit and no conflicts. No integration fix was needed: nothing in `apps/`, `packages/` or `e2e/` changed at integration. The web owner's two §9 readings are accepted (§12).

**Gate on the merged `next`** (Windows 11, Node 24, headless Chromium, `E2E_PORT_BASE=6800`):
- `pnpm lint`: clean (1,035 files). `pnpm -r typecheck`: every project clean.
- `pnpm test`: 293 files passed, 9 skipped; 3,297 tests passed, 36 skipped (the opt-in real-Postgres and Chrome-only cases).
- `e2e/tests/domain-access.spec.ts`: three separate runs in a row, 5/5 each (15/15).
- The whole e2e suite once: 332 tests, 331 passed in 23.8 min. The one failure is `workshop-copy.spec.ts` "R2-11, R2-09, R2-08", a time-of-day artefact unrelated to domain access: run at 23:29 local, its 3-hour link ends after midnight, so the badge (unchanged `shortTime`) rightly adds the date ("until Sep 29, 2:25 AM") while the test expects the time alone. The spec and the badge code are unchanged from `next` before this work (§10 requires the spec unmodified). Re-run unmodified at 00:00 local (same build, same port base): 2/2 passed, so every one of the 332 tests has passed on the merged `next`.
- The §10 and §11.5 "must stay green unmodified" specs are byte-for-byte unchanged and passed in that run (apart from the workshop-copy case above).

**Not done at integration**: the opt-in real-Postgres run (`migrations.pg`, `concurrency.pg`, `lock-order.pg`, and the api suite with `DRAFTROOM_TEST_DATABASE_URL`): no Postgres is installed on this PC and none was provisioned for this run; the demo video and perf smoke checks (§11.5); the independent security review (§14); recording in DEPLOY.md that Clerk test mode is off (§13, the lead); the deploy.

## 19. Verifier findings, fixer round 1

An independent verification of the merged `next` (three lenses: creation, invites, regression) found no blocking defect: one medium and eleven low. Each fix below is small and local, has a test that failed before it and passes after, and is marked "fixer round 1" where it changes a section above.

| # | Lens, severity | Finding | Resolution | Tests |
|---|---|---|---|---|
| 1 | creation, low | GET …/invitations (`url` of multi-use links) and GET …/sharing/members decided on the stored status and never freshened the caller: a former creator who skipped /api/me kept link URLs for 24 h with no Clerk call, and a guarded share call later in that window still succeeded. | Both routes call `identity.freshen(req, user, 'me')` after their permission check (§3.4, §4.2). A removed company address now stops URLs and link minting about 1 h after any of these requests; the request that starts the refresh still answers from stored data (D12, stated in §14 item 11 and §15). | api `staleness.test.ts` (4 cases) |
| 2 | creation, low | The Clerk exchange that saw `banned` answered 403 but left the account's existing sessions alive, with creator rights until a refresh. | A banned exchange with an `identities` row revokes every session of the account (`SignInContext.endBannedAccount`, §3.3 step 1). `locked` does not (a temporary lockout anyone's failed attempts can cause). | api `staleness.test.ts` (3 cases) |
| 3 | creation, low | A stored `identity_checked_at` later than the running clock (written by a process whose clock ran ahead) blocked newer snapshots and stopped freshen from refreshing; a dev login with an outside email under such skew kept `<handle>@dev.invalid`. | `replaceUserEmails` / `stampIdentityChecked` take `{ now, always? }`: a stored time more than 60 s (`CLOCK_SKEW_TOLERANCE_MS`) ahead of `now` never blocks a write; the dev login writes always. `freshen` treats such a time as stale but not unconfirmed (§3.3, §3.4). | api `staleness.test.ts` (3 cases) |
| 4 | invites, low | §6.1 and §14 item 5 said the full invited address appears in exactly one response, but the email route echoes it back to its caller. | Wording only: returned to others only in the manager-only pending list; echoed back only to the creator who typed it (§6.1, §14 item 5). | none (documentation) |
| 5 | regression, medium | An outside account with an owner/admin/member workspace role saw New board, Import, Templates and "New project lobby" vanish once any board was listed, with no reason (worst case: the owner's personal account while `DRAFTROOM_CREATOR_EMAILS` is unset). | Dashboard notice `access-outside` (§9, `showOutsideNotice`, `OUTSIDE_NOTICE`); the outside empty state does not repeat it while it shows. | web `dashboard/model.test.ts`; e2e `domain-access.spec.ts` flow 5, "an existing account that lost creator status" (its own workspace as Owner) and "an email-locked workspace invitation" (a new outside member) |
| 6 | regression, low | An unconfirmed creator's Share dialog said "Only people at Dark Burn Creative or Trailer Park Group can…". | `shareCreatorNote`: `data-reason="unconfirmed"` and a "paused" message (§9). | web `share-model.test.ts`; e2e failure-states test |
| 7 | regression, low | The outside landing said "open the link in their email", but D13 links are sent by the inviter, not by email. | "open the invite link they send you" (§9). | web `dashboard/model.test.ts`; e2e flow 1 |
| 8 | regression, low | An inviter opening their own locked link was told to "ask {themselves} to invite {their address}". | `InvitationEmailLock.sentByYou` (contracts, api preview) and its copy on the invite page (§6.1, §7, §9 state 3). | contracts `domain-access.test.ts`; api `invite-lock.test.ts`; web `invite/model.test.ts`; e2e flow 2 |
| 9 | regression, low | "Or pick someone from the workspace…" offered Owner for outsiders (409 after Add); the disabled Owner option and transfer button gave their reason only in a `title`. | AddMember offers edit, comment and view only (`ADD_MEMBER_ROLES`); the row shows `member-owner-note` as text, tied with `aria-describedby` (§9). | web `share-model.test.ts`; e2e "a creator managing an outside member" |
| 10 | regression, low | History promised "Restoring one makes a new board…" to people with no Restore button; the export setting told a reduce-only owner that "Creating a client link turns this off". | `checkpointsHint` (`checkpoints-hint`) and `clientLinkWillLimit({ canCreateLinks })` (§9). | web `history/model.test.ts`, `export-policy.test.ts`; e2e "an existing account that lost creator status" |
| 11 | regression, low | §11.5 flow 6 (a name-only guest joins a creator's client link under the domain-access env) was missing. | Added. | e2e flow 6 |
| 12 | regression, low | The failure-mode UI was never rendered in a test. | e2e "failure states…" rewrites /api/auth/me, /api/me and the accept response with `page.route`: `access-unconfirmed`, `no-workspace[data-reason=unconfirmed]`, the unconfirmed Share note, 503 `invite-retry`, 409 server message, 403 mismatch after a matching preview. **Not covered**: `ClerkSignIn`'s `clerk-exchange-error` rendering (the e2e stack runs the dev provider and cannot load Clerk); its code-to-message mapping stays unit-tested in `auth/exchange-error.test.ts`. | e2e failure-states test |
| 13 | regression, low | No e2e for the creator-side `canOwn` UI, an outsider's request-access path, or an email-locked workspace invitation. | Added: "a creator managing an outside member", "an outsider opens a board link…", "an email-locked workspace invitation…" (workspace admin for an outside address is 409). | e2e (3 tests) |

`domain-access.spec.ts` now has 11 tests. Run against the pre-fix source (source changes stashed, the new tests kept; E2E_PORT_BASE 6800), 7 failed: flows 1, 2 and 5 on their new assertions, "an existing account that lost creator status", "a creator managing an outside member", "an email-locked workspace invitation" (its `access-outside` assertion) and "failure states…" (the unconfirmed Share note). 4 passed: flows 3 and 4, the guest flow 6 and "an outsider opens a board link", which were added for missing coverage and test behaviour that already worked.

**Gate after the fixes** (Windows 11, Node 24, headless Chromium, `E2E_PORT_BASE=6800`): `pnpm lint` clean (1,036 files); `pnpm -r typecheck` clean; `pnpm test` 294 files passed / 9 skipped, 3,314 tests passed / 36 skipped (17 more than at step D: `staleness.test.ts` 10, plus the new unit cases in contracts, invite-lock and the web models); `domain-access.spec.ts` 11/11 in three runs in a row (33/33); the e2e specs that touch the changed UI, run once: `client-defaults`, `dashboard-share`, `dashboard`, `guests`, `guests-2`, `invite-email`, `permissions`, `sample-board`, `search`, `sharing-polish`, `history`, `checkpoints`, `export-control`, 65/65. Not re-run: the whole e2e suite, the opt-in real-Postgres tests (no Postgres here), the demo and perf smoke checks.

## 20. Verifier findings, fixer round 2

A second verification of `next` (regression lens) found one medium and three low findings, all in the web. Each fix is small and local, has a test that failed before it and passes after, and is marked "fixer round 2" where it changes §9. No api, contracts or schema change.

| # | Severity | Finding | Resolution | Tests |
|---|---|---|---|---|
| 1 | medium | A regression from round 1 (finding 9): in a creator's Share dialog, every outside member's row carried the two-line `member-owner-note`, viewers and commenters included. With a few client reviewers it repeated down the list; each client row grew from 47 to 81 px on a desktop, and to 209 px at 390 px, where names were cut to "Client P…". | The reason is said once, under "People with access" (`listShowsOwnerNote`, `rowNeedsOwnerNote`, new wording in §9); each affected row's select and transfer button keep `aria-describedby`, pointing to that one note. Rows are as tall as a creator's again. | web `share-model.test.ts` ("the people list says once…"); e2e "a creator managing an outside member" (two outside rows, one note outside the list, `aria-describedby` on both rows and not on the creator's, row heights within 2 px of the creator's at 1280 px and 390 px, no sideways scroll) |
| 2 | low | Round-1 finding 8 only partly fixed: on the inviter's own locked link the page still read "Alice Park invited you to a board / Join …", the block was `role="alert"`, and its only action, "Sign in with a different account", signed the inviter out (then /api/me 401 and a sign-in page for the invitee's address, with an accept intent stored). | A contract addition in §9 state 3: the page speaks of "Your invitation to a board/workspace", the title drops "Join", "Invited by" says "(you)", the role fact is "Their role", the block is `role="status"`, and its one action is `invite-own-back`, "Back to the board" or "Go to the workspace". Nothing on it signs out. | web `invite/model.test.ts` (`invitationSummary` with `sentByYou`, `ownInvitationWayBack`); e2e flow 2 (board: no buttons, back to the board, /api/me still 200) and "an email-locked workspace invitation" (back to the workspace) |
| 3 | low | When accept answered 403 `INVITATION_EMAIL_MISMATCH` after a matching preview, the page kept the session's stale `access.email` (the invited address itself), so it said "sent to i•••@… You're signed in as ivy@… ask Alice Park to invite ivy@…", and it made no /api/me call. | The 403 branch awaits `refresh()` (GET /api/auth/me) before showing the state (§9 state 3). | e2e failure-states test: after the routed 403, /api/auth/me is rewritten to the account's current address; the page must read it and name it |
| 4 | low | `ClerkSignIn`'s `clerk-exchange-error` rendering was never rendered in a test (round-1 finding 12, left open). | The markup after Clerk's form moved to `auth/ExchangeStatus.tsx` (no Clerk hooks); `ClerkSignIn` renders it unchanged apart from a `clerk-exchange-retry` test id on "Try again". A unit test renders it with `react-dom/server` (already a dependency): `ACCOUNT_DISABLED` in `role="alert"` with no retry, `IDENTITY_UNAVAILABLE` with "Try again", and the running state as a status. The Clerk flow itself still has no browser test (the e2e stack runs the dev provider). | web `auth/exchange-status.test.ts` (3) |

Run against the pre-fix source (source changes stashed, the new tests kept; E2E_PORT_BASE 6800): the three changed unit files failed (share-model 1, invite model 2, exchange-status could not load), and `domain-access.spec.ts` failed 4 of 11 on the new assertions (flow 2 `role` "alert", the owner note count 2, the workspace link's `data-sent-by-you`, the stale "signed in as ivy@…"); the other 7 passed.

**Gate after the fixes** (Windows 11, Node 24, headless Chromium, `E2E_PORT_BASE=6800`): `pnpm lint` clean (1,038 files); `pnpm -r typecheck` clean (14 projects); `pnpm test` 295 files passed / 9 skipped, 3,319 tests passed / 36 skipped (5 more than round 1); `domain-access.spec.ts` 11/11 in three runs in a row (33/33); the e2e specs that touch the Share dialog's member rows or the invite page, run once: `client-defaults`, `dashboard-share`, `demo-polish-b`, `guests`, `guests-2`, `invite-email`, `permissions`, `search`, `security-web.fix`, `sharing-polish`, `shell-sharing-platform.fix`, `theme`, 66/66. Not re-run: the whole e2e suite, the opt-in real-Postgres tests (no Postgres here), the demo and perf smoke checks.
