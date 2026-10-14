# Tracker (newest log entries last)

This is the single tracker for the Hushloom build (Jayvo's run plan of 2026-10-13 02:01 UTC,
ground rule 2). `notes/plan.md` holds decisions and environment; `notes/state.json` holds counts.
Statuses use exactly: verified, implemented but not verified, blocked, not done.

## Phase status

| Phase / step | Status | Evidence |
| --- | --- | --- |
| 0 Baseline re-verified on a fresh container | verified | typecheck 0, lint 0 warnings, vitest 79/79, Playwright 8/8 on the production build (2026-10-12 22:06-22:26) |
| 0 Shared scaffold for the four additions | verified | commit 9e1db60 (migration 0002, env, adapter interfaces, hook points); vitest 79/79 |
| 1.1 Payments track | verified | branch worktree-wf_1b2f5203-519-1, commits 5dce1dc 5497de0 2cc0d60; re-run 2026-10-13 02:03: typecheck 0, lint 0, vitest 100/100 |
| 1.2 Age verification track | verified | branch worktree-wf_1b2f5203-519-2, commits b1fe1e4 2fb7c18; agent run: typecheck 0, lint 0, vitest 100/100 |
| 1.3 Scanning track | verified | branch worktree-wf_a044751c-de7-1 (c63e72a 1821c5a fe8e6bc ca1309e 0fd6820) on base e0ae32c; agent run: typecheck 0, lint 0, vitest 140/140, mutation check, dev-server and 390/1440 px checks; report notes/analysis/track-reports/scan.json |
| 1.4 Web app track | verified | branch worktree-wf_a044751c-de7-2 (8 commits f31e530..e29a196) on base e0ae32c; agent run: typecheck 0, lint 0, vitest 169/169, real-Chromium service worker and offline checks; report notes/analysis/track-reports/pwa.json |
| 1.5 Fix track A (fixes-core) | verified | branch worktree-wf_44ccc76c-0c7-1 (2c0068b a84f632 4498243 e12bacd a30f7ea) on base d6c48b6; agent run: typecheck 0, lint 0, vitest 232/232, migration chain 0000-0003 applied to a copy of the dev database, seed on a fresh database; UI changes not seen in a browser (report notes/analysis/track-reports/fixes-core.json) |
| 1.6 Fix track B (fixes-ui) | implemented but not verified | branch worktree-wf_44ccc76c-0c7-2 (7 commits b0e0e0a..7f7afb0) on base d6c48b6; agent run: typecheck 0, lint 0, vitest 202/202; no browser was run, so layout and interaction changes are unseen until the phase 2 journey and phase 4 visual review (report notes/analysis/track-reports/fixes-ui.json) |
| 1.7 Infra track | implemented but not verified | branch worktree-wf_99e4d646-98b-1 (6 commits 9109f7d..9856efd) on base 542af7a; agent run: typecheck 0, lint 0, vitest 258/258, `docker compose config` valid, worker and error webhook exercised outside Docker; `docker build` and `docker compose up` never ran (no Docker daemon here), CI never ran on GitHub (report notes/analysis/track-reports/infra.json) |
| 2 Merge payments, then age, into the integration branch | verified | merges c1ef260, bcf9113; after each: typecheck 0, lint 0; after both: vitest 121/121 (9 files) |
| 2 Merge scanning, then web app | verified | merges feafeb4 (then typecheck 0, lint 0, vitest 140/140) and 96923a7 (npm install, then typecheck 0, lint 0, vitest 188/188) |
| 2 APP_ENV: sandboxes allowed on a production build only when it is not a live site | verified | 0686f87; tests/unit/env.test.ts 5/5; full suite 193/193 |
| 2 Production build and existing e2e after four tracks | verified | `npm run test:e2e` at 0686f87 (APP_ENV=test): next build ok, Playwright 8/8 in 2.3 min, exit 0 |
| 2 Merge fix track A, then fix track B | verified | merges 0d06957 (typecheck 0, lint 0, vitest 232/232) and b28583c (typecheck 0, lint 0, vitest 241/241); the two tracks changed no file in common |
| 2 Merge infra | verified | merge a432052: typecheck 0, lint 0, vitest 258/258 (23 files) |
| 2 Clean install and full verification | verified | fresh worktree at a432052 (notes/evidence/clean-verify-a432052.log): npm ci (462 packages), typecheck 0, lint 0, vitest 258/258 in 23 files, next build exit 0 |
| 2 Launch browser journey (age verification, payments, scanning, web app, core flows) | verified | merged f80a555; on the integration head fe21509 `npm run test:e2e`: 36 passed (5.9 min), exit 0 (notes/evidence/e2e-fe21509.log); typecheck 0, lint 0, vitest 258/258; screenshots and per-test console/network evidence JSON in /mnt/project-files/playbox-2/evidence/journey/ (109 files) |
| 3.1 Adversarial review: find | verified | seven finders on a frozen snapshot of f8d5ef3 returned 62 raw findings (notes/analysis/review/raw-findings.json) and a checked-and-fine list per area |
| 3.2 Triage | verified | the triage agent's output was withheld by the platform, so the main session triaged by hand: 49 findings after merging duplicates: 1 critical, 12 high, 22 medium, 14 low (notes/analysis/review/triage.json) |
| 3.3 Reproduce and fix | verified | all 49 triaged findings fixed (1 critical, 12 high, 22 medium, 14 low), each with a test that failed on the old code and passes now; the infra fixer's own pass found 12 more (I01-I12: 2 high, 2 medium, 8 low): 8 fixed, 3 low left by decision, 1 refuted. Per-finding commits, tests and before/after output: notes/analysis/review/fix-results.json (workflow wf_530a6aa5-74c, 21 agents) |
| 3.4 Attack the fixes, patch what broke | verified | one attacker per area tried to get around each fix (90 attempts, 51 held); each of the 39 holes became a failing test, then a patch: 37 patched, 2 left for a product decision (sign-in lockout R05-H6, sign-up membership probe R05-H7, see open issues). Branch suites at their heads, all green with typecheck 0 and lint 0: payments 296, age 286, scan 321, auth 292, moderation 290, generation 281, infra 285 |
| 3.5 Merge the seven fix branches | verified | merges f1e5f8e (payments, vitest 296/296), abded82 (age, 324/324), 09dc2a1 (scan, 387/387), aa7fba0 (auth, 421/421), 16a67db (moderation, 453/453), 0a01221 (generation, 476/476), ce84bff (infra, 503/503 in 44 files); typecheck 0 and lint 0 after each. Four conflicts resolved by hand (download route, scanner imports, media imports, log redaction), plus three merge-only test or import fixes named in the merge commits |
| 4 Visual review | not done | |
| 5 Deliverables: vision, information architecture | implemented but not verified | drafts in the session scratchpad; critiques returned "revise"; finishing in phase 5 against the merged build |
| 5 Deliverables: design system, engineering, deployment, verification | not done | |
| 6 Copilot evidence: read and run main (d2d6cad) | verified | notes/analysis/copilot/ (read.md, run.json, probe scripts); its tests 5/5; server probed with curl; 27 screenshots in /mnt/project-files/playbox-2/evidence/copilot-main/ |
| 6 Copilot comparison and final report | not done | |

## Track definitions

Defined on 2026-10-12 from the approved launch-readiness addendum (Jayvo, 22:30) and the four spec
audits; each runs on its own branch in its own worktree and must pass typecheck, lint and the full
vitest suite before merging.

1. **Payments.** Payments behind an adapter: labeled sandbox, CCBill, Segpay, Stripe off by default
   (Stripe bans adult content). Exactly-once webhooks, refunds claw back credits, chargebacks flag the
   account. Tests: duplicate webhook grants once; refund claws back; chargeback flags.
2. **Age verification.** Provider adapter (sandbox, Yoti) on top of the age gate; jurisdiction rules
   (GB plus US states with laws) as configuration; status per user; no ID images stored; unverified
   users in covered places cannot generate, upload or see explicit media. Tests: blocked until verified,
   signed callbacks, audit on every change.
3. **Scanning.** Every upload and output scanned before storage or display (dev scanner, PhotoDNA,
   Cloudflare); a match blocks, holds evidence, suspends, escalates to a human review queue; fail closed;
   takedown request flow; abuse-response document. Tests: matched content never reaches anyone; outage
   holds content; every block audited.
4. **Web app.** Manifest, icons, app-shell-only service worker, offline state, opt-in push with no
   private content, install offer in settings only. Tests: installability fields, cache rules, push
   subscriptions per device removed at logout, payload privacy.
5. **Fix track A (fixes-core).** Verified defects in the create flow, pipeline and seed: stale draft
   after undo/model switch, retry without cost confirmation, remix lineage, character reference never
   reaching the provider, post-execute failure handling, enum params and policy checks, fabricated seed
   counts, creator suspension, policies copy, missing foreign keys (migration 0003), date of birth kept
   after deletion, video metadata, presets while composing.
6. **Fix track B (fixes-ui).** UX gaps: loading and error pages, mobile "You" sheet and sticky make
   bar, contrast and touch targets, toast overlap, sheet animation, ARIA, polling, project scene
   context, demo badge and VIP filter, discovery rails, creator versioning UI, library filters, admin
   table at narrow widths.
7. **Infra.** Dockerfiles for web and worker, compose with Postgres, Redis and MinIO, .env.example,
   README, CI workflow that never runs on main, an error-webhook hook.

## Decisions log

- 2026-10-13 02:05 This file is the tracker (ground rule 2: the existing file is used, no TRACKER.md).
- 2026-10-13 02:05 Both workflows were interrupted at 01:49 by the session restart. Payments had
  committed all three of its commits with a clean tree; it was re-verified by hand rather than rebuilt
  (ground rule 1: never redo finished work). Scanning had no commits and restarts from scratch.
- 2026-10-13 02:05 Tracks run two at a time in stages (3+4, then 5+6, then 7), and each stage's tracks
  merge into the integration branch in slot order before the next stage starts. Later tracks then
  build on the merged code (payments and age changed shared signatures), which lowers conflict risk.
  The cost is an idle slot while the slower track of a stage finishes.
- 2026-10-13 02:05 The integration branch is `claude/playbox-2-foundation-q7fpbs`, the branch this
  session is assigned to push to. It continues `claude/playbox-2-foundation`'s history.
- 2026-10-13 02:05 Vision and information-architecture drafts wait for phase 5 so their critique runs
  against the merged build, as the run plan asks.
- 2026-10-14 09:00 Medium and low review findings were fixed along with the critical and high ones
  rather than parked: each was small, inside its area's code, and came with a reproducing test.
- 2026-10-14 (fix agents) Product calls taken inside the fixes, each reversible and listed for Jayvo:
  a VIP template's recipe (prompt, negative prompt, defaults) is the paid part and is not sent to a
  viewer without a pass (R35); an actioned NCII or abuse takedown also removes byte-identical copies on
  other accounts (R08-A3, the industry norm for NCII); a sandbox age verification stored before a
  site went live reads as unverified on the live site (R16); AGE_VERIFICATION_FAIL_CLOSED stays false
  by default (R14).

## Open issues

- Age: the US state list is compiled from the Free Speech Coalition tracker as read on 2026-10-12; it is
  configuration, not legal advice, and must be re-checked before launch.
- Age: geo headers are trusted as sent unless the edge strips client copies; deployment must ensure it.
- Age: every public template is treated as explicit (no per-template flag), so unverified viewers in
  covered places see no previews at all.
- Payments: CCBill, Segpay and Yoti adapters are written from public documentation and have never run
  against the real services (no accounts or credentials exist).
- (Resolved 0686f87: APP_ENV; e2e sets APP_ENV=test.) E2E: the Playwright stack runs the production build (NODE_ENV=production), and env() now refuses to
  boot production with the defaults (SCAN_PROVIDER=dev with SCAN_FAIL_CLOSED=true; the age sandbox
  with AGE_VERIFICATION_ENFORCE=true); the payment sandbox also refuses production. So `npm run
  test:e2e` cannot pass at the integration head, and the browser journey cannot exercise the
  sandboxes. Found by reading src/server/env.ts:106-112 and the providers; not yet run. Plan: after
  the scan and web app merge, separate "real deployment" from NODE_ENV with an APP_ENV variable
  (defaults to NODE_ENV; the e2e stack sets APP_ENV=test) so sandboxes stay refused on a real
  production deployment, before the infra track writes CI and the env template.
- Scanning (for Jayvo and counsel, from the track report): keep the original upload bytes as evidence
  on a match (today only the re-encoded file and the sha256)? File through NCMEC's CyberTipline API
  or by hand? Add a classifier slot? Restore templates after a cleared false positive? PhotoDNA's
  success code (3000) is from memory. Cloudflare's tool scans only edge-cached images, and app media is
  private, so as shipped it would see nothing. Legal statements in docs/abuse-response.md are marked
  "for legal review".
- Web app: a user-initiated cancel also sends a push ("A creation was cancelled"); demo outputs get the
  same "Your creation is ready" line. Left as briefed; noted for review.
- Fix track A: lighting, framing, pacing and atmosphere now reach Replicate as prompt words only; the
  suspend route still returns {ok:true} without the unpublished count; Library retry's cost sheet
  cannot show the balance; expired drafts are hidden rather than shown as "Expired".
- Fix track B: Library's extra filters render as a row above the Library heading rather than inside its
  filter bar; every seeded template shows Demo (all seeds use demo models); admin suspend reason and
  flag clearing still use window.prompt.
- Infra: MinIO's official images are no longer on Docker Hub (registry 401 on 2026-10-14), so the s3
  profile defaults to Pigsty's community fork pgsty/minio at a pinned tag (overridable with
  MINIO_IMAGE). A third-party image is a supply-chain choice for Jayvo. No reverse proxy is bundled
  (TLS and geo-header stripping assumed at the edge). Next.js's own error printer can still print a
  Drizzle error's query params to stdout. scripts/seed.ts has no live-site guard outside compose.
  CI builds twice (checks job and e2e job).

- Review, needs Jayvo (product decisions, no code-only fix):
  - Sign-in lockout (R05-H6, medium): ten wrong guesses from anywhere lock the account's sign-in, and
    since R05-H3 its deletion, for 15 minutes; the owner is locked out too. Options: CAPTCHA or proof of
    work after N failures, progressive delay, a trusted-device cookie, or per-(email, address) buckets
    with a higher per-email cap. Each changes two existing regression tests.
  - Sign-up membership probe (R05-H7, medium): sign-up answers differently for a registered email.
    The fix is email verification (always answer "check your inbox"), which needs an email adapter
    that does not exist yet. Probes are rate-limited per address or IPv6 /64.
  - AGE_VERIFICATION_FAIL_CLOSED defaults to false (R14): a request from an unknown country or US state
    is allowed. true blocks unknown locations until the person verifies.
- Review, left open (low, by decision): compose Redis has no password but is not published (I09;
  a required REDIS_PASSWORD breaks every existing .env because compose interpolates inactive
  profiles); base images pinned by tag, not digest (I10, needs registry access); the web image's
  server files are owned by the runtime user (I11, unverifiable without Docker); first-party GitHub
  actions pinned to tags, not SHAs (I07 remainder). I12 (MinIO default credentials) refuted: ports
  bind to 127.0.0.1 and the bucket setup exits without keys.
- Review, go-live questions for the processors (from the payment fixes): does CCBill echo pass-through
  values with their X- prefix (if not, sales are held, failing closed)? Is a CCBill Refund or
  Chargeback transactionId the original sale's or a new one? A timestamp freshness window and nonces
  in the pass-through signatures wait on CCBill's and Segpay's real formats. Segpay still reads a
  missing currencycode as USD (postbacks are authenticated by the postback secret).

## Log (newest last)

- 2026-10-13 02:15 Hand-off requested by Jayvo before the session limit. Wrote `notes/handoff.md`;
  copied maps, audits, track reports, doc drafts and the stage script to
  `/mnt/project-files/playbox-2/working/`. Scanning and web app tracks running, nothing committed yet.
- 2026-10-13 23:41 Resumed from `notes/handoff.md` (Jayvo pasted it at 23:40). Postgres and Redis
  restarted with `notes/workflow/start-services.sh`. The scan worktree had no changes; the web app
  worktree had only an uncommitted package.json/lock edit (drop `motion`, add `web-push` 3.6.7 and
  `@types/web-push` 3.6.4). Both tracks restart from scratch: nothing was committed, and the web app
  track's brief already covers that dependency change, so discarding the edit loses no decision.
- 2026-10-13 23:45 Stage script now tells every track to commit after each coherent step ("WIP:" while
  red), because container restarts have twice killed tracks with uncommitted work.
- 2026-10-13 23:5x Copilot evidence run finished (workflow resumed from its read step): main is a
  front-end-only mock (8 hard-coded templates, localStorage, a 4-file static server); 5/5 tests pass;
  confirmed defects: a closed dialog stays on screen and blocks clicks, search unreachable at phone
  width, recently viewed in catalog order and unreachable on mobile, malformed storage renders 0 cards.
- 2026-10-14 00:22 Scanning and web app tracks finished green. Merged in slot order and verified after
  each merge (140/140, then 188/188). Added APP_ENV/isLiveDeployment (see open issue on e2e boot) and
  tests; 193/193. Stage briefs updated with the tracks' hand-over notes: fix track A wraps the create
  panel, creation detail and Library retry in OfflineGuard; fix track B offsets toasts for the iPhone
  safe area, guards projects and the buy button, and adds a single-device sign-out; infra copies
  public/ into the image and documents APP_ENV.
- 2026-10-14 00:35 `npm run test:e2e` at 0686f87: production build, 8/8 passed. Fix tracks A and B started
  on base d6c48b6.
- 2026-10-14 01:12 Fix tracks A and B finished green and merged in slot order (232/232, then 241/241).
  Track A also edited two files outside its list (src/lib/copilot.ts, src/server/templates/publish.ts),
  both small; reviewed in the merge and kept. Infra track started on the merged head.
- 2026-10-14 01:2x Started in parallel with the infra track: the phase 2 launch journey (worktree,
  production build, writes tests/e2e/launch.spec.ts and evidence capture) and the phase 3 adversarial
  review (seven finders on a frozen snapshot of f8d5ef3, triage, then reproduce-or-refute with a
  failing test per finding). Neither is a build track, so the two-track limit still holds.
- 2026-10-14 01:42 Infra finished green and merged (258/258). All seven phase 1 tracks are merged.
  Clean-install verification (fresh worktree, npm ci, typecheck, lint, vitest, next build) running.
- 2026-10-14 01:45 Clean-install verification passed (log in notes/evidence). npm warns that
  eslint 9.39.1 is no longer supported (out of scope; noted). Docs workflow for deliverables A, B, C, E
  and F started on a frozen snapshot of c52f843, writing to /mnt/project-files/playbox-2/docs.
- 2026-10-14 02:3x Review finders done. The triage step's output was withheld before it returned
  (nothing was refuted by it), so I merged duplicates and calibrated severity by hand from the raw
  findings. Next: one fix agent per area (payments, age, scan and media, auth, moderation,
  generation, plus an infra review), each reproducing every finding with a failing test before
  fixing it, then an independent agent trying to bypass each critical and high fix.
- 2026-10-14 02:40 to 04:40 Session limit. All three running workflows stopped: the journey's gap
  closing, the five doc critiques, and the fix agents. The container restarted. Nothing was lost: the
  worktrees kept their commits, and their uncommitted edits were committed as "WIP:" on their own
  branches at 04:47. The five doc drafts were written before the limit and are committed unreviewed
  (5c6bc8d). Resumed at 04:50: fixes continue in their worktrees (payments, age) or start fresh (the
  other areas), and the journey's gap closing continues in its worktree. Doc fact-checks wait until
  those finish.
- 2026-10-14 04:50 Journey first pass found two app defects: clock and locale text broke hydration
  (fixed, 11ad512) and not-found pages answer HTTP 200 because loading.tsx on dynamic routes streams
  first (being fixed in the gap-closing pass).
- 2026-10-14 05:15 The container restarted again (about 05:10). Payments and age fix agents had
  finished (their results are in the workflow journal); scan and auth were mid-way and their edits
  were committed as "WIP:"; the journey's gap closing had committed everything (39d35ea) but its
  report was lost. Resumed the fix workflow from its journal (payments and age replay from cache,
  scan and auth continue in their worktrees). The journey was verified by hand instead of rerunning
  its agent: merged (f80a555), the env template gained the two e2e variables it reads, and the full
  suite passed 36/36. App fixes the journey made: hydration with clock text, 404 for missing and
  private pages (route groups keep list-page skeletons), the balance pill after a sandbox purchase,
  and a sandbox checkout link that settles once.

All times 2026-10-12, UTC, from `git log` and the thread.

- 20:35 Grounded: Node 22, Postgres 16, Redis 7, ffmpeg, Playwright Chromium present. Repo cloned,
  branch `claude/playbox-2-foundation` created. Playbox reference observed from the shared screen
  recording and `playbox-source.s` (layout patterns only).
- 20:49 `8047578` Foundation: Drizzle schema (users, sessions, consents, ledger, jobs, outputs, assets,
  templates, projects, scenes, folders, reports, audit, stripe events, model configs), credit ledger,
  storage drivers, safety policy, provider adapters, generation service + processor + BullMQ queue.
- 20:59 `89b82f2` Shell (rail, tab bar, age gate), design tokens, discovery queries, payments module,
  seed script with templates and creator accounts.
- 21:00 `cb5eabb` Template card and gallery components.
- 21:16 `4f5d2a5` Library, creation detail, presets, projects and character reference APIs.
- 21:30 `58c8737` Projects, studio, train, creators, favorites, pricing, settings, admin, policies,
  webhooks. Every route smoke-tested as anonymous, member and admin; fixed a template detail crash
  (tags overlap query) and 22P02 → 404 mapping.
- 21:47 `273ec3a` Tests: unit (policy, copilot, registry, signatures), platform integration (Stripe
  dedupe and forgery, consent cascade, cross-user access, publish privacy, report removal, account
  deletion, admin credit idempotency, media range requests, projects, presets), Playwright journey on
  the production standalone build (8 specs). Fixes found by tests: underage regex, "years of
  experience" false positive, copilot "pans", storage path shared between app and worker, duplicate
  balance test id.
- 21:56 `0987b7c` Video poster frames (ffmpeg + sharp, migration 0001), discarded outputs purge
  posters, seeded users carry terms/adult consents, settings toggle knob centered. Results at this
  commit: typecheck clean, lint clean, vitest 79/79 in 27.7 s.
- 21:58 Sneak-peek screenshots taken from the dev server (member account) into
  `/mnt/project-files/playbox-2/sneak-peek/` (7 PNGs). A new demo clip in project "Night swim"
  confirmed the poster frame renders in the Library and the project workspace.
- 22:00 Handover: Jayvo asked for a sneak peek and a restart on the best model; the Coordinator starts a
  fresh session on Fable 5.1 from this branch. Playwright e2e re-run on the production standalone
  build at `0987b7c`: 8 passed in 2.4 min (`npm run test:e2e`, exit 0). The e2e run also proved
  `npm run build` at this commit. Dev server and worker were stopped for that run and left stopped.
