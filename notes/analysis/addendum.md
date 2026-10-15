# HUSHLOOM LAUNCH-READINESS ADDENDUM (approved by Jayvo 2026-10-12 22:30)

Apply these four additions on top of the existing Hushloom build. Do not start over, and keep the current visual identity and design system.

WHY (checked against official sources on 12 October 2026 by the coordinator; cite these in docs, do not re-research)
- Stripe's prohibited-businesses list bans pornography and mature content, including AI-generated content (https://stripe.com/legal/restricted-businesses). Stripe cannot be the payment rail for explicit content.
- The UK requires "highly effective age assurance" where users can generate or upload pornographic content, effective 25 July 2025 (Ofcom: https://www.ofcom.org.uk/online-safety/protecting-children/enforcement-programme-to-protect-children-from-encountering-pornographic-content-through-the-use-of-age-assurance). The US Supreme Court upheld Texas's age-verification law in 2025, and 27 US states have similar laws (https://www.freespeechcoalition.com/faq).
- Any platform that accepts uploads must stop child sexual abuse material. Cloudflare's CSAM Scanning Tool is free with no application (https://blog.cloudflare.com/the-csam-scanning-tool/); Microsoft PhotoDNA is free after approval; Thorn's Safer is a paid contract.
- Apple (App Store guideline 1.1.4, https://developer.apple.com/app-store/review/guidelines/) and Google Play (https://support.google.com/googleplay/android-developer/answer/9878810) both ban sexually explicit apps, so mobile must be an installable web app.

1. ADULT-FRIENDLY PAYMENTS
- Put payments behind a provider adapter, like the AI providers: checkout, webhook verification, credit issuance through the existing ledger, refunds, chargebacks.
- Implement CCBill and Segpay adapters (both accept adult merchants). Keep Stripe as an adapter that is off by default, with a comment citing its policy.
- Choose the active processor by configuration. Without credentials, run a clearly labeled sandbox; never fake a successful charge.
- Verify every webhook with the processor's documented scheme, reject unsigned or replayed events, and never trust client-reported payment results.
- Tests: a duplicate webhook issues credits once; a reversed payment claws credits back through the ledger; a chargeback flags the account.

2. REAL AGE VERIFICATION
- Keep the current age gate as step one, and add an age-verification provider adapter for jurisdictions that require it, using methods that meet the UK "highly effective" standard.
- Jurisdiction rules are configuration, on by default for the UK and the US states with laws.
- Store status per user (unverified, pending, verified, failed) with timestamps and the provider's reference. Do not store ID images or biometrics; if a provider forces it, encrypt them and set a retention limit.
- Users who need verification cannot generate, upload or see explicit content until verified.
- Without credentials, a labeled sandbox provider; never mark a real user verified without a real provider result.
- Tests: a user in a covered jurisdiction is blocked until verified; provider callbacks are signature-checked; every status change is audit-logged.

3. CSAM AND ABUSE SCANNING
- Scan every upload (images and video keyframes) and every generated output before storage or display, through a scanning adapter: hash matching (PhotoDNA, or Cloudflare at the edge) plus a classifier slot.
- On a match: block it, never display or share it, suspend the account, write moderation and audit events, and send it to a human review queue for reporting to NCMEC or the relevant authority. Handle evidence preservation and reporting as the applicable law requires, and document the process for legal review. Never auto-delete evidence needed for a report.
- Fail closed: if the scanner is unavailable, content waits; nothing is published unscanned.
- Keep the existing consent checks for identifiable real people, and add a takedown request flow for nonconsensual intimate imagery.
- Without credentials, a labeled development scanner, with exactly what production needs written down.
- Tests: matched content never reaches other users; a scanner outage holds content; every block is audit-logged.

4. INSTALLABLE WEB APP
- Make the site installable on iOS and Android: web app manifest, icons, standalone display, and a service worker that caches the app shell only, never private media or private API responses.
- Opt-in push notifications when a generation finishes or fails. Payloads carry no explicit or private detail, only a line like "Your creation is ready".
- Offer install from settings, not a popup on first visit. Show a clear offline state and queue nothing chargeable offline.
- Tests: the installability checks pass; push subscriptions are stored per device and removed at logout; notification payloads contain no private content.

SHARED RULES
- Every external service sits behind an adapter with declared capabilities, configured through environment variables listed in the env template. Never commit or invent credentials.
- Sandbox modes are clearly labeled in the UI and in the verification report; never present a demo as live.
- AI generation stays a labeled demo until the owner picks a provider. fal.ai forbids sexually explicit output unless it authorizes the account; Replicate's terms are ambiguous, though callers can disable its safety checker.
- Update the docs (architecture, privacy and consent, deployment, env template) and the verification report for each addition, including the accounts the owner must open: CCBill or Segpay, an age-verification provider, and PhotoDNA approval or Cloudflare.

DONE MEANS
- All four additions work end to end in sandbox mode, behind adapters, with their tests passing.
- No explicit or private content leaks through notifications, caches, logs or unscanned storage.
- The final report says what is operational, what runs in sandbox, and the exact accounts and environment variables needed to go live.
