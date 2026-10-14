# Abuse scanning and response

How Hushloom keeps child sexual abuse material (CSAM) and other abusive content from reaching anyone, what happens when something matches, how evidence is kept, how takedown requests work, and what production needs. This implements addendum §3 (approved 2026-10-12).

> **For legal review.** This document describes how the software behaves. It is not legal advice. Every statement about a legal duty below is marked *for legal review*: the operator must confirm with counsel what applies in each jurisdiction where Hushloom is offered, and the process here must be adjusted to match.

**Build status (2026-10-14).** The pipeline, verdict handling, review queue, takedown flow and tests run end to end with the **development scanner**, which matches only test hashes and protects no one. The PhotoDNA adapter is written from public material and has never run against Microsoft's service. The Cloudflare layer is configuration on Cloudflare's side; the app cannot test it. See [What is unverified](#what-is-unverified).

## 1 The pipeline

Every file that can ever be shown gets a recorded verdict on its `media_assets` row (`scan_status`, `scan_provider`, `scan_ref`, `scanned_at`). The only status that is ever served is `clean`. Everything else, including `pending` (not scanned yet), is treated exactly like a deleted file.

```
Upload    file → type/size checks → re-encode (images) → private storage (pending) → scan → verdict
Output    provider result → quality check → private storage (pending) → scan → verdict → poster frame
Seed      generated cover/preview → storage (pending) → scan (origin "seed") → must be clean or the seed stops
Existing  scripts/scan-backfill.ts → every pending asset → scan (origin "backfill")
```

- **Images** are scanned as stored. For uploads the SHA-256 of the file as received (before re-encoding) is passed too, so a hash list of original files still matches.
- **Videos** are scanned as keyframes: ffmpeg extracts one frame per second, up to 30 frames, and each frame is scanned. A scanner that can read whole videos (only the development scanner today) also scans the file itself first. If the frames cannot be read, the verdict is `unavailable`.
- **Poster frames** of a clip are not scanned again: they are recorded with the clip's verdict (`scan_ref = derived:<clip asset id>`), because they come from a clip whose keyframes were just checked.
- **Published templates** copy an output into new public assets. Publishing refuses any source (or its poster) that is not `clean` or is on legal hold (409 `not_cleared`), and the public copies carry the source's recorded clean verdict.
- **Generation inputs** must be clean: an uncleared upload looks missing (404) when used in a draft, and the worker refuses it (`invalid_input`).

Code: `src/server/safety/scan/` (adapters and verdict handling), `src/server/media.ts` (uploads, signing, purge), `src/server/generation/processor.ts` (outputs), `src/app/api/media/route.ts` (serving), `src/server/templates/publish.ts`.

Nothing in this pipeline logs or audits image bytes or prompts. Logs and audit rows carry asset ids, SHA-256 hashes, scanner names and scanner references only.

## 2 Verdicts

| Verdict | The file | The owner | Upload API | Generation job |
| --- | --- | --- | --- | --- |
| `clean` | served to whoever may see it | nothing | 201 as before | completes as before |
| `matched` | kept, `legal_hold = true`, never served, never purged | suspended (signed out everywhere), `account_flags` row `csam_match` | **403** `upload_rejected`, "This upload was rejected." (never says why) | **failed**, `content_blocked`, credits returned, **no output row** |
| `unavailable`, fail-closed (default) | deleted now (rows removed, bytes purged) | nothing | **503** `scan_unavailable`, "We couldn't check this file right now. Try again in a few minutes." | back to **queued** with the credit reservation held; after `max_attempts` (3) **failed**, `scan_unavailable`, credits returned |
| `unavailable`, fail-closed off | kept as `unavailable`, never served or usable | nothing | 201 with warning `scan_pending` | completes; the output exists but has no URL until a rescan clears it |

"Never served" is enforced in three places: `assetUrl()` signs only clean assets; `/api/media` returns 404 for anything not clean even with a validly signed link issued earlier; downloads go through `assetUrl()` and 404 the same way. Library, projects, characters, creator pages and the gallery all build URLs through `assetUrl()`.

## 3 What happens on a match

In one database transaction (`recordVerdict` in `src/server/safety/scan/index.ts`):

1. The asset is marked `matched` with the scanner's name and reference, and put on **legal hold**.
2. If the asset was a public template copy (found by a later scan), its template is taken down (`removed`).
3. A **moderation event** opens with action `escalate`, status `open`, subject type `upload` or `output`, and details `{assetId, sha256, sourceSha256?, provider, ref, category, origin, ownerId, jobId?, storageKey}`. This is the human review queue entry.
4. An **audit row** `scan.block` records the block (asset id, scanner, reference, origin, hash).
5. An **account flag** `csam_match` is written for the owner.
6. The owner is **suspended** (`users.status = suspended`), all their sessions are deleted, and an audit row `user.suspend` records it.

Repeat scans of an already matched asset change nothing (one case per asset). A match from the classifier slot (category `abuse`, no classifier exists yet) would hold and escalate with a `manual_review` flag and no automatic suspension.

The uploader sees only "This upload was rejected." The creator of a blocked generation sees "This creation was blocked by our safety checks. Your credits were returned." Both are then signed out by the suspension.

## 4 Evidence preservation

- **Legal hold** (`media_assets.legal_hold`) means: the file is never served, never purged by the 30-day retention job (`purgeDeletedMedia`), never purged immediately (`purgeAssetsNow`), and never soft-deleted by account deletion or consent withdrawal (`src/server/auth/account.ts`). The row is never hard-deleted.
- **What is kept:** the stored file (for uploads, the re-encoded WebP; for outputs, the provider's file), its SHA-256, the SHA-256 of the upload as received, the uploader's consent record and statement, the scanner's reference, timestamps, the account, and the audit trail. Location: the storage key shown on the review card.
- **What is not kept:** the original upload bytes before re-encoding (EXIF is stripped by the re-encode). *For legal review:* whether the original file as received must be preserved for a report; if so, store the received bytes as a second held asset on a match.
- **Who can lift a hold:** only an admin, only through "Clear as false positive" on `/admin/review`, and every clear is audit-logged with the admin and a required note. The generic "Clear flag" tool refuses `csam_match` flags, and the generic report queue refuses escalations. There is deliberately no "release hold after reporting" button: when evidence may be destroyed after a report is a decision for counsel (*for legal review*, see §6).
- **No viewing in the app.** The review page never displays matched media. Whether and how a person may view suspected CSAM to confirm a match, and under what controls, is *for legal review*; until then, verification happens outside the app under the operator's own procedure.

## 5 The human review queue

`/admin/review` (admins only; everyone else gets the same 404 as a missing page). Linked from the Admin page header ("Abuse review") and from a `csam_match` flag in Account flags.

- A status box says which scanner is active. The development scanner is labeled **"Development scanner · not live"** in the demo tone; an edge-only scanner shows "no pre-storage scan".
- **Scanner matches** (open escalations, oldest first): owner, account status, file type and size, asset id, SHA-256, scanner and reference, storage key, job id.
  - **Confirm and record report:** after filing the report, the admin enters its reference (for example the CyberTipline report number) and where it was filed (NCMEC CyberTipline, IWF, another authority). The escalation closes with the reference; the hold and the suspension stay; a `hold` moderation event and a `scan.match_confirmed` audit row are written; the reference is copied onto the account flag.
  - **Clear as false positive:** needs a note. The asset becomes `clean` and servable again, the hold lifts, the flag clears, and the account is reinstated if no other `csam_match` flag is open (`scan.false_positive_cleared`, `user.reinstate` audit rows). A blocked generation stays failed (its credits were already returned); the member can make it again.
- **Takedown requests** (open, the most harmful categories first): see §7.
- **Recently closed:** the last 20 closed escalations and takedowns with their references and notes.

API: `GET /api/admin/review`, `POST /api/admin/review/:id` (`{action:"confirm", reportRef, reportedTo, note?}` or `{action:"clear", note}`), `GET /api/admin/takedowns?status=open|closed`, `POST /api/admin/takedowns/:id` (`{action:"action"|"dismiss", note}`).

## 6 Reporting (for legal review)

The app records that a report was made; it does not file reports. Filing is a human step today.

- **United States:** providers that obtain actual knowledge of apparent CSAM report it to NCMEC's CyberTipline (report.cybertip.org); 18 U.S.C. § 2258A sets the duty, and § 2258A(h) requires preserving a report's contents for a period after it is made (one year after the 2024 REPORT Act, as we understand it). *For legal review:* confirm the duty, the preservation period, and whether to register for NCMEC's ESP reporting API.
- **United Kingdom:** report to the Internet Watch Foundation (iwf.org.uk); the Online Safety Act 2023 adds a duty for in-scope services to report CSEA content to the National Crime Agency once the regulations are in force. *For legal review:* status and procedure.
- **Elsewhere:** the national hotline in the INHOPE network (inhope.org) or the relevant authority. *For legal review:* per jurisdiction of operation.
- **Cloudflare's tool** (if enabled) emails the account owner about matches once a day and tries to block them at the edge; it does not report for you. The owner must report, preserve a copy, remove the content and tell Cloudflare (developers.cloudflare.com/cache/reference/csam-scanning/).
- **Nonconsensual intimate imagery:** the US TAKE IT DOWN Act (2025) requires covered platforms to remove reported NCII within 48 hours of a valid request, as we understand it. *For legal review:* applicability and the request requirements; the form below collects a signature and a good-faith statement for that reason.

## 7 Takedown requests

Public page `/policies/takedown` (outside the age gate; linked from the Policies page, the age gate and the template Report sheet). Anyone can send one, signed in or not.

- Fields: what it is (`ncii` intimate image without consent, `likeness`, `csam`, `copyright`, `other`), where it is (a link or an id), an email (required signed out, optional signed in), an optional name as signature, optional details, and a required good-faith statement.
- `POST /api/takedowns`: rate limited (10 an hour per account, or per IP signed out), 201 for every accepted request whether or not the target exists, so the form confirms nothing. Links to `/templates/…`, `/collection/…` and signed `/api/media` URLs are resolved to the template, creation or asset; anything else is kept as a URL for a person to look at. The audit row (`takedown.create`) holds ids and the category, never the requester's email or words.
- Nothing is removed automatically, so the form cannot be used to knock down someone else's work. On `/admin/review`, an admin:
  - **Take it down** (API action `action`): soft-deletes the target (a creation with its outputs and poster, a template with its public media, or one asset and anything showing it). `ncii` and `likeness` requests purge the files right away, as a consent withdrawal does. A `csam` request instead puts the files on legal hold and opens an escalation (`csam_report`) so the reporting step runs through §5. Audit row `takedown.action`.
  - **Dismiss**: needs a note. Audit row `takedown.dismiss`.
- The card shows how long a request has been open and turns amber after 24 hours for urgent categories (see the 48-hour note in §6).
- The existing template report (`POST /api/templates/:id/report`, signed in) still works and still feeds the Reports panel on `/admin`.

## 8 Fail-closed behavior

`SCAN_FAIL_CLOSED=true` is the default. A scanner that errors, times out (`SCAN_TIMEOUT_S`, default 30 s per call), is unconfigured, or answers with anything unexpected gives `unavailable`. With fail-closed on, nothing unscanned is kept:

- Upload: rows removed, bytes deleted, 503 with "We couldn't check this file right now. Try again in a few minutes." The upload form shows that message.
- Generation: the files are deleted, the job goes back to the queue with its credits still reserved (the tray shows it queued), and retries with backoff (5 s, 10 s). After 3 attempts it fails with "Our safety check couldn't run, so nothing was saved. Try again in a few minutes; your credits were returned."
- Seed: stops with an error.

With fail-closed off (operator's choice, weaker), unscannable content is kept as `unavailable` and is still never served, used or published; `npx tsx scripts/scan-backfill.ts --include-unavailable` rescans it later.

Drill: `SCAN_DEV_SIMULATE_OUTAGE=true` makes the development scanner unavailable for every file.

## 9 What production needs

| Need | How | Env vars |
| --- | --- | --- |
| A pre-storage hash matcher | **Microsoft PhotoDNA Cloud Service**: apply at microsoft.com/photodna (free after approval). Microsoft issues a subscription key and the Match endpoint. | `SCAN_PROVIDER=photodna`, `PHOTODNA_API_KEY`, `PHOTODNA_ENDPOINT` |
| Fail-closed | Keep the default. | `SCAN_FAIL_CLOSED=true` |
| An edge second layer (recommended) | **Cloudflare CSAM Scanning Tool**: free, no application; enable in the dashboard (Caching › Configuration › CSAM Scanning Tool) and give a notification email. It scans only images Cloudflare serves from its cache. This build sends every media response with `Cache-Control: private`, so as shipped Cloudflare caches, and therefore scans, nothing; making public template media cacheable at the edge is the operator's decision (it also means a CDN purge on takedown). | none in the app |
| Timeouts | Optional. | `SCAN_TIMEOUT_S` |
| Existing databases | Run once after deploying: `npx tsx scripts/scan-backfill.ts`. Until then, assets created before scanning existed are `pending` and are not served. It prints counts and exits 1 if anything is left without a verdict. | the app's env |
| Monitoring | Alert on the JSON log lines `scan.unavailable` (outage: uploads are being refused) and `scan.matched` (a case is waiting in `/admin/review`). | — |
| People | Named admins who handle `/admin/review` daily, a reporting account with NCMEC (US) and the relevant hotline elsewhere, and counsel's sign-off on §4 and §6. | — |

`SCAN_PROVIDER=cloudflare` exists for honesty, not as a recommendation: Cloudflare's tool has no pre-storage API, so with fail-closed on it makes every scan `unavailable` (nothing can be uploaded or generated), and with fail-closed off it records files clean with provider `cloudflare-edge` and reference `edge-only:not-pre-scanned`, meaning nothing was checked before storage. That configuration is **weaker** and should be flagged in any launch review.

The development scanner (`SCAN_PROVIDER=dev`, the default) refuses production: the app will not boot in production with it while fail-closed is on, and with fail-closed off it answers `unavailable` for every file in production, so nothing is ever served. `SCAN_DEV_MATCH_HASHES` (comma-separated SHA-256) and the built-in drill fixture `tests/fixtures/scan-drill-match.png` (a harmless striped test image) are the only things it matches. `CLOUDFLARE_SCAN_WEBHOOK_SECRET` is unused: Cloudflare's tool notifies by email only.

## 10 What is unverified

- **PhotoDNA** (`src/server/safety/scan/providers/photodna.ts`): never run against Microsoft's service; no account or key exists. It posts the image as JPEG (≤ 4 MB, ≤ 2048 px) with `Ocp-Apim-Subscription-Key`, and reads `Status.Code`, `IsMatch` and `TrackingId`. Sources: Microsoft's Content Moderator "ProcessImage/Match" reference (headers, media types, `IsMatch`/`Status`/`TrackingId`), Wikimedia's MediaModeration extension and task T336205 (raw image POST with those headers; response fields; 4 MB cap; 5 requests per second). `Status.Code 3000` as success is from PhotoDNA's documentation as remembered; any other code fails closed. Requests are spaced to stay under 5 per second per process.
- **Cloudflare**: configured in Cloudflare's dashboard, not in the app; nothing here can exercise it.
- **Legal statements** in §4 and §6: summaries for counsel, not checked by a lawyer.
- **Exercised by tests** (`tests/integration/scan.test.ts`, 19 tests, development scanner): matched uploads and outputs, a match in a video keyframe, outage on upload and output (retry, exhaustion, recovery), fail-open, publishing refusals, takedowns signed out and in, admin actions, false-positive clear and confirm.

## 11 Known gaps

- Original upload bytes are not preserved on a match (see §4).
- No in-app secure viewer for reviewers (deliberate, see §4).
- Reports are filed by hand; no NCMEC API integration.
- The classifier slot is empty: only known material can match.
- A false positive found on a public template copy does not republish the template.
- Reinstating after a false positive cannot tell a scan suspension from an unrelated manual one; check the account before clearing.
- Fail-open `unavailable` files are rescanned only when someone runs the backfill with `--include-unavailable`.
