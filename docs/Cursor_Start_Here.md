# Cursor start here: creative collaboration board

Use with `Miro_Clone_Build_Plan.md`, researched September 26, 2026.

This is an implementation handoff, not an existing application. Create a new repository for the project and put both documents in `docs/`. Start with the first prompt below. Work through the subsequent milestones only after each acceptance gate is demonstrated.

Target: demo in 48–72 hours, internal pilot in 7–14 days, broader release in 4–6 weeks. Use Opus 5.5 Medium by default at standard speed. These are aggressive goals supported by mature components, focused review, and overnight execution. Follow the evidence, not the date, for release decisions. Coding-usage budgets are cumulative: $50–150 demo, $250–600 pilot, $750–1,500 broader build, with a $2,500 reserve. See section 14 of the full plan for token assumptions and Cursor-credit treatment.

## Overnight execution prompt

Use this after the engine gate passes and concrete tasks have been queued. Replace bracketed values before running. It is a run brief, not a substitute for an account-level usage limit.

```text
Read docs/PROGRESS.md, FEASIBILITY.md, the build plan, and repository instructions. Work through this scoped queue: [two to four tasks with clear acceptance criteria]. Use Opus 5.5 Medium and the available run time to produce completed, verified workflows.

Time limit: [hours]. Iteration limit: [number]. Usage budget: [amount, enforced with available account controls]. At a limit, checkpoint safely and report remaining work. Never assume a prompt alone enforces billing limits.

Each task must name its owned files and allowed shared contracts. If using parallel agents, put them in separate branches/worktrees and assign independent areas. One integration owner merges results. Serialize changes to migrations, shared schemas, dependency versions and the lockfile. Do not let several agents rewrite the same canvas synchronization code.

Continue routine local implementation, debugging and targeted checks without waiting for me. If one task requires an unavailable credential or unresolved product decision, record the blocker and continue an independent queued task. Keep production deployment and paid provisioning outside this run unless already explicitly authorized.

Demonstrate the acceptance criteria, not just a successful build. When changing collaboration, exercise separate clients and restart/reconnect behavior. Commit each working increment; preserve unrelated work. Keep a compact progress log including actual failures and usage when available.

Finish with: completed workflows, exact checks and outcomes, screenshots where useful, commit/branch identifiers, unresolved blockers, usage consumed if available, and the next integration step. Do not mark simulated behavior or unrun checks as passing.
```

## First prompt to paste into Cursor

```text
Read docs/Miro_Clone_Build_Plan.md and this file completely. We are building a Miro-style creative collaboration application, initially for an internal team and invited reviewers. Use our own branding and interface design.

Start with milestone 0 only: prove the canvas, shared editing, durable persistence, and representative file behavior before building the full application.

First inspect this repository and any applicable project instructions. Preserve unrelated work. If this is a new repository, establish a pnpm TypeScript workspace with apps/web and apps/sync, plus packages/canvas-schema and docs. Do not scaffold future services as fake working features.

Proposed stack:
- React + Vite + TypeScript in the browser.
- tldraw canvas and native @tldraw/sync / @tldraw/sync-core.
- A Node.js WebSocket service, one authoritative room per board.
- SQLiteSyncStorage using the current supported Node SQLite wrapper.
- Later: Fastify API, Render Postgres, Render Key Value/BullMQ worker queue, private R2 asset storage, and Clerk sign-in.

Before implementation, inspect current official tldraw documentation and the actual selected package exports. Pin mutually compatible exact package versions and document them. Do not copy outdated APIs from memory. Identify the production license requirement and note that price/terms remain unresolved. Local development is the current goal; do not purchase or provision services.

Build a working local prototype with two independently connected browser sessions editing the same board. Include notes, text, bound arrows, frames, images, undo/redo, cursors, and user presence. Use non-sensitive local fixture files only. Development-only user identities are acceptable only behind an explicit local development guard; never carry them into a deployment.

Persist each board to its own SQLite database in a configurable data directory. Use one room object per board, race-safe room creation, validated board IDs, and no second sync implementation. Do not debounce whole-board JSON into a last-writer-wins save endpoint. Do not add Yjs or Liveblocks to native tldraw sync.

Demonstrate:
1. Two sessions see one another and their edits.
2. A normal reload preserves content.
3. A killed/restarted server preserves acknowledged committed changes.
4. A network interruption and reconnect do not replace current state with an old board.
5. Simultaneous typing in one note, edit/delete conflicts, and undo after a remote edit have documented behavior. Do not assume character-level merging. If it is insufficient, propose the smallest server-enforced edit lease or another explicit solution and show the impact.
6. A custom file-card shape uses one schema shared by server and client, including a migration example.
7. An image, a multipage PDF, and a short MP4 fixture have a documented path to usable previews. Keep file processing outside the live sync loop.

Add meaningful behavioral tests for these risks, not tests that merely mirror implementation. Record actual results, unresolved issues, and engine compatibility in docs/FEASIBILITY.md. Include one reproducible development command and a short manual demonstration checklist.

At the end, report the exact files changed, checks run, observed limitations, and the next milestone. Update docs/PROGRESS.md. Do not call the prototype production-ready or deploy it publicly. Produce a concrete recommendation on whether this engine is suitable before starting the dashboard and integrations.
```

## Repository rules to ask Cursor to create

Keep rules short and scoped. Use an always-applied architecture rule, then narrower files for canvas, backend, and worker code. The exact rule-file syntax should follow current Cursor documentation: https://cursor.com/docs/rules.

Suggested global rule content:

```text
This repository implements docs/Miro_Clone_Build_Plan.md. Treat it as the product and architecture baseline. Read docs/PROGRESS.md before making changes and update it when a milestone finishes.

Work from the queued milestones and their acceptance gates. Independent tasks may run in parallel with explicit ownership and shared contracts. Keep code deployable in small increments. Inspect current library docs and installed exports before relying on API names. Pin compatible dependencies and record migrations.

Canvas state has one authority: native tldraw sync. There is exactly one room owner per board. Application metadata and independently implemented comments live in Postgres. Binary files live in private object storage. Derived search indexes and previews are not authoritative.

Do not combine native tldraw sync with Yjs or Liveblocks for the same board data. Do not add a whole-board overwrite save loop. Never put base64 uploads or signed expiring URLs into durable canvas records; store stable asset IDs and resolve access when needed.

Every API, WebSocket connection, asset access, worker request, export, and AI action must enforce the correct board/workspace permissions. UI restrictions are not authorization. Derive authorship from the authenticated server session.

Shared shape schemas and migrations must be compatible on client and server. Test reconnects, process restarts, stale clients, permission revocation, and concurrent modifications when those paths change.

Use mature authentication and file-processing libraries. Keep secrets server-side. Do not log session tokens, private content, signed URLs, or OAuth refresh tokens.

File jobs must tolerate retries and crashes. Treat imported documents and URLs as untrusted input. Impose size, page, pixel, duration, CPU, memory and time limits.

Do not show Saved until the actual sync/persistence behavior supports it. Do not present a demo, mock, or unverified benchmark as a finished feature. Do not claim a file is natively editable when it is a flattened preview.

Run meaningful targeted checks, review changes, and record evidence. Do not automatically broaden scope or upgrade unrelated dependencies. Do not provision paid resources, contact vendors, or publish an unreviewed deployment.
```

## Milestone 1 prompt: accounts, permissions, and deployment foundation

```text
Implement milestone 1 from the build plan using the proven milestone 0 architecture. Read FEASIBILITY.md and preserve the working shared canvas.

Add apps/api with Fastify and the Postgres schema/migration layer. Use Clerk for real authentication. Implement users, workspaces, workspace membership, projects, boards, board grants and invitations. Owners/editors/commenters/viewers must have defined server-enforced permissions. Use stable internal user IDs mapped to provider identities.

Create the board dashboard, board creation, rename, archive/trash and restore flows. New boards are private by default. Guests receive explicit board grants. Keep workspace scope on every relevant query.

Replace development identities with authenticated, short-lived board-specific connection tickets. Verify origin, expiry, board status and role at the collaboration service. Redact tokens from logs. Enforce canvas read-only permissions on the server. Implement a path to disconnect or downgrade revoked participants and test the documented enforcement bound.

Add local development configuration, .env.example without secrets, CI build/type checks and meaningful permission tests. Include wrong-workspace access and a forged read-only mutation.

Prepare render.yaml and Docker/runtime configuration for staging using verified current Render schemas and plan IDs. Configure a single collaboration instance with SQLite under its persistent disk mount. Document deploy interruptions, graceful shutdown, readiness and reconnect behavior. Do not enable sync autoscaling or assume other services can open its disk.

Complete all local and configuration work before reporting any external account or deployment blocker. Report cost-bearing services explicitly. Update PROGRESS.md and the deployment runbook.
```

## Milestone 2 prompt: complete the shared canvas

```text
Implement milestone 2. Finish the everyday canvas workflow: bulk notes, rich text supported by the chosen engine, pen, geometric shapes, connectors with bindings, frames, multi-selection, grouping, snapping, alignment, ordering, keyboard duplication, copy/paste, and local-user undo/redo.

Add named frames, an outline, fit-to-content, a minimap or equivalent overview, object deep links, and in-board text search. Add clear connection/saving/error UI based on verified sync semantics.

Prove convergence across multiple independent sessions, server restarts, disconnected clients and mixed client versions. Resolve the same-note editing decision from FEASIBILITY.md. A presence indicator is not a substitute for an enforced text-edit lease if one is required.

Keep cursor/presence state out of permanent board history. Add appropriate message/rate/record size limits and bounded room lifecycle management. Document any SDK behavior we rely on, especially undo and conflict resolution.

Create the initial repeatable load fixture. Measure actual results and report limits; do not claim 20-user or 5,000-object support until measured. Keep application correctness ahead of cosmetic toolbar polish.
```

## Milestone 3 prompt: private uploads and usable previews

```text
Implement milestone 3 using the file matrix in the build plan. Add private R2 object storage, stable asset/version records, signed upload/download access and workspace quota reservation. Use direct browser uploads rather than routing large file bodies through the API or board WebSocket.

Use the job queue and a separate processing worker. Keep durable job status and idempotency in Postgres. Verify uploaded size/type/checksum as appropriate, scan uploads, generate thumbnails, render PDF pages lazily, probe media codecs, and supply tested browser-compatible playback. Keep the original downloadable with authorization.

Implement image placement, PDF cover/page viewing, selected-page extraction, supported MP4 playback, basic audio cards, and attachment-only cards for allowed formats without previews. Expose queued/processing/ready/failed states with actionable errors. Do not advertise Office preview support until it is implemented and tested.

Store asset IDs and immutable version IDs in canvas records. Resolve signed access dynamically so old boards do not break when URLs expire. Comment anchor metadata must be able to identify an asset version and page or timestamp later.

Test duplicate completion requests, a worker crash, retries, cancelled/multipart uploads, unsupported codecs, malformed/encrypted PDFs, very large image dimensions, quota exhaustion, expired URLs and attempts to use another board's asset IDs. Add cleanup for abandoned uploads and a retention-aware asset deletion policy.

Document actual supported formats and limits using fixtures. Keep large processing jobs from affecting cursor/edit latency.
```

## Milestone 4 prompt: a usable pilot

```text
Implement milestone 4. Add our Postgres-backed comment threads with shape-relative anchors, resolve/reopen, verified author identity, mentions and notification preferences. Reviewers can comment without editing the canvas. Events are broadcast only after commit; reconnecting clients resynchronize comments.

Ship six editable templates: brainstorm, mood board, storyboard, pitch outline, retrospective and simple production plan. Regenerate IDs and bindings correctly on insertion. Template copies must not inherit invitations or public links.

Add frame presentation, PNG/PDF exports, a versioned native board export with an asset manifest, named checkpoints and restore-as-new-board. Clearly document what exports retain, flatten or omit. Do not advertise native export as asset-complete until its package includes the files and passes reimport.

Implement consistent SQLite backups inside the collaboration service and private object-storage backup retention. Other services can request a snapshot through an authenticated internal API; they must not create a second room or try to access the sync service's disk. Create a coordinated manifest with board, schema and asset versions. Perform a clean-environment restore drill.

Complete the permission, reconnect, restart, file-failure, accessibility and performance gates in the build plan. Test with three real pilot boards using authorized assets. Record observed limits and unresolved defects. Prepare a production checklist and rollback procedure based on evidence.
```

## Milestone 5 prompt: workshops and broader file support

```text
Implement milestone 5 as separate small changes with clear acceptance gates.

Add server-timed sessions, transactional vote budgets, reveal-only results, follow/presenter controls and private-draft reveal. Keep confidential drafts out of other participants' sync data. Preserve voting anonymity in participant-facing APIs; do not promise anonymity from administrators unless the storage design actually provides it.

Add mind maps with editable nodes and automatic layout, basic tables and Kanban cards, and save-as-template. Keep these features lightweight and integrate them into existing navigation.

Add Office previews through a conversion-provider interface, then validate real DOCX/PPTX/XLSX fixtures and font substitutions. Add HEIC/HEIF and extended media support only for tested converters/codecs. Retain original files and show conversion limits.

Add Google Picker with per-file Drive permission. Distinguish linking to an original from importing a dated copy visible to board collaborators. Handle OAuth expiry, denied access, Google-native document exports, binary downloads, export limits and explicit refresh. Do not build silent two-way sync.

Add expiring guest review links, snapshot history UI, CSV export and asset-complete native archive import/export with a round-trip test. Update documentation and PROGRESS.md after each subfeature.
```

## Milestone 6 prompt: AI features

```text
Implement milestone 6 after the core product gates pass. Verify current official OpenAI documentation and choose available models through configuration.

Start with: summarize selected objects, suggest groups for selected notes, and generate a new editable frame from a brief. Use the Responses API with a structured operation schema. Keep provider/model choices behind an adapter and secrets on the server.

The server gathers only authorized selected content. Model output is a proposal, not direct execution. Validate every operation, object reference, coordinate, count and permission. Show a preview, then apply only after the user's action. Preserve an undo/checkpoint path. Recheck the board version before applying stale proposals.

Handle refusals, truncation, invalid references, rate limits, timeouts and provider errors. Do not allow document text to authorize tool calls, external sharing or permission changes. Keep per-workspace spend caps and usage records.

Add transcription-linked notes for recordings once basic AI edits are stable. Preserve timestamps and asset-version references. Optional image generation should be an explicit separately budgeted action.

Evaluate on a small representative collection of authorized briefs and boards. Verify correct object placement, useful grouping, grounded summaries and no cross-workspace access. Report actual results and remaining failure cases.
```

## Daily review prompt

```text
Review only the changes since the last verified checkpoint against the active milestone. Prioritize:
1. Data loss, overwrite and split-room risks.
2. Workspace/board/file permission errors.
3. Reconnect, retry, deploy and crash behavior.
4. File processing, export and recovery correctness.
5. User-visible usability and performance regressions.

Show evidence for each concrete issue. Fix confirmed defects within scope, run relevant checks and update PROGRESS.md. Do not add unrelated features or repeat broad testing without a specific remaining risk. Summarize what now works, what was actually verified, and the next smallest step.
```

## Decisions that must remain visible

- tldraw commercial license price and included modules are unresolved until quoted.
- Twenty editors and large-board responsiveness are test targets, not capacity guarantees.
- Render collaboration initially has one instance and a short interruption during deployments.
- Character-level simultaneous editing inside a note needs an explicit prototype decision.
- Uploading a format does not imply native editing or even a preview.
- Public SaaS, full enterprise parity and lossless Miro migration are outside the first release.
