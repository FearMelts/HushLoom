# Comparison of the two builds: Copilot's prototype and Hushloom

Written 2026-10-14 for Jayvo's decision "Run both, compare" (notes/plan.md L113-114). It compares GitHub Copilot's prototype on `origin/main` (d2d6cad) with Hushloom on `claude/playbox-2-foundation-q7fpbs` (342afb4).

How evidence is cited:

- `main:<path>:L<n>` is a line of a file on `origin/main`, read with `git show`.
- `read.md` and `run.json` are in notes/analysis/copilot/: the reading and the run of `origin/main` on 2026-10-13.
- `copilot-main/` (27 screenshots of Copilot's build) and `journey/` (Hushloom's screenshots and per-test console and network evidence) are under /mnt/project-files/playbox-2/evidence/.
- "Tracker" is notes/progress.md. "e2e test N" is test N in notes/evidence/e2e-ce84bff.log.

## 1. Summary and recommendation

Continue from Hushloom. Copilot's build on `main` is a front-end preview: one static page, 8 hard-coded templates drawn with CSS gradients, storage in the browser only, and a 53-line file server. Its own docs say it is "**not** the production full-stack platform in the product brief" (main:docs/engineering.md:L7) and list authentication, age verification, generation, credits, payments, uploads and moderation as "not operational" (L89). The brief asks for a working application with a connected backend, auth, persistence, generation infrastructure and credits (notes/analysis/spec.md L72). Hushloom has these: Postgres, sessions, a queued generation pipeline with a worker, an idempotent credit ledger, and payments, age verification and scanning behind adapters. At ce84bff (same code as 342afb4) it passed typecheck, lint, 503 vitest tests and 36 Playwright tests on a production build (tracker row 3.5). Copilot's build has two defects a user hits at once (a closed dialog blocks the gallery; phones cannot reach search), and it shows the Playbox name throughout, which the owner has ruled out. No Copilot code needs to come across; two small ideas are worth taking (section 8). Hushloom is not ready to launch: its generation is a labeled demo, payments, age checks and scanning run in labeled sandbox or development modes, and no real provider integration has run.

## 2. What each one is

| | Copilot (`origin/main`, d2d6cad) | Hushloom (342afb4) |
| --- | --- | --- |
| Made | Copilot's coding agent: 3 commits from 20:43 to 20:52 UTC on 2026-10-12, merged as PR #1 at 20:56 UTC (`git log origin/main`) | 196 commits from 2026-10-12 20:49 UTC to 2026-10-14 09:59 UTC (`git log`) |
| Stack | Static HTML, one CSS file, plain JavaScript modules; Node's built-in `http` server; `node:test` (read.md §1, §3) | Next.js 15.5.27, React 19.2.0, strict TypeScript 5.9.3, Tailwind 4.3.3, Drizzle, BullMQ, sharp, local or S3 storage (package.json; tsconfig.json L7); Postgres 16 and Redis 7 (docker-compose.yml L38, L53); ffmpeg (Dockerfile.worker) |
| Dependencies | None, no lockfile (main:package.json) | 19 runtime, 14 dev, with a lockfile |
| Files | 10 files, 67,948 bytes, 1,115 lines (read.md §1) | 358 tracked files, 305 outside notes/ (`git ls-tree -r 342afb4`) |
| App code | index.html 133 lines, src/app.js 273, src/catalog.js 130, styles.css 293, server.mjs 53 | src/: 201 files, 20,551 lines (ls-tree, `wc -l`); 22 pages and 56 API route handlers; 38 tables (src/server/db/schema.ts); 5 migrations (drizzle/); a worker (src/worker/index.ts) |
| Tests | test/catalog.test.js, 39 lines | 44 vitest files and 2 Playwright specs, 11,657 lines |
| Deployment files | None | Dockerfile, Dockerfile.worker, docker-compose.yml, .github/workflows/ci.yml, .env.example |

Counts show size, not quality.

## 3. What runs

### Copilot

Start: `npm start` runs `node server.mjs` on 127.0.0.1 at `PORT` or 4173 (main:server.mjs:L50-53). `npm test` runs `node --test`.

What was started (run.json; read.md §8), from a `git archive` export:

- `npm test` passed 5 of 5 on Node 22.22.0.
- Curl probes of the server (port 4590): `/` and 4 allowlisted files answer 200; other paths, including `/explore` and `/api/templates`, 404; other methods 405; a malformed escape 400.
- Playwright drove headless Chromium 141 at 390, 820 and 1440 pixels: no console errors; requests only for the 4 local files and Google Fonts; none from "Start creating".

Defects seen (read.md §8.9):

1. A closed template dialog stays on screen and blocks the cards at all three widths (`display: grid`, main:styles.css:L191; copilot-main/copilot-1440-after-close.png).
2. At 620 pixels and narrower, search cannot be reached by tap, click, "/" or script (main:styles.css:L244-246; copilot-main/copilot-390-search-tap.png).
3. Recently viewed is in catalog order, not most recent first, and phones cannot reach it.
4. A malformed localStorage value leaves the grid empty (copilot-main/copilot-1440-corrupt-storage.png).
5. "For you" shows the same 8 cards as "All templates".

### Hushloom

Start: `npm run dev` plus `npm run worker`, with Postgres and Redis (README.md L56-57). The production commands, `npm run build` then `npm start` or `docker compose up -d --build` (README.md L129), give no working site with the default config. A production build first throws "MEDIA_SIGNING_SECRET must be set in production", which .env.example leaves commented out (src/server/env.ts L133-135; .env.example L46-47). It also needs an absolute `STORAGE_LOCAL_DIR`, not the `.storage` default (env.ts L138-140; .env.example L59). Compose will not start without `POSTGRES_PASSWORD` and `MEDIA_SIGNING_SECRET` (docker-compose.yml L21, L41). With those set, a build with `APP_ENV` unset counts as live (env.ts L144), so the config check rejects the dev scanner and the sandbox age check (L145-151): the worker exits at start and the web app answers every request with an error (README.md L188-195). README.md L120-126 asks for both secrets, then `APP_ENV=staging` for a private preview. The other ways past that check are real provider accounts, or `SCAN_FAIL_CLOSED=false` with `AGE_VERIFICATION_ENFORCE=false`; then every dev scan returns "unavailable" (src/server/safety/scan/providers/dev.ts L10-12), a verdict that is never served, so no upload or creation would show (src/server/safety/scan/index.ts L27). The e2e stack sets `APP_ENV=test` (playwright.config.ts L23).

On record (none of it run for this comparison):

- `npm run test:e2e` at ce84bff (same code as 342afb4: `git diff ce84bff 342afb4` touches only notes/). It built the app and started the web server and worker (playwright.config.ts L43-58). 36 passed in 5.4 minutes, exit 0.
- A clean install at a432052, before the phase 3 fixes: npm ci, typecheck, lint, vitest 258 of 258 and `next build`, all exit 0 (notes/evidence/clean-verify-a432052.log).
- Never started: `docker build`, `docker compose up` (no Docker daemon here), CI on GitHub (tracker row 1.7) and any real provider (section 9).

## 4. Real versus demo

| Area | Copilot | Hushloom |
| --- | --- | --- |
| Persistence | Browser localStorage only, 3 keys (main:src/app.js:L3-7). The server stores nothing (read.md §3). | **Operational.** Postgres through Drizzle, 38 tables (src/server/db/schema.ts). Media on local disk or S3; S3 tested only against an in-memory stand-in (tests/integration/media-s3.test.ts L23-24). |
| Auth | **None.** The "Y" avatar's label says sign-in is not available (main:index.html:L30). | **Operational.** Password hashed with bcrypt and a session cookie (src/server/auth/session.ts L27, L46). An under-18 date of birth is refused (e2e test 4). Another member gets 404 (e2e test 2). |
| Generation | **None.** "Start creating" only shows a "not connected" notice (main:src/app.js:L257-261). | **Pipeline operational, output a labeled demo.** BullMQ queue and worker. Without a provider key the "Demo Still (not AI)" and "Demo Motion (not AI)" models make placeholders (src/server/ai/registry.ts L82, L96). Replicate never run. Evidence: e2e test 1; journey/journey-01-creation-detail.png. |
| Credits | **None** (main:docs/engineering.md:L7). | **Operational.** Each ledger movement has an idempotency key (src/server/credits/ledger.ts L42-66); credits are held at confirm (L72-81) and returned on failure (L98-112), except credits a refund or chargeback put on the `credit_debt` flag, which are taken back (L99, L109-111; fix-results.json, R17). A re-delivered payment grants once (e2e test 23). |
| Payments | **None** (main:docs/engineering.md:L7). | **Labeled sandbox.** Default provider (src/server/env.ts L55); refuses a live site (src/server/payments/providers/sandbox.ts L31, L155). CCBill and Segpay written from public docs, never run; Stripe off by default (tracker). Evidence: e2e tests 16 to 24; journey/pay-01 to pay-10. |
| Age verification | **None.** Listed as not implemented (main:docs/engineering.md:L24); no age gate. | **Labeled sandbox.** GB and US state rules (src/config/jurisdictions.ts). The sandbox page says it "proves nothing about anyone's age" (journey/age-07-sandbox-proves-nothing.png). Refused on a live site while enforced (src/server/env.ts L149-151). Yoti never run. Evidence: e2e tests 10 to 15. |
| Scanning | **None.** No uploads or moderation (main:docs/engineering.md:L7, L89). | **Development mode.** The dev scanner matches only `SCAN_DEV_MATCH_HASHES` and one drill fixture (src/server/safety/scan/providers/dev.ts L5-7). PhotoDNA and Cloudflare never run. Refused on a live site while fail-closed (src/server/env.ts L145-147). Evidence: e2e tests 25 to 28. |
| Installable web app | **None.** No manifest or service worker; `/favicon.ico` is 404 (run.json). | **Operational; push needs VAPID keys.** public/manifest.webmanifest, public/sw.js, icons. Chromium's installability check reports no errors (e2e test 31). Settings says push is not configured (e2e test 33). |
| Admin | **None.** `/admin` is "Not implemented" (main:docs/engineering.md:L25). | **Operational.** /admin, /admin/review and 9 routes under src/app/api/admin. An admin clears a chargeback flag (journey/pay-07, pay-08), sees a scan escalation and handles a takedown (e2e tests 27, 28). |

## 5. Tests and verification

| | Copilot | Hushloom |
| --- | --- | --- |
| Automated tests | 5 `node:test` tests in 1 file, all on src/catalog.js: test 1 checks its data, tests 2 to 5 its pure filter function (main:test/catalog.test.js:L5-39). Nothing tests the server, page, storage or dialog (read.md §5). | 503 vitest tests in 44 files (17 unit, 27 integration), run against Postgres and Redis test databases (vitest.config.ts L13-14) |
| Browser tests | None | 36 Playwright tests: 9 in tests/e2e/journey.spec.ts, 27 in tests/e2e/launch.spec.ts |
| Typecheck and lint | No scripts | Both clean, lint at 0 warnings (tracker row 3.5) |
| Runs on record | Run for this comparison: `npm test` 5 of 5; `node --check` on 4 files; curl on every kind of route; Playwright probes at 3 widths (scripts in notes/analysis/copilot/) | None for this comparison. Phase 3.5 merge verification at ce84bff: vitest 503 of 503, then e2e 36 of 36 on a fresh production build (tracker row 3.5) |
| Adversarial review | None | 49 triaged findings (1 critical, 12 high, 22 medium, 14 low), each fixed with a test that failed first. 90 attempts to get around the fixes found 39 holes: 37 patched, 2 wait on a product decision (tracker rows 3.2 to 3.4; notes/analysis/review/fix-results.json). |
| Claims versus runs | main:docs/engineering.md:L86 says a headless Chromium check verified "template details". No script is committed, and the dialog-close defect appears on the first close (read.md §8.10). | Tracker rows name their evidence, usually a run. Row 3.2 (Triage) is "verified" on a hand triage with no run (notes/progress.md L29). |

Copilot's unmerged branch `copilot/analyze-test-coverage-gaps` (6be39a8, 2026-10-13 23:55 UTC) adds test/server.test.js (159 lines) for the static server and a one-line server.mjs change to export `server`. It was read, not run, and does not touch the dialog or search defects. This comparison is about `main`.

## 6. Documentation

**Copilot** (read.md §6):

- README.md (16 lines): run steps and an accurate statement that nothing is uploaded, generated or charged.
- docs/engineering.md (90 lines): status, routes, an architecture and API sketch labeled not implemented (L35, L45) and a verification report (L85-89). Scope statements are accurate. It overstates the browser check (L86). About 60% describes future architecture (read.md §7).
- docs/playbox-2-vision.md (76 lines): vision, tokens matching styles.css, journey and phases. Its one-column grid (L49) and opt-in recents (L13) do not exist.
- No environment template, database setup, deployment guide or abuse-response document.

**Hushloom** at 342afb4:

- README.md (1,820 words): setup, commands, Docker Compose. tests/unit/env-template.test.ts checks .env.example against the code.
- docs/abuse-response.md (3,081 words), with legal statements marked for legal review (tracker).
- Five drafts committed unreviewed in 5c6bc8d (vision, information architecture, design system, engineering, deployment), drafted against c52f843, before the review fixes (commit message). The tracker says vision and information architecture are "finishing in phase 5"; design system, engineering, deployment and verification are "not done" (notes/progress.md L34-35).

## 7. Product structure and look

The owner's rule: the product is Hushloom and must look nothing like playbox.com (notes/analysis/spec.md L3). This section describes each build, not Playbox.

**Copilot** (copilot-main/copilot-1440.png, copilot-390.png, copilot-1440-dialog-notice.png):

- One page. A top bar with a "playbox." wordmark, Explore and Collection links, a search box with a "/" hint and a "Y" avatar.
- A hero, "A little inspiration. A lot of possibility.", beside a short note set in Manrope, rotated 7 degrees inside two drawn ellipses (main:styles.css:L28, L85-88).
- A left sidebar (For you, All templates, Images, Videos, Recently viewed, Saved) beside a 4-column grid of 8 cards with soft pastel gradient art, an IMAGE tag or a duration ("5 sec" or "8 sec") and a heart. Video templates contain no video (read.md L72-74).
- Near-black background with a lime accent (#d9f36a, main:docs/playbox-2-vision.md:L41-47).
- A two-column template dialog: art, prompt, optional frame and motion, a lime "Start creating" button and the notice.
- At 390 pixels: chips replace the sidebar, 2 grid columns, search shown only as an icon.
- The Playbox name is everywhere: page title (main:index.html:L8), wordmark (L15-17), footer (L95), "Playbox picks" on every template (main:src/catalog.js) and the storage keys. Nothing is aimed at adults and there is no age gate.

**Hushloom**, from the fe21509 journey run (section 9; journey/journey-layout-desktop-home.png, journey-layout-mobile-home.png, journey-layout-mobile-explore.png, journey-layout-desktop-template.png, journey-01-creation-detail.png, pay-01-pricing-sandbox-label.png):

- Desktop left rail: an italic serif "hushloom" wordmark; Discover, Create, Library, Train; "Go deeper" with Projects, Studio, Favorites; a coral "Join or sign in" button. Phones get a bottom tab bar: Discover, Search, "+", Library, Sign in.
- Home: a serif headline, "Pick a template. Make it yours.", "Make an image" and "Make a video" buttons, category chips (Boudoir, Nightlife, Romance, Couples and more) and a "Trending tonight" rail.
- Cards carry NEW and DEMO badges, creator handles and like counts. Explore keeps a full search field at phone width.
- Warm near-black background (#0f0a0d, src/app/globals.css L12), coral accent, lavender demo and sandbox labels.
- Template page: DEMO MEDIA and DEMO MODEL tags, creator with Follow, three modes, the prompt, an assistant suggestion and "Make it" with its cost.
- Creation detail: READY and DEMO badges, ten actions from Remix to Delete, the model "Demo Still (not AI)" and the cost.
- Pricing: "SANDBOX · NO MONEY MOVES" by the passes and credit packs; prices are operator placeholders (notes/plan.md L109-110).

Hushloom's design-system draft records its own-look choice (5c6bc8d:docs/design-system.md, Visual principles, item 8), but the phase 4 visual review is "not done" (tracker).

## 8. What is worth porting from Copilot's build into Hushloom

Two ideas; no Copilot code.

| Idea | Copilot source | Hushloom today | Notes |
| --- | --- | --- | --- |
| A Content-Security-Policy on every page | main:server.mjs:L37-42 (`default-src 'self'`, `script-src 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`) | Only /sw.js gets a CSP (next.config.ts L21). | Written for a static page; its fit with Next.js was not checked, so it needs its own design and an e2e run. Copilot sends it on 200 responses only (run.json); a port should cover errors too. |
| "/" focuses search, Escape clears it | main:src/app.js:L214-228 | No page-wide key handler. Radio groups and the card grid handle keys (src/components/auth-forms.tsx L61, explore-feed.tsx L78, template-card.tsx L227); the Sheet dialog closes on Escape through onCancel (ui.tsx L171-175) | Copilot's search breaks at phone width (main:styles.css:L244-246), so take the behavior, not the CSS. |

Not worth porting:

- **server.mjs and the unmerged server tests.** Next.js serves Hushloom; the tests check a server it does not run.
- **The catalog, art and styles.css** (main:src/catalog.js:L1-106; main:styles.css:L154-185). Playbox-branded, not adult-oriented, no media. Hushloom seeds 24 templates (scripts/seed.ts L94-119) and has its own tokens (src/app/globals.css L11-37).
- **Browser-only favorites, recents and edits** (main:src/app.js:L25-40). Hushloom keeps recently viewed and saved templates on the account, newest first (src/server/discovery/templates.ts L228-248). Per-template edits have no equivalent; saved presets come closest (src/server/db/schema.ts L500).
- **The not-connected notice and the architecture sketch** (main:src/app.js:L259; main:docs/engineering.md:L35-64). Hushloom's DEMO and SANDBOX labels and its built code already cover both.

## 9. Risks and limits of this comparison

- **Copilot apparently had the same brief and delivered a labeled preview.** Its prompt is not recorded, but its route table covers all 17 of the spec's routes (main:docs/engineering.md:L13-25; notes/analysis/spec.md L39), its vision doc repeats the spec's journey (main:docs/playbox-2-vision.md:L7; spec.md L17), and it calls itself "**not** the production full-stack platform in the product brief" (main:docs/engineering.md:L7). A smaller intended scope is still possible: the merge commit says "Build a Playbox discovery and remix preview" (d2d6cad), the vision doc says "browser-only design prototype" (L9), and the 3 commits span 9 minutes. Judging both against the full spec favors the larger build.
- **Naming.** Copilot's package.json is named "hushloom" (main:package.json:L2) but the interface says Playbox. Nothing records whether Copilot saw the owner's later messages on name and look.
- **Nothing of Copilot's was changed.** It was read with `git show` and run from a `git archive` export; nothing was modified or checked out (read.md L5, L268-274). The plan forbids modifying or commenting on it (notes/plan.md L27-28).
- **One evidence pass.** Copilot's d2d6cad, still `origin/main` on 2026-10-14, was read and run on 2026-10-13 (read.md L5-8, L268).
- **Hushloom checked its own work.** Its evidence, the adversarial review included, comes from its own agents. No human has reviewed it.
- **Unverified integrations.** Never run against the real service: CCBill, Segpay, Yoti (tracker, open issues), Replicate (notes/plan.md L143), PhotoDNA, Cloudflare (notes/analysis/track-reports/scan.json), a real S3 bucket (README.md L23), Docker and CI (tracker row 1.7).
- **Open questions.** Three items wait on Jayvo: two attack holes (sign-in lockout, sign-up probe; tracker row 3.4) and one default, `AGE_VERIFICATION_FAIL_CLOSED` (tracker L140-141). Others are in the tracker's decisions log and open issues.
- **Older screenshots.** Hushloom's screenshots come from the journey run at fe21509 (tracker L27), before the phase 3 fixes. The layout test passes the 18+ gate first (tests/e2e/journey.spec.ts L13-18, L233-235), so the signed-out shots show a visitor past the gate. Since phase 3, a visitor without the `hl_age_ok` gate cookie gets no media URLs from discovery pages or GET /api/templates (src/server/age/access.ts L22-23; fix-results.json, age cluster).
- **No look comparison** against playbox.com was made for either build.
- **No shared history.** `git merge-base` finds no common commit between 342afb4 and `origin/main`, so making Hushloom the main line needs a merge of unrelated histories or a replaced `main`. Opening a PR, merging and porting are Jayvo's call (notes/plan.md L29).
