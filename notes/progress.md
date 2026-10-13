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
| 1.3 Scanning track | not done | 02:07 attempt ended with the session at the daily limit, no commits; restarting 2026-10-13 23:4x from the integration head |
| 1.4 Web app track | not done | 02:07 attempt ended with the session at the daily limit, no commits (only an uncommitted dependency edit, discarded); restarting 2026-10-13 23:4x from the integration head |
| 1.5 Fix track A (fixes-core) | not done | |
| 1.6 Fix track B (fixes-ui) | not done | |
| 1.7 Infra track | not done | |
| 2 Merge payments, then age, into the integration branch | verified | merges c1ef260, bcf9113; after each: typecheck 0, lint 0; after both: vitest 121/121 (9 files) |
| 2 Merge remaining tracks, full verification, browser journey | not done | |
| 3 Adversarial review | not done | |
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

## Open issues

- Age: the US state list is compiled from the Free Speech Coalition tracker as read on 2026-10-12; it is
  configuration, not legal advice, and must be re-checked before launch.
- Age: geo headers are trusted as sent unless the edge strips client copies; deployment must ensure it.
- Age: every public template is treated as explicit (no per-template flag), so unverified viewers in
  covered places see no previews at all.
- Payments: CCBill, Segpay and Yoti adapters are written from public documentation and have never run
  against the real services (no accounts or credentials exist).
- E2E: the Playwright stack runs the production build (NODE_ENV=production), and env() now refuses to
  boot production with the defaults (SCAN_PROVIDER=dev with SCAN_FAIL_CLOSED=true; the age sandbox
  with AGE_VERIFICATION_ENFORCE=true); the payment sandbox also refuses production. So `npm run
  test:e2e` cannot pass at the integration head, and the browser journey cannot exercise the
  sandboxes. Found by reading src/server/env.ts:106-112 and the providers; not yet run. Plan: after
  the scan and web app merge, separate "real deployment" from NODE_ENV with an APP_ENV variable
  (defaults to NODE_ENV; the e2e stack sets APP_ENV=test) so sandboxes stay refused on a real
  production deployment, before the infra track writes CI and the env template.

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
