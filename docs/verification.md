# Hushloom verification report

Deliverable G. It says what was built, what was tested and how, what passed, what failed, which
providers are configured, which need credentials, which features are demonstrations and which are
operational, the known limitations, and what still blocks a production launch.

Every result uses exactly one of four statuses:

| Status | Meaning |
| --- | --- |
| verified | Run here, with the output recorded (a command result, a test, a screenshot). |
| implemented but not verified | The code exists and its local tests pass, but it was never run against the real service, device or environment it is for. |
| blocked | It cannot be run without something this build does not have (an account, a key, a daemon). |
| not done | Not built. |

Scope: the branch `claude/playbox-2-foundation-q7fpbs` at {{HEAD}} in FearMelts/HushLoom. The single
tracker with every step, decision and open issue is `notes/progress.md`. Nothing is deployed, nothing
is merged into `main`, and no pull request is open.

## 1. Checks at the final head

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Clean install | `npm ci` in a fresh worktree | {{CI}} | `notes/evidence/clean-verify-{{HEAD}}.log` |
| Typecheck | `npm run typecheck` (`tsc --noEmit`, strict) | {{TC}} | same log |
| Lint | `npm run lint` (zero warnings allowed) | {{LINT}} | same log |
| Unit and integration tests | `npx vitest run` against Postgres 16 and Redis 7 | {{VITEST}} | same log |
| Production build | `next build` (standalone output) | {{BUILD}} | same log |
| Browser tests | `npm run test:e2e` (fresh database, production build, standalone server and worker) | {{E2E}} | `notes/evidence/e2e-{{HEAD}}.log` |

The browser run includes the launch journey (`tests/e2e/journey.spec.ts`, `tests/e2e/launch.spec.ts`)
and the always-on layout guard (`tests/e2e/layout.spec.ts`). The 32 visual-capture tests in
`tests/e2e/visual.spec.ts` are skipped unless `VISUAL_REVIEW=1`; they ran twice in the visual review
(section 4).

## 2. Feature status

### Core product (deliverable D)

| Area | Status | Evidence and notes |
| --- | --- | --- |
| Accounts: sign-up with date of birth (18+), sign-in, sign-out, sessions, account deletion | verified | e2e "an adult signs up ...", "an under-18 date of birth is refused"; vitest `tests/integration/auth.test.ts` |
| Ownership: a member never sees another member's creations or media | verified | e2e "another member cannot see that creation or its media"; vitest platform and media tests |
| Private and missing pages answer 404; signed-out private pages redirect | verified | e2e "missing and private pages answer 404 ..." |
| Discovery: home rails, Explore with sort and filters, template pages, creator pages, favorites | verified | e2e journeys and 223 visual captures (section 4) |
| Create flow: template prefill, models, settings, cost shown before confirm, assistant that blocks prohibited prompts before any charge | verified | e2e "an adult signs up ...", "the assistant blocks a prohibited prompt ..." |
| Generation pipeline: BullMQ queue, worker, job states, retries, cancellation and refund | verified | vitest generation and processor tests; e2e runs the real worker |
| AI output | demonstration | The `demo-still` and `demo-motion` models render labeled placeholder images and clips with sharp and ffmpeg. No AI model runs. |
| Credits ledger: reserve, settle, release, refund, idempotent movements | verified | vitest ledger and payments tests; e2e purchase and refund cases |
| Library (Collection), creation detail, filters, folders, variations, retry, download | verified | e2e (a creation found in the Library); vitest (download, derive and retry routes, through the age and scan suites); visual captures |
| Projects and scenes, Studio, Train (character references with consent) | verified | vitest; visual captures at three widths |
| Admin: reports, credits, flags, suspension, models, audit log, abuse review queue | verified | e2e: clearing a chargeback flag, the abuse escalation, dismissing a takedown; vitest platform and moderation tests; visual captures |
| Responsive layout at 390, 820 and 1440 px | verified | visual review (section 4); e2e layout guard |
| Keyboard access (skip link, navigation) | verified | e2e "keyboard users can skip to content and reach navigation" |

### Launch-readiness additions

| Area | Status | Evidence and notes |
| --- | --- | --- |
| Payments through the labeled sandbox: buy, failure, refund clawback, chargeback flag and pause, forged or replayed webhooks refused | verified | e2e "payments in the labeled sandbox" (9 tests); vitest `payments.test.ts`, `attack-payments.test.ts` |
| CCBill and Segpay adapters | implemented but not verified | Written from public documentation; no merchant account exists. Open questions in section 6. |
| Stripe adapter | implemented but not verified | Off by default: Stripe's restricted-businesses list bans adult content. |
| Age verification through the labeled sandbox, in GB and covered US states | verified | e2e "age verification in a covered jurisdiction (GB)" and "in US states" |
| Yoti age-verification adapter | implemented but not verified | Written from Yoti's public documentation; no Yoti account exists. |
| Abuse scanning with the development scanner: uploads and outputs scanned before storage or display, fail closed, match held as evidence, uploader suspended, admin review, public takedown form | verified | e2e "abuse scanning and takedowns" (4 tests); vitest scan, verdict, upload and takedown suites |
| PhotoDNA adapter | blocked | Needs Microsoft's approval and a key. The success code it checks was written from memory. |
| Cloudflare CSAM Scanning Tool | implemented but not verified | It only scans images Cloudflare caches, and app media is private, so as shipped it would see nothing. |
| Installable web app: manifest, icons, service worker, offline page, offline guard | verified | e2e "installable web app" (6 tests), including Chromium's own installability check |
| Install on real devices (Android, desktop Chrome or Edge, iOS Safari) | implemented but not verified | Never run on a device. |
| Push notifications for finished and failed generations | blocked | Needs VAPID keys. Settings says push is off without them (e2e). Delivery through real push services was never tested. |

### Operations

| Area | Status | Evidence and notes |
| --- | --- | --- |
| Environment validation and live-site guard (sandboxes refuse a live site) | verified | `tests/unit/env.test.ts`, `tests/unit/env-template.test.ts` |
| Structured logs with prompts, emails and query values redacted; error webhook | verified | vitest observability and `attack-infra.test.ts` (outside Docker) |
| Docker images and compose stack | blocked | No Docker daemon here. Only `docker compose config` was run. |
| CI workflow (`.github/workflows/ci.yml`) | implemented but not verified | Never run on GitHub. It never runs on `main`. |
| Migrations `0000` to `0004` | verified | Applied on a fresh database by every vitest and e2e run |

## 3. Adversarial review

Seven reviewers read a frozen snapshot and returned 62 raw findings. Triage merged them into 49:
1 critical, 12 high, 22 medium, 14 low. The infra fixer reviewed the Docker, compose, CI and logging
code (merged after the snapshot) and found 12 more (I01 to I12: 2 high, 2 medium, 8 low).

| Outcome | Count |
| --- | --- |
| Review findings fixed, each with a test that failed before the fix and passes after | 49 of 49 |
| Infra findings fixed | 8 of 12 (3 low left by decision, 1 refuted) |
| Attack attempts on the fixes | 90, of which 51 held |
| Holes the attacks found | 39: 37 patched with tests, 2 left for a product decision |

The critical finding (R01) let a payment short of the price, or in another currency, grant the full
item. Every processor's sale now has to match the item's price and currency, or it is held for manual
review and grants nothing. Per-finding commits, tests and before-and-after output are in
`notes/analysis/review/fix-results.json`.

## 4. Visual review

A capture spec took 223 full-page screenshots at 390, 820 and 1440 px: every page, as a visitor, a
member, a new member with empty states, an unverified member in GB, a creator and an admin, plus
loading skeletons, the offline page, the not-found page and open sheets. Each screenshot carried
automated checks for horizontal overflow, tap targets, clipped text and axe colour contrast. Two
reviewers opened every screenshot and found 43 defects: 3 high, 26 medium, 14 low.

All 43 were fixed and confirmed by a second full capture: no overflow at any width, contrast
violations from 9 to 0, and flagged phone tap targets from 1,916 to 369. The remaining flags are card
title links that duplicate the card's own link, switches inside full-row labels, links inside
sentences, and native checkboxes inside their labels. The second capture found no new defect.

One fix worked around a hydration bug in the React 19.2 build that Next.js 15.5.27 ships (React error
#418 on about 1 in 130 cold loads with the browser cache off); a Next.js release that ships React 19.3 or later removes the
cause. Screenshots and manifests: `/mnt/project-files/playbox-2/evidence/visual/before/` and
`after/`; results `notes/analysis/visual/visual-review.json`.

Not captured: the route error boundary, because no page throws on demand.

## 5. Providers and credentials

| Service | Configured here | To go live | Environment variables |
| --- | --- | --- | --- |
| AI generation | Demo models only | An AI provider whose terms allow adult content. fal.ai forbids sexually explicit content unless it authorizes the account; Replicate's terms are ambiguous. A Replicate adapter exists. | `REPLICATE_API_TOKEN`, `REPLICATE_WEBHOOK_SECRET`, `ENABLE_DEMO_PROVIDER` |
| Payments | Sandbox | A CCBill or Segpay merchant account | `PAYMENT_PROVIDER`, `CCBILL_*` or `SEGPAY_*` |
| Age verification | Sandbox | A Yoti account (or another provider through the adapter) | `AGE_VERIFICATION_PROVIDER`, `AGE_VERIFICATION_API_KEY`, `AGE_VERIFICATION_SDK_ID`, `AGE_VERIFICATION_NOTIFICATION_PUBLIC_KEY` |
| Abuse scanning | Development scanner | Microsoft PhotoDNA approval; NCMEC registration in the US, IWF or INHOPE reporting routes elsewhere | `SCAN_PROVIDER`, `PHOTODNA_API_KEY`, `PHOTODNA_ENDPOINT` |
| Push | Off | VAPID keys, generated once per deployment | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| Storage | Local disk | A private S3-compatible bucket (AWS S3 or Cloudflare R2) | `STORAGE_DRIVER`, `S3_*` |
| Error monitoring | Logs only | Any HTTPS endpoint, for example a relay to Sentry | `ERROR_WEBHOOK_URL` |
| Edge | None | TLS, geo headers set at the edge with client copies stripped, forwarding headers | `GEO_COUNTRY_HEADER`, `GEO_REGION_HEADER`, `TRUSTED_PROXY_HOPS` |

`.env.example` lists every variable with its default. `docs/deployment.md` has the going-live
checklist.

## 6. Known limitations and open decisions

Decisions for the owner:

- **Sign-in lockout (R05-H6).** Ten wrong guesses from anywhere lock an account's sign-in, and its
  deletion, for 15 minutes, which locks the owner out too. Options: CAPTCHA after failures,
  progressive delay, a trusted-device cookie, or per-address buckets with a higher per-account cap.
- **Sign-up membership probe (R05-H7).** Sign-up answers differently for a registered email. The fix
  is email verification, which needs an email service the build does not have.
- **Unknown locations.** `AGE_VERIFICATION_FAIL_CLOSED` defaults to false, so a visitor whose country
  or US state is unknown is not asked to verify.
- **Product calls taken in the fixes, all reversible:** a VIP template's recipe is withheld from
  viewers without a pass; an actioned takedown also removes byte-identical copies on other accounts; a
  sandbox verification made before launch does not count on a live site.

Questions for the processors (from the payment fixes): whether CCBill echoes pass-through values with
their `X-` prefix (if not, sales are held, which fails closed); whether a CCBill refund or chargeback
carries the original sale's transaction id; the formats a timestamp window and signed nonces would
need. Segpay still reads a missing currency code as USD.

Low items left by decision: compose Redis has no password (it is not published); base images are
pinned by tag, not digest; the web image's server files are owned by its runtime user; GitHub actions
are pinned to tags, not commit SHAs. The brief "Weaving a demo placeholder" toast overlaps the Make
button on phones while it shows.

Legal: statements in `docs/abuse-response.md` are marked for legal review. The US state list in
`src/config/jurisdictions.ts` was compiled from the Free Speech Coalition tracker on 2026-10-12; it
is configuration, not legal advice, and must be re-checked before launch.

## 7. What blocks a production launch

1. An AI provider that permits adult content, under contract, wired through the adapter and tested.
2. A merchant account with CCBill or Segpay, and a test against its sandbox and real webhooks.
3. An age-verification account (Yoti or another) and a test of its live flow and notifications.
4. PhotoDNA approval, the reporting registrations, and a drill against the live scanner.
5. Hosting whose terms allow adult content, with TLS and the geo and forwarding headers set at the
   edge. Vercel's acceptable-use policy is unclear for adult content; check before deploying.
6. `docker build` and `docker compose up` run on a real Docker host, and the CI workflow run on GitHub.
7. Counsel's review of the abuse-response document, the jurisdictions list and the policies.
8. The owner's decisions in section 6.

No production deploy, real payment or public publish was made by this build.
