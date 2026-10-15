# Comparison of the two builds: Copilot's prototype and Hushloom

Written 2026-10-14 for Jayvo's decision "Run both, compare" (notes/plan.md L113-114). It compares GitHub Copilot's prototype on `origin/main` (d2d6cad) with Hushloom on `claude/playbox-2-foundation-q7fpbs`, its code as verified at 09a436e (later commits change only documents and notes).

How evidence is cited:

- `main:<path>:L<n>` is a line of a file on `origin/main`, read with `git show`.
- `read.md` and `run.json` are in notes/analysis/copilot/: the reading and the run of `origin/main` on 2026-10-13.
- Screenshots are under /mnt/project-files/playbox-2/evidence/: `copilot-main/` (27, Copilot), `visual/after/` (Hushloom's final UI at a802cc4, app code identical to 09a436e) and `journey/` (Hushloom's launch journey at fe21509).
- "Tracker" is notes/progress.md. "e2e test N" is test N in notes/evidence/e2e-09a436e.log.

## 1. Summary and recommendation

Continue from Hushloom. Copilot's build on `main` is a front-end preview: one static page, 8 hard-coded templates drawn with CSS gradients, storage in the browser only, and a 53-line file server. Its own docs call it "**not** the production full-stack platform in the product brief" and list authentication, age verification, generation, credits, payments, uploads and moderation as "not operational" (main:docs/engineering.md:L7, L89). The brief asks for a connected backend, auth, persistence, generation infrastructure and credits (notes/analysis/spec.md L72). Hushloom has these, plus payments, age verification and scanning behind adapters (section 4). At 09a436e it passed typecheck, lint, 507 vitest tests, a production build and 40 browser tests, with none failing (section 3). A visual review at three widths fixed all 43 defects it found (tracker row 4). Copilot's build has two defects a user hits at once (a closed dialog blocks the gallery; phones cannot reach search) and shows the Playbox name, which the owner has ruled out. No Copilot code needs to come across; two small ideas are worth taking (section 8). Hushloom is not ready to launch: generation is a labeled demo, payments, age checks and scanning run in labeled sandbox or development modes, push needs VAPID keys, and no real provider integration has run.

## 2. What each one is

| | Copilot (`origin/main`, d2d6cad) | Hushloom (09a436e) |
| --- | --- | --- |
| Made | Copilot's coding agent: 3 commits from 20:43 to 20:52 UTC on 2026-10-12, merged as PR #1 at 20:56 UTC (`git log origin/main`) | 237 commits from 2026-10-12 20:49 UTC to 2026-10-14 16:27 UTC (`git log 09a436e`) |
| Stack | Static HTML, one CSS file, plain JavaScript modules; Node's built-in `http` server; `node:test` (read.md §1, §3) | Next.js 15.5.27, React 19.2.0, strict TypeScript 5.9.3, Tailwind 4.3.3, Drizzle, BullMQ, sharp, ffmpeg, local or S3 storage; Postgres 16 and Redis 7 (package.json; docker-compose.yml L38, L53) |
| Dependencies | None, no lockfile (main:package.json) | 19 runtime, 14 dev, with a lockfile |
| Files | 10 files, 68,038 bytes, 1,115 lines (sum of read.md §1 rows) | 364 tracked files, 308 outside notes/ (`git ls-tree -r 09a436e`) |
| App code | index.html 133 lines, src/app.js 273, src/catalog.js 130, styles.css 293, server.mjs 53 | src/: 201 files, 20,855 lines; 22 pages; 56 API route files with 73 method handlers; 38 tables (src/server/db/schema.ts); 5 migrations (drizzle/); a worker (src/worker/index.ts) |
| Tests | test/catalog.test.js, 39 lines | 45 vitest files and 4 Playwright specs, 12,976 lines |
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

Start: `npm run dev` plus `npm run worker`, with Postgres and Redis (README.md L56-57). For production, README gives `npm run build` then `npm start` (L86-87), or `docker compose up -d --build` (L129).

Read from the code, not run: the .env.example defaults give no working production site. The configuration check, `env()`, rejects production without `MEDIA_SIGNING_SECRET` (commented out in .env.example) or with a relative `STORAGE_LOCAL_DIR` (src/server/env.ts L133-140; .env.example L47, L59), and compose will not start without it or `POSTGRES_PASSWORD` (docker-compose.yml L21, L41). A production build with `APP_ENV` unset counts as live (env.ts L144), so the check rejects the dev scanner and the sandbox age check (L145-152): the worker exits and the web app answers every request with an error (README.md L188-195). README asks for both secrets, then `APP_ENV=staging` for a private preview (L118-126). Turning off `SCAN_FAIL_CLOSED` and `AGE_VERIFICATION_ENFORCE` instead leaves the dev scanner answering "unavailable" on a live site, a verdict never served (src/server/safety/scan/providers/dev.ts L43-45; index.ts L27).

On record (not run for this comparison):

- A clean install at 09a436e in a fresh worktree: `npm ci` (462 packages), typecheck and lint clean (0 warnings), vitest 507 of 507 in 45 files, `next build` exit 0 (notes/evidence/clean-verify-09a436e.log).
- `npm run test:e2e` at 09a436e, on a fresh production build with the worker (playwright.config.ts L43-63): 72 tests, 40 passed, 32 skipped, 0 failed (notes/evidence/e2e-09a436e.log).
- CI on GitHub Actions: run 16 at 574ccaf (code as at 09a436e) passed both jobs. 1 of 22 runs failed, a socket hang up at ce84bff that did not repeat (notes/evidence/github-ci.md).
- Never started: `docker build` and `docker compose up` (no Docker daemon here; tracker row 1.7) and any real provider (section 9).

## 4. Real versus demo

| Area | Copilot | Hushloom |
| --- | --- | --- |
| Persistence | Browser localStorage only, 3 keys (main:src/app.js:L3-7). The server stores nothing (read.md §3). | **Operational.** Postgres through Drizzle. Media on local disk or S3; S3 tested only against an in-memory stand-in (tests/integration/media-s3.test.ts L23-24). |
| Auth | **None.** The "Y" avatar's label says sign-in is not available (main:index.html:L30). | **Operational.** Password hashed with bcrypt and a session cookie (src/server/auth/session.ts L27, L46). An under-18 date of birth is refused (e2e test 4). Another member gets 404 (e2e test 2). |
| Generation | **None.** "Start creating" only shows a "not connected" notice (main:src/app.js:L257-261). | **Pipeline operational, output a labeled demo.** BullMQ queue and worker. Without a provider key the "Demo Still (not AI)" and "Demo Motion (not AI)" models make placeholders (src/server/ai/registry.ts L82, L96). Replicate never run. Evidence: e2e test 1; visual/after/desktop-member-creation-detail.png. |
| Credits | **None** (main:docs/engineering.md:L7). | **Operational.** Each ledger movement has an idempotency key (src/server/credits/ledger.ts L42-66); credits are held at confirm (L72-81) and returned on failure, less any debt a refund or chargeback left (L98-112; fix-results.json, R17). A re-delivered payment grants once (e2e test 23). |
| Payments | **None** (main:docs/engineering.md:L7). | **Labeled sandbox.** Default provider (src/server/env.ts L55); refuses a live site (src/server/payments/providers/sandbox.ts L31, L155). CCBill and Segpay written from public docs, never run; Stripe off by default (tracker). Evidence: e2e tests 16 to 24; journey/pay-01 to pay-12. |
| Age verification | **None.** Listed as not implemented (main:docs/engineering.md:L24); no age gate. | **Labeled sandbox.** GB and US state rules (src/config/jurisdictions.ts). The sandbox page says it "proves nothing about anyone's age" (visual/after/desktop-gb-member-unverified-sandbox-age-check-labeled-proves-nothing.png). Refused on a live site while enforced (src/server/env.ts L149-151). Yoti never run. Evidence: e2e tests 10 to 15. |
| Scanning | **None.** No uploads or moderation (main:docs/engineering.md:L7, L89). | **Development mode.** The dev scanner matches only `SCAN_DEV_MATCH_HASHES` and one drill fixture (src/server/safety/scan/providers/dev.ts L27-32). PhotoDNA and Cloudflare never run. Refused on a live site while fail-closed (src/server/env.ts L145-147). Evidence: e2e tests 25 to 28. |
| Installable web app | **None.** No manifest or service worker; `/favicon.ico` is 404 (run.json). | **Verified in headless Chromium; push and real-device install implemented but not verified.** Manifest, service worker and offline page pass, with no installability errors (e2e tests 29 to 32, 34). Without VAPID keys push is off, as Settings says (e2e test 33). Push delivery and real-device install never ran (notes/analysis/track-reports/pwa.json). |
| Admin | **None.** `/admin` is "Not implemented" (main:docs/engineering.md:L25). | **Operational.** /admin, /admin/review and 9 route files under src/app/api/admin. An admin clears a chargeback flag (journey/pay-07, pay-08), sees a scan escalation and handles a takedown (e2e tests 27, 28). |

## 5. Tests and verification

| | Copilot | Hushloom |
| --- | --- | --- |
| Automated tests | 5 `node:test` tests in 1 file, all on src/catalog.js: test 1 checks its data, tests 2 to 5 its pure filter function (main:test/catalog.test.js:L5-39). Nothing tests the server, page, storage or dialog (read.md §5). | 507 vitest tests in 45 files (18 unit, 27 integration), run against Postgres and Redis test databases (vitest.config.ts L13-14) |
| Browser tests | None | 72 Playwright tests. 40 run by default: 9 in tests/e2e/journey.spec.ts, 27 in launch.spec.ts, and 4 in layout.spec.ts (main routes at 390 and 820 px). The 32 in visual.spec.ts need `VISUAL_REVIEW=1`. |
| Typecheck and lint | No scripts | Both clean, 0 lint warnings (notes/evidence/clean-verify-09a436e.log) |
| Runs on record | Run for this comparison: `npm test` 5 of 5; `node --check` on 4 files; curl on every kind of route; Playwright probes at 3 widths (scripts in notes/analysis/copilot/) | None for this comparison; final runs in section 3 |
| Visual review | None committed | 223 screenshots at 390, 820 and 1440 px with automated overflow, tap-target, clipped-text and axe contrast checks. Two reviewers found 43 defects (3 high, 27 medium, 13 low), all fixed (merged at 91d270c). A second capture found no new defect: no overflow, contrast violations 9 to 0, flagged phone targets 1916 to 369 (tracker row 4; notes/analysis/visual/visual-review.json). |
| Adversarial review | None | 49 triaged findings (1 critical, 12 high, 22 medium, 14 low), each fixed with a test that failed first. 90 attempts to get around the fixes found 39 holes: 37 patched, 2 wait on a product decision (tracker rows 3.2 to 3.4; notes/analysis/review/fix-results.json). |
| Claims versus runs | main:docs/engineering.md:L86 says a headless Chromium check verified "template details". No script is committed, and the dialog-close defect appears on the first close (read.md §8.10). | Tracker rows name their evidence, usually a run. Row 3.2 (Triage) is "verified" on a hand triage with no run (notes/progress.md L29). |

Copilot's unmerged branch `copilot/analyze-test-coverage-gaps` (6be39a8, 2026-10-13) adds test/server.test.js (159 lines) for the static server and exports `server` from server.mjs. It was read, not run, and does not touch the dialog or search defects.

## 6. Documentation

**Copilot** (read.md §6):

- README.md (16 lines): run steps and an accurate statement that nothing is uploaded, generated or charged.
- docs/engineering.md (90 lines): status, routes, an architecture and API sketch labeled not implemented (L35, L45) and a verification report (L85-89). Scope statements are accurate. It overstates the browser check (L86). About 60% describes future architecture (read.md §7).
- docs/playbox-2-vision.md (76 lines): vision, tokens matching styles.css, journey and phases. Its one-column grid (L49) and opt-in recents (L13) do not exist.
- No environment template, database setup, deployment guide or abuse-response document.

**Hushloom**:

- README.md (1,820 words): setup, commands, Docker Compose. tests/unit/env-template.test.ts checks .env.example against the code.
- docs/abuse-response.md (3,081 words), with legal statements marked for legal review (tracker).
- The deliverables in docs/ (vision, design system, information architecture, engineering, deployment, verification, this comparison), written or fact-checked against the merged build (6243984, 3f3637a). No human has reviewed them.

## 7. Product structure and look

The owner's rule: the product is Hushloom and must look nothing like playbox.com (notes/analysis/spec.md L3).

**Copilot** (copilot-main/copilot-1440.png, copilot-390.png, copilot-1440-dialog-notice.png):

- One page. A top bar with a "playbox." wordmark, Explore and Collection links, a search box with a "/" hint and a "Y" avatar.
- A hero, "A little inspiration. A lot of possibility.", beside a note set in Manrope, rotated 7 degrees inside two drawn ellipses (main:styles.css:L28, L85-88).
- A left sidebar (For you, All templates, Images, Videos, Recently viewed, Saved) beside a 4-column grid of 8 cards with soft pastel gradient art, an IMAGE tag or a duration ("5 sec" or "8 sec") and a heart. Video templates contain no video (read.md L72-74).
- Near-black background with a lime accent (#d9f36a, main:docs/playbox-2-vision.md:L41-47).
- A two-column template dialog: art, prompt, optional frame and motion, a lime "Start creating" button and the notice.
- At 390 pixels: chips replace the sidebar, 2 grid columns, search shown only as an icon.
- The Playbox name is everywhere: page title (main:index.html:L8), wordmark (L15-17), footer (L95), "Playbox picks" on every template (main:src/catalog.js) and the storage keys. Nothing is aimed at adults and there is no age gate.

**Hushloom**, from the visual review's final capture (visual/after/: desktop-anonymous-home.png, phone-anonymous-home.png, phone-anonymous-explore.png, desktop-member-template.png, desktop-member-creation-detail.png, desktop-anonymous-pricing.png):

- Desktop left rail: an italic serif "hushloom" wordmark; Discover, Create, Library, Train; "Go deeper" with Projects, Studio, Favorites; a coral "Join or sign in" button. Phones get a bottom tab bar: Discover, Search, "+", Library, Sign in.
- Home: a serif headline, "Pick a template. Make it yours.", "Make an image" and "Make a video" buttons, category chips (Boudoir, Nightlife, Romance, Couples and more; below the first grid on phones), a "Trending tonight" grid and a "New" rail.
- Cards carry NEW, VIP and DEMO badges, creator handles and like counts; on phones each card has a Make button. Explore keeps a full search field at phone width.
- Warm near-black background (#0f0a0d, src/app/globals.css L12), coral accent, lavender demo and sandbox labels.
- Template page: DEMO MEDIA and DEMO MODEL tags, creator with Follow, three modes, the prompt, an assistant suggestion and "Make it" with its cost.
- Creation detail: READY and DEMO badges, ten actions from Remix to Delete, the model "Demo Still (not AI)" and the cost.
- Pricing: "SANDBOX · NO MONEY MOVES" by the passes and credit packs; prices are operator placeholders (notes/plan.md L109-110).

docs/design-system.md records the own-look choice (Visual principles, item 8). Visual-review fixes raised phone tap targets to 40 px, several through shared primitives (src/components/ui.tsx).

## 8. What is worth porting from Copilot's build into Hushloom

Two ideas; no Copilot code.

| Idea | Copilot source | Hushloom today | Notes |
| --- | --- | --- | --- |
| A Content-Security-Policy on every page | main:server.mjs:L37-42 (`default-src 'self'`, `script-src 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`) | Only /sw.js gets a CSP (next.config.ts L21). | Written for a static page; a Next.js version needs its own design and an e2e run. Copilot sends it on 200 responses only (run.json); a port should cover errors too. |
| "/" focuses search, Escape clears it | main:src/app.js:L214-228 | No page-wide key handler. Radio groups and the card grid handle keys (src/components/auth-forms.tsx L61, explore-feed.tsx L78, template-card.tsx L275) | Copilot's search breaks at phone width (main:styles.css:L244-246), so take the behavior, not the CSS. |

Not worth porting:

- **server.mjs and the unmerged server tests.** Next.js serves Hushloom; the tests check a server it does not run.
- **The catalog, art and styles.css** (main:src/catalog.js:L1-106; main:styles.css:L154-185). Playbox-branded, not adult-oriented, no media. Hushloom seeds 24 templates (scripts/seed.ts L94-119) and has its own tokens (src/app/globals.css L11-37).
- **Browser-only favorites, recents and edits** (main:src/app.js:L25-40). Hushloom keeps recently viewed and saved templates on the account, newest first (src/server/discovery/templates.ts L228-248). Saved presets come closest to per-template edits (src/server/db/schema.ts L500).
- **The not-connected notice and the architecture sketch** (main:src/app.js:L259; main:docs/engineering.md:L35-64). Hushloom's DEMO and SANDBOX labels and built code cover both.

## 9. Risks and limits of this comparison

- **Copilot apparently had the same brief and delivered a labeled preview.** Its prompt is unrecorded, but its route table covers all 17 of the spec's routes (main:docs/engineering.md:L13-25; notes/analysis/spec.md L39). A smaller intended scope is possible: the merge commit says "Build a Playbox discovery and remix preview" (d2d6cad), and the 3 commits span 9 minutes. Judging both against the full spec favors the larger build.
- **Naming.** Copilot's package.json is named "hushloom" (main:package.json:L2) but the interface says Playbox. Nothing records whether Copilot saw the owner's later messages on name and look.
- **Nothing of Copilot's was changed.** It was read with `git show` and run from an export (read.md L5, L268-274). The plan forbids modifying or commenting on it (notes/plan.md L27-28).
- **One evidence pass.** Copilot's d2d6cad, still the local `origin/main` on 2026-10-14, was read and run on 2026-10-13 (read.md L5-8, L268).
- **Hushloom checked its own work.** Its evidence, reviews included, comes from its own agents; no human has checked it.
- **Unverified integrations.** Never run against the real service: CCBill, Segpay, Yoti (tracker, open issues), Replicate (notes/plan.md L143), PhotoDNA, Cloudflare (notes/analysis/track-reports/scan.json), a real S3 bucket (README.md L23), push delivery and install on a real device (notes/analysis/track-reports/pwa.json).
- **Open questions.** Three review findings need a product decision: the sign-in lockout, the sign-up probe and the `AGE_VERIFICATION_FAIL_CLOSED` default (tracker L134-143). Other tracker items for Jayvo: product calls in the fixes (L89-94), scanning evidence and reporting (L113-118) and the MinIO image (L127-129).
- **Screenshots past the gate.** Section 4's payment and admin shots predate the phase 3 and 4 fixes (fe21509, tracker L27). Both capture runs pass the 18+ gate first (tests/e2e/visual.spec.ts L496-500; launch.spec.ts L38-42, L475, L486), so signed-out shots show a visitor past it. Without its `hl_age_ok` cookie, discovery pages and GET /api/templates return no media URLs (src/server/age/access.ts L22-23).
- **No look comparison** against playbox.com was made for either build.
- **No shared history.** `git merge-base` finds no common commit between 09a436e and `origin/main`, so making Hushloom the main line needs a merge of unrelated histories or a replaced `main`. Opening a PR, merging and porting are Jayvo's call (notes/plan.md L29).
