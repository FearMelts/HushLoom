# Hushloom build plan

Resume file for any session continuing this build. Pair it with `notes/progress.md` (what happened,
newest last), `notes/state.json` (countable state) and `git log`.

## Task

Build Hushloom: an adult-only, AI-native image and video creation app modeled on Playbox's product
structure (template gallery, one-tap remix, fast generation, projects, community) but with its own
name and look. It must be a real build: persistent data, a generation state machine with no fake
progress, an idempotent credit ledger, server-side age and consent enforcement, private-by-default
media. The spec is Jayvo's root message of the "Build Playbox 2.0" thread (2026-10-12).

## Acceptance test

`npm run verify` passes on a clean checkout with Postgres and Redis running: typecheck, lint,
vitest (unit + integration), `next build`, and the Playwright journey on the production standalone
build. The journey covers signup, an admin credit grant, template → make → Ready, cross-user 404s, a
forged media link (403), a cross-origin POST (403), an under-18 refusal, a blocked prompt, layouts at
390/820/1440 with no sideways scroll, and keyboard reachability.

Baseline (2026-10-12 20:35, before any code): empty repo clone, nothing ran.

## Rules of the branch

- Our work lives only on `claude/playbox-2-foundation`. Never push to `main`.
- Copilot's prototype is on `main` (PR #1). Never modify, rebase, comment on or close its work; read it
  only as material for the comparison.
- Opening a PR, merging or porting is Jayvo's call. Prepare the PR text; list it under "Waiting on you".
- Never invent credentials or results. Anything the demo provider makes is labeled as a demo.

## Environment that worked here (cloud container, 2026-10-12)

- Postgres 16 started by hand: `/usr/lib/postgresql/16/bin/postgres -D /home/claude/.pgdata -k /tmp -p 5432`
  (role `playbox`, no password, trust auth on localhost). Databases: `playbox` (dev), `playbox_test`
  (vitest), `playbox_e2e` (Playwright; recreated on every run).
- Redis 7 at `redis://localhost:6379` (`redis-server` daemonized). vitest uses db 1, e2e uses db 2.
- ffmpeg at `/usr/bin/ffmpeg` (demo clips and poster frames need it).
- Node 22, `npm install` (no postinstall browser download; Playwright uses `/opt/pw-browsers`).
- `npm run db:migrate` then `SEED_PASSWORD=<choose one> npm run db:seed`. The seed prints the accounts:
  `admin@hushloom.local` (admin), `demo@hushloom.local` (member, 200 credits), six creator accounts.
  Without `SEED_PASSWORD` the seed makes a random password and prints it once.
- Dev: `npm run dev` (port 3000) plus `npm run worker` in a second process. The dev DB currently holds
  the seed plus a project "Night swim" (two scenes), four creations, a character "Mara" and a preset
  "Lace window" for the demo member.

### Environment variables (names only; see `src/server/env.ts` for defaults)

`APP_URL`, `DATABASE_URL`, `REDIS_URL`, `SESSION_TTL_DAYS`, `MEDIA_SIGNING_SECRET` (required in
production, 32+ chars), `MEDIA_URL_TTL_S`, `STORAGE_DRIVER` (local|s3), `STORAGE_LOCAL_DIR` (absolute in
production), `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`ENABLE_DEMO_PROVIDER`, `REPLICATE_API_TOKEN`, `REPLICATE_WEBHOOK_SECRET`, `PROVIDER_TIMEOUT_S`,
`WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`, `USER_MAX_ACTIVE_JOBS`, `SIGNUP_GRANT_CREDITS`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `AGE_ASSURANCE_STRICT_REGIONS`, `GEO_COUNTRY_HEADER`.
No real provider, Stripe or S3 credentials have ever been present; those paths are untested live.

## Commands and their last verified result (all at commit 0987b7c unless noted)

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean (exit 0) |
| `npm run lint` | clean, 0 warnings |
| `npm test` (vitest) | 6 files, 79/79 passed in 27.7 s (44 unit, 35 integration) |
| `npm run build` | passes (run by the e2e webServer; standalone output) |
| `npm run test:e2e` | 8/8 passed in 2.4 min on the production standalone build |
| Route smoke (`scripts` in scratch, not committed) | every page returned the expected code as anonymous, member and admin at 58c8737 |

## Decisions so far

Identity
- Name **Hushloom** (unique, no "box"/"play"); Jayvo's rule: site must look nothing like playbox.com.
- Palette tokens in `src/app/globals.css`: aubergine-black `ink` scale for surfaces, warm `bone` for
  text, `ember` (coral-orange) as the single accent, `brass` for VIP, `sage` for "new", `iris` for demo
  labels, `danger` rose. Playbox is neutral black with blue/pink; we deliberately avoid that.
- Type: Fraunces (display serif, italic emphasis), Manrope (body), JetBrains Mono (labels, counts).
  Self-hosted via @fontsource-variable; no Google Fonts.
- Shape: "petal" cards (`.petal`: 20px radius on two opposite corners, 5px on the other two), left
  rail on desktop, bottom tab bar with a center "+" on mobile. Reduced motion respected (the
  `prefers-reduced-motion` block in `globals.css` cuts every animation to 1ms).
- Voice: short, warm, second person. Demo outputs carry "Demo output · not AI-generated".

Stack
- Next.js 15 App Router (standalone output), React 19, strict TypeScript, Tailwind 4, Drizzle +
  postgres, BullMQ + ioredis, zod, Stripe SDK, sharp, AWS S3 SDK, vitest, Playwright.
- No ORM-level auth library; sessions are our own table with an httpOnly cookie `hl_session`.
- Age gate cookie `hl_age_ok` for anonymous browsing; real enforcement is DOB + attestation at signup,
  checked on the server. Strict regions (`AGE_ASSURANCE_STRICT_REGIONS`, read from `GEO_COUNTRY_HEADER`)
  get 451 when they try to create (`src/server/generation/service.ts`).

Platform
- Generation is a state machine: awaiting_confirmation → queued → processing → completed | failed |
  cancelled. Draft returns the cost; confirm must send `expectedCost` (409 if the price changed).
- Credits: ledger with available/reserved, every write keyed by an idempotency key; reserve on confirm,
  capture on completion, release on failure/cancel. Stripe events are processed exactly once: each one is
  recorded in `payment_events` with a `processedAt`, and a repeat returns "duplicate".
- Providers are adapters: `demo-still`, `demo-motion` (ffmpeg clip), `replicate-flux-schnell` (real,
  untested without a token). Demo adapters are clearly labeled in the UI and in the data (`isDemo`).
- Media is private by default: local driver serves through `/api/media` with HMAC-signed, expiring
  URLs issued after the ownership check. Publishing copies the output into a new public asset.
- Creations made from an upload or a character reference cannot be published (consent boundary).
- Consent records for terms, adult attestation, uploads and likeness; withdrawing a consent soft-deletes
  dependent assets and purges files right away.
- Safety policy is regex-based with text normalization (`src/server/safety/policy.ts`); the copilot is
  rules-based (`src/lib/copilot.ts`), filtered to block-only when the user turns suggestions off.
- Origin-check middleware on every mutating API call; Redis rate limits on expensive endpoints.
- Discovery personalization uses only category/tag affinity from the user's own events.
- Video outputs get a poster frame (ffmpeg + sharp) as a separate asset (migration 0001).
- Bad UUIDs in routes map to 404, not 500.
- Plans drive VIP access and concurrent-job limits (`src/config/pricing.ts`); prices there are
  placeholders for the operator to set.

Process
- Jayvo chose "Run both, compare" (decision card, 2026-10-12): finish on our branch, then compare with
  Copilot's `main` and recommend. Nothing merged until Jayvo picks.
- Jayvo asked for a sneak peek and a restart "in ULTRACODE on the best model" (2026-10-12 21:50). The
  Coordinator restarts the build in a fresh session on Fable 5.1 from this branch; this session's job
  was to hand over cleanly.

## Remaining work

1. Visual review of every page at 390/820/1440 as member and admin (done for the main pages; admin
   model row "Price %" wraps and the toggle column is cramped; the dev-only Next indicator overlaps
   the rail footer in dev mode only).
2. Deliverables A–G under `/mnt/project-files/playbox-2/` and `docs/` in the repo: vision, design
   system, information architecture, engineering docs, deployment/config, verification report.
   Note: `/mnt/project-files/.notes/inputs.md` points at `playbox-2/docs/01-reference-observations.md`,
   but that file was never written (checked 2026-10-12 21:57; the folder held only `sneak-peek/`).
   The reference observations live in this session's thread history only; re-derive them from the
   recording if needed (skip roughly 10 s to 60 s, which shows the owner's private Photos library).
3. Docker: Dockerfile for the standalone server, Dockerfile for the worker (needs ffmpeg),
   docker-compose with postgres, redis, optional minio; `.env.example` with names only; README.
4. Backfill posters for clips created before migration 0001 (one such clip in the dev DB).
5. Copilot comparison: read `main` read-only (PR #1: a static page, a small Node server, two docs);
   report what runs, real vs demo, tests, what is worth porting; recommend one.
6. Final report in Jayvo's format with the prepared PR title/body under "Waiting on you".
7. Cleanup: remove `src/server/copilot/` (empty directory), delete scratch screenshots, decide on
   dropping `playbox_test`/`playbox_e2e`.

## Known defects and gaps

- H.264 playback inside headless Chromium is unverified (posters cover the thumbnail case).
- Admin model table layout on narrow widths (see above).
- `replicate-flux-schnell` adapter and the Replicate webhook route have never run against the real
  service; the webhook only verifies and logs.
- Stripe checkout returns 503 until `STRIPE_SECRET_KEY` is set; webhook tests sign locally with a fake
  secret from `vitest.config.ts`.
- No S3 run; the driver is written against the SDK but unexercised.
