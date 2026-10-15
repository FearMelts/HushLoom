# Hushloom verification report

Deliverable G. It says what was built, what was tested and how, what passed, what failed, which
providers are configured, which need credentials, which features are demonstrations and which are
operational, the known limitations, and what still blocks a production launch. It also separates
what was built from what was intended but not built (the last table in section 2).

Every result in sections 1 to 4 carries exactly one of four statuses:

| Status | Meaning |
| --- | --- |
| verified | Run here or on GitHub Actions, with the output recorded (a command result, a test, a screenshot). |
| implemented but not verified | The code exists and its local tests pass, but it was never run against the real service, device or environment it is for, or no test runs it. |
| blocked | It cannot be run without something this build does not have (an account, a key, a daemon). |
| not done | Not built. |

Section 2 also gives each feature a mode, which says whether it is operational or a labeled
stand-in.

Scope: the branch `claude/playbox-2-foundation-q7fpbs` in FearMelts/HushLoom. The code was verified at
commit 09a436e on 2026-10-14; later commits on the branch change only documents and notes. The single
tracker with every step, decision and open issue is `notes/progress.md`. Nothing is deployed, and
nothing is merged into `main`, which still holds Copilot's prototype (d2d6cad).

## 1. Checks at the final head

| Check | Command | Result | Status | Evidence |
| --- | --- | --- | --- | --- |
| Clean install | `npm ci` in a fresh worktree | exit 0, 462 packages | verified | `notes/evidence/clean-verify-09a436e.log` |
| Typecheck | `npm run typecheck` (`tsc --noEmit`, strict) | exit 0, no errors | verified | same log |
| Lint | `npm run lint` (zero warnings allowed) | exit 0, no warnings or errors | verified | same log |
| Unit and integration tests | `npx vitest run` against Postgres 16 and Redis 7 | 45 files, 507 tests, all passed (302 s) | verified | same log |
| Production build | `next build` (standalone output) | exit 0 | verified | same log |
| Browser tests | `npm run test:e2e` (fresh database, production build, standalone server and worker) | 72 tests: 40 passed, 32 skipped (the visual captures), 0 failed (5.6 min), exit 0 | verified | `notes/evidence/e2e-09a436e.log` |
| CI on GitHub Actions | `.github/workflows/ci.yml`: a checks job (typecheck, lint, vitest, build) and a Playwright job on the production build | Run 16 at 574ccaf (code as at 09a436e): both jobs green. One failed run, run 9 (section 6) | verified | `notes/evidence/github-ci.md`, read through the GitHub API (22 runs in total; the ten newest, runs 7 to 16, listed) |

The 40 browser tests that run are the launch journey (`tests/e2e/journey.spec.ts`,
`tests/e2e/launch.spec.ts`) and the always-on layout guard (`tests/e2e/layout.spec.ts`, 4 tests: the
main routes fit 390 and 820 px for a visitor and a member, with 40 px primary targets at 390). The 32
visual-capture tests in `tests/e2e/visual.spec.ts` are skipped unless `VISUAL_REVIEW=1`. In the
visual review they ran for the before and after captures, with 32 passed each time (section 4).

## 2. Feature status

Status says what was run. Mode says what the feature is today:

| Mode | Meaning |
| --- | --- |
| operational | Works here end to end and needs no outside account. |
| labeled demo | Stands in for an AI model. It runs here, and every result says Demo on screen. No AI model runs. |
| labeled sandbox | Stands in for a payment or age-check provider. It runs here, says Sandbox on screen, and refuses to run on a live site. |
| development | The development scanner. It matches only test hashes, shows "Development scanner · not live" in the admin review queue, and refuses to run on a live site. |
| off | The code exists but stays off until its credentials or settings are supplied. An adapter that is off has never run against its real service (unverified). |
| never run | Build tooling that was not run here. |

### Core product (deliverable D)

| Area | Status | Mode | Evidence and notes |
| --- | --- | --- | --- |
| Accounts: sign-up with date of birth (18+), sign-in, sign-out, sessions, account deletion | verified | operational | e2e "an adult signs up ...", "an under-18 date of birth is refused"; vitest `auth.test.ts`, `platform.test.ts` (deletion ends sessions), `push.test.ts` (logout, sign out everywhere). There is no password reset or change (see the last table). |
| Ownership: a member never sees another member's creations or media | verified | operational | e2e "another member cannot see that creation or its media"; vitest platform and media tests |
| Private and missing pages answer 404; signed-out private pages redirect | verified | operational | e2e "missing and private pages answer 404 ..." |
| Discovery: home rails, Explore with sort and filters, template pages, creator pages, favorites | verified | operational; the seeded templates show labeled demo media | e2e journeys; vitest "browse templates"; 223 visual captures (section 4) |
| Create flow: template prefill, models, settings, cost shown before confirm, assistant that blocks prohibited prompts before any charge | verified | operational; its output is labeled demo | e2e "an adult signs up ...", "the assistant blocks a prohibited prompt ..." |
| Generation pipeline: BullMQ queue, worker, job states, retries, cancellation and refund | verified | operational | vitest generation suites; e2e runs the real worker |
| AI output from the labeled demo models (`demo-still`, `demo-motion`) | verified | labeled demo | They render placeholder images and clips with sharp and ffmpeg, marked Demo. Every seeded template uses them, so every one shows Demo. e2e makes a demo image; vitest makes a demo clip through ffmpeg |
| Real AI generation through the Replicate adapter | implemented but not verified | off | Off without `REPLICATE_API_TOKEN`. Unit tests check the input it builds and its webhook signature check; it never called Replicate. Its one model, FLUX.1 schnell, makes images only (`src/server/ai/registry.ts`). No provider is chosen (section 5) |
| Credits ledger: reserve, settle, release, refund, idempotent movements | verified | operational; credits are bought through the labeled sandbox | vitest generation and payments suites; e2e purchase and refund cases |
| Library (Collection), creation detail, filters, variations, retry, download | verified | operational | e2e (a creation found in the Library); vitest library filters, variations, and the download, derive and retry routes (age, scan and moderation suites); visual captures |
| Publishing a creation as a template: the output is copied to a new public asset, the original stays private, anything made from an upload or character is refused | verified | operational | vitest `platform.test.ts:180-222` ("publishing"), `composing.test.ts:148` (the content policy re-checks stored settings), moderation suites (the takedown hash block; suspended creators cannot publish) |
| Creator versioning and remix attribution: a prompt edit makes a new version; a remix links its source and keeps the template's credit | verified | operational | vitest `moderation.test.ts:225` (versions), `composing.test.ts:56-94` and `generation.test.ts:317` (remix lineage), `moderation.test.ts:415` ("Remix of" names only a source that is still published) |
| VIP templates: the recipe is withheld from a viewer without a pass | verified | operational; passes are bought through the labeled sandbox | vitest `moderation.test.ts:385` (R35); "browse templates" filters by VIP |
| Ratings | verified | operational | vitest `generation-hardening.test.ts:252` (totals stay right when two members rate at once) |
| Template reports: filing a report, admin removal | verified | operational | vitest `platform.test.ts:208` (removing a reported template closes every report on it); the visual capture setup files a report through `POST /api/templates/{id}/report` and checks for 201 (`tests/e2e/visual.spec.ts:709`) |
| Presets | verified | operational | vitest `platform.test.ts:359` (saved without the seed, owner only), `composing.test.ts:138` |
| Follows | implemented but not verified | operational | `/api/follows` exists (follow and unfollow), but no test calls it. The only follow is seeded (`scripts/seed.ts:290`); a visual capture shows it on a creator page (`tests/e2e/visual.spec.ts:811`) |
| Folders; admin model switches (on or off, price multiplier) | implemented but not verified | operational | Both appear in the visual captures, but no test creates a folder, adds a creation to one, or changes a model setting. The only folder request a test sends is a cross-site POST, refused with 403 |
| Projects and scenes, Studio, Train (character references with consent) | verified | operational; outputs are labeled demo, and a character reference reaches a model only in Demo Still's reference mode | vitest platform, composing and generation suites; visual captures at three widths |
| Admin: reports, credits, flags, suspension, audit log, abuse review queue | verified | operational | e2e: clearing a chargeback flag, the abuse escalation, dismissing a takedown; vitest platform, payments and moderation suites; visual captures |
| Responsive layout at 390, 820 and 1440 px | verified | operational | visual review (section 4); e2e layout guard at 390 and 820 |
| Keyboard access (skip link, navigation) | verified | operational | e2e "keyboard users can skip to content and reach navigation" |

### Launch-readiness additions

| Area | Status | Mode | Evidence and notes |
| --- | --- | --- | --- |
| Payments: buy, failure, refund clawback, chargeback flag and pause, forged or replayed webhooks refused | verified | labeled sandbox | e2e "payments in the labeled sandbox" (9 tests); vitest `payments.test.ts`, `attack-payments.test.ts` |
| CCBill and Segpay adapters | implemented but not verified | off | Written from public documentation and tested only against webhooks and postbacks built locally; no merchant account exists. Open questions in section 6 |
| Stripe adapter | implemented but not verified | off | Off by default: Stripe's restricted-businesses list bans adult content. vitest runs its webhook handling against locally signed events (`platform.test.ts:77`) |
| Age verification in GB and covered US states | verified | labeled sandbox | e2e "age verification in a covered jurisdiction (GB)" (5 tests) and "in US states" (1 test) |
| Yoti age-verification adapter | implemented but not verified | off | Written from Yoti's public documentation; no Yoti account exists |
| Abuse scanning: uploads and outputs scanned after storage and before the file is used, served or shown (stored first so a match can keep the file under legal hold as evidence), fail closed, match held as evidence, uploader suspended, admin review, public takedown form | verified | development | e2e "abuse scanning and takedowns" (4 tests); vitest scan, verdict, upload and takedown suites |
| PhotoDNA adapter | implemented but not verified | off | Its own test (`tests/integration/scan.test.ts:586-597`) checks only that the JPEG it would send is under the size cap and that it fails closed when unconfigured. Its JPEG conversion also runs in `tests/integration/uploads.test.ts` (stored pixels equal scanned pixels; the pixel-limit refusal). No test, local or fake, sends its HTTP request or exercises its check for success code 3000 (`src/server/safety/scan/providers/photodna.ts:92`), which was written from memory. Running it needs Microsoft's approval and a key |
| Cloudflare CSAM Scanning Tool | implemented but not verified | off | It only scans images Cloudflare caches, and app media is private, so as shipped it would see nothing |
| Installable web app: manifest, icons, service worker, offline page, offline guard | verified | operational | e2e "installable web app" (6 tests), including Chromium's own installability check |
| Install on real devices (Android, desktop Chrome or Edge, iOS Safari) | implemented but not verified | operational | Never run on a device |
| Push notifications for finished and failed generations | implemented but not verified | off | Off until VAPID keys are set; Settings says so (e2e). vitest builds a VAPID-signed, encrypted request locally and sends nothing. Delivery through a real push service was never tested |

### Operations

| Area | Status | Mode | Evidence and notes |
| --- | --- | --- | --- |
| Environment validation and live-site guard (sandboxes refuse a live site) | verified | operational | `tests/unit/env.test.ts`, `tests/unit/env-template.test.ts` |
| Structured logs with prompts, emails and query values redacted (two untested gaps remain, section 6); error webhook | verified | operational; the webhook is off until `ERROR_WEBHOOK_URL` is set | vitest observability and `attack-infra.test.ts` (outside Docker) |
| S3 storage driver | implemented but not verified | off; local disk is the default | vitest runs it against a stubbed S3 client (`media-s3.test.ts`); never run against a real bucket |
| Docker images and compose stack | blocked | never run | No Docker daemon here. Only `docker compose config` was run |
| CI workflow (`.github/workflows/ci.yml`) | verified | operational | Green on GitHub Actions at 574ccaf (run 16). It never runs for `main` |
| Migrations `0000` to `0004` | verified | operational | Applied on a fresh database by every vitest and e2e run |

### Intended but not built

These were planned in the spec or are named as missing in the other deliverables. None exists in
the code.

| Feature | Status | Evidence and notes |
| --- | --- | --- |
| Password reset, password change and account recovery | not done | `src/app/api/auth` has only login, logout and signup, and no route changes a password, for a member or an admin. A member who forgets their password cannot get back in. |
| Multi-factor authentication | not done | No code for it (`docs/engineering.md`, section 15). |
| An email service | not done | `src/server/env.ts` has no email settings. Password reset and the fix for the sign-up membership probe (R05-H7) both need one. |
| Creating or editing template collections | not done | The `template_collections` table exists (`src/server/db/schema.ts:304`) and creator pages list collections, but no API creates or edits one. The one collection is seeded. |
| Avatar upload | not done | Avatars are initials. |
| Visual-style similarity in discovery | not done | For you uses categories and tags only. |
| Quick Generate on a template card | not done | |
| A media-type mark on image cards | not done | |
| Alternate angles for a scene | not done | |
| A real video model, and a fal.ai adapter | not done | The only real model is Replicate's FLUX.1 schnell, which makes images. |
| Lifting an admin suspension | not done | The only admin user route is suspend. The review queue reinstates an account only after a false-positive scanner case is cleared, never one an admin suspended. |
| A page Content-Security-Policy and HSTS | not done | `next.config.ts` sets nosniff, frame, referrer, permissions and robots headers; its only CSP is on `/sw.js`. |
| Metrics, tracing and dashboards | not done | The error webhook is the only alerting path. |
| Background sync while offline | not done | Most actions that need the network are disabled offline instead. |

## 3. Adversarial review

Seven reviewers read a frozen snapshot (f8d5ef3) and returned 62 raw findings. Triage, done by hand,
merged them into 49: 1 critical, 12 high, 22 medium, 14 low. The infra fixer reviewed the Docker,
compose, CI and logging code (merged after the snapshot) and found 12 more (I01 to I12: 2 high, 2
medium, 8 low). Of those 12, 8 were fixed, 3 low ones were left by decision (I09 to I11, section 6),
and 1 was refuted (I12: MinIO's ports bind to 127.0.0.1).

| Outcome | Count | Status |
| --- | --- | --- |
| Review findings fixed, each with a regression test that passes | 49 of 49 (48 have the failing run on the old code recorded; R05's was lost in a session restart) | verified |
| Infra findings fixed, each with a test | 8 of 12 | verified |
| Infra findings left by decision (I09, I10, I11) | 3 of 12 | not done |
| Attack attempts on the fixes | 90, of which 51 held | verified |
| Holes the attacks found, patched with tests | 37 of 39 | verified |
| Holes left for a product decision (R05-H6, R05-H7, section 6) | 2 of 39 | not done |

The critical finding (R01) let a CCBill buyer pay for the cheapest item and be credited with any pack
or pass. Every processor's sale now has to match the item's price and currency, or it is held for
manual review and grants nothing. Per-finding commits, tests and before-and-after output are in
`notes/analysis/review/fix-results.json`. Some fixes and patches recorded residual risks they did not
fix; section 6 lists the main ones, and `fix-results.json` has the rest in each finding's notes.

## 4. Visual review

A capture spec took 223 screenshots at 390, 820 and 1440 px, most of them full page: every main page,
as a visitor, a visitor in GB, a member, a new member with empty states, an unverified member in GB, a
creator and an admin, plus the create flow (cost sheet, job tray, upload consent, sandbox checkout),
loading skeletons, the offline page, the not-found page and open sheets. Each screenshot carried
automated checks for horizontal overflow, tap targets, clipped text and axe color contrast. Two
reviewers went through them (158 and 97 screenshots each) and found 43 defects: 3 high, 27 medium,
13 low (counted from the defect list in `notes/analysis/visual/visual-review.json`: 3 high, 14
medium and 3 low from the first reviewer, 13 medium and 10 low from the second). The tracker
first recorded 26 medium and 14 low; that miscount was corrected on 2026-10-14.

| Result | Status | Evidence |
| --- | --- | --- |
| Before capture at 7149139: 223 screenshots, each with the automated checks | verified | `before/manifest.json`; 32 passed |
| All 43 defects fixed | verified | `visual-review.json`, each defect with its fix and before and after |
| After capture at a802cc4: no overflow, contrast violations from 9 to 0, flagged phone tap targets from 1,916 to 369, no new defect | verified | `after/manifest.json`; 32 passed |
| Layout guard, run in every e2e run | verified | `tests/e2e/layout.spec.ts`, 4 passed in `notes/evidence/e2e-09a436e.log` |
| Route error boundary (`src/app/error.tsx`) | implemented but not verified | Never captured, because no page throws on demand |

Branch `visual-review` holds 36 commits in 7149139..a802cc4: 35 fixes and the layout guard
(d4b594c). It was merged at 91d270c. Commit 7149139 itself is the capture spec. The remaining
tap-target flags are card title links that duplicate the card's own link, switches inside full-row
labels, links inside sentences, and native checkboxes inside their labels.
Most fixes went into shared parts: 40 px phone targets (section links, back links, the sheet Close
button, small buttons, the toast action), grids that shrink to the phone width, page bottom padding
that clears the job tray and the Make bar, a fade at the edge of sideways-scrolling rows, the sandbox
tag's contrast on the buy button, a page heading on the creation page, a "Verify your age" button on
the age-check refusal, correct scene and take counts (they read 0 before) and Demo labels on
projects, and a demo caption that fits its frame.

One fix worked around a hydration bug in the React 19.2 build that Next.js 15.5.27 ships (React error
#418 on about 1 in 130 cold loads with the browser cache off). The shell now passes the page through a
small component, which changes no markup. A Next.js release that ships React 19.3 or later removes the
cause. Screenshots and manifests: `/mnt/project-files/playbox-2/evidence/visual/before/` and
`after/`; results, with each defect's fix and before and after, in
`notes/analysis/visual/visual-review.json`.

Private pages seen signed out were not captured as pages; their response codes are recorded instead.

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
| Edge | None | TLS, geo headers set at the edge with client copies stripped, forwarding headers, and the proxy count set (section 6) | `GEO_COUNTRY_HEADER`, `GEO_REGION_HEADER`, `TRUSTED_PROXY_HOPS` |
| Email | None (not built) | An email service and the code to use it (section 2) | None yet |

`.env.example` lists every variable with its default. `docs/deployment.md` has the going-live
checklist.

## 6. Known limitations and open decisions

Decisions for the owner:

- **Account recovery.** There is no password reset, no password change and no email service, so a
  member who forgets their password cannot get back in, and no admin tool sets a password. Build
  reset (with an email service) before launch, or launch without it knowingly.
- **Sign-in lockout (R05-H6).** Ten wrong guesses from anywhere lock an account's sign-in, and its
  deletion, for 15 minutes, which locks the owner out too. Options: CAPTCHA after failures,
  progressive delay, a trusted-device cookie, or per-address buckets with a higher per-account cap.
- **Sign-up membership probe (R05-H7).** Sign-up answers differently for a registered email. The fix
  is email verification, which needs an email service the build does not have.
- **Unknown locations.** `AGE_VERIFICATION_FAIL_CLOSED` defaults to false, so a visitor whose country
  or US state is unknown is not asked to verify.
- **Previews in covered places.** Every public template counts as explicit (there is no per-template
  flag), so an unverified viewer in GB or a covered US state sees no template previews at all.
- **Scanning, for the owner and counsel.** Keep the original upload bytes as evidence on a match
  (today only the re-encoded file and its sha256 are kept)? File reports through NCMEC's CyberTipline
  API or by hand? Add a classifier slot? Restore templates after a cleared false positive?
- **Product calls taken in the fixes, all reversible:** a VIP template's recipe is withheld from
  viewers without a pass; an actioned takedown of any category, copyright included, also removes
  byte-identical copies on other accounts, private copies included; a sandbox verification made
  before launch does not count on a live site.
- **React upgrade.** Moving to a Next.js release with React 19.3 or later would remove the hydration
  bug the shell works around (section 4). It is a separate dependency decision.
- **MinIO image.** MinIO's official images are no longer on Docker Hub, so the compose `s3` profile
  uses a community fork (`pgsty/minio`, pinned tag, `MINIO_IMAGE` overrides it). Using a third-party
  image is a supply-chain choice.

Questions for the processors (from the payment fixes): whether CCBill echoes pass-through values with
their `X-` prefix (if not, sales are held, which fails closed); whether a CCBill refund or chargeback
carries the original sale's transaction id; the formats a timestamp window and signed nonces would
need. Segpay still reads a missing currency code as USD.

Residual risks the review fixes recorded and left open (`notes/analysis/review/fix-results.json`):

- **Taken-down content.** A creator can still make a taken-down file again privately in their own
  Library; only publishing checks the hash block. Near-duplicates (the same prompt with another seed)
  are not matched. A scanner match on a public copy does not reach other copies of the file, as a
  takedown does. No admin tool lifts a hash block.
- **Report removals.** Removing a reported template in Admin > Reports (`resolveReport` in
  `src/server/admin.ts`) adds nothing to the hash block and, unless the report's reason is `minor`,
  puts no file under legal hold. Publishing refuses only blocked hashes and held files
  (`isTakenDownOrHeld` in `src/server/safety/takedowns.ts`, called from
  `src/server/templates/publish.ts`), and the creator's private source stays. So a creator whose
  template was removed after a report can publish the same creation again. Whether a report removal
  should also block the source is a product call.
- **A configuration error looks like bad input.** When a setting fails the configuration schema,
  the ZodError that `env()` throws inside an API route is answered as 422 `invalid_input`, "Some
  fields need attention.", and is not logged (`route()` in `src/server/http.ts`). A live site with
  such a broken setting answers API calls with a misleading 422, and neither the logs nor the error
  webhook record it. The production checks that throw a plain error instead, such as a missing
  `MEDIA_SIGNING_SECRET`, are logged and answered with 500.
- **Log redaction gaps (not tested).** For a Postgres class-22 error (invalid input), the driver's
  own message repeats the rejected value, and nothing redacts it. A plain error whose message quotes
  a Drizzle error message, thrown from a page, prints before the redaction hook; no code in `src/`
  creates one today.
- **Seed guard.** `scripts/seed.ts` refuses to run on a live deployment, but a run from a
  development shell with `NODE_ENV` unset against a production `DATABASE_URL` cannot be detected. On
  a database with no templates yet, it would create `admin@hushloom.local` and the other seeded
  accounts, which share one password (`SEED_PASSWORD`, or one it prints).
- **Video frames.** Besides one frame a second, a clip's scan picks a frame only when it differs by
  more than 10% from the last frame picked, so a frame within 10% of a scanned frame is not scanned on
  its own. If the hash matcher would match that frame but not the scanned one, the match is missed.
  `docs/abuse-response.md` says this.
- **A rare deadlock.** An account deletion at the same moment as that user's own publishing edit can
  deadlock. Postgres aborts one of the two.
- **The scan backfill is manual.** If recording a scanner match fails three times (a deadlock, a lost
  connection, a timeout), the file is kept under legal hold with its scan pending, never served and
  never purged. A generation then fails and is refunded; an upload is refused. The escalation, flag
  and suspension are created only when `scripts/scan-backfill.ts` rescans the file, and nothing
  schedules that script (the worker's only timers are its job sweep and its media purge). Operators must alert on the error logs
  `generation.match_record_failed`, `generation.match_hold_failed`, `scan.match_record_failed` and
  `scan.match_hold_failed`, then run the backfill.
- **Client addresses.** `TRUSTED_PROXY_HOPS` defaults to 0, which means no client address is
  believed. The per-address limits on sign-in (30 per 15 minutes), sign-up (10 per hour) and
  signed-out takedown requests (10 per hour) then share one site-wide key, so a few visitors can
  use them up for everyone. Behind a proxy it must be at least 1, and the app port must be reachable
  only through the proxy, or a client can name its own address.

Deployment: geo headers are trusted as sent, so the edge must set them and strip any copy a client
sends. No reverse proxy is bundled. An allowlist of CCBill's webhook source addresses at the edge is
left as an operations item (R19).

Smaller gaps in the build:

- Lighting, framing, pacing and atmosphere reach Replicate only as words in the prompt.
- Push: a cancel the person made also sends a notification ("A creation was cancelled"), and a demo
  output gets the same "Your creation is ready" line as a real one.
- The admin suspend route answers `{ok: true}` without the number of templates it unpublished; the
  admin suspend reason and flag clearing use the browser's own prompt box.
- The Library's retry cost sheet does not show the balance. Drafts nobody confirmed are hidden after
  24 hours rather than shown as expired.
- The brief "Weaving a demo placeholder" toast overlaps the "Make it" button on phones while it shows.
- Three small interface defects found while checking the documents, not fixed: the top bar's Create
  button, meant for wide screens, also shows on phones (`src/components/shell.tsx:215`); Home's
  "Tune" link goes to `/settings#discovery`, but no element has that id; the creation page's
  "in {project}" link opens the project, not the take's scene.
- CI: one failed run, run 9 at ce84bff (a `socket hang up` on an API request in one journey test,
  with no server error logged). The same code passed at run 11 and at every later run. The cause was
  not found. `notes/evidence/github-ci.md`, read through the GitHub API, gives 22 runs in total but
  lists only the ten newest (runs 7 to 16): seven green, run 9 failed, and runs 10 and 13 cancelled
  by a newer push. The claim that no older run failed rests on the tracker alone (`notes/progress.md`,
  "One failure in 22 runs"). The older runs are not recorded one by one, and the evidence file does
  not say why run numbers stop at 16 when 22 runs are counted.
  CI also builds the app twice, once per job. In the checks job, the Postgres health check connects
  to a database the job does not create, so the service log shows a FATAL line every 5 seconds
  (noise only).
- `npm ci` warns that eslint 9.39.1 is no longer supported.

Low items left by decision: compose Redis has no password (it is not published); base images are
pinned by tag, not digest; the web image's server files are owned by its runtime user; GitHub actions
are pinned to tags, not commit SHAs.

Legal: statements in `docs/abuse-response.md` are marked for legal review. The US state list in
`src/config/jurisdictions.ts` was compiled from the Free Speech Coalition tracker on 2026-10-12; it
is configuration, not legal advice, and must be re-checked before launch.

## 7. What blocks a production launch

1. An AI provider that permits adult content, under contract, wired through the adapter and tested.
2. A merchant account with CCBill or Segpay, and a test against its sandbox and real webhooks.
3. An age-verification account (Yoti or another) and a test of its live flow and notifications.
4. PhotoDNA approval, the reporting registrations, and a drill against the live scanner. Alerts on
   the match-recording failures, and a way to run `scripts/scan-backfill.ts` when one fires.
5. Hosting whose terms allow adult content, with TLS and the geo and forwarding headers set at the
   edge, `TRUSTED_PROXY_HOPS` set to at least 1 with the app port reachable only through the proxy,
   and a private bucket tested with the S3 driver. No host's terms were checked here; check them
   before deploying.
6. `docker build` and `docker compose up` run on a real Docker host.
7. Account recovery: an email service and a password reset flow, or the owner's decision to launch
   without them.
8. Counsel's review of the abuse-response document, the jurisdictions list and the policies.
9. The owner's decisions in section 6.

No production deploy, real payment or public publish was made by this build.
