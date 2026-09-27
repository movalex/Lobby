# What users love and hate about Miro and its alternatives (user-voice research)

Date: 2026-09-26. Scope: Miro, FigJam, Mural, tldraw, Excalidraw and Milanote, as seen by creative/agency teams, workshop facilitators, and the clients and reviewers they invite. Purpose: turn recurring user praise and pain into concrete product decisions for Draftroom (our own brand and design; we study patterns, not assets).

Companion documents: [../Miro_Clone_Build_Plan.md](../Miro_Clone_Build_Plan.md) §2–4 (workflows, value priorities, feature scope) and [miro-official-behaviors.md](miro-official-behaviors.md) (what Miro documents). This file covers what users *say*, not what vendors document.

---

## 0. Summary: the ten things that matter most for Draftroom

1. **Big, image-heavy boards must stay fast, including in live sessions with 20–30 people.** This is the most frequent and most intense complaint across every review site, the Miro community and the App Store. Creative mood boards are the worst case: one team reported ~3,000 images on one board (§4 F1).
2. **Boards rot into clutter.** Users and facilitators both want structure that survives the session: frame outline, search, tidy-up/archive, clear entry point (§4 F2).
3. **Clients must get in with no account and no confusion,** with obvious sharing state and owner-controlled download/export rights (§4 F3, §6).
4. **No per-seat anxiety.** Creative teams resent paying per client or per occasional collaborator. Draftroom is internal, so we can simply not have that friction (§4 F4).
5. **Phone and iPad are where Miro is weakest.** Crashes on large boards, poor Pencil support, keyboard covering text. Our phone scope (view, comment, upload) must actually work on heavy boards (§4 F5).
6. **Text editing is a daily papercut:** click-count to edit, auto-shrinking sticky text, missing justify/line spacing, limited fonts (§4 F6).
7. **Exports must look like the work.** Blurry PDFs, rasterized embedded PDFs, no comment export, viewers who can't export and resort to screenshots (§4 F7).
8. **Facilitators need control and calm:** timer, voting, silent brainstorming, anonymity, locking, follow/summon, a view of where everyone is, and a board that works as a decision record afterwards (§5).
9. **Creatives need media-native behavior:** consistent image sizing on insert, auto-arrange grids, web clipping, rich link cards, GIFs that play, video you can comment on, storyboards that renumber themselves (§7).
10. **What keeps people on Miro is low-floor, real-time co-presence plus one place for references, ideas and decisions.** Keep the default UI minimal and fast (the tldraw/Excalidraw praise) without losing that breadth (§3).

Market context that raises the stakes: on 2026-09-10 Bending Spoons announced an agreement to acquire Miro for $1.355B enterprise value, expected to close in Q4 2026 (Bending Spoons investor newsroom). Hacker News commenters immediately discussed price increases and migration (§1).

---

## 1. Context as of September 2026

| Fact | Status | Why it matters |
|---|---|---|
| Bending Spoons agreed to acquire Miro, $1.355B EV, close expected Q4 2026 | Verified (investor newsroom page, fetched 2026-09-26) | HN users advise migrating off; one says "If you’re using it, you should plan to migrate off ASAP." (cameldrv, HN, 2026-09-10). Another notes it "has strong vendor lock-in" (0xbadcafebee, HN, 2026-09-10). Import and export portability become selling points. |
| Price hikes after other Bending Spoons acquisitions (800% and 1,400% Harvest renewals) | UNVERIFIED (HN user reports only) | Signals fear of lock-in, not a fact about Miro's future pricing. |
| Miro Free: three most recent boards editable; no guest or visitor roles; anyone invited on Free becomes a paid-seat member | Verified (miro.com/pricing raw page text) | Seat and board limits drive much of the pricing frustration. |
| Miro Starter adds visitors via public link with no account; signed-in guests (no paid seat) on Business | Verified (pricing page text) | Guest/visitor rules are plan-gated and confusing (§4 F3). |
| Miro per-seat prices ($8 Starter, $20 Business, billed yearly) | UNVERIFIED (prices render client-side; a fetch summary reported these, raw HTML showed only "$20") | Do not quote as fact. |
| FigJam open sessions: no account, visitors enter a name, last 24 hours, cannot comment, paid plans only, not billable | Verified (Figma Help Center) | The model for friction-free workshop access, and its main annoyance (24-hour reset). |
| Microsoft Whiteboard being discontinued | UNVERIFIED (several r/productivity users, 2026) | Some displaced users want tablet ink plus screenshot and PDF annotation. |

---

## 2. Method, sources and how themes were ranked

**Sources inspected (all accessed 2026-09-26):**

| Source | What was read | Access method | Notes |
|---|---|---|---|
| TrustRadius, Miro | 10 full reviews (March 2026), 25 detailed pros/cons (April 2024), 25 "alternatives considered" answers (April–May 2024) | Wayback Machine snapshots (live site blocks automated access) | Nearly all marked **incentivized** |
| TrustRadius, FigJam | 3 detailed reviews (2022) | Wayback | |
| G2 | 22 Miro reviews (mostly Dec 2025–Jan 2026), 16 Mural (Jan–Feb 2025), 25 FigJam (2023–2024) | Wayback (raw HTML parsed) | Many incentivized |
| Capterra | Miro: 12 raw reviews (archived 2024) plus about 50 reviews dated 2025–2026 via a summarizing fetch; Mural and FigJam about 25 each (summarizing fetch); Milanote 20 raw (archived 2024) plus summaries | Mixed | Summarized content is **paraphrase only; no quotes taken from it** |
| Product Hunt | Reviews pages for Miro, Milanote, tldraw, Excalidraw | Direct HTML | Reviewer names not reliably attributable; cited by role |
| Apple App Store (US) | 243 most recent Miro iOS reviews (2022–2026), 153 rated 3 stars or lower | iTunes RSS JSON | Mobile-specific by nature |
| Miro Community | Top 200 Wish List ideas by votes (with status); 7 performance, export and guest-access threads | Direct HTML | Votes accumulate over years; a demand signal, not a survey |
| Reddit | r/UXDesign (7 threads plus searches), r/agile, r/graphic_design, r/Filmmakers, r/productivity | Reddit RSS | |
| Hacker News | Miro acquisition thread (2026-09-10, 76 comments), Miro vs MS Whiteboard (2023), "Why is Excalidraw so good?" (2021), tldraw launch (2021), Milanote Show HN (2017) | Algolia HN API | Developer-heavy audience |
| Facilitator and design blogs | Facilitator School "Miro vs Mural" (Daniel Wirtz, updated 2025-05-16); several vendor comparison blogs | WebFetch/WebSearch | Vendor-written comparisons treated as UNVERIFIED |

**Ranking.** Each theme is ranked by (a) **breadth**: how many independent source types raise it; (b) **frequency**: counts in the samples coded below plus Miro Wish List votes; and (c) **intensity**: language about lost work, "deal breaker", churn, or failed live sessions. This is directional evidence, not a statistically representative survey. Review sites over-sample happy, incentivized users. The App Store over-samples angry mobile users. Hacker News over-samples developers.

**Complaint coding (manual unless noted).** Figures are the number of reviews mentioning the theme critically.

| Theme | TrustRadius Miro 2024 detailed (n=25) | TrustRadius Miro 2026 (n=10) | G2 Miro 2025–26 (n=22) | App Store Miro ≤3★ (n=153, keyword-coded) | Capterra Miro 2025–26 page 2 (n=25, summarizer clusters, UNVERIFIED) |
|---|---|---|---|---|---|
| Performance / large boards | 7 | 2 | 5 | 29 (crash, lag, won't load) | 8 (with clutter) |
| Clutter / navigation / organization | 6 | 3 | 3 | 7 | (in the 8 above) |
| Guest access / sharing / sign-in | 3 | 1 | 3 | 24 (mostly sign-in loops) | 7 (with pricing) |
| Pricing / seats / plan gates | 1 | 1 | 3 | 12 | (in the 7 above) |
| Text editing / typography | 4 | 1 | 1 | 10 | – |
| Export / portability | 2 | 1 | 2 | 11 | 2 |
| Media handling (images, video, PDF) | 1 | 3 | 1 | 7 | – |
| Accidental edits / locking | 4 | 0 | 0 | 4 | – |
| Offline / connectivity | 2 | 2 | 0 | 3 | – |
| Connectors / diagram precision | 1 | 0 | 4 | 2 | – |
| Mobile / tablet | 0 | 0 | 1 | nearly all | 3 |

---

## 3. Delights: why people stay

Ranked by breadth and frequency.

### D1. Real-time co-presence without screen-sharing (all tools, every source)
Seeing cursors and edits live, and everyone adding input directly, is the single most praised quality. Reviewers call it inclusive: "Allows everyone to provide their input, both introverts and extraverts alike" (Employee, Professional Services, TrustRadius, 2026-03-10). It also replaces attachment ping-pong: "I no longer send each other attachments via email as if we’re insane." (Brent S., CCO, G2, 2025-12-22).
**Draftroom:** Build-plan priority 1 is right. Add lightweight social signals that FigJam users single out as fun: cursor chat, reactions, high-fives ("cursor chat and high-fives", Tynan Purdy, Design Strategist, TrustRadius, 2024-05-09, on what Miro should borrow from FigJam). Presence must stay legible at 20–30 people: collapse avatars and let people hide cursors (§5).

### D2. Low floor: anyone can join and contribute in minutes
Miro wins stakeholders because non-designers can "collaborate with others right away, without needing to give everyone an introduction" (Mattias L., CIO, G2, 2026-01-05). Excalidraw and tldraw are loved for "Nice, clean, fast. No need of a sign in." (skywal_l, HN, 2021-11-18). One facilitator used double-click-to-create-sticky with first-timers to "reduce their anxiety of teleporting into this weird virtual space" (travoltek, r/UXDesign, 2022-05-10).
**Draftroom:** Treat the first 60 seconds of a visitor as a release gate. Arrive at the right frame, see one obvious action, and double-click to create a note (Miro Wish List "Bring back double click to add the last object used": 159 votes). No product tours or modal stacks (§4 F11).

### D3. One place for references, ideas, plans and decisions, persistent for weeks
Creative teams use the board from kickoff research through planning: "helpful to see all of the research laid out together" (Employee in Engineering, TrustRadius, 2026-03-09). Teams stay because of breadth: "the team just... never left it" (achinius, r/UXDesign, 2026-02-20). A facilitator values that the board can "remain active for several weeks" (r/agile, 2026-09-15).
**Draftroom:** Keep uploads, link cards, notes, frames and comments in one canvas (plan priority 4). Design for long-lived boards, not just one-off sessions. That means archive, history and decision capture (§4 F2).

### D4. Templates as a fast start, but small ones
Templates are praised everywhere, with a consistent counter-signal: "The templates they provide are usually WAY more than is needed." (Margo P., Operations Director, G2, 2025-12-19). Another reviewer struggles to bridge unstructured stickies and polished frames (Matus M., Product Manager, G2, 2025-12-17).
**Draftroom:** Ship the six planned templates, plus **composable blocks** that can be inserted alone (a voting area, a 2×2, a storyboard strip, a mood-board grid, a retro column set). Make "save selection as block" a broader-release item.

### D5. Facilitation tools that feel good
Timer with music, voting and follow are repeatedly named as the reasons Miro, Mural and FigJam beat plain whiteboards. FigJam users describe "Delightful, one of a kind features like the timer with music, stickers, washi tape" (Verified User, Financial Services, G2, 2023-11-17).
**Draftroom:** The facilitation set in plan §9 is the right core. Give it personality in our own brand: our own stamp set, our own timer sounds with per-person mute (§5).

### D6. Output looks good by default
A design-consulting reviewer credits Miro's constrained styling: "you have to work HARD to make things ugly" (Todd Greco, Director of Experience Design, TrustRadius, 2024-05-02). Milanote is praised for boards that look presentable to clients.
**Draftroom:** A constrained, brand-quality default palette, type scale and spacing, with a workspace brand kit (fonts and colors) for client-facing pitch boards (§4 F6).

### D7. Speed and minimalism (tldraw, Excalidraw)
tldraw is described as "fast and intuitive which makes it easy to simplify any idea" (Product Hunt reviewer, tldraw page). Excalidraw users praise its "distraction free interface" (Product Hunt reviewer). On HN, a tldraw user wrote: "The mobile web experience (Safari) for this app is really remarkable." (ughitsaaron, HN, 2021-11-18).
**Draftroom:** We inherit tldraw's fast core. The risk is burying it under features. Every added panel must earn its place and be hidden until needed (plan §3: keep advanced tools out of the default toolbar).

### D8. Links and media become rich objects
"Links are immediately turned into interactive blocks" (Employee in Engineering, TrustRadius, 2026-03-09). Milanote users love "the ability to mix notes, images, links, and files on the same board" (Product Hunt reviewer, Milanote page).
**Draftroom:** Safe server-side unfurling into link cards (plan §8) is a delight feature, not plumbing. Prioritize it for the first release (§7).

---

## 4. Frustrations, ranked by frequency and intensity

### F1. Performance on large, image-heavy and crowded boards (rank 1: broadest and most intense)
**What users say.** Slow loads, lag and hangs on big boards. It gets worse with many hi-res images and many live participants. Several say Miro has become slower over time as features were added.
- "I don’t like how SLOW it comes when we have 20+ people working together." (Bruna R., Designer, Capterra, 2024-02-19)
- "This can really kill the momentum in a workshop." (Marian D., Portfolio Manager, G2, 2026-01-12)
- "very image heavy (~3000 images) and slow down quickly" (Miro Community poster on mood boards and concepting, 2021-05-14)
- "I can’t risk workshops not flowing well as participants become frustrated with the speed." (Miro Community, thread "Miro has become too slow", 2022+)
- "potentially been feature-creep which has slowed down the responsiveness of the core interface" (Rhydian L., Senior Product Design Engineer, G2, 2025-12-19)
- Specific triggers named: "too many large images/screenshots that were pasted onto the board" (Justin B., G2, 2026-01-12); "performance issues crept in with hires images" (Manager in Marketing, TrustRadius, 2026-03-10). Also noted: bugs when several people add photos at once (Ilva M., UX designer, G2, 2026-01-06), and lost content on overfull boards (Employee, Finance, TrustRadius, 2024-04-11).
- Competitors are not immune. A Mural user says it can "run a little slow sometimes and take up a good bit of memory" (Spencer H., SQA Analyst, G2, 2025-02-21). A FigJam graphic designer reports performance glitches with large files (paraphrase, Jason M., Capterra, 2024-11-23, UNVERIFIED wording).

**Implications for Draftroom**
1. **Never render originals on the canvas.** Use the sharp derivative pipeline from [file-previews.md](file-previews.md) and pick a derivative size in `TLAssetStore.resolve` from `steppedScreenScale` and `dpr` (interface confirmed in [sync-client.md §3.1](sync-client.md)). Serve the original only for download or export (`shouldResolveToOriginal`).
2. **Downscale absurd uploads for display** (keep the original). The Miro Wish List idea "Automatically reduce the resolution of images over 32 megapixels" has 118 votes.
3. **Add a performance release gate built from creative reality.** Suggested fixture: a mood board with 2,000–3,000 images, a 40-frame storyboard with PDFs and video posters, and a workshop board with 20–30 concurrent editors adding notes and photos. Measure time to interactive, pan/zoom frame times and sync latency on a mid-range laptop and an iPad. Plan §1 targets 20 simultaneous editors; users complain at "20+", so test at 30.
4. **Load progressively.** The viewport first; placeholders for off-screen or loading media; editing never blocked by image loading.
5. **Board health.** Show a quiet indicator when a board is getting heavy. Offer "move selection to a new linked board" (asked for by Robert Strouse, Director of Digital UX, TrustRadius, 2024-04-09: "select these elements and export them to a 'child' board").
6. **Guard against regression.** Track the gate's numbers per release. The "slower every month" narrative is what users remember.

### F2. Clutter, navigation and organization (rank 2)
**What users say.** Boards grow into sprawl. People get lost, can't find features or content, and zooming in loses context. Board lists across projects and clients get messy.
- "the board becomes a massive collection of workshop leftovers" (quarterly-planning facilitator, r/agile, 2026-09-15)
- "People who don’t use it regularly can get lost on a large canvas." (same facilitator)
- "inevitably you spend more time organizing the board than actually getting work done" (pjm331, HN, 2026-09-10)
- "you often have to zoom in, which then cuts off other parts" (Kristel P., Program Coordinator, G2, 2025-12-26)
- "there are so many and sometimes they move and are hard to find" (on Miro's functions; Employee, Professional Services, TrustRadius, 2026-03-10)
- An empty viewport on open "made me think that my work was lost" (Darrell Spearman, Consultant, TrustRadius, 2026-03-09)
- Wish List demand: Folders in projects 1,436 votes (In Development); Find & Replace 869 (Open); Layers 813 (Delivered); Archive projects and boards 311; Tags on all shapes 262; Nested frames 198; Collapsible frames 146; smaller frame titles when zoomed out 129.
- The same problem appears in the alternatives. FigJam users lacked pages and search (r/UXDesign, 2023). A Milanote user found that nesting content made it "nearly impossible to know where what asset is stored" (Capterra reviewer, 2022-04-12).

**Implications for Draftroom**
1. **Frame outline, minimap and board search with jump-to** (already in plan §3). Search must cover sticky text, text, frame names, file names and comment text.
2. **Find & replace** across the board (869 votes). It is cheap to build and valued by pitch teams renaming a campaign line.
3. **Open to a meaningful place.** Resume the user's last viewport. If that is empty, fit to the "home" frame. Never show a blank canvas.
4. **Tidy-up tools for facilitators:** collapse or hide finished frames; move a frame to a "parking lot" area or a linked board; bulk-archive leftovers. Include a post-session "decision record" frame template (§5).
5. **Workspace organization by client and campaign** (folders or projects, starring, archive) from the first release. The top organizational request on Miro's Wish List is exactly this.
6. **Tags and filters** on notes and cards (broader release). They also power affinity-sorting, which a BBC Creative Director singled out as a pro ("Automated affinity sorting through tagging", Dan Ramsden, TrustRadius, 2024-04-06).
7. **Readable at every zoom:** frame titles and outline labels stay legible when zoomed out.
8. **Keep the UI stable.** Do not move tools between releases. Mural users complain that relocated menu items break training (paraphrase, Sharon H., Capterra, 2025-03-21).

### F3. Guest and client access, and sharing confusion (rank 3)
**What users say.** Clients hit sign-up walls. Guest features depend on the plan. Visitors get a reduced toolbar. People can't tell whether a board is private or shared. Link-based access is the thing people love when it works.
- Love: "it's easy to collaborate with others who don't have a license" (Shelbie Hasbrouck, Director PMO, TrustRadius, 2024-05-08). She adds that the alternative is "going to be clunky for them to have to log in/sign up".
- Love: Mural preferred for "workshops with clients who don’t need accounts or logins" (Crab_Shark, r/UXDesign, 2026-02-20).
- Pain: "Especially for when non-regular users have to sign in or participate." (Brian L., Digital Marketing Strategy, G2, 2024-03-21)
- Pain: "Hard to know when a board is private and when it's been shared" (Employee in Engineering, TrustRadius, 2026-03-09)
- Pain: "who has access to which board is not easy to see" (Simon Pipkin, Senior PM, TrustRadius, 2024-04-09); "the share button is somewhat hidden" (Mattias L., CIO, G2, 2026-01-05)
- FigJam's workaround has its own tax: "resetting the 24-hour timer is a bit tedious" (Jason W., Senior Director UX, G2, 2023-05-15)
- A Miro Community moderator confirmed that anonymous visitors have very limited tool access, for example no uploads, and need a free account for more (Miro Community, "Guest access to board without creating an account?").
- Wish List: "Allow anonymous visitors to edit their names" 379 votes (Beta); "Customize toolbar for anonymous guest editors" 49.

**Implications for Draftroom**
1. **Review link = name-only entry, commenter by default.** Owners can require sign-in, set expiry (plan §9) and upgrade a link to editor for a workshop. Visitors can edit their display name.
2. **Visible sharing state on every board header:** private / workspace / link (view, comment or edit) / expiring, with a one-click "who has access" list. The Share control stays in a fixed, prominent place.
3. **Visitor toolbar parity for invited sessions.** If a facilitator invites a visitor as an editor, uploads and paste work too. Otherwise photo-of-sketch exercises break (§5).
4. **Workshop sessions, not 24-hour sessions.** Tie visitor edit access to a scheduled session window the facilitator controls, with one-click extend.
5. **Owner-controlled download and export for viewers** (§6).

### F4. Pricing, seats and plan gates (rank 4: frequent, and intense for small studios)
**What users say.** Per-member pricing hurts agencies whose collaborators are occasional. Free tiers are too small for real client work. Seasonal users feel punished. Acquisition news adds fear of price increases.
- "it is also expensive to subscribe to it" (Brent S., G2, 2025-12-22); a small-agency reviewer says each client needing a seat makes costs add up fast (paraphrase, Keith K., Capterra, 2026-08, UNVERIFIED wording).
- "no option for a day pass or limited time excess" (Manager in Marketing, TrustRadius, 2026-03-10)
- On FigJam: "the licensing can be annoying" (Todd Greco, TrustRadius, 2024-05-02)
- Milanote: "I love Milanote but the pricing is too expensive for me." (JaniHazard, r/graphic_design, 2022-02-12); "purchasing a yearly subscription for 80 days of use is a waste of money" (Capterra reviewer, 2022-02-10); card limits across all boards frustrate free users (Capterra, 2022-09-26).
- A long-time consultant-plan user described a confusing forced plan change and poor support communication (paraphrase, Employee, Finance, TrustRadius, 2024-04-11).

**Implications for Draftroom**
1. **No per-seat friction for guests or clients** in our access model. It is an internal tool, so collaborators are grants, not seats. Say so in the UI ("Clients you invite are free").
2. **No board or card caps** that push people to delete history.
3. **Time-boxed client access** (the "day pass" wish) as a link option: "access for this pitch week".
4. **Migration path:** consider a basic Miro import (notes, text, shapes, images, frames, connectors) via Miro's export/REST API as a broader-release item. Plan §4 defers pixel-perfect import, but a good-enough importer may be the strongest adoption lever in Q4 2026. (UNVERIFIED feasibility; needs an API spike.)

### F5. Mobile and tablet (rank 5: very intense, narrower audience)
**What users say.** Miro's iOS app crashes or refuses to load large or image-heavy boards. It feels like a wrapped website. Pencil and keyboard support is weak. Milanote's phone app lacks the canvas.
- "This is clearly just a wrapper of the Miro website" (Void3d, App Store, 2026-03-19)
- "The app still crashes due to memory issues." (on a 12" iPad Pro; assthmaa, App Store, 2026-06-02)
- An artist with many reference images: "This app cannot handle it on the iPad" (Honesty16., App Store, 2025-04-05)
- "the keyboard constantly blocks it, so I can’t see what I’m typing" (RoyalTiara, App Store, 2024-09-28)
- "Pretty much unusable on tablet for left-handed people using apple pencils." (Lefty Designer, App Store, 2023-06-07)
- Other reports: palm contact stops Pencil input (ZeroC00lio, 2025-10-23); the app restarts from scratch after switching apps (ABR3434, 2023-10-31); magic-link sign-in loops on iPad (two reviews, September 2026).
- Milanote: "on mobile its close to unusable" (Product Hunt reviewer); the mobile app shows only a card list, not the canvas.
- FigJam: the iPad app's file size restriction blocks on-the-go sketching (paraphrase, Sarah Z., Product Designer, G2, 2023-05-09).

**Implications for Draftroom**
1. **Phone: view, comment and upload must survive heavy boards.** Viewport-only loading plus small derivatives (F1). Fall back to a frame list and read-only mode rather than crashing. Show the real canvas, not only a list.
2. **Camera-to-board upload** on phone, used for sketch-on-paper exercises and set photos (§5, §7).
3. **iPad basics before iPad breadth:** Pencil with palm rejection, a toolbar that can move for left-handed use, trackpad pinch zooms the board not the UI, hardware keyboard shortcuts, and a text editor that scrolls into view above the software keyboard.
4. **Keep state on app switch** (last board and viewport). Make sign-in work in the same browser context (web-first avoids the app-wrapper trap).
5. Add an iPad to the performance gate (F1).

### F6. Text editing and typography (rank 6: constant papercuts)
**What users say.** Too many clicks to edit. Sticky font size changes unpredictably. Basic formatting such as justify, line spacing and mixed sizes is missing. Few fonts. New objects come in at the wrong size for the current zoom.
- "Some basic functions are missing: you can't justify text, for example" (Richard James, Strategy Consultant, Interbrand, TrustRadius, 2024-04-10)
- "Sticky notes only have two available fonts--please enable more fonts" (Team Lead, R&D, TrustRadius, 2024-04-12)
- On FigJam: "two clicks to edit text in a sticky" (Marissa L., UX Researcher, G2, 2023-05-15)
- On Mural: "Text boxes and the formatting of text held within doesn't match the high standards" (Steven H., Business Analyst, G2, 2025-01-22)
- When zoomed out, "the text size is limited", and new elements should match the board scale (Ishit P., Venture builder, Design, Capterra, 2024-03-07)
- "Text boxes are hard to use at times" (resizing in one direction; Employee in Engineering, TrustRadius, 2026-03-09)
- Wish List: custom typeface 693 (Delivered); custom sticky colors 252; character limit for text boxes 260; free text formatting in stickies 231; line spacing 161; text padding 117; rich text editor 91; multiple fonts or sizes in one text box 90; lock sticky text size (several ideas).

**Implications for Draftroom**
1. **Type to edit.** With a note selected, typing starts editing (replace or append by setting). Double-click places the caret. One click never needs two more.
2. **Predictable sticky text:** auto-fit with a per-note "lock size" option, and a board-level default size so notes made at different zooms match.
3. **Rich text in text and notes:** bold, italic, lists, links, alignment including justify, line spacing, and at least two sizes inside one block. Pitch boards need headline and body in one object.
4. **Workspace brand kit:** fonts (self-hosted, licensed) and palette, applied to notes, shapes and frames.
5. **Create at a sensible size for the current zoom** (notes, text and inserted images; see §7).
6. Find & replace (F2).

### F7. Export fidelity and portability (rank 7: less frequent, high stakes for client deliverables)
**What users say.** "Best quality" PDFs come out low-res or fail. Embedded PDFs export as blurry raster. Viewers cannot export. There is no export for comments, structure or tables. Users fear lock-in.
- A Miro representative explained that embedded "pdf documents will be exported as pictures and can be displayed with pixel blur" (Miro Community thread 4724)
- A user's high-quality PDF export dropped from about 300 MB to 30 MB: "huge difference in file size and quality of the exports. Not useable." (Miro Community thread 16806)
- A viewer who needed to show clients a board: "No just printscreened everything" (Boring-Amount5876, r/UXDesign, 2024-11-01)
- "Exporting data into other formats (like Word or Excel)" (Employee, Professional Services, TrustRadius, 2026-03-10); "the inability to easily print the full board is a limitation" (Kristel P., G2, 2025-12-26)
- "Have templates that are formatted for export, things can end up small" (Michael Boltie, TrustRadius, 2024-04-11)
- FigJam exports only PDF or image (paraphrase, Devansh R., G2, 2023-06-06).
- Wish List: Export to PDF with comments 298; Export frames to PowerPoint 290; Export transparent PNGs 286; Export comments to CSV/Excel 146; PDF export with frame names as table of contents or bookmarks 102; Export to SVG 98; API backup/export 69.

**Implications for Draftroom**
1. **Frame-ordered PDF export that stays sharp:** vector shapes and text; images from the original or a high-resolution derivative; embedded PDF pages re-rendered from the source at export resolution, not screenshots. Include frame names as PDF bookmarks. Add this to the export release gate with a fixture containing an embedded PDF.
2. **PNG with transparent background** and SVG for selections (designers paste these into decks).
3. **Comment export** (CSV or PDF appendix: author, date, status, anchor frame or object). Agencies use this as the feedback record.
4. **Owner toggle "Viewers can download/export"** (Miro delivered a similar guest-download control; Wish List 88 votes).
5. **Native, asset-complete board export** (plan §9) marketed as the answer to lock-in.
6. PPTX export of frames: broader release, after PDF.

### F8. Accidental edits and locking (rank 8: facilitator pain)
- "Too easy for collaborators to move the background, locking certain items is fiddly" (Verified User, Analyst, TrustRadius, 2024-04-11)
- On frames: "new users often accidentally move them if we have forgot to lock them" (Program Manager, Construction, TrustRadius, 2024-04-06)
- Mural reviewers report the same: participants move board items, and admins must remember to lock everything (G2, January 2025).
- Arrows get drawn by clicking the wrong part of a sticky (Employee, Finance, TrustRadius, 2024-04-11).

**Implications:** Template backgrounds, instructions and frame chrome are **locked by default**. There is a facilitator lock that visitors and guests cannot undo. Modifier-click selects locked items for owners (Wish List 76 votes). Connector handles need generous hit areas that do not overlap the note's edit and move targets. Undo is per user and never undoes someone else's work.

### F9. Offline, connectivity and "did it save?" (rank 9)
- Miro Wish List: "Offline mode" has 1,888 votes, status Open, opened 2020. Commenters describe lost work on planes, trains and flaky venues.
- On Excalidraw: "anything I created in live collaboration mode wouldn’t be saved" (Product Hunt reviewer)
- iPad/macOS users report lost sync and lost work several times an hour (tbearwilson, App Store, 2023-04-18).

**Implications:** Keep the plan's saving-state feedback prominent (saved / syncing / offline, with pending edits). The m0 skeleton already passed an offline-edit-then-reconnect test ([SYNTHESIS.md](SYNTHESIS.md)). Turn that into a visible user promise: "You're offline. Changes will sync." Offer read-only cached copies of recently opened boards in the broader release. Presenting from a cached board in a venue with bad Wi-Fi is a real creative-pitch need.

### F10. Connectors and diagram precision (rank 10 overall; higher for diagram users, lower for creatives)
- G2 Miro reviewers (4 of 22) complain that arrows snap to the wrong side, can't sit behind images, and auto-arrange breaks layouts. FigJam and Mural reviewers say the same.
- tldraw HN launch feedback asked for staying in the current tool after drawing and typing into a selected shape (2021).

**Implications:** Follow the connector minimums in [miro-official-behaviors.md](miro-official-behaviors.md) §3. Test explicitly that connectors can be ordered behind images, and that there is no auto-layout unless the user asks for it.

### F11. Bloat, tours and UI churn (rank 11: low frequency, strong emotion)
- "each new action resulted in another 'tour'" (politelemon, HN, 2021-11-05, on first-run Miro)
- "I found it a bit bloated" (arnvald, HN, 2026-09-10). A G2 reviewer blames feature creep for slowness (F1).
- An agile coach built a lighter tool because retros became "overengineered Miro boards" (r/agile, 2025-06-21).

**Implications:** No stacked onboarding tours and no upsell modals. Use contextual hints at most, dismissable forever. Progressive disclosure: the default toolbar holds a note, text, shape, pen, arrow, frame, upload and comment. Everything else lives one level down.

### F12. AI features that underdeliver (rank 12: noted, not a driver)
Several 2026 TrustRadius reviewers list AI shortcomings as their main con: an AI template feature that "Doesn't come close" on organization; "AI Accuracy". A G2 reviewer found manual work better than the AI (Naveen G., 2026-01-07).
**Implication:** This confirms plan §4: core flows must not depend on AI. When AI arrives, scope it to assistive, reviewable actions such as clustering suggestions and summaries.

---

## 5. What facilitators need during live sessions

Evidence comes mainly from a quarterly-planning facilitator (18–30 people, r/agile, 2026-09-15), the Facilitator School comparison, Mural and FigJam reviewers, the r/agile retro thread and the Miro Wish List. The facilitator's list is the clearest spec: "silent brainstorming, clustering, voting, process mapping, dependency discussions" plus "a final artifact people can revisit after the meeting". A Mural user praised the outline: "I appreciate the outline feature as it helps keep my team organized during facilitation." (Marie M., Enterprise Agile Coach, G2, 2025-02-20).

| Need | User evidence | Draftroom implication | Release |
|---|---|---|---|
| Prepare a board participants can't break | Locked backgrounds and instructions are a prerequisite (r/agile facilitator); accidental moves (F8) | Lock-by-default template chrome; facilitator-only unlock | First |
| Bring people to the right place and see where they are | "I can't easily tell where my clients are looking or if we've lost anyone" (Ben D., Mural, G2, 2025-02-21); follow, summon and teleport are core (Facilitator School) | Follow and summon, with easy escape (plan §2), plus a **facilitator overview**: participant list with each person's current frame, and "idle / not on this frame" flags | Broader |
| Timer | Loved with music; "Music is very loud, with no way to adjust at my end" (Analyst, TrustRadius, 2024-04-11) | Server-timed timer (plan §9) with per-participant mute and volume; optional sound | Broader (early) |
| Voting | Named by nearly every facilitator; voting CSV export is a delivered Wish List item (167 votes) | Vote budgets and reveal (plan §9); export results with the board | Broader (early) |
| Silent brainstorming and anonymity | A retro lead reports people won't raise contentious points when cursors and names show: "they can't hide their own from everyone else" (tallpaullewis, r/agile, 2026-03-26); Wish List "Hide my cursor" 147; private mode 226 (Delivered) | Server-side private drafts (plan §9); **session setting "anonymous contributions"** that hides authorship on notes and cursors for the activity; "hide my cursor" toggle | Broader |
| Quick reactions | "Easier way to quickly add a thumbs up or "+1"" (Simon Pipkin, TrustRadius, 2024-04-09); raise-hand and reactions delivered in Miro (80 votes) | One-key +1 and emoji stamps on any object; hand raise | Broader |
| Show and hide content per phase | "to be able to show and hide sections" (Allan K., UX Designer, FigJam, G2, 2023-05-09); hide/reveal frames 185 (Delivered) | Facilitator hide/reveal of frames for everyone; hide frames from presentation order | Broader |
| Double-click to create | A facilitator's first-timer trick (§3 D2); 159 votes | Double-click on empty canvas creates a note of the last-used color | First |
| Stable under load | Lag in live workshops with many members (Consultant, TrustRadius, 2026-03-10; Marian D., G2) | F1 performance gate at 30 participants | First (gate) |
| Participants join without friction | Visitors with a name only (F3) | Session link with name entry and editor rights for the session window | Broader (early) |
| Photo-of-sketch exercises (crazy 8s) | Facilitators have people photograph paper sketches and paste them in (r/UXDesign, 2021-04-22) | Phone camera upload straight to a named frame; visitors allowed to upload in sessions | First (phone upload) |
| Present without juggling apps | A facilitator worried about switching between FigJam and slides mid-workshop (r/UXDesign, 2022-01-27) | Frame presentation mode (plan §4) usable mid-session, returning to live editing in one click | First |
| After the session: a decision record | "Our workshop tool becomes a record of why decisions were made" (r/agile facilitator, 2026-09-15) | "Close session" step: snapshot, move leftovers to an archive frame, and add a decisions/actions frame with owners | Broader |
| Breakout groups | Breakout rooms 235 votes (Beta) | Defer (plan says so); frames per group with follow-group is a cheap substitute | Defer |

---

## 6. What reviewers and clients need for async feedback

| Need | User evidence | Draftroom implication |
|---|---|---|
| Open without an account | "share the live board with clients or friends without them needing to signup" (Capterra Milanote reviewer, 2019-12-18); F3 quotes | Name-only commenter links, expiring by default (plan §9) |
| Comments pinned to the right thing, and staying there | Sai Charan S. praises how "easy to leave contextual comments, organize ideas, and track feedback" (G2, 2026-01-05); Wish List "Comments/annotations on moved or duplicated board elements" 224 (Open) | Object-anchored threads that follow moves (plan §9). Define what duplication does: new object, no threads, with a link back. |
| Read the work without comment clutter | "there is no way to hide comments while previewing the board" (Capterra Milanote reviewer, 2019-05-26) | A comments on/off toggle per viewer; resolved threads hidden by default |
| Know who said what and what changed | "My main complaint about both is tracking changes to work." (bigredbicycles, r/UXDesign, 2021-02-06); Milanote reviewers want to see who left feedback (paraphrase, SoftwareAdvice summary) | Activity feed per frame ("changed since you last looked"); named checkpoints before client reviews (plan §9 history) |
| A feedback record the agency can file | Export comments 298 and 146 votes (Open) | Comment export (F7) |
| Walkthrough context | Talktrack (Miro's recorded walkthrough) is listed as a pro (Ryan O'Connor, TrustRadius, 2024-04-09); a reviewer pairs Miro "as a combo with Loom" (Product Hunt reviewer); Talktrack download 49 votes | Broader release: a pinned video or voice note on a frame (upload or link), which our video card already supports. Do not build a recorder first. |
| Formal sign-off | A consultant's business users test and sign off inside the board (paraphrase, TrustRadius, 2026-03-10); approval before production saves revision rounds (storyboard sources) | Frame-level review status (in review / changes requested / approved) with who and when; plan lists "review status" as broader |
| Clients can take it away | Viewer export blocked leads to screenshots (F7) | Owner-controlled viewer download/export |
| Notification control | Wish List "Turn off notifications at board level" 64 | Per-board notification setting from day one |

---

## 7. What creatives need for media (images, video, PDFs, mood boards, storyboards)

| Need | User evidence | Draftroom implication |
|---|---|---|
| Image-heavy boards that stay fast | ~3,000-image mood boards (Miro Community); iPad can't handle an artist's references (App Store); VizRef and PureRef named as faster local alternatives | F1 derivatives, LOD and fixtures. This is *the* creative-team requirement. |
| Consistent image size on insert | Miro places images at native resolution, so boards drift in scale: "Pretty soon, everyone is using font size 1500" (Israelshaw, App Store, 2024-11-21) | Insert images at a normalized on-screen size (fit to a fraction of the viewport or a board-default width). Keep the original pixels for export. |
| Arrange references neatly | FigJam "doesn't auto-resize photos into a neat masonry layout with consistent sizing" (Angela F., G2, 2023-05-15); Milanote's column object is praised (HN, 2017) | "Arrange as grid/masonry" for a selection, with equal width or equal height; a mood-board block that auto-flows dropped images |
| Fast capture from the web | "The Google chrome extension also makes it 10x faster to add things" (justajini, r/graphic_design, 2023-10-17) | Drag and paste of images and URLs from the browser in the first release; a web clipper extension in the broader release |
| Paste from design tools | A designer lost simple copy-paste from Illustrator after a Miro update (App Store, 2025-03-18); Wish List "Import SVG objects to be editable" 196 | Paste of image, PNG and SVG (sanitized, rasterized per plan §8) from Figma, Illustrator and Photoshop must be tested fixtures |
| Rich link cards and GIFs that play | Link cards praised (TrustRadius 2026); a designer loves that they can "embed GIFs and have them work as they're supposed to" (Capterra Milanote reviewer); Autoplay GIF 160 votes (Delivered) | Safe unfurling (plan §8); animated GIF and WebP play on the canvas with a board-level "pause animations" option (reduced motion) |
| Video, and feedback on video | "Video support" and "Support for more file formats" as cons (Dan Ramsden, Creative Director, BBC, TrustRadius, 2024-04-06); Upload MOV/MP4 220 votes (In Development); commenting on a specific moment of a video is not supported in Miro (UNVERIFIED, from a search summary of Miro Help) | Plan §8 MP4 poster and click-to-play first. Plan §4 lists **video timestamp comments** as broader: move it up for trailer and cutdown reviews. Any frame grab should become a comment anchor. |
| PDFs on the canvas, and annotation | Users want to place PDF pages on the canvas, draw, highlight and resize (TellAbood, r/productivity, 2026-09-17); blurry PDFs on zoom and export (Miro Community) | PDF page extraction (plan §8) with page images re-rendered at zoom-appropriate resolution, and PDF-page comment anchors (plan: broader) |
| Audio | Upload audio files 221 votes (Open) | Audio card (plan §8 first release) covers voice-over and music-bed reviews |
| Color and brand | Brand colors praised (TrustRadius 2024); custom sticky colors 252; color palette management delivered in Miro (177); Milanote color swatches praised | Swatch object (hex, name, copyable), eyedropper from images, workspace palette |
| Storyboards that renumber themselves | A director's pain: "scissors and tape to reorder, renumbering everything by hand" (thinkyac, r/Filmmakers, 2026-03-27); rough pitch boards must adapt because "client feedback changes the concepts, making new boards from scratch isn't an option" (starboy2008, r/Filmmakers, 2026-09-01) | Storyboard block: a panel strip with auto-numbering, insert and reorder, alternates, shot notes under each panel, and export as a crew PDF. It fits "trailer beats, storyboards" in plan §1. |
| A campaign at a glance for stakeholders | An agency art director wants to "look at an entire campaign at a glance" across static and video assets (itscliche, r/graphic_design, 2022-02-18); a designer wants to show 20–40 images in "an easily digestible layout" (castlebasetone, r/graphic_design, 2022-08-11) | Client-facing "presentation view" of a frame or board: clean grid, no editing chrome, comments optional. Workspace organized by client and campaign (F2). |
| Sketch and draw | Pencil and palm rejection problems (F5); pen smoothing too aggressive for handwriting (tldraw HN, 2021); FigJam users ask for a smoothness slider | Keep tldraw's pen with pressure. Expose a smoothing option. Verify palm rejection on iPad Safari. |
| It won't replace pro tools, and shouldn't | "it won't replace Photoshop or Illustrator" (illustrator on Product Hunt, Miro page) | Keep scope: attachments, previews and annotation, not editing (plan §8 contract) |

---

## 8. What each alternative teaches (patterns to study, not copy)

| Tool | Why people choose it | What they complain about | Lesson for Draftroom |
|---|---|---|---|
| **Miro** | Breadth ("does 80% of everything"), templates, facilitation, easy invites, integrations | Speed on big boards, clutter, pricing and seats, mobile, exports, bloat | Match the core workflows while staying faster and calmer by default |
| **FigJam** | Figma integration, delight (timer music, stickers, washi tape, cursor chat), simple UI, open sessions | No pages or search on big files (2023), the 24-hour open-session reset, extra clicks for text, weak export formats, account needed outside open sessions | Delight and simplicity win designers. Provide the structure (outline, search) that FigJam lacked. |
| **Mural** | Facilitation depth (outline, locking, summon), easy client workshops without accounts | Clunky text, bugs, shortcuts unlike design tools, moving menus, performance on big murals | Facilitator controls and an outline matter. Keep keyboard conventions familiar to designers. |
| **tldraw** | Fast, intuitive, pressure-sensitive ink, good mobile web | Sparse feature set as a product; early feedback asked for tool lock and typing into shapes | Our engine's strength is speed. Protect it with the F1 gate. |
| **Excalidraw** | No signup, instant start, shortcuts, hand-drawn feel that lowers perfectionism | Missing tables and icons; live-collab work not auto-saved (one user) | The "just start" first minute and always-clear saving state |
| **Milanote** | Built for creatives: mood boards, web clipper, link previews, swatches, nested boards, PDF export for clients, "secret link" sharing | Pricing and card limits, a weak mobile canvas, deep nesting that hides assets, and client access (one 2019 reviewer wanted live view-only links without signup) | Creative-native media handling plus flat, searchable organization, and client links without accounts |

---

## 9. Suggested adjustments to the build plan (§3–4)

These are proposals from the evidence above. The plan owner decides.

1. **Add a creative-reality performance gate** (F1): a 2,000–3,000 image board, 30 live participants, and an iPad, measured per release. Put this under plan §13 release gates.
2. **Move up** (from broader to early broader, or first): session links with name-only visitors and edit windows (F3, §5); frame review status (§6); video timestamp comments (§7); comment export (F7).
3. **Add to the first release:** type-to-edit and double-click-to-create (F6, D2); normalized image insert size and "arrange as grid" (§7); open-to-last-viewport or home frame (F2); a visible sharing-state badge and fixed Share control (F3); a viewer export/download toggle (F7); lock-by-default template chrome (F8).
4. **Add to the broader release:** find & replace; tags and filters; storyboard block with auto-numbering; swatch object and workspace palette; facilitator overview of participants; anonymous-contribution mode; decision-record close-out; transparent PNG and SVG export; PDF bookmarks by frame; a basic Miro importer (spike first).
5. **Keep deferred:** breakout orchestration, AI-driven edits, and Frame.io-level media review. User evidence supports those deferrals.
6. **Design principles to write down:** no tours or upsell modals; a stable toolbar; clients are free; never a blank canvas on open; never a screenshot-quality export.

---

## 10. Appendix: Miro Community Wish List signals (top-voted ideas relevant to Draftroom)

Read 2026-09-26 from community.miro.com/ideas sorted by votes (top 200). Votes accumulate since 2020, so this is a demand signal. "Delivered" means Miro marks it as shipped, and the underlying need is still real.

| Votes | Status | Idea | Theme |
|---|---|---|---|
| 2,421 | Open | Dark mode / night mode | Comfort in long sessions (our UI should ship dark mode) |
| 1,888 | Open | Offline mode | F9 |
| 1,436 | In Development | Folders in projects | F2 |
| 1,004 | Delivered | Collapsible mind-map branches | Diagramming |
| 869 | Open | Find & replace text | F2, F6 |
| 813 | Delivered | Layers | F2 |
| 693 | Delivered | Custom typeface/font | F6 |
| 590 | Delivered | Board background color | D6 |
| 379 | Beta | Anonymous visitors can edit their names | F3 |
| 311 | Open | Archive projects and boards | F2 |
| 298 | Open | Export to PDF with comments | F7, §6 |
| 290 | Open | Export frames to PowerPoint | F7 |
| 286 | Open | Export transparent PNGs | F7 |
| 262 | Open | Tags on all shapes | F2 |
| 260 | Open | Increase text box character limit | F6 |
| 252 | Open | Custom sticky note colors | F6, §7 |
| 235 | Beta | Breakout rooms | §5 |
| 231 | Open | Free text formatting for stickies | F6 |
| 226 | Delivered | Private mode for contributors | §5 |
| 224 | Open | Comments on moved or duplicated elements | §6 |
| 221 | Open | Upload audio files | §7 |
| 220 | In Development | Upload MOV/MP4 videos | §7 |
| 198 | Open | Nested frames | F2 |
| 196 | Open | Import SVG as editable objects | §7 |
| 188 | Delivered | Lock areas only the facilitator can unlock | F8, §5 |
| 185 | Delivered | Hide/reveal frames | §5 |
| 167 | Delivered | Export voting to CSV | §5 |
| 160 | Delivered | Autoplay GIF | §7 |
| 159 | Open | Bring back double-click to add last object | D2, §5 |
| 147 | Open | Hide my cursor | §5 |
| 146 | Open | Export comments to CSV/Excel | F7, §6 |
| 138 | Open | Timer: custom music | §5 |
| 129 | Open | Smaller frame titles when zoomed out | F2 |
| 124 | Delivered | Apple Pencil palm rejection | F5 |
| 118 | Open | Auto-reduce images over 32 MP | F1 |
| 102 | Open | PDF export with frame names as TOC/bookmarks | F7 |
| 98 | Open | Export to SVG | F7 |
| 88 | Delivered | Enable/disable download for guests | F7, §6 |
| 65 | Open | Pasting on iPad | F5 |
| 64 | Open | Turn off notifications per board | §6 |
| 50 | Open | WebP image support | §7 |

---

## 11. Sources

All accessed 2026-09-26. Wayback snapshot timestamps are given where used.

**Review sites**
- TrustRadius, Miro reviews (all): https://www.trustradius.com/products/miro/reviews/all (Wayback 20260311014958)
- TrustRadius, Miro pros and cons: https://www.trustradius.com/products/miro/reviews?qs=pros-and-cons (Wayback 20240415113415)
- TrustRadius, Miro alternatives evaluated: https://www.trustradius.com/products/miro/reviews?qs=alternatives-evaluated (Wayback 20240520093755)
- TrustRadius, FigJam pros and cons: https://www.trustradius.com/products/figjam/reviews?qs=pros-and-cons (Wayback 20240620003258)
- G2, Miro individual reviews, e.g. https://www.g2.com/products/miro/reviews/miro-review-12128783 (Wayback, 57 snapshots 2025–2026)
- G2, FigJam reviews: https://www.g2.com/products/fig-jam/reviews (Wayback 20240319044050)
- G2, Mural reviews: https://www.g2.com/products/mural/reviews (Wayback 20250225121702, page 2 20250531150219)
- Capterra, Miro: https://www.capterra.com/p/128955/Miro/reviews/ (Wayback 20240408193557; live pages 1–2 via summarizing fetch)
- Capterra, Mural: https://capterra.com/p/171956/Mural/reviews/ (summarizing fetch)
- Capterra, FigJam: https://www.capterra.com/p/265222/FigJam/reviews/ (summarizing fetch)
- Capterra, Milanote: https://www.capterra.com/p/165790/Milanote/reviews/ (Wayback 20240505065803; live via summarizing fetch)
- SoftwareAdvice, Milanote: https://www.softwareadvice.com/idea-management/milanote-profile/reviews/ (summarizing fetch)
- Product Hunt reviews: https://www.producthunt.com/products/miro/reviews, /milanote/reviews, /tldraw/reviews, /excalidraw/reviews
- Apple App Store, Miro iOS reviews RSS: https://itunes.apple.com/us/rss/customerreviews/id=1180074773/sortby=mostrecent/json (pages 1–5)

**Community and discussion**
- Miro Community Wish List sorted by votes: https://community.miro.com/ideas?sort=votes.desc (pages 1–8)
- Miro Community threads: offline-mode-925; layers-93; miro-has-become-too-slow-9139; board-size-impacting-performance-4783; performance-issues-with-multiple-frames-looking-for-overview-solutions-8666; slow-load-time-for-images-1017; pdf-embedded-in-board-is-low-quality-when-exported-from-frame-4724; best-quality-pdf-exports-are-low-res-16806; guest-access-to-board-without-creating-an-account-16219 (all under https://community.miro.com/)
- Hacker News: Bending Spoons buying Miro https://news.ycombinator.com/item?id=49643848; Miro vs MS Whiteboard https://news.ycombinator.com/item?id=36400321; Why is Excalidraw so good? https://news.ycombinator.com/item?id=29109995; Tldraw launch https://news.ycombinator.com/item?id=29261733; Show HN Milanote https://news.ycombinator.com/item?id=13587909
- Reddit r/UXDesign: ulxh6u (Miro or Mural), ldw5xg (Miro, Figma's real competitor), 1r9tocd (Figma vs Miro vs Lucidchart vs Mural, 2026), 1bin2rx (export without rights), mw7zfr (remote idea generation), 1hwbdcz (remote sketching), 14ljtnv (complex user flows)
- Reddit r/agile: 1wgtww4 (Miro vs Whimsical for quarterly workshops, 2026-09-15), 1s49dj2 (retro tools and anonymity, 2026-03-26), 1lgwqom (overengineered retros)
- Reddit r/graphic_design: 17a7yx8, sqj94u (Milanote pricing and web clipper), wlukl1 (showing mood boards to clients), svimqo (agency campaign repository)
- Reddit r/Filmmakers: 1s5dycl (storyboarding pain), 1w3yyo7 (pitch boards and client feedback)
- Reddit r/productivity: 1wie55f (whiteboard with PDF support, 2026)

**Vendor and facts**
- Bending Spoons newsroom: https://investors.bendingspoons.com/newsroom/bending-spoons-agrees-to-acquire-miro
- Miro pricing: https://miro.com/pricing/
- Figma Help, open sessions: https://help.figma.com/hc/en-us/articles/4410786053911-Invite-visitors-to-an-open-session
- Facilitator School, Miro vs Mural (Daniel Wirtz, updated 2025-05-16): https://www.facilitator.school/blog/miro-vs-mural

---

## 12. Unverified or weakly supported items

- **Capterra 2025–2026 content** (Miro pages 1–2, Mural, FigJam) came through a summarizing fetch. Reviewer names, dates and paraphrases are plausible, but exact wording could not be checked because the live site blocks direct download. No quotation marks were used for that material.
- **Miro seat prices** ($8 Starter, $20 Business, yearly): UNVERIFIED (see §1).
- **Miro video comments:** that you cannot comment on a specific part of a video comes from a search-engine summary of Miro Help. The help page returned 403.
- **Mural and Miro facilitation feature gating** as described by third-party comparison blogs (versustool, usecarly, etc.): UNVERIFIED and not relied on.
- **Bending Spoons price increases** at Harvest (800% and 1,400%): HN user claims only.
- **Microsoft Whiteboard discontinuation:** Reddit user claims only.
- **Miro Community attribution:** some quotes come from posts whose author and date could not be pinned beyond the thread's start date. They are attributed to the thread.
- **Product Hunt attribution:** reviewer names could not be reliably tied to review text, so quotes are attributed by stated role and page.
- **Miro importer feasibility** (§4 F4, §9): not investigated. It needs an API spike.
- **Coded counts** in §2 are small samples coded by one researcher (the App Store column by keyword). Treat rank order as directional.
